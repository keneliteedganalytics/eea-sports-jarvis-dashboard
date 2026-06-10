// Regression for the v6.7.3 model-outlier sanity gate. A double-digit-plus edge
// whose simulated median sits far from the line (> 0.5σ) is almost always a
// thin-sample artifact, not a real edge — the builder must PASS it and record a
// `model_outlier` audit row (queryable: SELECT * FROM pick_audit WHERE reason=
// 'model_outlier'). We seed an offer whose mispriced under (against a strong
// hitter) produces a phantom edge, run the REAL simulate/edge chain, and assert
// the pick is filtered AND audited. Run: tsx server/__tests__/propModelOutlier.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-prop-outlier-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

import type { BuildDeps } from "../sports/props/buildPropPicks";
import type { BatterProfile, BatterGameLog } from "../sports/props/mlbStatsProps";

const { upsertPropOffer, gradedDb } = await import("../gradedBook");
const { buildMlbPropPicks } = await import("../sports/props/buildPropPicks");

const DATE = "2026-06-10";

// An extreme contact hitter: ~3 hits/game with a season anchor far above any
// posted line, so the simulated median sits many σ above a 0.5 line — but the
// book prices the over LONG (+250), inflating the over edge into outlier range.
function batterLog(over: Partial<BatterGameLog> = {}): BatterGameLog {
  return {
    date: "2026-06-01", pa: 5, ab: 5, hits: 3, totalBases: 6, homeRuns: 1,
    runs: 2, rbi: 3, walks: 1, singles: 1, oppPitcherHand: "R", home: true, ...over,
  };
}
function monster(id: number): BatterProfile {
  return {
    available: true, playerId: id, name: "Phantom Slugger",
    logs: Array.from({ length: 20 }, () => batterLog()),
    seasonPa: 600,
    seasonRates: {
      hitsPerPa: 0.6, tbPerPa: 1.2, hrPerPa: 0.2, runsPerPa: 0.4,
      rbiPerPa: 0.6, walksPerPa: 0.2, singlesPerPa: 0.3,
    },
  };
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log("model-outlier sanity gate");

await test("a phantom-edge over is PASSed and audited as model_outlier", async () => {
  // Over priced at +250 against a hitter who clears 0.5 hits ~always: the model
  // prob ≈ 1, so edgePp is huge (> 20) and the median sits far from the line.
  upsertPropOffer({
    event_id: "evtX", sport: "mlb", game_date: DATE, player_name: "Phantom Slugger",
    market: "batter_hits", line: 0.5, over_price: 250, under_price: -400, book: "draftkings",
  });

  const deps: BuildDeps = {
    resolveId: async () => 700001,
    persistId: () => undefined,
    batterProfile: async (playerId) => monster((playerId as number) ?? 700001),
    pitcherProfile: async () => ({ available: false, playerId: null, name: "", logs: [], starts: 0, seasonRates: null }),
    schedule: async () => [],
  };

  const summary = await buildMlbPropPicks(DATE, deps);
  assert.equal(summary.written, 0, `outlier should be filtered, got ${summary.written} written`);

  // Post v6.7.6 the sim-guard clamps a monster's hits/PA into a sane band, so the
  // median/σ test of the edge>20 gate may not trip; the tighter v676 divergence
  // gate then catches the same phantom edge. Either flavor is a model-outlier PASS.
  const audits = gradedDb()
    .prepare("SELECT * FROM pick_audit WHERE reason IN ('model_outlier', 'model_outlier_v676')")
    .all() as Array<{ reason: string }>;
  assert.ok(audits.length >= 1, "expected a model-outlier audit row (model_outlier or model_outlier_v676)");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
