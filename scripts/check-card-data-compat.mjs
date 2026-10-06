#!/usr/bin/env node
// Card-data / engine-WASM compatibility gate.
//
// Answers the ONE question that decides whether `./scripts/build-wasm.sh` (a
// ~20-minute rebuild) has to run: can the engine currently compiled into
// `client/src/wasm/` parse the card data currently on disk?
//
// The card database is loaded at RUNTIME, but the engine that parses it is
// compiled INTO the WASM. So a parser change ships a mismatch only when it
// changes a SERIALIZED shape that reaches `card-data.json` — a new `Effect`,
// `TargetFilter`, `FilterProp`, `ContinuousModification`, `Keyword`, … variant.
// A change that only alters parser LOGIC (which variant gets chosen for a given
// sentence), or only the runtime that executes an already-parsed ability, leaves
// the shape untouched and needs no rebuild at all.
//
// Usage (after regenerating card data, BEFORE deciding on a rebuild):
//
//   node scripts/check-card-data-compat.mjs
//   node scripts/check-card-data-compat.mjs --card "The Eleventh Doctor"
//
// Exit 0 = the built engine parses this card data; no rebuild needed.
// Exit 1 = it does not; rebuild the WASM (`./scripts/build-wasm.sh`).
//
// With `--card`, every `supported` flag in that card's parse tree is printed,
// which is the check that matters when the goal is "make card X supported" —
// and the one a substring search for "Unimplemented" gets WRONG, because the
// coverage tree renders an unimplemented clause under its own label
// (`parser-warning-patterns.json` / the `Unimplemented { name }` payload), not
// under the literal word.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmDir = resolve(repoRoot, "client/src/wasm");
const wasmPath = resolve(wasmDir, "engine_wasm_bg.wasm");
const dataPath = resolve(repoRoot, "client/public/card-data.json");

for (const [label, path] of [
  ["engine WASM", wasmPath],
  ["card data", dataPath],
]) {
  if (!existsSync(path)) {
    console.error(`missing ${label}: ${path}`);
    console.error("build it first (./scripts/build-wasm.sh / ./scripts/gen-card-data.sh)");
    process.exit(2);
  }
}

const wasm = await import(`${wasmDir}/engine_wasm.js`);
await wasm.default({
  module_or_path: await WebAssembly.compile(await readFile(wasmPath)),
});

let count;
try {
  count = wasm.load_card_database(await readFile(dataPath, "utf8"));
} catch (error) {
  console.error("INCOMPATIBLE — the built engine cannot parse this card data.");
  console.error(String(error));
  console.error("\nRebuild the engine WASM: ./scripts/build-wasm.sh");
  process.exit(1);
}

console.log(`COMPATIBLE — the built engine loaded ${count} cards from card-data.json.`);
console.log("No WASM rebuild needed for this card-data revision.");

const cardFlag = process.argv.indexOf("--card");
if (cardFlag === -1) process.exit(0);
const cardName = process.argv[cardFlag + 1];
if (!cardName) {
  console.error("--card needs a card name");
  process.exit(2);
}

const tree = wasm.get_card_parse_details(cardName);
if (tree === null || tree === undefined) {
  console.error(`\n"${cardName}" is not in the card database.`);
  process.exit(1);
}

let unsupported = 0;
const walk = (items, depth) => {
  for (const item of items ?? []) {
    const ok = item.supported === true;
    if (!ok) unsupported += 1;
    console.log(`${"  ".repeat(depth)}[${ok ? "ok  " : "FAIL"}] ${item.category} :: ${JSON.stringify(item.label)}`);
    if (!ok) console.log(`${"  ".repeat(depth)}        source: ${JSON.stringify(item.source_text)}`);
    if (item.children?.length) walk(item.children, depth + 1);
  }
};

console.log(`\n${cardName} — parse tree support flags:`);
walk(tree, 0);
console.log(
  unsupported === 0
    ? `\n${cardName}: every node supported.`
    : `\n${cardName}: ${unsupported} unsupported node(s).`,
);
process.exit(unsupported === 0 ? 0 : 1);
