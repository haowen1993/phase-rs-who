#!/usr/bin/env bash
set -euo pipefail

# Measure which printings a COMMUNITY-CDN art locale actually has art for, and
# write the result as an availability sidecar.
#
#     ./scripts/gen-derived-art-availability.sh                    # zhs, whole pool
#     ./scripts/gen-derived-art-availability.sh zhs _WHO           # zhs, one product
#     PHASE_AVAILABILITY_SCOPE=_WHO ./scripts/gen-derived-art-availability.sh
#
# ── Why this cannot be derived ──────────────────────────────────────────────
#
# The mapped locales (de/es/fr/it/ja/pt) get their sidecar by joining MTGJSON
# `foreignData` to Scryfall's bulk export: a localized printing is a real Scryfall
# object with its own id, so the relationship is data.
#
# A derived locale (zhs) has no such printing to point at. Its CDN localizes
# community art under the ENGLISH printing's id, so no Scryfall field records
# availability, and the split is arbitrary even inside one set — Doctor Who #318
# of a card has a Chinese image while #528, #909 and #1119 of the same card do
# not. Membership can only be measured, so it is measured here and shipped as a
# set the client consults when choosing which printing to render.
#
# ── Probing rules (both are load-bearing) ───────────────────────────────────
#
# GET, never HEAD: the CDN answers 404 to HEAD on an object that is not in its
# edge cache and 200 to GET on the same URL. A HEAD-based run reports ~0%
# coverage and looks like a working script.
#
# `Range: bytes=0-0` keeps each probe to one byte (206 when present, 404 when
# absent) instead of downloading every image in the pool.
#
# Prints are the only input, so a pool of N printings costs N tiny requests.
# Doctor Who's 1178 printings finish in well under a minute at this parallelism.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LANG_CODE="${1:-zhs}"
SCOPE="${2:-${PHASE_AVAILABILITY_SCOPE:-}}"
OUTPUT_DIR="${PHASE_AVAILABILITY_OUTPUT_DIR:-$REPO_ROOT/client/public}"
MTGJSON_SETS="${MTGJSON_SETS_DIR:-$REPO_ROOT/data/mtgjson/sets}"
SET_LIST="${MTGJSON_SET_LIST_FILE:-$REPO_ROOT/data/mtgjson/SetList.json}"
# CDN host and path prefix for the locale. `zhs` is 大学院废墟 (mtgch.com), the
# only community CDN wired up today; adding another means adding its shape here.
case "$LANG_CODE" in
  zhs) CDN_HOST="images.mtgch.com"; CDN_PREFIX="zhs" ;;
  *)
    echo "ERROR: no CDN shape known for derived locale '$LANG_CODE'." >&2
    echo "  Add its host and path prefix to the case statement above." >&2
    exit 2
    ;;
esac

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
echo "=== Derived art availability ($LANG_CODE${SCOPE:+ scope=$SCOPE}) ==="
IDS_FILE="$(mktemp)"
trap 'rm -f "$IDS_FILE"' EXIT

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
else
  # Every set file MTGJSON gave us. `paths` is deliberately not used here: the
  # pool is whatever has been downloaded, which is what the client will ship.
  for set_file in "$MTGJSON_SETS"/*.json; do
    jq -r '.data.cards[]? | select(.identifiers.scryfallId != null) | .identifiers.scryfallId' \
      "$set_file" 2>/dev/null || true
  done | sort -u > "$IDS_FILE"
fi

TOTAL=$(wc -l < "$IDS_FILE" | tr -d ' ')
if [ "$TOTAL" = 0 ]; then
  echo "ERROR: no printing ids collected. Is the MTGJSON cache populated?" >&2
  exit 1
fi
echo "Probing $TOTAL printings on $CDN_HOST/$CDN_PREFIX/ ..."

OUTPUT="$OUTPUT_DIR/scryfall-images.$LANG_CODE-available.json"
mkdir -p "$OUTPUT_DIR"

LANG_CODE="$LANG_CODE" CDN_HOST="$CDN_HOST" CDN_PREFIX="$CDN_PREFIX" \
  IDS_FILE="$IDS_FILE" OUTPUT="$OUTPUT" SCOPE="$SCOPE" \
  python3 "$SCRIPT_DIR/lib/probe-derived-art-availability.py"
