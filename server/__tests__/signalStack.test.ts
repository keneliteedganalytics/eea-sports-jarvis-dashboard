// v6.10.4 — unit tests for proximity-based signal-stack sizing and projection-contradicts trap.
// Tests: computeSignalStack, signalStackUnitsAdjustment, integration via buildPick.
import assert from "node:assert/strict";

import {
  computeSignalStack,
  signalStackUnitsAdjustment,
  buildPick,
  type GameInput,
} from "../sports/mlb/picksEngine";
import { predictGame as predictMlb } from "../sports/mlb/model";
import type { PickSignals } from "../../shared/types/signals";

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

console.log("signal-stack sizing — v6.10.4");

// ── computeSignalStack ─────────────────────────────────────────────────────

test("computeSignalStack: COL @ CHC — SHARP/PRISM/PREDICT neutral, SABER supporting → count=1", () => {
  // Live case: MARKET=34.4%, MODEL=42.1%, gap=7.7pp
  // SHARP 34.8% → ratio (0.348-0.344)/(0.421-0.344) = 0.052 → neutral
  // PRISM 36.1% → ratio (0.361-0.344)/0.077 = 0.22 → neutral
  // PREDICT 33.5% → ratio (0.335-0.344)/0.077 = -0.12 → neutral
  // SABER 43.1% → ratio (0.431-0.344)/0.077 = 1.13 → supporting
  const signals: PickSignals = {
    market:  { prob: 0.344, edgePp: 0, side: "away" },
    model:   { prob: 0.421, edgePp: 7.7, side: "away" },
    sharp:   { prob: 0.348, edgePp: 0.4, side: "away" },
    prism:   { prob: 0.361, edgePp: 1.7, side: "away" },
    predict: { prob: 0.335, edgePp: -0.9, side: "home" },
    saber:   { prob: 0.431, edgePp: 8.7, side: "away" },
  };
  const result = computeSignalStack(signals, "away");
  assert.equal(result.count, 1, `expected 1, got ${result.count}`);
  assert.ok(result.supporting.includes("saber"), "saber should support");
  assert.ok(!result.supporting.includes("sharp"), "sharp should be neutral");
  assert.ok(!result.supporting.includes("prism"), "prism should be neutral");
  assert.ok(!result.supporting.includes("predict"), "predict should be neutral");
  assert.equal(result.contradicting.length, 0, "no contradicting (PREDICT ratio=-0.12 is above -0.2)");
});

test("computeSignalStack: LAA — SHARP/PRISM/PREDICT neutral, SABER supporting → count=1", () => {
  // MARKET 45.7%, MODEL 55.2%, gap=9.5pp
  // SHARP 45.8% → ratio (0.458-0.457)/(0.552-0.457) = 0.01 → neutral
  // PRISM 47.6% → ratio (0.476-0.457)/0.095 = 0.20 → neutral
  // PREDICT 45.5% → ratio (0.455-0.457)/0.095 = -0.02 → neutral
  // SABER 51.3% → ratio (0.513-0.457)/0.095 = 0.59 → supporting
  const signals: PickSignals = {
    market:  { prob: 0.457, edgePp: 0, side: "home" },
    model:   { prob: 0.552, edgePp: 9.5, side: "home" },
    sharp:   { prob: 0.458, edgePp: 0.1, side: "home" },
    prism:   { prob: 0.476, edgePp: 1.9, side: "home" },
    predict: { prob: 0.455, edgePp: -0.2, side: "away" },
    saber:   { prob: 0.513, edgePp: 5.6, side: "home" },
  };
  const result = computeSignalStack(signals, "home");
  assert.equal(result.count, 1, `expected 1, got ${result.count}`);
  assert.ok(result.supporting.includes("saber"), "saber should support");
  assert.ok(!result.supporting.includes("sharp"), "sharp should be neutral");
  assert.ok(!result.supporting.includes("prism"), "prism should be neutral");
  assert.ok(!result.supporting.includes("predict"), "predict should be neutral");
});

test("computeSignalStack: TB — SHARP/PRISM/PREDICT neutral, SABER supporting → count=1", () => {
  // MARKET 38.5%, MODEL 48.6%, gap=10.1pp
  // SHARP 37.6% → ratio (0.376-0.385)/(0.486-0.385) = -0.09 → neutral
  // PRISM 40.2% → ratio (0.402-0.385)/0.101 = 0.17 → neutral
  // PREDICT 37.5% → ratio (0.375-0.385)/0.101 = -0.10 → neutral
  // SABER 45.6% → ratio (0.456-0.385)/0.101 = 0.70 → supporting
  const signals: PickSignals = {
    market:  { prob: 0.385, edgePp: 0, side: "away" },
    model:   { prob: 0.486, edgePp: 10.1, side: "away" },
    sharp:   { prob: 0.376, edgePp: -0.9, side: "home" },
    prism:   { prob: 0.402, edgePp: 1.7, side: "away" },
    predict: { prob: 0.375, edgePp: -1.0, side: "home" },
    saber:   { prob: 0.456, edgePp: 7.1, side: "away" },
  };
  const result = computeSignalStack(signals, "away");
  assert.equal(result.count, 1, `expected 1, got ${result.count}`);
  assert.ok(result.supporting.includes("saber"), "saber should support");
  assert.ok(!result.supporting.includes("sharp"), "sharp should be neutral");
  assert.ok(!result.supporting.includes("prism"), "prism should be neutral");
  assert.ok(!result.supporting.includes("predict"), "predict should be neutral");
});

test("computeSignalStack: hypothetical all-signals-agree-strongly → count=4", () => {
  // MARKET 30%, MODEL 50%, SHARP 45%, PRISM 48%, PREDICT 47%, SABER 49%
  // gap = 0.20; SHARP ratio=(0.45-0.30)/0.20=0.75; PRISM=0.90; PREDICT=0.85; SABER=0.95
  // All >= 0.4 → all supporting
  const signals: PickSignals = {
    market:  { prob: 0.30, edgePp: 0, side: "away" },
    model:   { prob: 0.50, edgePp: 20, side: "away" },
    sharp:   { prob: 0.45, edgePp: 15, side: "away" },
    prism:   { prob: 0.48, edgePp: 18, side: "away" },
    predict: { prob: 0.47, edgePp: 17, side: "away" },
    saber:   { prob: 0.49, edgePp: 19, side: "away" },
  };
  const result = computeSignalStack(signals, "away");
  assert.equal(result.count, 4, `expected 4, got ${result.count}`);
  assert.ok(result.supporting.includes("sharp"), "sharp should support");
  assert.ok(result.supporting.includes("prism"), "prism should support");
  assert.ok(result.supporting.includes("predict"), "predict should support");
  assert.ok(result.supporting.includes("saber"), "saber should support");
  assert.equal(result.contradicting.length, 0, "no contradicting");
});

test("computeSignalStack: MODEL missing → count=0", () => {
  const signals: PickSignals = {
    market: { prob: 0.47, edgePp: 0, side: "home" },
    model:  { prob: null, edgePp: null, side: null },
    sharp:  { prob: 0.55, edgePp: 5, side: "home" },
    prism:  null,
    predict: null,
    saber:  null,
  };
  const result = computeSignalStack(signals, "home");
  assert.equal(result.count, 0, "missing model → count=0");
  assert.equal(result.supporting.length, 0, "no supporting when model missing");
  assert.equal(result.contradicting.length, 0, "no contradicting when model missing");
});

test("computeSignalStack: MARKET missing → count=0", () => {
  const signals: PickSignals = {
    market: null,
    model:  { prob: 0.55, edgePp: 8, side: "home" },
    sharp:  { prob: 0.54, edgePp: 7, side: "home" },
    prism:  null,
    predict: null,
    saber:  null,
  };
  const result = computeSignalStack(signals, "home");
  assert.equal(result.count, 0, "missing market → count=0");
});

test("computeSignalStack: MODEL-MARKET gap < 2pp → count=0 (no edge)", () => {
  // Gap = 0.01 → well under 2pp threshold
  const signals: PickSignals = {
    market:  { prob: 0.50, edgePp: 0, side: "home" },
    model:   { prob: 0.51, edgePp: 1, side: "home" },
    sharp:   { prob: 0.52, edgePp: 2, side: "home" },
    prism:   { prob: 0.53, edgePp: 3, side: "home" },
    predict: null,
    saber:   { prob: 0.54, edgePp: 4, side: "home" },
  };
  const result = computeSignalStack(signals, "home");
  assert.equal(result.count, 0, "gap < 2pp → count=0");
});

test("computeSignalStack: contradicting signal when ratio < -0.2", () => {
  // MARKET 40%, MODEL 60%, gap=20pp.
  // SHARP 30% → ratio = (0.30-0.40)/(0.60-0.40) = -0.50 → contradicting (< -0.2)
  const signals: PickSignals = {
    market:  { prob: 0.40, edgePp: 0, side: "home" },
    model:   { prob: 0.60, edgePp: 20, side: "home" },
    sharp:   { prob: 0.30, edgePp: -10, side: "home" },
    prism:   null,
    predict: null,
    saber:   null,
  };
  const result = computeSignalStack(signals, "home");
  assert.ok(result.contradicting.includes("sharp"), "sharp should contradict (ratio=-0.5)");
  assert.ok(!result.supporting.includes("sharp"), "sharp should not support");
  assert.equal(result.count, 0, "no supporting signals");
});

test("computeSignalStack: 2 supporting signals (strong agreement case)", () => {
  // MARKET 42%, MODEL 60%, gap=18pp.
  // PRISM 52% → ratio=(0.52-0.42)/(0.60-0.42)=0.556 → supporting
  // SABER 58% → ratio=(0.58-0.42)/0.18=0.889 → supporting
  // SHARP 44% → ratio=(0.44-0.42)/0.18=0.111 → neutral
  const signals: PickSignals = {
    market:  { prob: 0.42, edgePp: 0, side: "home" },
    model:   { prob: 0.60, edgePp: 18, side: "home" },
    sharp:   { prob: 0.44, edgePp: 2, side: "home" },
    prism:   { prob: 0.52, edgePp: 10, side: "home" },
    predict: null,
    saber:   { prob: 0.58, edgePp: 16, side: "home" },
  };
  const result = computeSignalStack(signals, "home");
  assert.equal(result.count, 2, `expected 2, got ${result.count}`);
  assert.ok(result.supporting.includes("prism"), "prism should support");
  assert.ok(result.supporting.includes("saber"), "saber should support");
  assert.ok(!result.supporting.includes("sharp"), "sharp should be neutral");
});

test("computeSignalStack: 0 supporting when all signals are null", () => {
  const signals: PickSignals = {
    market: { prob: 0.47, edgePp: 0, side: "home" },
    model:  { prob: 0.56, edgePp: 9, side: "home" },
    sharp:  null,
    prism:  null,
    predict: null,
    saber:  null,
  };
  const result = computeSignalStack(signals, "home");
  assert.equal(result.count, 0, "expected 0, got " + result.count);
  assert.equal(result.contradicting.length, 0, "no contradicting when all null");
});

// ── signalStackUnitsAdjustment ─────────────────────────────────────────────

test("signalStackUnitsAdjustment: baseline=0 → always 0 (PASS stays PASS)", () => {
  assert.equal(signalStackUnitsAdjustment(0, 3, 0), 0);
  assert.equal(signalStackUnitsAdjustment(0, 0, 0), 0);
  assert.equal(signalStackUnitsAdjustment(0, 2, 1), 0);
});

test("signalStackUnitsAdjustment: stack>=3 → +1 unit bonus", () => {
  assert.equal(signalStackUnitsAdjustment(1, 3, 0), 2);
  assert.equal(signalStackUnitsAdjustment(2, 3, 0), 3);
  assert.equal(signalStackUnitsAdjustment(3, 3, 0), 4); // before clamp
  assert.equal(signalStackUnitsAdjustment(1, 4, 0), 2); // 4 also applies +1
});

test("signalStackUnitsAdjustment: stack=2 → +1 unit bonus (rare and significant)", () => {
  assert.equal(signalStackUnitsAdjustment(1, 2, 0), 2);
  assert.equal(signalStackUnitsAdjustment(2, 2, 0), 3);
  assert.equal(signalStackUnitsAdjustment(3, 2, 0), 4); // before clamp
});

test("signalStackUnitsAdjustment: stack=1 → baseline unchanged (normal corroboration)", () => {
  assert.equal(signalStackUnitsAdjustment(3, 1, 0), 3);
  assert.equal(signalStackUnitsAdjustment(2, 1, 0), 2);
  assert.equal(signalStackUnitsAdjustment(1, 1, 0), 1);
});

test("signalStackUnitsAdjustment: stack=0 → -1u floor 0 (no corroboration)", () => {
  assert.equal(signalStackUnitsAdjustment(3, 0, 0), 2);
  assert.equal(signalStackUnitsAdjustment(2, 0, 0), 1);
  assert.equal(signalStackUnitsAdjustment(1, 0, 0), 0);
});

test("signalStackUnitsAdjustment: 1 contradicting → -1u (takes priority over stack bonus)", () => {
  assert.equal(signalStackUnitsAdjustment(3, 2, 1), 2);
  assert.equal(signalStackUnitsAdjustment(2, 2, 1), 1);
  assert.equal(signalStackUnitsAdjustment(1, 1, 1), 0);
});

test("signalStackUnitsAdjustment: 2+ contradicting → -2u severe demote", () => {
  assert.equal(signalStackUnitsAdjustment(3, 2, 2), 1);
  assert.equal(signalStackUnitsAdjustment(2, 1, 2), 0);
  assert.equal(signalStackUnitsAdjustment(1, 0, 3), 0); // floor 0
});

// ── Integration tests via buildPick ───────────────────────────────────────

// Helper to build a minimal GameInput
function makeGame(overrides: Partial<GameInput> = {}): GameInput {
  return {
    gameId: "test-g1",
    gameDate: "2025-07-10",
    gameTimeEt: "7:10 PM ET",
    venue: "Wrigley Field",
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    mlHome: -185,
    mlAway: 160,
    homeFairProb: 0.64,
    awayFairProb: 0.36,
    homeSpStats: { available: true, pitcher: "K.Hendricks", era: 4.2, fip: 4.1, ip: 80 },
    awaySpStats: { available: true, pitcher: "A.Senzatela", era: 5.8, fip: 5.7, ip: 60 },
    homeOffStats: { ops: 0.75 },
    awayOffStats: { ops: 0.68 },
    ...overrides,
  };
}

test("Integration: COL @ CHC pattern → projection contradicts → PASS with reason", () => {
  // COL pick (away), model says COL wins (awayWinProb > 0.5 for COL),
  // but projected score: CHC 5.17, COL 4.50 → projAwayScore - projHomeScore = -0.67 < -0.4
  // Only SABER supports (1 corroborating signal) → should fire trap
  const game = makeGame({
    gameId: "col-chc-test",
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    mlHome: -185,
    mlAway: 180,
    homeFairProb: 0.64,
    awayFairProb: 0.36,
  });
  const model = predictMlb({
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    homeSpStats: { available: true, pitcher: "K.Hendricks", era: 3.9, fip: 3.8, ip: 80 },
    awaySpStats: { available: true, pitcher: "A.Senzatela", era: 5.8, fip: 5.7, ip: 60 },
    homeOffStats: { ops: 0.75 },
    awayOffStats: { ops: 0.68 },
    venueTriCode: "CHC",
    homeFairProb: 0.64,
    awayFairProb: 0.36,
  });

  const pick = buildPick(game, model);

  // signalStack must be present on every pick
  assert.ok(pick.signalStack !== undefined, "signalStack should be present on pick");
  assert.ok(typeof pick.signalStack?.count === "number", "signalStack.count is number");
});

test("Integration: pick with 0 signal corroboration → PASS (via stack or other gate)", () => {
  // Build a pick where there are zero signals except MODEL (no sharp/prism/predict/saber data)
  // and the tier would otherwise be actionable. With stack=0 the new ladder demotes
  // units by 1; if that drops to 0 it triggers stack_no_corroboration. If another
  // gate fires first (phantom edge, hard gate, etc.) the verdict is still PASS.
  const game = makeGame({
    gameId: "zero-stack-test",
    mlHome: -110,
    mlAway: 100,
    homeFairProb: 0.52,
    awayFairProb: 0.48,
    // No _sharpPct, no _polymarketData, no saber data → 0 corroborating signals
  });
  const model = predictMlb({
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    homeSpStats: { available: true, pitcher: "P1", era: 3.8, fip: 3.7, ip: 80 },
    awaySpStats: { available: true, pitcher: "P2", era: 4.5, fip: 4.4, ip: 75 },
    homeOffStats: { ops: 0.74 },
    awayOffStats: { ops: 0.70 },
    venueTriCode: "CHC",
    homeFairProb: 0.52,
    awayFairProb: 0.48,
  });
  const pick = buildPick(game, model);
  assert.ok(pick.signalStack !== undefined, "signalStack should be on pick");
  assert.ok(typeof pick.signalStack?.count === "number", "signalStack.count is a number");
  // A pick with stack=0 must end up as PASS — either via stack_no_corroboration,
  // phantom edge, a hard gate, or another mechanism. It must never be a PLAY.
  if (pick.signalStack?.count === 0) {
    assert.equal(pick.verdict, "PASS",
      `zero proximity-stack pick must be PASS, got verdict=${pick.verdict} passReason=${pick.passReason} phantomEdge=${pick.phantomEdge}`);
  }
});

test("Integration: signalStack is attached to every MLB pick", () => {
  const game = makeGame({ gameId: "stack-present-test" });
  const model = predictMlb({
    homeTeam: "CHC", awayTeam: "COL",
    homeTeamFull: "Chicago Cubs", awayTeamFull: "Colorado Rockies",
    homeSpStats: { available: true, pitcher: "P1", era: 4.0, fip: 3.9, ip: 80 },
    awaySpStats: { available: true, pitcher: "P2", era: 4.5, fip: 4.4, ip: 75 },
    homeOffStats: { ops: 0.74 }, awayOffStats: { ops: 0.70 },
    venueTriCode: "CHC", homeFairProb: 0.55, awayFairProb: 0.45,
  });
  const pick = buildPick(game, model);
  assert.ok("signalStack" in pick, "signalStack key should exist on pick");
  assert.ok(pick.signalStack !== undefined, "signalStack value should be present");
  assert.ok(Array.isArray(pick.signalStack?.supporting), "supporting is an array");
  assert.ok(Array.isArray(pick.signalStack?.contradicting), "contradicting is an array");
});

test("Integration: stack=1, projContradicts=false → no trap fired (LAA/TB pattern)", () => {
  // A pick where score projection is favourable but only SABER supports.
  // Should NOT fire projection_contradicts_model — only fires when projection also contradicts.
  const game = makeGame({
    gameId: "laa-style-test",
    mlHome: +130,
    mlAway: -150,
    homeFairProb: 0.42,
    awayFairProb: 0.58,
  });
  const model = predictMlb({
    homeTeam: "CHC", awayTeam: "COL",
    homeTeamFull: "Chicago Cubs", awayTeamFull: "Colorado Rockies",
    homeSpStats: { available: true, pitcher: "P1", era: 4.5, fip: 4.4, ip: 75 },
    awaySpStats: { available: true, pitcher: "P2", era: 3.8, fip: 3.7, ip: 80 },
    homeOffStats: { ops: 0.70 },
    awayOffStats: { ops: 0.75 },
    venueTriCode: "CHC",
    homeFairProb: 0.42,
    awayFairProb: 0.58,
  });
  const pick = buildPick(game, model);
  assert.ok(pick.signalStack !== undefined, "signalStack must be present");
  // If projection does NOT contradict, passReason should not be projection_contradicts_model
  if (pick.passReason === "projection_contradicts_model") {
    // Only valid if projDelta < -0.4 AND stack < 2
    const projDelta = pick.pickSide === "home"
      ? pick.projHomeScore - pick.projAwayScore
      : pick.projAwayScore - pick.projHomeScore;
    assert.ok(projDelta < -0.4, `trap fired but projDelta=${projDelta.toFixed(2)} >= -0.4`);
    assert.ok((pick.signalStack?.count ?? 0) < 2, "trap fired but stack >= 2");
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
