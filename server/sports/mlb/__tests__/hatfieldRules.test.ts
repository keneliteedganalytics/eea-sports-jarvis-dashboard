// Unit + integration tests for the v6.13.0 Hatfield Statcast + spot rules.
// Covers all 8 rules' pure functions plus model-pipeline integration and the
// regression-safety guarantee: with Statcast/series inputs absent, predictGame
// reproduces the prior (v6.12.x) numeric output exactly.
//
// Rule 2 coefficients (v6.13.1): score = 50 + 200*(xBA-.240) + 10*(barrel-7.0)
// + 2.5*(sweetSpot-33.3). The barrel coefficient is 10 (corrected from 5 in
// v6.13.0): that reconciles the spec's worked examples — Rodon-ish
// (.224, 5.8%, 32%) → 31.55 → ELITE (-0.15) and Gray-ish (.300, 11%, 36.5%) →
// 110 → WEAK (+0.15).
// Run: tsx server/sports/mlb/__tests__/hatfieldRules.test.ts

import assert from "node:assert/strict";
import {
  computeFadeFlag,
  computeContactQualityScore,
  computeBaseTrafficTilt,
  computeSweepSpot,
  computePriceCap,
  computeTrendConfirm,
  computeLineupHealth,
  assembleSpotProfile,
  type StarterStatcast,
  type SeriesContext,
} from "../hatfieldRules";
import { predictGame, type ModelContext } from "../model";

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
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("Hatfield Statcast + spot rules (v6.13.0)");

// ── Rule 1: ERA vs xERA fade ─────────────────────────────────────────────
test("Rule 1: ERA 2.50, xERA 3.80 → fadeFlag true, +0.20, gap -1.30", () => {
  const r = computeFadeFlag(2.5, 3.8);
  assert.equal(r.fadeFlag, true);
  assert.ok(near(r.runsAdj, 0.2));
  assert.ok(near(r.eraXeraGap as number, -1.3));
});
test("Rule 1: gap exactly -1.00 → fade fires (inclusive)", () => {
  const r = computeFadeFlag(3.0, 4.0);
  assert.equal(r.fadeFlag, true);
  assert.ok(near(r.runsAdj, 0.2));
});
test("Rule 1: gap -0.99 → no fade", () => {
  const r = computeFadeFlag(3.01, 4.0);
  assert.equal(r.fadeFlag, false);
  assert.equal(r.runsAdj, 0);
});
test("Rule 1: ERA above xERA (underperforming) → no fade", () => {
  const r = computeFadeFlag(4.5, 3.5);
  assert.equal(r.fadeFlag, false);
  assert.equal(r.runsAdj, 0);
  assert.ok(near(r.eraXeraGap as number, 1.0));
});
test("Rule 1: missing era/xera → no-op, gap null", () => {
  assert.deepEqual(computeFadeFlag(null, 3.8), { fadeFlag: false, runsAdj: 0, eraXeraGap: null });
  assert.deepEqual(computeFadeFlag(2.5, null), { fadeFlag: false, runsAdj: 0, eraXeraGap: null });
  assert.deepEqual(computeFadeFlag(undefined, undefined), { fadeFlag: false, runsAdj: 0, eraXeraGap: null });
});

// ── Rule 2: contact-quality composite ────────────────────────────────────
test("Rule 2: Gray (.300, 11%, 36.5%) → score 110, weak band, +0.15", () => {
  const r = computeContactQualityScore(0.3, 11, 36.5);
  assert.ok(near(r.score, 110));
  assert.equal(r.band, "weak");
  assert.ok(near(r.runsAdj, 0.15));
});
test("Rule 2: Rodon (.224, 5.8%, 32%) → score 31.55, elite band, -0.15", () => {
  const r = computeContactQualityScore(0.224, 5.8, 32);
  assert.ok(near(r.score, 31.55, 1e-6));
  assert.equal(r.band, "elite");
  assert.ok(near(r.runsAdj, -0.15));
});
test("Rule 2: clearly elite suppressor (.200, 4%, 28%) → score < 35, -0.15", () => {
  const r = computeContactQualityScore(0.2, 4, 28);
  assert.ok(r.score < 35);
  assert.equal(r.band, "elite");
  assert.ok(near(r.runsAdj, -0.15));
});
test("Rule 2: all fields null → league-average → score exactly 50, neutral, 0", () => {
  const r = computeContactQualityScore(null, null, null);
  assert.ok(near(r.score, 50));
  assert.equal(r.band, "neutral");
  assert.equal(r.runsAdj, 0);
});
test("Rule 2: missing fields fall back to league average individually", () => {
  // only xBA present at league avg → still 50
  const r = computeContactQualityScore(0.24, null, null);
  assert.ok(near(r.score, 50));
});
test("Rule 2: band boundaries — 35 and 65 are neutral (inclusive)", () => {
  // Construct via xBA only: score = 50 + 200*(xba-0.240).
  // xba = 0.165 → 50 + 200*(-0.075) = 35 → neutral.
  const at35 = computeContactQualityScore(0.165, null, null);
  assert.ok(near(at35.score, 35));
  assert.equal(at35.band, "neutral");
  // xba = 0.315 → 50 + 200*(0.075) = 65 → neutral.
  const at65 = computeContactQualityScore(0.315, null, null);
  assert.ok(near(at65.score, 65));
  assert.equal(at65.band, "neutral");
});

// ── Rule 3: walk-rate base-traffic Over tilt ─────────────────────────────
test("Rule 3: one SP bbPct 12.7% → tilt true, runsEnv += 0.25", () => {
  const r = computeBaseTrafficTilt(12.7, 5.0);
  assert.equal(r.tilt, true);
  assert.ok(near(r.runsEnvAdj, 0.25));
});
test("Rule 3: both SP bbPct >= 10 → runsEnv += 0.50", () => {
  const r = computeBaseTrafficTilt(12.0, 11.0);
  assert.equal(r.tilt, true);
  assert.ok(near(r.runsEnvAdj, 0.5));
});
test("Rule 3: bbPct exactly 10.0 → fires (inclusive)", () => {
  const r = computeBaseTrafficTilt(10.0, 5.0);
  assert.equal(r.tilt, true);
  assert.ok(near(r.runsEnvAdj, 0.25));
});
test("Rule 3: both below 10 → no tilt", () => {
  const r = computeBaseTrafficTilt(8.0, 9.9);
  assert.equal(r.tilt, false);
  assert.equal(r.runsEnvAdj, 0);
});
test("Rule 3: null bbPct counts as below threshold", () => {
  assert.deepEqual(computeBaseTrafficTilt(null, null), { tilt: false, runsEnvAdj: 0 });
  assert.deepEqual(computeBaseTrafficTilt(null, 11), { tilt: true, runsEnvAdj: 0.25 });
});

// ── Rule 4: division sweep-avoidance spot ────────────────────────────────
const sweepBase: SeriesContext = {
  sameDivision: true,
  seriesLength: 3,
  gameNumberInSeries: 3,
  trailingTeamLostFirstTwo: true,
  trailingTeamPositiveRunDiff: true,
  trailingSide: "away",
};
test("Rule 4: AL East rivals, game 3, 0-2, +run-diff → spot true, +0.025 to trailing side", () => {
  const r = computeSweepSpot(sweepBase);
  assert.equal(r.sweepAvoidanceSpot, true);
  assert.ok(near(r.winProbAdj, 0.025));
  assert.equal(r.side, "away");
});
test("Rule 4: 4-game series game 3 also qualifies", () => {
  const r = computeSweepSpot({ ...sweepBase, seriesLength: 4 });
  assert.equal(r.sweepAvoidanceSpot, true);
});
test("Rule 4: not yet game 3 → no spot", () => {
  assert.equal(computeSweepSpot({ ...sweepBase, gameNumberInSeries: 2 }).sweepAvoidanceSpot, false);
});
test("Rule 4: not same division → no spot", () => {
  assert.equal(computeSweepSpot({ ...sweepBase, sameDivision: false }).sweepAvoidanceSpot, false);
});
test("Rule 4: trailing team didn't lose first two → no spot", () => {
  assert.equal(computeSweepSpot({ ...sweepBase, trailingTeamLostFirstTwo: false }).sweepAvoidanceSpot, false);
});
test("Rule 4: trailing team negative run diff → no spot", () => {
  assert.equal(computeSweepSpot({ ...sweepBase, trailingTeamPositiveRunDiff: false }).sweepAvoidanceSpot, false);
});
test("Rule 4: null context → no-op", () => {
  assert.deepEqual(computeSweepSpot(null), { sweepAvoidanceSpot: false, winProbAdj: 0, side: null });
});

// ── Rule 5: price-cap discipline ─────────────────────────────────────────
test("Rule 5: -135 EDGE → side cap true", () => {
  assert.equal(computePriceCap("EDGE", -135, null, null).side, true);
});
test("Rule 5: -135 SNIPER → side cap false (SNIPER exempt, keeps -250 cap)", () => {
  assert.equal(computePriceCap("SNIPER", -135, null, null).side, false);
});
test("Rule 5: -130 EDGE → false (boundary, not strictly shorter than -130)", () => {
  assert.equal(computePriceCap("EDGE", -130, null, null).side, false);
});
test("Rule 5: -125 EDGE → false", () => {
  assert.equal(computePriceCap("EDGE", -125, null, null).side, false);
});
test("Rule 5: +200 RECON → false (plus money never capped)", () => {
  assert.equal(computePriceCap("RECON", 200, null, null).side, false);
});
test("Rule 5: total Over 8.5 opened 7.5 → total cap true", () => {
  assert.equal(computePriceCap("EDGE", null, 8.5, 7.5).total, true);
});
test("Rule 5: total 8.5 opened 8 → total cap true", () => {
  assert.equal(computePriceCap("EDGE", null, 8.5, 8).total, true);
});
test("Rule 5: total 8.5 opened 8.5 → false (didn't move through window)", () => {
  assert.equal(computePriceCap("EDGE", null, 8.5, 8.5).total, false);
});
test("Rule 5: total 8.0 opened 7.5 → false (below 8.5)", () => {
  assert.equal(computePriceCap("EDGE", null, 8.0, 7.5).total, false);
});
test("Rule 5: nulls → both false", () => {
  assert.deepEqual(computePriceCap(null, null, null, null), { side: false, total: false });
});

// ── Rule 6: recent away trend (telemetry) ────────────────────────────────
test("Rule 6: away pick + last18AwayWinPct 0.60 → trendConfirm true (inclusive)", () => {
  assert.equal(computeTrendConfirm(true, { awayWinPct: 0.6, homeWinPct: 0.4 }).trendConfirm, true);
});
test("Rule 6: away pick + 0.55 → false", () => {
  assert.equal(computeTrendConfirm(true, { awayWinPct: 0.55, homeWinPct: 0.5 }).trendConfirm, false);
});
test("Rule 6: home pick never confirms (away-trend only)", () => {
  assert.equal(computeTrendConfirm(false, { awayWinPct: 0.9, homeWinPct: 0.9 }).trendConfirm, false);
});
test("Rule 6: null record → false", () => {
  assert.equal(computeTrendConfirm(true, null).trendConfirm, false);
});

// ── Rule 7: lineup-health flag ───────────────────────────────────────────
test("Rule 7: injuryWOBAOut 0.010 → healthy", () => {
  assert.equal(computeLineupHealth(0.01).lineupHealthy, true);
});
test("Rule 7: injuryWOBAOut 0.020 → NOT healthy (boundary, not < 0.020)", () => {
  assert.equal(computeLineupHealth(0.02).lineupHealthy, false);
});
test("Rule 7: injuryWOBAOut 0.025 → not healthy", () => {
  assert.equal(computeLineupHealth(0.025).lineupHealthy, false);
});
test("Rule 7: null injury data → healthy (no-op default)", () => {
  assert.equal(computeLineupHealth(null).lineupHealthy, true);
});

// ── Rule 8: composite profile assembly ───────────────────────────────────
test("Rule 8: assembleSpotProfile wires all sub-results + raw statcast", () => {
  const statcast: StarterStatcast = {
    era: 2.5, xera: 3.8, xbaAllowed: 0.3, barrelRatePct: 11, sweetSpotPct: 36.5, bbPct: 12.7,
  };
  const profile = assembleSpotProfile({
    fade: { fadeFlag: true, eraXeraGap: -1.3 },
    contact: { score: 90 },
    statcast,
    baseTraffic: { tilt: true },
    sweep: { sweepAvoidanceSpot: true },
    priceCap: { side: true, total: false },
    trend: { trendConfirm: true },
    lineup: { lineupHealthy: false },
  });
  assert.equal(profile.fadeFlag, true);
  assert.ok(near(profile.eraXeraGap as number, -1.3));
  assert.ok(near(profile.contactQualityScore, 90));
  assert.ok(near(profile.xBAAllowed as number, 0.3));
  assert.ok(near(profile.barrelRatePct as number, 11));
  assert.ok(near(profile.launchAngleSweetSpotPct as number, 36.5));
  assert.equal(profile.baseTrafficOverTilt, true);
  assert.equal(profile.sweepAvoidanceSpot, true);
  assert.deepEqual(profile.priceCap, { side: true, total: false });
  assert.equal(profile.trendConfirm, true);
  assert.equal(profile.lineupHealthy, false);
});
test("Rule 8: null statcast → raw fields null, profile still assembles", () => {
  const profile = assembleSpotProfile({
    fade: { fadeFlag: false, eraXeraGap: null },
    contact: { score: 50 },
    statcast: null,
    baseTraffic: { tilt: false },
    sweep: { sweepAvoidanceSpot: false },
    priceCap: { side: false, total: false },
    trend: { trendConfirm: false },
    lineup: { lineupHealthy: true },
  });
  assert.equal(profile.xBAAllowed, null);
  assert.equal(profile.barrelRatePct, null);
  assert.equal(profile.launchAngleSweetSpotPct, null);
  assert.equal(profile.lineupHealthy, true);
});

// ── Model pipeline integration ───────────────────────────────────────────
function baseCtx(): ModelContext {
  return {
    homeTeam: "CHC",
    awayTeam: "COL",
    homeTeamFull: "Chicago Cubs",
    awayTeamFull: "Colorado Rockies",
    homeSpStats: { available: true, pitcher: "P1", era: 4.0, fip: 3.9, ip: 80 } as any,
    awaySpStats: { available: true, pitcher: "P2", era: 4.5, fip: 4.4, ip: 75 } as any,
    homeOffStats: { available: true, ops: 0.74, rpg: 4.6 } as any,
    awayOffStats: { available: true, ops: 0.7, rpg: 4.3 } as any,
    venueTriCode: "CHC",
    homeFairProb: 0.55,
    awayFairProb: 0.45,
  };
}
const NULL_STATCAST: StarterStatcast = {
  era: null, xera: null, xbaAllowed: null, barrelRatePct: null, sweetSpotPct: null, bbPct: null,
};

test("REGRESSION: Statcast/series absent → identical output to the bare context", () => {
  const baseline = predictGame(baseCtx());
  const withNullInputs = predictGame({
    ...baseCtx(),
    homeSpStatcast: { ...NULL_STATCAST },
    awaySpStatcast: { ...NULL_STATCAST },
    seriesContext: null,
  });
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  for (const k of [
    "projHomeScore", "projAwayScore", "expectedTotalRuns",
    "homeWinProb", "awayWinProb", "homeWinProbFormula", "homeWinProbRaw",
  ] as const) {
    assert.ok(
      near(r6(baseline[k] as number), r6(withNullInputs[k] as number)),
      `${k}: ${baseline[k]} vs ${withNullInputs[k]}`,
    );
  }
  // And the new flag outputs are the regression-safe defaults.
  assert.equal(withNullInputs.homeFadeFlag, false);
  assert.equal(withNullInputs.awayFadeFlag, false);
  assert.ok(near(withNullInputs.homeContactQualityScore, 50));
  assert.ok(near(withNullInputs.awayContactQualityScore, 50));
  assert.equal(withNullInputs.baseTrafficOverTilt, false);
  assert.equal(withNullInputs.sweepAvoidanceSpot, false);
});

test("INTEGRATION Rule 1: away SP overperforming xERA → home runs +0.20", () => {
  const baseline = predictGame(baseCtx());
  const fade = predictGame({
    ...baseCtx(),
    awaySpStatcast: { ...NULL_STATCAST, era: 2.5, xera: 3.8 },
  });
  assert.equal(fade.awayFadeFlag, true);
  assert.ok(near(fade.projHomeScore - baseline.projHomeScore, 0.2, 1e-6),
    `home runs delta ${fade.projHomeScore - baseline.projHomeScore}`);
});

test("INTEGRATION Rule 3: both SP high walk → expected total +0.50", () => {
  const baseline = predictGame(baseCtx());
  const tilt = predictGame({
    ...baseCtx(),
    homeSpStatcast: { ...NULL_STATCAST, bbPct: 12.0 },
    awaySpStatcast: { ...NULL_STATCAST, bbPct: 11.0 },
  });
  assert.equal(tilt.baseTrafficOverTilt, true);
  assert.ok(near(tilt.expectedTotalRuns - baseline.expectedTotalRuns, 0.5, 1e-6),
    `total delta ${tilt.expectedTotalRuns - baseline.expectedTotalRuns}`);
});

test("INTEGRATION Rule 4: home is trailing team → homeWinProb +0.025", () => {
  const baseline = predictGame(baseCtx());
  const spot = predictGame({
    ...baseCtx(),
    seriesContext: {
      sameDivision: true,
      seriesLength: 3,
      gameNumberInSeries: 3,
      trailingTeamLostFirstTwo: true,
      trailingTeamPositiveRunDiff: true,
      trailingSide: "home",
    },
  });
  assert.equal(spot.sweepAvoidanceSpot, true);
  assert.ok(near(spot.homeWinProb - baseline.homeWinProb, 0.025, 1e-6),
    `homeWinProb delta ${spot.homeWinProb - baseline.homeWinProb}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
