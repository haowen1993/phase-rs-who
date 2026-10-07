#!/usr/bin/env python3
"""Fetch a community CDN's per-printing art availability from its own index API.

Invoked by `scripts/gen-derived-art-availability.sh`, which owns argument
parsing, the MTGJSON scan, and the locale-to-source mapping. Everything here is
the fetching plus the sidecar it writes.

── Why this replaced blind CDN probing ────────────────────────────────────────

The original implementation asked the CDN once per printing (`GET` + `Range:
bytes=0-0`) because no Scryfall field records whether a derived locale has art for
an English printing id. That reasoning was right about SCRYFALL and wrong about
the CDN operator: 大学院废墟 publishes its own index, and for every printing it
answers exactly the question this file needs — `zhs_image_url` is the URL when the
art exists and `null` when it does not. Measured on Doctor Who, the API's answer
and a full probe agree on every one of the 1178 printings (398 available, 0
disagreements in either direction), so the probe was buying the same boolean for
~70,000 requests instead of ~70.

The two implementations are kept side by side rather than one replacing the other:
`probe-derived-art-availability.py` remains correct and dependency-free, and is
the fallback when this index is unreachable or has not caught up.

── Two rules that are easy to get wrong ───────────────────────────────────────

`include_extras=true` is REQUIRED, not an optimization. The index excludes
supplemental cards by default, and Doctor Who's 40 planechase cards are extras:
without the flag the WHO answer is 358 printings instead of 398, silently dropping
art the client would otherwise prefer. Any new locale must re-check this.

`unique=scryfall_id` is what makes the query per-PRINTING. The default
deduplicates to a representative version per Oracle object (`count: 318` for the
same set), which cannot answer a per-printing question at all.

Requests are grouped by set and paginated at the API's 1000-item maximum, so cost
scales with the number of sets (~70 for the current pool) rather than printings.
"""

import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

LANG_CODE = os.environ["LANG_CODE"]
SOURCE_URL = os.environ["SOURCE_URL"]
IDS_FILE = os.environ["IDS_FILE"]
SET_CODES_FILE = os.environ["SET_CODES_FILE"]
OUTPUT = os.environ["OUTPUT"]
SCOPE = os.environ.get("SCOPE", "")

PAGE_SIZE = 1000
WORKERS = int(os.environ.get("PHASE_AVAILABILITY_WORKERS", "3"))
RETRIES = int(os.environ.get("PHASE_AVAILABILITY_RETRIES", "5"))
TIMEOUT = int(os.environ.get("PHASE_AVAILABILITY_TIMEOUT", "60"))
USER_AGENT = "phase-rs-card-art-availability/1.0"

# The index rate-limits by request FREQUENCY, not concurrency or volume: a burst
# of a hundred parallel page fetches draws 429s while twelve sequential requests
# do not, and the 429 carries no Retry-After or rate-limit header to pace against.
# So pacing is ours: few workers, and a proportional throttle between requests.
# A run that draws 429s still finishes — the coverage check below refuses to write
# a partial file, so the failure mode is "run it again", never "silently missing
# art".
REQUEST_DELAY = float(os.environ.get("PHASE_AVAILABILITY_DELAY", "0.25"))
RATE_LIMIT_BACKOFF = float(os.environ.get("PHASE_AVAILABILITY_BACKOFF", "5"))


class RateLimiter:
    """Serialize requests to at most one per `delay`, shared across workers."""

    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.lock = threading.Lock()
        self.next_slot = 0.0

    def wait(self) -> None:
        if self.delay <= 0:
            return
        with self.lock:
            now = time.monotonic()
            self.next_slot = max(now, self.next_slot) + self.delay
            sleep_for = self.next_slot - now
        if sleep_for > 0:
            time.sleep(sleep_for)


RATE_LIMITER = RateLimiter(REQUEST_DELAY)

# The field that IS the answer: a URL when the locale has art for this printing,
# `null` when it does not. Named per locale so adding a locale is an explicit
# edit here rather than a silent wrong-field read.
AVAILABILITY_FIELD = {"zhs": "zhs_image_url"}


def api_base() -> str:
    return SOURCE_URL.rstrip("/")


def fetch_page(set_code: str, page: int) -> dict:
    """One page of one set's printings. Raises on an unrecoverable failure."""
    query = urllib.parse.urlencode(
        {
            "q": f"set:{set_code}",
            "view": 1,
            "page_size": PAGE_SIZE,
            "page": page,
            # See the module docstring: both are load-bearing.
            "unique": "scryfall_id",
            "include_extras": "true",
        }
    )
    request = urllib.request.Request(
        f"{api_base()}/result?{query}", headers={"User-Agent": USER_AGENT}
    )
    last: Exception | None = None
    for attempt in range(RETRIES):
        RATE_LIMITER.wait()
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # A 404 means this set has no index entry — an answer, not a retry.
            if error.code == 404:
                return {"items": [], "total_pages": 0, "count": 0}
            last = error
            # 429 is pacing, not failure: back off harder than a transient error.
            # Jittered so the workers do not all return at the same instant and
            # recreate the burst that caused it.
            if error.code == 429:
                time.sleep(RATE_LIMIT_BACKOFF * (2**attempt) + random.uniform(0, 1))
                continue
        except Exception as error:  # noqa: BLE001 - network layer, retried below
            last = error
        if attempt < RETRIES - 1:
            time.sleep(1 + attempt)
    raise RuntimeError(f"{set_code} page {page}: {last}")


def collect_set(set_code: str, field: str) -> tuple[dict[str, bool], int]:
    """Every printing in one set -> {scryfall_id: has_art}, plus pages fetched."""
    result: dict[str, bool] = {}
    page = 1
    pages = 1
    while page <= pages:
        body = fetch_page(set_code, page)
        for item in body.get("items") or []:
            printing_id = item.get("id") or item.get("scryfall_id")
            if printing_id:
                result[printing_id] = bool(item.get(field))
        # The endpoint clamps an out-of-range page to the last one, so trusting a
        # hard-coded page count would loop forever; take it from the response.
        pages = int(body.get("total_pages") or 0)
        if pages <= 0:
            break
        page += 1
    return result, page - 1


def main() -> int:
    field = AVAILABILITY_FIELD.get(LANG_CODE)
    if field is None:
        print(
            f"ERROR: no availability field known for derived locale '{LANG_CODE}'.",
            file=sys.stderr,
        )
        print(
            "  Add it to AVAILABILITY_FIELD in this script.",
            file=sys.stderr,
        )
        return 2

    with open(IDS_FILE, encoding="utf-8") as handle:
        expected = {line.strip() for line in handle if line.strip()}
    if not expected:
        print("ERROR: no printing ids to resolve.", file=sys.stderr)
        return 1

    with open(SET_CODES_FILE, encoding="utf-8") as handle:
        set_codes = [line.strip() for line in handle if line.strip()]
    if not set_codes:
        print("ERROR: no set codes to query.", file=sys.stderr)
        return 1

    print(
        f"Querying {len(set_codes)} set(s) at {api_base()}/result "
        f"(page_size={PAGE_SIZE}) ..."
    )
    started = time.time()
    observed: dict[str, bool] = {}
    pages_fetched = 0
    failures: list[str] = []

    def work(set_code: str):
        try:
            return set_code, collect_set(set_code, field), None
        except Exception as error:  # noqa: BLE001 - reported, not swallowed
            return set_code, ({}, 0), error

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for done, (set_code, (printings, pages), error) in enumerate(
            pool.map(work, set_codes), start=1
        ):
            if error is not None:
                failures.append(f"{set_code}: {error}")
            else:
                observed.update(printings)
                pages_fetched += pages
            if done % 10 == 0 or done == len(set_codes):
                print(
                    f"  {done}/{len(set_codes)} sets "
                    f"({len(observed)} printings, {time.time() - started:.0f}s)",
                    flush=True,
                )

    # Coverage is the correctness check that distinguishes "the index has no art"
    # from "we never asked about this printing". Without it a set that failed or
    # was missing from SET_CODES_FILE would look like a set with no localized art,
    # and the client would silently stop preferring art that does exist.
    missing = expected - observed.keys()
    if missing:
        print(
            f"ERROR: {len(missing)} of {len(expected)} expected printings were "
            "never returned by the index.",
            file=sys.stderr,
        )
        for printing_id in sorted(missing)[:5]:
            print(f"    {printing_id}", file=sys.stderr)
        if failures:
            print("  set failures:", file=sys.stderr)
            for failure in failures[:5]:
                print(f"    {failure}", file=sys.stderr)
        print(
            "  Refusing to write a sidecar that would treat unqueried printings "
            "as having no art.",
            file=sys.stderr,
        )
        return 1

    available = sorted(printing_id for printing_id, has in observed.items() if has)
    document = {
        "schema_version": 1,
        "language": LANG_CODE,
        "algorithm": "index-api-art-availability-v1",
        "scope": SCOPE or "all",
        "source": f"{api_base()}/result",
        "note": (
            "English Scryfall printing ids this locale's index serves art for, "
            "read from the index's own per-printing field "
            f"({field}). See scripts/gen-derived-art-availability.sh."
        ),
        "ids": available,
    }
    with open(OUTPUT, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(OUTPUT) // 1024
    total = len(expected)
    print(
        f"Wrote {OUTPUT} ({size_kb} KB, {len(available)} ids, "
        f"{len(available) * 100 // total}% of {total} printings; "
        f"{pages_fetched} request(s) in {time.time() - started:.0f}s)"
    )
    if failures:
        print(
            f"  WARNING: {len(failures)} set(s) failed but their printings were "
            "covered by another set's response.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
