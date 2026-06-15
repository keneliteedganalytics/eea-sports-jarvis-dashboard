// Integration tests for v6.10 sabermetric adjustments in the MLB model.
// Tests that predictGame handles saber context correctly (additive adjustments,
// null fallbacks, sensible clamping).
// Run: tsx server/__tests__/saberModelIntegration.test.ts

import assert from "node:assert/strict";
import { predictGame, type ModelContext } from "../sports/mlb/model";
import type { PitcherSabermetrics } from "../sports/mlb/pitcherSabermetrics";
import type { TeamOffenseSaber } from "../sports/mlb/teamOffenseSaber";
import type { HandednessSplit } from "../sports/mlb/handednessSplits";

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

console.log("saberModelIntegration — v6.10");

// ── Fixture: minimal model context with solid starters ────────────────────────
const SOLID_HOME_SP = {
  available: true, pitcher: "Home Ace", pitcherId: 1, ip: 100, gs: 16,
  era: 3.50, fip: 3.40, whip: 1.10, classification: "SOLID" as const,
  hardPassReason: null,
};
const SOLID_AWAY_SP = {
  available: true, pitcher: "Away Ace", pitcherId: 2, ip: 95, gs: 15,
  era: 4.20, fip: 4.10, whip: 1.30, classification: "SOLID" as const,
  hardPassReason: null,
};
const HOME_OFF = { available: true, team: "TST", rpg: 4.5, ops: 0.735 };
const AWAY_OFF = { available: true, team: "OPP", rpg: 4.3, ops: 0.720 };

function baseCtx(overrides: Partial<ModelContext> = {}): ModelContext {
  return {
    homeTeam: "TST",
    awayTeam: "OPP",
    homeTeamFull: "Test Team",
    awayTeamFull: "Opponent Team",
    homeSpStats: SOLID_HOME_SP,
    awaySpStats: SOLID_AWAY_SP,
    homeOffStats: HOME_OFF,
    awayOffStats: AWAY_OFF,
    homeFairProb: 0.52,
    awayFairProb: 0.48,
    venueTriCode: "TST",
    ...overrides,
  };
}

function makePitcherSaber(overrides: Partial<PitcherSabermetrics> = {}): PitcherSabermetrics {
  // Default xFIP close to home SP FIP (3.40) so that no xFIP adjustment fires
  // unless the test explicitly sets a divergent xFIP.
  return {
    playerId: 999, season: 2026,
    whip: 1.20, kBBPct: 0.15, xFIP: 3.45, // within 0.30 of FIP=3.40
    xFIPProxy: false, source: "mlb_stats", staleness: "fresh",
    ...overrides,
  };
}

function makeOffSaber(wRCplus: number | null = 100, overrides: Partial<TeamOffenseSaber> = {}): TeamOffenseSaber {
  return {
    teamId: 888, triCode: "TST", season: 2026,
    wOBA: 0.318, iso: 0.165, wRCplus,
    staleness: "fresh", ...overrides,
  };
}

function makeHandedness(vsLHPwOBA: number | null, vsRHPwOBA: number | null): HandednessSplit {
  return {
    teamId: 888, triCode: "TST",
    vsLHP: { wOBA: vsLHPwOBA, ops: null, kPct: null },
    vsRHP: { wOBA: vsRHPwOBA, ops: null, kPct: null },
    staleness: "fresh",
  };
}

// ── Null context → no saber adjustment (backward-compatible) ─────────────────
test("null saber context: predictGame produces sensible result (no change)", () => {
  const base = predictGame(baseCtx());
  const withNull = predictGame(baseCtx({
    homePitcherSaber: null,
    awayPitcherSaber: null,
    homeOffenseSaber: null,
    awayOffenseSaber: null,
    homeHandedness: null,
    awayHandedness: null,
  }));
  // projectedScores should be equal since null context = no adjustment
  assert.equal(withNull.projHomeScore, base.projHomeScore);
  assert.equal(withNull.projAwayScore, base.projAwayScore);
});

// ── xFIP adjustment ──────────────────────────────────────────────────────────
test("high away xFIP (bad pitcher) increases home team expected runs", () => {
  const base = predictGame(baseCtx());
  const withBadAwaySP = predictGame(baseCtx({
    awayPitcherSaber: makePitcherSaber({ xFIP: 6.00 }), // xFIP much higher than FIP 4.10
  }));
  assert.ok(withBadAwaySP.projHomeScore > base.projHomeScore,
    `Bad away SP should increase home runs: ${withBadAwaySP.projHomeScore} vs ${base.projHomeScore}`);
});

test("low away xFIP (elite pitcher) decreases home team expected runs", () => {
  const base = predictGame(baseCtx());
  const withEliteAwaySP = predictGame(baseCtx({
    awayPitcherSaber: makePitcherSaber({ xFIP: 2.80 }), // much lower than FIP 4.10
  }));
  assert.ok(withEliteAwaySP.projHomeScore < base.projHomeScore,
    `Elite away SP should decrease home runs: ${withEliteAwaySP.projHomeScore} vs ${base.projHomeScore}`);
});

test("xFIP within 0.30 of existing proxy: no adjustment applied", () => {
  const base = predictGame(baseCtx());
  // Home SP FIP=3.40, so xFIP=3.45 (delta=0.05) → no adjustment
  const ctx = baseCtx({ homePitcherSaber: makePitcherSaber({ xFIP: 3.45 }) });
  const result = predictGame(ctx);
  assert.equal(result.projAwayScore, base.projAwayScore);
});

// ── K-BB% adjustment ─────────────────────────────────────────────────────────
test("K-BB% > 18pp: dominant home pitcher reduces away team runs", () => {
  const base = predictGame(baseCtx());
  const ctx = baseCtx({ homePitcherSaber: makePitcherSaber({ kBBPct: 0.22 }) });
  const result = predictGame(ctx);
  assert.ok(result.projAwayScore < base.projAwayScore,
    `Dominant home SP: away runs should decrease`);
});

test("K-BB% < 8pp: weak home pitcher increases away team runs", () => {
  const base = predictGame(baseCtx());
  const ctx = baseCtx({ homePitcherSaber: makePitcherSaber({ kBBPct: 0.05 }) });
  const result = predictGame(ctx);
  assert.ok(result.projAwayScore > base.projAwayScore,
    `Weak home SP: away runs should increase`);
});

test("K-BB% between 8pp and 18pp: no adjustment applied", () => {
  const base = predictGame(baseCtx());
  const ctx = baseCtx({ homePitcherSaber: makePitcherSaber({ kBBPct: 0.13 }) });
  const result = predictGame(ctx);
  // No K-BB% adjustment for mid-range values (floating-point aware)
  assert.ok(Math.abs(result.projAwayScore - base.projAwayScore) < 0.02, 
    `Expected no change: ${result.projAwayScore} vs ${base.projAwayScore}`);
});

// ── WHIP adjustment ──────────────────────────────────────────────────────────
test("WHIP > 1.40: +0.10 run penalty for opponent", () => {
  const base = predictGame(baseCtx());
  const ctx = baseCtx({ homePitcherSaber: makePitcherSaber({ whip: 1.50 }) });
  const result = predictGame(ctx);
  // Score before adjustment + 0.10, rounded to 2 decimals
  assert.ok(result.projAwayScore > base.projAwayScore,
    `WHIP>1.40 should increase away runs: ${result.projAwayScore} vs ${base.projAwayScore}`);
  assert.ok(Math.abs(result.projAwayScore - base.projAwayScore - 0.10) < 0.02,
    `WHIP penalty: ${result.projAwayScore} should be ≈ ${base.projAwayScore + 0.10}`);
});

test("WHIP ≤ 1.40: no run penalty", () => {
  const base = predictGame(baseCtx());
  const ctx = baseCtx({ homePitcherSaber: makePitcherSaber({ whip: 1.40 }) });
  const result = predictGame(ctx);
  // default makePitcherSaber has whip=1.20 so WHIP=1.40 still = no penalty
  assert.ok(Math.abs(result.projAwayScore - base.projAwayScore) < 0.02,
    `WHIP=1.40 should not penalise: ${result.projAwayScore} vs ${base.projAwayScore}`);
});

// ── wRC+ adjustment ──────────────────────────────────────────────────────────
test("wRC+ 110 home team: +0.20 expected home runs vs league avg", () => {
  const base = predictGame(baseCtx());
  const ctx = baseCtx({ homeOffenseSaber: makeOffSaber(110) });
  const result = predictGame(ctx);
  assert.ok(Math.abs(result.projHomeScore - (base.projHomeScore + 0.20)) < 0.01,
    `wRC+110 run adj: ${result.projHomeScore} vs ${base.projHomeScore + 0.20}`);
});

test("wRC+ 90 away team: -0.20 expected away runs vs league avg", () => {
  const base = predictGame(baseCtx());
  const ctx = baseCtx({ awayOffenseSaber: makeOffSaber(90) });
  const result = predictGame(ctx);
  assert.ok(Math.abs(result.projAwayScore - (base.projAwayScore - 0.20)) < 0.01,
    `wRC+90 run adj: ${result.projAwayScore} vs ${base.projAwayScore - 0.20}`);
});

test("wRC+ 100 (league avg): no run adjustment", () => {
  const base = predictGame(baseCtx());
  const ctx = baseCtx({ homeOffenseSaber: makeOffSaber(100) });
  const result = predictGame(ctx);
  assert.equal(result.projHomeScore, base.projHomeScore);
});

test("null wRCplus → no run adjustment", () => {
  const base = predictGame(baseCtx());
  const ctx = baseCtx({ homeOffenseSaber: makeOffSaber(null) });
  const result = predictGame(ctx);
  assert.equal(result.projHomeScore, base.projHomeScore);
});

// ── ModelResult saber fields ──────────────────────────────────────────────────
test("ModelResult: homeXFIP and awayXFIP populated from context", () => {
  const ctx = baseCtx({
    homePitcherSaber: makePitcherSaber({ xFIP: 3.50 }),
    awayPitcherSaber: makePitcherSaber({ xFIP: 4.20 }),
  });
  const result = predictGame(ctx);
  assert.equal(result.homeXFIP, 3.50);
  assert.equal(result.awayXFIP, 4.20);
});

test("ModelResult: null saber context → null saber output fields", () => {
  const result = predictGame(baseCtx());
  assert.equal(result.homeXFIP, null);
  assert.equal(result.awayXFIP, null);
  assert.equal(result.homeWHIP, null);
  assert.equal(result.homeKBBPct, null);
  assert.equal(result.homeWRCplus, null);
  assert.equal(result.homeHandednessAdj, null);
});

test("ModelResult: homeWRCplus populated from context", () => {
  const ctx = baseCtx({ homeOffenseSaber: makeOffSaber(115) });
  const result = predictGame(ctx);
  assert.equal(result.homeWRCplus, 115);
  assert.equal(result.awayWRCplus, null);
});

// ── Staleness propagation ─────────────────────────────────────────────────────
test("staleness missing → no adjustment, result is still sensible", () => {
  const ctx = baseCtx({
    homePitcherSaber: { playerId: 1, season: 2026, whip: null, kBBPct: null, xFIP: null, xFIPProxy: false, source: "mlb_stats", staleness: "missing" },
  });
  const result = predictGame(ctx);
  assert.ok(result.canModel, "should still model");
  assert.equal(result.homeXFIP, null);
});

// ── Existing behavior: no regression ─────────────────────────────────────────
test("existing model output still valid when saber context absent", () => {
  const result = predictGame(baseCtx());
  assert.ok(result.canModel, "model should run");
  assert.ok(result.projHomeScore >= 2.0, "home score floor");
  assert.ok(result.projAwayScore >= 2.0, "away score floor");
  assert.ok(result.homeWinProb > 0 && result.homeWinProb < 1, "home prob in (0,1)");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
