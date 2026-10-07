#!/usr/bin/env node
// Generate the Simplified-Chinese card-content sidecar (`card-data.zhs.json`)
// from the 大学院废墟 (HeliumOctahelide/magic-cards-zhs) weekly data export.
//
// WHY THIS EXISTS: Scryfall publishes no Simplified-Chinese printings at all, so
// `oracle_gen`'s MTGJSON `foreignData` sweep — the source of every other
// `card-data.<lng>.json` — can never produce `zhs`. This script fills that one
// locale from the community dataset instead.
//
// It is deliberately a STANDALONE script rather than part of `oracle-gen`:
// `card-data.json` already carries `scryfall_oracle_id` for every face, so the
// join needs no engine code, and running it costs seconds instead of a
// `tool`-profile engine rebuild.
//
// The sidecar also carries card RULINGS. The engine serves those from MTGJSON in
// English and exposes no id for them, so they are joined by NORMALIZED English
// text rather than by key — see `normalizeForMatch`.
//
// Usage:
//   node scripts/gen-zhs-card-text.mjs                    # pinned release
//   node scripts/gen-zhs-card-text.mjs --release data-2026-10-04
//   node scripts/gen-zhs-card-text.mjs --all-stages       # include stage 0
//   node scripts/gen-zhs-card-text.mjs --skip-rulings     # text fields only
//   node scripts/gen-zhs-card-text.mjs --dry-run          # report, write nothing
//
// Output: client/public/card-data.zhs.json
//   { "<lowercased english name>": { name, oracle_text, type_line } }
//   — the exact shape `oracle-gen` writes for de/es/fr/it/ja/pt, and the shape
//   `ensureCardLocale` (client/src/services/engineRuntime.ts) consumes.

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i === argv.length - 1 ? fallback : argv[i + 1];
};

const release = option("release", "data-2026-10-04");
const dryRun = flag("dry-run");
const allStages = flag("all-stages");
const skipRulings = flag("skip-rulings");
const sourceDir = resolve(repoRoot, option("source-dir", ".zhs-cache"));
const outPath = resolve(repoRoot, "client/public/card-data.zhs.json");
const releaseDir = join(sourceDir, release);
const oraclePath = join(releaseDir, "zhs_oracle.json");
const rulingPath = join(releaseDir, "zhs_ruling.json");

const TARBALL = `magic-cards-zhs-${release}.tar.gz`;
const URL = `https://github.com/HeliumOctahelide/magic-cards-zhs/releases/download/${release}/${TARBALL}`;

// The dataset's quality tier. `text_stage` 5 is the MTGZH/MTGso bulk, 9 is the
// official tier, and 0 is untranslated/unsourced (3,192 records). Dropping 0 is
// the difference between "we ship translations" and "we ship whatever was in the
// field that day", so it is the default; `--all-stages` opts back in.
const MIN_STAGE = allStages ? 0 : 5;

/** Un-escape the dataset's one systematic malformation.
 *
 * 2,351 of 39,959 lines escape a literal double quote TWICE (`\\"`), which is
 * not a legal JSON escape, so `JSON.parse` rejects the whole line. Replacing the
 * two-character sequence `\"` → `"` repairs every affected line (measured: 39,959
 * / 39,959 parse afterwards) and is a no-op on every other line.
 *
 * Applied to the RAW line BEFORE parsing, because the damage is inside the JSON
 * string syntax — repairing after parse is impossible.
 */
const repairLine = (line) => line.replaceAll('\\\\"', '\\"');

/** Substitute the dataset's one unexpanded template token: `CARDNAME`.
 *
 * Some records are machine-derived from Forge card scripts and still carry
 * Forge's `CARDNAME` placeholder instead of the card's name (measured: 73
 * occurrences across 52 of the 358 pool records — 14.5%). Left as-is it renders
 * literally in the card text.
 *
 * Replaced with the record's own localized name, because the token stands for
 * the card's name AS PRINTED and the surrounding text is localized. Falling back
 * to the English key keeps a nameless record readable rather than printing the
 * token. No other template token exists in the dataset (measured: zero
 * occurrences of any other all-caps placeholder). */
const expandCardName = (text, localizedName, englishName) =>
  typeof text === "string"
    ? text.replaceAll("CARDNAME", localizedName || englishName)
    : text ?? undefined;

/** Normalize the dataset's newline encoding to real line breaks.
 *
 * Every multi-line record escapes its line breaks TWICE — the parsed value
 * carries the three characters `\`, `\`, `n` (measured: 22,195 records with that
 * shape, 0 with a real newline, 14,735 single-line records with neither). The
 * engine's Oracle parser is line-oriented, so a card handed `\\n` instead of a
 * break would be parsed as one long line.
 *
 * The match is therefore the TWO backslashes plus `n`, replaced by one newline.
 * Matching only `\n` (one backslash) is the subtle wrong answer: it consumes the
 * pair and leaves the second backslash behind, yielding `\` + newline.
 *
 * A single-line record is unaffected, and an Oracle text has no legitimate
 * `\\n`, so this cannot damage a value that was already correct. */
const unescapeNewlines = (text) =>
  typeof text === "string" ? text.replaceAll("\\\\n", "\n") : text ?? undefined;

/** Fold the punctuation differences between the two sources.
 *
 * The engine's English ruling text comes from MTGJSON and the dataset's from
 * Scryfall, and they disagree on typography — curly vs straight quotes, em dash
 * vs `--`, the ellipsis character vs three dots — plus incidental whitespace.
 * Matching raw text finds 89% of rulings; folding those classes first finds 99%
 * (measured over the full 79,668-ruling WHO pool: 71,694 exact, +7,486 folded).
 *
 * Applied to BOTH sides, and the sidecar is keyed by the folded form so the
 * lookup at runtime is a single call rather than a scan. Folding cannot merge two
 * distinct rulings: it only rewrites punctuation that carries no meaning here.
 */
function normalizeForMatch(text) {
  return String(text ?? "")
    .replaceAll("\u2019", "'")
    .replaceAll("\u2018", "'")
    .replaceAll("\u201c", '"')
    .replaceAll("\u201d", '"')
    .replaceAll("\u2014", "--")
    .replaceAll("\u2013", "-")
    .replaceAll("\u2026", "...")
    .trim()
    .split(/\s+/)
    .join(" ");
}

/** Pick the best of the several records that share one `oracle_id`.
 *
 * The dataset is per-PRINTING (39,959 records over 38,932 oracle ids) while the
 * sidecar is per-CARD-NAME, so a deterministic reduction is required. Order:
 * higher `text_stage` wins, then the later `released_at` (a reprint's text is
 * the more likely current Oracle wording), then `collector_number` so the result
 * never depends on file order. */
function betterRecord(a, b) {
  const stage = (r) => r.text_stage ?? -1;
  if (stage(a) !== stage(b)) return stage(a) > stage(b) ? a : b;
  const rel = (r) => r.released_at ?? "";
  if (rel(a) !== rel(b)) return rel(a) > rel(b) ? a : b;
  return (a.collector_number ?? "") <= (b.collector_number ?? "") ? a : b;
}

async function ensureSource() {
  if (existsSync(oraclePath)) {
    console.log(`source: reusing ${oraclePath}`);
    return;
  }
  if (dryRun) {
    throw new Error(
      `--dry-run needs an extracted ${oraclePath}; fetch it first with\n` +
        `  node scripts/gen-zhs-card-text.mjs --release ${release}`,
    );
  }
  console.log(`source: downloading ${TARBALL} (~74 MB) ...`);
  await mkdir(releaseDir, { recursive: true });
  const response = await fetch(URL);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} for ${URL}`);
  }
  const tarball = join(sourceDir, TARBALL);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tarball));

  // Extract only the one member we need — `scryfall_card.json` alone is 247 MB.
  console.log("source: extracting zhs_oracle.json ...");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("tar", ["xzf", tarball, "-C", releaseDir, "zhs_oracle.json"]);
  await rm(tarball, { force: true });
  console.log(`source: extracted to ${oraclePath}`);
}

/** Lowercased English name -> oracle id, for the faces the card pool contains. */
async function loadPool() {
  const raw = await readFile(resolve(repoRoot, "client/public/card-data.json"), "utf8");
  const pool = JSON.parse(raw);
  const byOracle = new Map();
  let multiFace = 0;
  for (const [name, face] of Object.entries(pool)) {
    const oracleId = face.scryfall_oracle_id;
    if (!oracleId) continue;
    // Single-faced only, mirroring `oracle_gen::collect_localized`: MTGJSON and
    // this dataset both expose multi-face cards as one combined "A // B" record,
    // and writing that under a single face's key would put a wrong value where
    // the English fallback belongs.
    if (name.includes("//")) {
      multiFace += 1;
      continue;
    }
    byOracle.set(oracleId, name);
  }
  console.log(`pool: ${Object.keys(pool).length} faces, ${byOracle.size} usable keys (${multiFace} multi-face skipped)`);
  return byOracle;
}

/** Every face the sidecar should carry an entry for: `name -> english ruling
 *  texts`. Read from `card-data.json` because the engine's rulings live there and
 *  only there — and because a card can have rulings without having a Chinese
 *  Oracle record, which is the majority of them. */
async function loadPoolRulings() {
  const raw = await readFile(resolve(repoRoot, "client/public/card-data.json"), "utf8");
  const pool = JSON.parse(raw);
  const byName = new Map();
  for (const [name, face] of Object.entries(pool)) {
    if (name.includes("//")) continue;
    const rulings = (face.rulings ?? [])
      .map((ruling) => (ruling?.text ?? "").trim())
      .filter(Boolean);
    byName.set(name, rulings);
  }
  return byName;
}

/** English ruling text (normalized) -> Chinese, from the dataset's ruling export.
 *
 * Keyed by `normalizeForMatch(comment)` because that is exactly what the runtime
 * lookup can compute: the engine exposes a ruling as `{date, text}` with no id, so
 * the ONLY join available is the English sentence itself.
 *
 * Optional file: a card-text-only run logs and continues rather than failing, so
 * the text half of this sidecar never depends on a second download.
 */
async function loadRulingTranslations() {
  if (skipRulings) return null;
  if (!existsSync(rulingPath)) {
    console.log(`rulings: ${rulingPath} not present — writing text fields only`);
    console.log("  fetch zhs_ruling.json from the same release to include rulings.");
    return null;
  }
  const translations = new Map();
  const stats = { lines: 0, malformed: 0, belowStage: 0, noTranslation: 0 };
  const rl = createInterface({
    input: (await import("node:fs")).createReadStream(rulingPath),
    crlfDelay: Infinity,
  });
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    stats.lines += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stats.malformed += 1;
      try {
        record = JSON.parse(repairLine(line));
      } catch {
        continue;
      }
    }
    const comment = (record.comment ?? "").trim();
    const translation = (record.translation ?? "").trim();
    if (!comment || !translation) {
      stats.noTranslation += 1;
      continue;
    }
    if ((record.stage ?? -1) < MIN_STAGE) {
      stats.belowStage += 1;
      continue;
    }
    translations.set(normalizeForMatch(comment), translation);
  }
  console.log(
    `rulings: ${translations.size} translations ` +
      `(${stats.lines} records, ${stats.malformed} malformed, ` +
      `${stats.belowStage} below stage ${MIN_STAGE}, ${stats.noTranslation} untranslated)`,
  );
  return translations;
}

async function main() {
  await ensureSource();
  const byOracle = await loadPool();

  const best = new Map();
  const stats = {
    lines: 0,
    malformed: 0,
    noChinese: 0,
    belowStage: 0,
    notInPool: 0,
  };

  const rl = createInterface({
    input: (await import("node:fs")).createReadStream(oraclePath),
    crlfDelay: Infinity,
  });
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    stats.lines += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stats.malformed += 1;
      try {
        record = JSON.parse(repairLine(line));
      } catch {
        continue; // unrepairable; counted and skipped rather than aborting
      }
    }
    const oracleId = record.oracle_id ?? record.face_oracle_id;
    const name = byOracle.get(oracleId);
    if (!name) {
      stats.notInPool += 1;
      continue;
    }
    if (!record.translated_name && !record.translated_text) {
      stats.noChinese += 1;
      continue;
    }
    if ((record.text_stage ?? -1) < MIN_STAGE) {
      stats.belowStage += 1;
      continue;
    }
    const previous = best.get(oracleId);
    best.set(oracleId, previous ? betterRecord(previous, record) : record);
  }

  const rulingTranslations = await loadRulingTranslations();

  // Built over the WHOLE pool rather than over `best` alone: the two datasets
  // cover different cards (text is per-Oracle-record, rulings are per-card), and
  // most cards with rulings have no Chinese Oracle record at all. Iterating only
  // the text winners would silently drop those rulings.
  const poolRulings = await loadPoolRulings();
  const localizedByOracle = new Map();
  for (const [oracleId, record] of best) localizedByOracle.set(byOracle.get(oracleId), record);

  const sidecar = {};
  let cardsWithText = 0;
  let cardsWithRulings = 0;
  let rulingsTotal = 0;
  for (const [englishName, rulings] of poolRulings) {
    const record = localizedByOracle.get(englishName);
    const localizedName = record?.translated_name ?? undefined;
    const entry = {};
    if (record) {
      cardsWithText += 1;
      entry.name = localizedName;
      entry.oracle_text = expandCardName(
        unescapeNewlines(record.translated_text),
        localizedName,
        englishName,
      );
      entry.type_line = record.translated_type ?? undefined;
    }
    if (rulingTranslations) {
      // Keyed by the NORMALIZED ENGLISH TEXT, not a positional array. The engine
      // returns its own ruling list and a translation can be missing for any one
      // of them, so an array would slide out of correspondence the moment a
      // ruling shifted or was untranslated — silently attaching the wrong Chinese
      // sentence to a ruling. Keyed, a runtime lookup either finds the sentence
      // that matches or falls back to English.
      const translated = {};
      for (const text of rulings) {
        const zh = rulingTranslations.get(normalizeForMatch(text));
        if (zh) {
          translated[normalizeForMatch(text)] = zh;
          rulingsTotal += 1;
        }
      }
      if (Object.keys(translated).length) {
        entry.rulings = translated;
        cardsWithRulings += 1;
      }
    }
    if (Object.keys(entry).length) sidecar[englishName] = entry;
  }

  const covered = Object.keys(sidecar).length;
  const poolSize = byOracle.size;
  console.log("");
  console.log(`dataset: ${stats.lines} lines, ${stats.malformed} malformed (repaired)`);
  console.log(`  skipped: ${stats.belowStage} below stage ${MIN_STAGE}, ` +
    `${stats.noChinese} without Chinese, ${stats.notInPool} not in this card pool`);
  if (rulingTranslations) {
    console.log(`  rulings: ${rulingsTotal} translations across ${cardsWithRulings} cards`);
    console.log(`  text:    ${cardsWithText} cards`);
  }
  console.log(`sidecar: ${covered} / ${poolSize} pool faces (${((covered / poolSize) * 100).toFixed(1)}%)`);

  if (dryRun) {
    console.log("--dry-run: nothing written");
    return;
  }
  await writeFile(outPath, JSON.stringify(sidecar));
  const { size } = await import("node:fs").then((fs) => fs.promises.stat(outPath));
  console.log(`wrote ${outPath} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(
    "attribution: card text from 大学院废墟 (HeliumOctahelide/magic-cards-zhs), CC-BY-SA-4.0",
  );
}

await main();
