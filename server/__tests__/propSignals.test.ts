// v6.9.1 — BUG 2. The props board and parlay legs must carry the same five-source
// PickSignals as game lines. For a prop: market = implied prob of the posted
// price, model = the simulator's projected hit rate (model_prob, 0..1), prism =
// posted→closing odds velocity, sharp/predict = null (no prop feeds). This seeds a
// prop with a posted price, a model hit rate, and a closing price (so prism has a
// move), then mounts a copy of the /api/props/board mapping and asserts the
// signals object rides on the item with market/model/prism non-null in 0..1.
// Run: tsx server/__tests__/propSignals.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-prop-signals-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const { upsertPropPick, propBoard, gradedDb } = await import("../gradedBook");
const { assemblePropSignals } = await import("../sports/signals/assembleSignals");

const TODAY = new Date().toISOString().slice(0, 10);

upsertPropPick({
  pick_id: "sig1",
  sport: "mlb",
  game_id: "evtSig",
  player_name: "Aaron Judge",
  market_type: "batter_hits",
  line: 1.5,
  side: "over",
  posted_odds: 120,        // +120 ≈ 45.5% implied
  best_price: 125,
  model_prob: 0.54,        // simulator hit rate, already 0..1
  edge_pp: 8.5,
});
// closing_odds is written at grading, not by upsert — set it directly so prism
// has a posted(+120)→close(+105) move (market crept toward our side).
gradedDb().prepare("UPDATE prop_picks SET closing_odds = 105 WHERE pick_id = 'sig1'").run();

// Mirror of routes.ts propSignalsFor + the /api/props/board item mapping.
function propSignalsFor(row: ReturnType<typeof propBoard>[number]) {
  const side = row.side === "over" || row.side === "under" ? row.side : null;
  return assemblePropSignals({
    side,
    modelProb: row.model_prob,
    edgePp: row.edge_pp,
    postedOdds: row.posted_odds,
    bestPrice: row.best_price,
    closingOdds: row.closing_odds,
  });
}

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log("v6.9.1 — prop signals (BUG 2)");

const row = propBoard({ sport: "mlb", date: TODAY }).find((r) => r.pick_id === "sig1")!;
const sig = propSignalsFor(row);

function inUnit(p: number | null): boolean {
  return p !== null && p > 0 && p < 1;
}

test("market is implied prob of the posted price (non-null, 0..1)", () => {
  assert.ok(sig.market, "market signal present");
  assert.ok(inUnit(sig.market!.prob), `market prob out of range: ${sig.market!.prob}`);
  // +120 → ~0.455
  assert.ok(Math.abs(sig.market!.prob! - 0.455) < 0.01, `got ${sig.market!.prob}`);
});

test("model is the simulator hit rate (non-null, 0..1, not 100x-shrunk)", () => {
  assert.ok(sig.model, "model signal present");
  assert.ok(inUnit(sig.model!.prob), `model prob out of range: ${sig.model!.prob}`);
  assert.equal(sig.model!.prob, 0.54);
  assert.equal(sig.model!.edgePp, 8.5);
});

test("prism is non-null with positive velocity (line moved toward our side)", () => {
  assert.ok(sig.prism, "prism signal present");
  assert.ok(inUnit(sig.prism!.prob), `prism prob out of range: ${sig.prism!.prob}`);
  // +120 (0.455) → +105 (0.488): market moved toward us → positive velocity.
  assert.ok(sig.prism!.edgePp! > 0, `expected positive prism velocity, got ${sig.prism!.edgePp}`);
});

test("sharp and predict are null for props (no prop feeds)", () => {
  assert.equal(sig.sharp, null);
  assert.equal(sig.predict, null);
});

test("model/market are the same magnitude (no double-percentage shrink)", () => {
  assert.ok(sig.model!.prob! > 0.1 && sig.market!.prob! > 0.1, JSON.stringify(sig));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
