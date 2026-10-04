#!/usr/bin/env python3
"""Probe a derived art locale's CDN for per-printing availability.

Invoked by `scripts/gen-derived-art-availability.sh`, which owns argument
parsing, the MTGJSON scan, and the locale-to-CDN mapping. Everything here is the
probing itself plus the sidecar it writes.

Two rules from that CDN shape drive the implementation:

* **GET, never HEAD.** It answers 404 to HEAD on an object that is not in its
  edge cache and 200 to GET on the same URL, so a HEAD-based run reports ~0%
  coverage while looking like it worked.
* **`Range: bytes=0-0`.** One byte per probe (206 present, 404 absent) rather
  than downloading the whole pool.

Failures are retried a few times and anything still unresolved is recorded
separately rather than being folded into "absent": a transient network error
must not silently become "this printing has no art", because the client would
then stop preferring a printing that does.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

LANG_CODE = os.environ["LANG_CODE"]
CDN_HOST = os.environ["CDN_HOST"]
CDN_PREFIX = os.environ["CDN_PREFIX"]
IDS_FILE = os.environ["IDS_FILE"]
OUTPUT = os.environ["OUTPUT"]
SCOPE = os.environ.get("SCOPE", "")

WORKERS = int(os.environ.get("PHASE_AVAILABILITY_WORKERS", "16"))
RETRIES = int(os.environ.get("PHASE_AVAILABILITY_RETRIES", "3"))
TIMEOUT = int(os.environ.get("PHASE_AVAILABILITY_TIMEOUT", "20"))
USER_AGENT = "phase-rs-card-art-availability/1.0"


def url_for(printing_id: str) -> str:
    # The CDN mirrors Scryfall's layout with a language prefix: the shard
    # directories are the printing id's own first two characters.
    return (
        f"https://{CDN_HOST}/{CDN_PREFIX}/normal/front/"
        f"{printing_id[0]}/{printing_id[1]}/{printing_id}.webp"
    )


def probe(printing_id: str) -> tuple[str, int]:
    request = urllib.request.Request(
        url_for(printing_id),
        headers={"User-Agent": USER_AGENT, "Range": "bytes=0-0"},
    )
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return printing_id, response.status
        except urllib.error.HTTPError as error:
            # A 404 is the answer, not a failure to retry.
            return printing_id, error.code
        except Exception:
            if attempt == RETRIES - 1:
                return printing_id, 0
            time.sleep(1 + attempt)
    return printing_id, 0


def main() -> int:
    with open(IDS_FILE, encoding="utf-8") as handle:
        ids = [line.strip() for line in handle if line.strip()]
    if not ids:
        print("ERROR: no printing ids to probe.", file=sys.stderr)
        return 1

    started = time.time()
    available: list[str] = []
    absent = 0
    unresolved: dict[str, int] = {}
    done = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for printing_id, status in pool.map(probe, ids):
            done += 1
            if status in (200, 206):
                available.append(printing_id)
            elif status == 404:
                absent += 1
            else:
                unresolved[printing_id] = status
            if done % 250 == 0:
                print(f"  {done}/{len(ids)}  ({time.time() - started:.0f}s)", flush=True)

    available.sort()
    document = {
        "schema_version": 1,
        "language": LANG_CODE,
        "algorithm": "cdn-art-availability-v1",
        # Recorded so a reader can tell a measured file from a hand-written one,
        # and so a stale file is identifiable by its scope.
        "scope": SCOPE or "all",
        "source": f"https://{CDN_HOST}/{CDN_PREFIX}/",
        "note": (
            "English Scryfall printing ids this locale's CDN serves art for. "
            "Measured with GET + Range: bytes=0-0; see "
            "scripts/gen-derived-art-availability.sh for why it cannot be derived."
        ),
        "ids": available,
    }
    with open(OUTPUT, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(OUTPUT) // 1024
    total = len(ids)
    print(
        f"Wrote {OUTPUT} ({size_kb} KB, {len(available)} ids, "
        f"{len(available) * 100 // total}% of {total} printings)"
    )
    print(f"  absent {absent}, unresolved {len(unresolved)}")
    if unresolved:
        # Loud, because an unresolved probe is indistinguishable from "absent" to
        # the client and would silently drop a printing that does have art.
        print(
            "  WARNING: unresolved probes are recorded nowhere and will be treated "
            "as absent. Re-run to fill them in.",
            file=sys.stderr,
        )
        for printing_id, status in list(unresolved.items())[:5]:
            print(f"    {printing_id} -> {status}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
