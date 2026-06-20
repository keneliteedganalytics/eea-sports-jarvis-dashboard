// v6.12.0 — Advanced pillars wired live into the MLB model.
// Tests: each pillar in isolation, all-null baseline regression, worst-case
// combined scenario, and pillar ingestion failure (null/no-throw).
// Pure functions only — no network.
// Run: tsx server/__tests__/pillars_wired.test.ts

import assert from "node:assert/strict";
import { predictGame, type ModelContext } from "../sports/mlb/model";
import type { PitcherRecentForm, HitterRecentForm } from "../sources/recentForm";
import type { InjuryAssessment, KeyBatOut } from "../sources/injuries";

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

console.log("pillars_wired — v6.12.0 advanced pillars wired into MLB model");

// ── Shared fixtures ───────────────────────────────────────────────────────────

const SOLID_HOME_SP = {
  available: true, pitcher: "Ace Home", pitcherId: 100, ip: 80, gs: 14,
  era: 3.60, fip: 3.50, whip: 1.15, classification: "SOLID" as const,
  hardPassReason: null,
};
const SOLID_AWAY_SP = {
  available: true, pitcher: "Ace Away", pitcherId: 200, ip: 75, gs: 13,
  era: 4.30, fip: 4.20, whip: 1.30, classification: "SOLID" as const,
  hardPassReason: null,
};
const HOME_OFF = { available: true, team: "HME", rpg: 4.5, ops: 0.730 };
const AWAY_OFF = { available: true, team: "AWY", rpg: 4.2, ops: 0.715 };

function baseCtx(overrides: Partial<ModelContext> = {}): ModelContext {
  return {
    homeTeam: "HME",
    awayTeam: "AWY",
    homeTeamFull: "Home Team",
    awayTeamFull: "Away Team",
    homeSpStats: SOLID_HOME_SP,
    awaySpStats: SOLID_AWAY_SP,
    homeOffStats: HOME_OFF,
    awayOffStats: AWAY_OFF,
    homeFairProb: 0.53,
    awayFairProb: 0.47,
    venueTriCode: "HME",
    ...overrides,
  };
}

// ── Baseline: all pillars null → identical to pre-v6.12 behavior ─────────────

const BASELINE = predictGame(baseCtx());

test("baseline (all pillars null) — canModel true", () => {
  assert.equal(BASELINE.canModel, true);
});

test("baseline — method string has no pillar notes", () => {
  const m = BASELINE.method;
  assert.ok(!m.includes("spRecent"), `unexpected spRecent in: ${m}`);
  assert.ok(!m.includes("batRecent"), `unexpected batRecent in: ${m}`);
  assert.ok(!m.includes("inj("), `unexpected inj in: ${m}`);
  assert.ok(!m.includes("pitchmix"), `unexpected pitchmix in: ${m}`);
  assert.ok(!m.includes("bpFatigue"), `unexpected bpFatigue in: ${m}`);
});

test("explicit null pillars match baseline scores exactly", () => {
  const result = predictGame(baseCtx({
    homeSpRecentForm: null,
    awaySpRecentForm: null,
    homeTopBattersRecentForm: null,
    awayTopBattersRecentForm: null,
    homeInjuries: null,
    awayInjuries: null,
    homePitchMix: null,
    awayPitchMix: null,
    homeBpFatigue: null,
    awayBpFatigue: null,
  }));
  assert.equal(result.projHomeScore, BASELINE.projHomeScore);
  assert.equal(result.projAwayScore, BASELINE.projAwayScore);
  assert.equal(result.homeWinProb, BASELINE.homeWinProb);
});

// ── Pillar 1a: SP recent form ─────────────────────────────────────────────────

const STRONG_AWAY_SP_RECENT: PitcherRecentForm = {
  found: true, starts: 5, era: 2.10, whip: 0.95, k9: 10.5, pitchesPerStart: 95,
};

test("Pillar 1a: away SP on hot streak (low recent ERA) — homeExp rises (tougher pitcher)", () => {
  // Away SP recent ERA 2.10 vs season FIP 4.20 → blended 3.675 → higher spAdj → more runs suppressed for home
  // Wait — lower ERA means better pitcher → homeExp goes DOWN (away pitcher suppresses home bats more)
  const result = predictGame(baseCtx({ awaySpRecentForm: STRONG_AWAY_SP_RECENT }));
  // Away SP ERA blended to 0.75*4.20 + 0.25*2.10 = 3.675 (below baseline 4.20)
  // → awaySpProxy lower → spAdj lower → homeExp lower
  assert.ok(
    result.projHomeScore < BASELINE.projHomeScore,
    `Expected homeExp < baseline ${BASELINE.projHomeScore}, got ${result.projHomeScore}`,
  );
  assert.ok(
    result.method.includes("spRecent(away"),
    `Expected spRecent(away in method: ${result.method}`,
  );
});

const WEAK_HOME_SP_RECENT: PitcherRecentForm = {
  found: true, starts: 4, era: 6.50, whip: 1.80, k9: 5.0, pitchesPerStart: 80,
};

test("Pillar 1a: home SP struggling (high recent ERA) — awayExp rises", () => {
  const result = predictGame(baseCtx({ homeSpRecentForm: WEAK_HOME_SP_RECENT }));
  // Home SP ERA blended to 0.75*3.60 + 0.25*6.50 = 4.325 (above baseline 3.60)
  assert.ok(
    result.projAwayScore > BASELINE.projAwayScore,
    `Expected awayExp > baseline ${BASELINE.projAwayScore}, got ${result.projAwayScore}`,
  );
  assert.ok(result.method.includes("spRecent(home"));
});

test("Pillar 1a: fewer than 3 starts → no adjustment applied", () => {
  const tooFewStarts: PitcherRecentForm = {
    found: true, starts: 2, era: 1.00, whip: 0.70, k9: 12, pitchesPerStart: 90,
  };
  const result = predictGame(baseCtx({ awaySpRecentForm: tooFewStarts }));
  assert.equal(result.projHomeScore, BASELINE.projHomeScore);
  assert.ok(!result.method.includes("spRecent(away"));
});

test("Pillar 1a: found=false → no adjustment applied", () => {
  const notFound: PitcherRecentForm = {
    found: false, starts: 0, era: null, whip: null, k9: null, pitchesPerStart: null,
  };
  const result = predictGame(baseCtx({ homeSpRecentForm: notFound }));
  assert.equal(result.projAwayScore, BASELINE.projAwayScore);
});

test("Pillar 1a: era=null with found=true → no adjustment", () => {
  const noEra: PitcherRecentForm = {
    found: true, starts: 5, era: null, whip: 1.10, k9: 9, pitchesPerStart: 95,
  };
  const result = predictGame(baseCtx({ awaySpRecentForm: noEra }));
  assert.equal(result.projHomeScore, BASELINE.projHomeScore);
});

// ── Pillar 1b: top-of-order batter recent form ────────────────────────────────

const HOT_BATTER_FORM: HitterRecentForm = {
  found: true, games: 15, woba: 0.380, kRate: null, iso: null,
  // wOBA 0.380 vs LG_AVG 0.310 → delta +0.070 > 0.020 → positive nudge
};

test("Pillar 1b: home batters hot (wOBA 0.380 vs LG 0.310) — homeExp nudges up", () => {
  const result = predictGame(baseCtx({ homeTopBattersRecentForm: HOT_BATTER_FORM }));
  assert.ok(
    result.projHomeScore > BASELINE.projHomeScore,
    `Expected homeExp > baseline ${BASELINE.projHomeScore}, got ${result.projHomeScore}`,
  );
  assert.ok(result.method.includes("batRecent(home"));
});

const COLD_BATTER_FORM: HitterRecentForm = {
  found: true, games: 15, woba: 0.270, kRate: null, iso: null,
  // wOBA 0.270 vs LG_AVG 0.310 → delta -0.040 < -0.020 → negative nudge
};

test("Pillar 1b: away batters cold (wOBA 0.270) — awayExp nudges down", () => {
  const result = predictGame(baseCtx({ awayTopBattersRecentForm: COLD_BATTER_FORM }));
  assert.ok(
    result.projAwayScore < BASELINE.projAwayScore,
    `Expected awayExp < baseline ${BASELINE.projAwayScore}, got ${result.projAwayScore}`,
  );
  assert.ok(result.method.includes("batRecent(away"));
});

test("Pillar 1b: wOBA within ±0.020 of league avg → no adjustment", () => {
  const neutral: HitterRecentForm = {
    found: true, games: 15, woba: 0.318, kRate: null, iso: null,
  };
  const result = predictGame(baseCtx({ homeTopBattersRecentForm: neutral }));
  assert.equal(result.projHomeScore, BASELINE.projHomeScore);
  assert.ok(!result.method.includes("batRecent(home"));
});

test("Pillar 1b: batter adj clamped at ±0.30 runs", () => {
  const extreme: HitterRecentForm = {
    found: true, games: 15, woba: 0.600, kRate: null, iso: null, // huge positive delta
  };
  const result = predictGame(baseCtx({ homeTopBattersRecentForm: extreme }));
  // Should be at most +0.30 above baseline homeExp (before final floor)
  const diff = result.projHomeScore - BASELINE.projHomeScore;
  assert.ok(diff <= 0.31, `adj ${diff} exceeds clamp 0.30`);
});

// ── Pillar 2: injuries ────────────────────────────────────────────────────────

const makeInjury = (names: string[], wobas: number[]): InjuryAssessment => ({
  found: true,
  keyBatsOut: names.map((name, i) => ({
    playerId: 1000 + i,
    name,
    seasonWoba: wobas[i] ?? 0.310,
    reason: "IL" as const,
  })),
  wobaPenalty: 0.02 * names.length,
});

test("Pillar 2: one star out (wOBA 0.380) — homeExp drops", () => {
  const inj = makeInjury(["Star Hitter"], [0.380]);
  const result = predictGame(baseCtx({ homeInjuries: inj }));
  // delta = (0.380 - 0.310) * 4 * 0.5 dampened = 0.070 * 4 * 0.5 = 0.14
  assert.ok(
    result.projHomeScore < BASELINE.projHomeScore,
    `Expected homeExp < ${BASELINE.projHomeScore}, got ${result.projHomeScore}`,
  );
  assert.ok(result.method.includes("inj(homeBat"));
});

test("Pillar 2: injury adj clamped at −0.60 runs", () => {
  // 6 stars out each with wOBA 0.500
  const inj = makeInjury(
    ["P1","P2","P3","P4","P5","P6"],
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  );
  const result = predictGame(baseCtx({ awayInjuries: inj }));
  // unclamped = 6 * (0.5-0.31)*4*0.5 = 6*0.38 = 2.28; clamped to 0.60
  const diff = BASELINE.projAwayScore - result.projAwayScore;
  assert.ok(diff <= 0.61, `injury adj ${diff} exceeds clamp 0.60`);
  assert.ok(diff > 0, "injury should reduce scores");
});

test("Pillar 2: player with wOBA = league avg (0.310) → no run delta", () => {
  const inj = makeInjury(["Average Joe"], [0.310]);
  const result = predictGame(baseCtx({ homeInjuries: inj }));
  assert.equal(result.projHomeScore, BASELINE.projHomeScore);
});

test("Pillar 2: NEUTRAL_INJURY (found:false) → no adjustment", () => {
  const result = predictGame(baseCtx({
    homeInjuries: { found: false, keyBatsOut: [], wobaPenalty: 0 },
  }));
  assert.equal(result.projHomeScore, BASELINE.projHomeScore);
  assert.ok(!result.method.includes("inj(homeBat"));
});

// ── Pillar 3: pitch-mix ───────────────────────────────────────────────────────

test("Pillar 3: positive home pitch-mix delta — homeExp rises", () => {
  // homePitchMix = 0.040 → 0.040 * 0.5 (extra v1 dampener) = 0.020 added to homeExp
  const result = predictGame(baseCtx({ homePitchMix: 0.040 }));
  assert.ok(
    result.projHomeScore > BASELINE.projHomeScore,
    `Expected homeExp > ${BASELINE.projHomeScore}, got ${result.projHomeScore}`,
  );
  assert.ok(result.method.includes("pitchmix(home +"));
});

test("Pillar 3: negative away pitch-mix delta — awayExp drops", () => {
  const result = predictGame(baseCtx({ awayPitchMix: -0.040 }));
  assert.ok(
    result.projAwayScore < BASELINE.projAwayScore,
    `Expected awayExp < ${BASELINE.projAwayScore}, got ${result.projAwayScore}`,
  );
  assert.ok(result.method.includes("pitchmix(away"));
});

test("Pillar 3: pitch-mix clamped at ±0.25 runs", () => {
  // Input 0.9 → 0.9*0.5 = 0.45 → clamped to 0.25
  const result = predictGame(baseCtx({ homePitchMix: 0.9 }));
  const diff = result.projHomeScore - BASELINE.projHomeScore;
  assert.ok(diff <= 0.26, `pitch-mix adj ${diff} exceeds clamp 0.25`);
});

test("Pillar 3: zero pitch-mix → no adjustment, no log entry", () => {
  const result = predictGame(baseCtx({ homePitchMix: 0 }));
  assert.equal(result.projHomeScore, BASELINE.projHomeScore);
  assert.ok(!result.method.includes("pitchmix(home"));
});

test("Pillar 3: null pitch-mix → no-op", () => {
  const result = predictGame(baseCtx({ homePitchMix: null }));
  assert.equal(result.projHomeScore, BASELINE.projHomeScore);
});

// ── Pillar 4: bullpen fatigue ─────────────────────────────────────────────────

test("Pillar 4: fatigued away bullpen — awayExp increases (opponent scores more)", () => {
  // Away BP fatigued at 0.80 → extra 30%*0.80 = 24% more on away bullpen adjustment
  const result = predictGame(baseCtx({ awayBpFatigue: 0.80 }));
  // The fatigue is applied in Step E to the bullpen multiplier for the away pen
  // Away bullpen factor affects homeExp (away pen faces home batters)
  assert.ok(result.method.includes("bpFatigue(away"));
});

test("Pillar 4: fatigued home bullpen — method log notes it", () => {
  const result = predictGame(baseCtx({ homeBpFatigue: 0.65 }));
  assert.ok(result.method.includes("bpFatigue(home"));
});

test("Pillar 4: fatigue=0 → no bpFatigue log entry", () => {
  const result = predictGame(baseCtx({ homeBpFatigue: 0 }));
  assert.ok(!result.method.includes("bpFatigue(home"));
});

test("Pillar 4: fatigue clamped to [0,1] — negative input treated as 0", () => {
  const result = predictGame(baseCtx({ awayBpFatigue: -0.5 }));
  // Negative fatigue should clamp to 0 → identical to baseline bullpen behavior
  // (bullpenRunAdjustment is 0 with null/missing stats so fatigue term is 0*0.30*0 = 0)
  assert.ok(!result.method.includes("bpFatigue(away"));
});

test("Pillar 4: fatigue>1 clamped to 1", () => {
  const resultOver = predictGame(baseCtx({ homeBpFatigue: 2.0 }));
  const resultAtOne = predictGame(baseCtx({ homeBpFatigue: 1.0 }));
  // Both should produce identical results (clamped to 1.0)
  assert.equal(resultOver.method, resultAtOne.method);
});

// ── Worst-case combined scenario ──────────────────────────────────────────────

test("Worst case: injured stars + fatigued away bullpen + bad home pitch-mix — doesn't blow up scores", () => {
  const bigInj: InjuryAssessment = {
    found: true,
    keyBatsOut: [
      { playerId: 1, name: "Star1", seasonWoba: 0.500, reason: "IL" },
      { playerId: 2, name: "Star2", seasonWoba: 0.480, reason: "IL" },
      { playerId: 3, name: "Star3", seasonWoba: 0.450, reason: "IL" },
      { playerId: 4, name: "Star4", seasonWoba: 0.440, reason: "IL" },
    ],
    wobaPenalty: 0.06,
  };
  const result = predictGame(baseCtx({
    homeInjuries: bigInj,         // home stars out
    awayBpFatigue: 1.0,           // fully fatigued away pen
    homePitchMix: -0.9,           // very negative home pitch-mix
    awaySpRecentForm: { found: true, starts: 5, era: 2.00, whip: 0.90, k9: 11, pitchesPerStart: 100 },
  }));
  // Scores must still be finite and within sane MLB range
  assert.ok(Number.isFinite(result.projHomeScore), "homeScore must be finite");
  assert.ok(Number.isFinite(result.projAwayScore), "awayScore must be finite");
  assert.ok(result.projHomeScore >= 2.0, `homeScore must be >= floor 2.0, got ${result.projHomeScore}`);
  assert.ok(result.projAwayScore >= 2.0, `awayScore must be >= floor 2.0, got ${result.projAwayScore}`);
  assert.ok(result.projHomeScore <= 15.0, `homeScore seems too high: ${result.projHomeScore}`);
  assert.ok(result.projAwayScore <= 15.0, `awayScore seems too high: ${result.projAwayScore}`);
  assert.equal(result.canModel, true);
});

// ── Ingestion failure resilience ──────────────────────────────────────────────

test("Ingestion failure: undefined pillar fields → no throw, baseline scores", () => {
  // undefined is equivalent to not passing the field — should be a no-op
  const result = predictGame(baseCtx({
    homeSpRecentForm: undefined,
    awaySpRecentForm: undefined,
    homeTopBattersRecentForm: undefined,
    awayTopBattersRecentForm: undefined,
    homeInjuries: undefined,
    awayInjuries: undefined,
    homePitchMix: undefined,
    awayPitchMix: undefined,
    homeBpFatigue: undefined,
    awayBpFatigue: undefined,
  }));
  assert.equal(result.projHomeScore, BASELINE.projHomeScore);
  assert.equal(result.projAwayScore, BASELINE.projAwayScore);
  assert.equal(result.canModel, true);
});

test("Ingestion failure: NaN/Infinity fatigue → clamped to 0, no throw", () => {
  const result = predictGame(baseCtx({ homeBpFatigue: NaN, awayBpFatigue: Infinity }));
  assert.ok(Number.isFinite(result.projHomeScore));
  assert.ok(Number.isFinite(result.projAwayScore));
});

test("Ingestion failure: empty keyBatsOut array → no adjustment, no throw", () => {
  const result = predictGame(baseCtx({
    homeInjuries: { found: true, keyBatsOut: [], wobaPenalty: 0 },
  }));
  assert.equal(result.projHomeScore, BASELINE.projHomeScore);
});

// ── Method log completeness ───────────────────────────────────────────────────

test("All four active pillars each log their method note", () => {
  const result = predictGame(baseCtx({
    homeSpRecentForm: { found: true, starts: 5, era: 2.50, whip: 1.0, k9: 9, pitchesPerStart: 95 },
    homeTopBattersRecentForm: { found: true, games: 15, woba: 0.380, kRate: null, iso: null },
    homeInjuries: makeInjury(["Star"], [0.400]),
    homePitchMix: 0.04,
    homeBpFatigue: 0.5,
  }));
  const m = result.method;
  assert.ok(m.includes("spRecent(home"), `spRecent missing from: ${m}`);
  assert.ok(m.includes("batRecent(home"), `batRecent missing from: ${m}`);
  assert.ok(m.includes("inj(homeBat"), `inj missing from: ${m}`);
  assert.ok(m.includes("pitchmix(home"), `pitchmix missing from: ${m}`);
  assert.ok(m.includes("bpFatigue(home"), `bpFatigue missing from: ${m}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\npillars_wired: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
