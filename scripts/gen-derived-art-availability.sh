#!/usr/bin/env bash
set -euo pipefail

# Resolve which printings a COMMUNITY-CDN art locale actually has art for, and
# write the result as an availability sidecar.
#
#     ./scripts/gen-derived-art-availability.sh                    # zhs, whole pool
#     ./scripts/gen-derived-art-availability.sh zhs _WHO           # zhs, one product
#     PHASE_AVAILABILITY_SCOPE=_WHO ./scripts/gen-derived-art-availability.sh
#
#     PHASE_AVAILABILITY_METHOD=probe ./scripts/gen-derived-art-availability.sh
#       Force the CDN-probing fallback instead of the index API (see below).
#
# ── Why this cannot be derived from Scryfall ────────────────────────────────
#
# The mapped locales (de/es/fr/it/ja/pt) get their sidecar by joining MTGJSON
# `foreignData` to Scryfall's bulk export: a localized printing is a real Scryfall
# object with its own id, so the relationship is data.
#
# A derived locale (zhs) has no such printing to point at. Its CDN localizes
# community art under the ENGLISH printing's id, so no Scryfall field records
# availability, and the split is arbitrary even inside one set — Doctor Who #318
# of a card has a Chinese image while #528, #909 and #1119 of the same card do
# not. Membership has to come from the CDN operator, and it is shipped as a set
# the client consults when choosing which printing to render.
#
# ── Two ways to obtain it, and why the index is the default ─────────────────
#
# The CDN operator publishes its own index API, and for every printing it answers
# exactly the question this sidecar encodes: a per-printing image URL when the art
# exists, null when it does not. Measured on Doctor Who, that answer and a full
# CDN probe agree on all 1178 printings (398 available, zero disagreements in
# either direction), for ~70 requests instead of ~70,000.
#
# The probe is kept, not replaced: it depends on nothing but the CDN itself, so it
# stays the fallback when the index is unreachable, rate-limited, or behind. Both
# writers emit the same document and the same `ids` list, so the client cannot
# tell which produced a given file — only `algorithm` and `source` record it.
#
# ── Probing rules (both are load-bearing, for METHOD=probe) ─────────────────
#
# GET, never HEAD: the CDN answers 404 to HEAD on an object that is not in its
# edge cache and 200 to GET on the same URL. A HEAD-based run reports ~0%
# coverage and looks like a working script.
#
# `Range: bytes=0-0` keeps each probe to one byte (206 when present, 404 when
# absent) instead of downloading every image in the pool.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LANG_CODE="${1:-zhs}"
SCOPE="${2:-${PHASE_AVAILABILITY_SCOPE:-}}"
OUTPUT_DIR="${PHASE_AVAILABILITY_OUTPUT_DIR:-$REPO_ROOT/client/public}"
MTGJSON_SETS="${MTGJSON_SETS_DIR:-$REPO_ROOT/data/mtgjson/sets}"
SET_LIST="${MTGJSON_SET_LIST_FILE:-$REPO_ROOT/data/mtgjson/SetList.json}"
# `index` reads the CDN operator's own per-printing index; `probe` asks the CDN
# once per printing. See the header for why the index is the default and the probe
# is kept. Any other value is rejected rather than silently falling back — a typo
# must not cost an hour of probing.
METHOD="${PHASE_AVAILABILITY_METHOD:-index}"
# CDN host, path prefix, and index API for the locale. `zhs` is 大学院废墟
# (mtgch.com), the only community CDN wired up today; adding another means adding
# its shape here.
case "$LANG_CODE" in
  zhs)
    CDN_HOST="images.mtgch.com"
    CDN_PREFIX="zhs"
    INDEX_API="https://mtgch.com/api/v2"
    ;;
  *)
    echo "ERROR: no CDN shape known for derived locale '$LANG_CODE'." >&2
    echo "  Add its host, path prefix, and index API to the case statement above." >&2
    exit 2
    ;;
esac
case "$METHOD" in
  index|probe) ;;
  *)
    echo "ERROR: unknown PHASE_AVAILABILITY_METHOD='$METHOD' (want 'index' or 'probe')." >&2
    exit 2
    ;;
esac
if [ "$METHOD" = "index" ] && [ -z "${INDEX_API:-}" ]; then
  echo "ERROR: no index API known for derived locale '$LANG_CODE'." >&2
  echo "  Use PHASE_AVAILABILITY_METHOD=probe, or add its index API above." >&2
  exit 2
fi

if [ ! -d "$MTGJSON_SETS" ]; then
  echo "ERROR: MTGJSON set files not found at $MTGJSON_SETS" >&2
  echo "  Run ./scripts/gen-card-data.sh once to download them." >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required." >&2
  exit 2
fi

# Collect printing ids from the set files. Scoping by SET CODE (the `_WHO` suffix
# that MTGJSON gives Doctor Who decks) keeps a single-product channel's sidecar
# small — 1178 printings instead of the whole pool.
echo "=== Derived art availability ($LANG_CODE${SCOPE:+ scope=$SCOPE} via $METHOD) ==="
IDS_FILE="$(mktemp)"
SET_CODES_FILE="$(mktemp)"
trap 'rm -f "$IDS_FILE" "$SET_CODES_FILE"' EXIT

if [ -n "$SCOPE" ]; then
  # `_WHO` -> `WHO`; the suffix is the deck-id convention, the set code is not
  # suffixed, so strip the leading underscore.
  SET_CODE="${SCOPE#_}"
  SET_FILE="$MTGJSON_SETS/$SET_CODE.json"
  if [ ! -f "$SET_FILE" ]; then
    echo "ERROR: $SET_FILE not found for scope '$SCOPE'." >&2
    exit 2
  fi
  jq -r '.data.cards[]? | select(.identifiers.scryfallId != null) | .identifiers.scryfallId' \
    "$SET_FILE" | sort -u > "$IDS_FILE"
  printf '%s\n' "$SET_CODE" > "$SET_CODES_FILE"
else
  # Every set file MTGJSON gave us. `paths` is deliberately not used here: the
  # pool is whatever has been downloaded, which is what the client will ship.
  for set_file in "$MTGJSON_SETS"/*.json; do
    jq -r '.data.cards[]? | select(.identifiers.scryfallId != null) | .identifiers.scryfallId' \
      "$set_file" 2>/dev/null || true
  done | sort -u > "$IDS_FILE"
  # The index is queried per set, so the set list is derived from the same files
  # the ids came from. MTGJSON names each file after the set code, and `code` in
  # the body is written in caps; the API's `set:` operator is case-insensitive, so
  # the filename stem is used as-is rather than re-reading every file for it.
  for set_file in "$MTGJSON_SETS"/*.json; do
    basename "$set_file" .json
  done | sort -u > "$SET_CODES_FILE"
fi

TOTAL=$(wc -l < "$IDS_FILE" | tr -d ' ')
if [ "$TOTAL" = 0 ]; then
  echo "ERROR: no printing ids collected. Is the MTGJSON cache populated?" >&2
  exit 1
fi

OUTPUT="$OUTPUT_DIR/scryfall-images.$LANG_CODE-available.json"
mkdir -p "$OUTPUT_DIR"

if [ "$METHOD" = "index" ]; then
  echo "Resolving $TOTAL printings across $(wc -l < "$SET_CODES_FILE" | tr -d ' ') set(s) via $INDEX_API ..."
  LANG_CODE="$LANG_CODE" SOURCE_URL="$INDEX_API" \
    IDS_FILE="$IDS_FILE" SET_CODES_FILE="$SET_CODES_FILE" \
    OUTPUT="$OUTPUT" SCOPE="$SCOPE" \
    python3 "$SCRIPT_DIR/lib/fetch-index-art-availability.py"
else
  echo "Probing $TOTAL printings on $CDN_HOST/$CDN_PREFIX/ ..."
  LANG_CODE="$LANG_CODE" CDN_HOST="$CDN_HOST" CDN_PREFIX="$CDN_PREFIX" \
    IDS_FILE="$IDS_FILE" OUTPUT="$OUTPUT" SCOPE="$SCOPE" \
    python3 "$SCRIPT_DIR/lib/probe-derived-art-availability.py"
fi
