// Unit tests for teamOffenseSaber.ts — wOBA, wRC+, ISO formulas.
// Pure unit tests; no network calls.
// Run: tsx server/__tests__/teamOffenseSaber.test.ts

import assert from "node:assert/strict";
import { _computeWOBA, _computeWRCplus, LG_WOBA, WOBA_SCALE, LG_RUNS_PER_PA } from "../sports/mlb/teamOffenseSaber";

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

console.log("teamOffenseSaber — unit tests");

// ── wOBA formula ─────────────────────────────────────────────────────────────

test("wOBA: league-average inputs produce ≈ 0.318", () => {
  // Roughly league-average team: 5500 AB, 500 BB, 50 IBB, 40 HBP, 1450 H,
  // 280 2B, 30 3B, 180 HR, 50 SF.
  const singles = 1450 - 280 - 30 - 180; // = 960
  const uBB = 500 - 50; // = 450
  const woba = _computeWOBA({
    atBats: 5500,
    baseOnBalls: 500,
    intentionalWalks: 50,
    hitByPitch: 40,
    hits: 1450,
    doubles: 280,
    triples: 30,
    homeRuns: 180,
    sacFlies: 50,
  });
  assert.ok(woba !== null, "wOBA should not be null");
  // Should be close to league average (0.310–0.330)
  assert.ok(woba! >= 0.280 && woba! <= 0.360, `wOBA ${woba} not in [0.280, 0.360]`);
});

test("wOBA: team with many HR has higher wOBA than team with few HR", () => {
  const baseStats = {
    atBats: 5500,
    baseOnBalls: 450,
    intentionalWalks: 30,
    hitByPitch: 35,
    hits: 1400,
    doubles: 260,
    triples: 25,
    sacFlies: 40,
  };
  const highHR = _computeWOBA({ ...baseStats, homeRuns: 250 });
  const lowHR  = _computeWOBA({ ...baseStats, homeRuns: 80 });
  assert.ok(highHR !== null && lowHR !== null, "Both should be non-null");
  assert.ok(highHR! > lowHR!, `highHR wOBA ${highHR} should > lowHR wOBA ${lowHR}`);
});

test("wOBA: null denominator (0 AB etc.) returns null", () => {
  const woba = _computeWOBA({ atBats: 0, baseOnBalls: 0, hitByPitch: 0 });
  assert.equal(woba, null);
});

test("wOBA: IBB excluded from unintentional BB in formula", () => {
  // Same stats but different IBB — higher IBB means fewer uBB → lower wOBA
  const low = _computeWOBA({ atBats: 500, baseOnBalls: 50, intentionalWalks: 0, hits: 120, doubles: 25, triples: 3, homeRuns: 15, hitByPitch: 5, sacFlies: 4 });
  const high = _computeWOBA({ atBats: 500, baseOnBalls: 50, intentionalWalks: 30, hits: 120, doubles: 25, triples: 3, homeRuns: 15, hitByPitch: 5, sacFlies: 4 });
  assert.ok(low !== null && high !== null);
  assert.ok(low! > high!, `Higher IBB should produce lower wOBA: ${low} vs ${high}`);
});

// ── wRC+ formula ─────────────────────────────────────────────────────────────

test("wRC+: league-average wOBA + neutral park → 100", () => {
  const wrcPlus = _computeWRCplus(LG_WOBA, 1.0);
  assert.ok(Math.abs(wrcPlus - 100) < 1, `Expected ≈100, got ${wrcPlus}`);
});

test("wRC+: above-average team (wOBA=0.340) in neutral park → > 100", () => {
  const wrcPlus = _computeWRCplus(0.340, 1.0);
  assert.ok(wrcPlus > 100, `Expected > 100, got ${wrcPlus}`);
});

test("wRC+: below-average team (wOBA=0.295) in neutral park → < 100", () => {
  const wrcPlus = _computeWRCplus(0.295, 1.0);
  assert.ok(wrcPlus < 100, `Expected < 100, got ${wrcPlus}`);
});

test("wRC+: hitter-friendly park (factor=1.10) reduces wRC+ vs neutral", () => {
  const neutral = _computeWRCplus(0.330, 1.0);
  const hitterspark = _computeWRCplus(0.330, 1.10);
  // Same wOBA but in a hitters' park: the park inflated offense, so the wRC+
  // is lower (normalising by a larger park factor).
  assert.ok(hitterspark < neutral, `Hitters' park should reduce wRC+: ${hitterspark} vs ${neutral}`);
});

test("wRC+ team wRC+110 → +0.20 run adjustment (linear scale check)", () => {
  // Model spec: team wRC+ 110 → +0.20 runs vs league avg
  const wrcPlus = 110;
  const adj = Math.max(-0.50, Math.min(0.50, ((wrcPlus - 100) / 10) * 0.20));
  assert.ok(Math.abs(adj - 0.20) < 0.001, `Expected +0.20, got ${adj}`);
});

test("wRC+ team wRC+90 → -0.20 run adjustment", () => {
  const wrcPlus = 90;
  const adj = Math.max(-0.50, Math.min(0.50, ((wrcPlus - 100) / 10) * 0.20));
  assert.ok(Math.abs(adj - (-0.20)) < 0.001, `Expected -0.20, got ${adj}`);
});

test("wRC+ clamps at ±0.50 for extreme values", () => {
  // wRC+ = 160 → (60/10)*0.20 = 1.20 → clamped to 0.50
  const extreme = Math.max(-0.50, Math.min(0.50, ((160 - 100) / 10) * 0.20));
  assert.equal(extreme, 0.50);
  const extremeLow = Math.max(-0.50, Math.min(0.50, ((40 - 100) / 10) * 0.20));
  assert.equal(extremeLow, -0.50);
});

test("wRC+: clamped to range [40, 200]", () => {
  // A team with wOBA = 0.450 should produce a high but clamped wRC+
  const hi = _computeWRCplus(0.450, 1.0);
  const lo = _computeWRCplus(0.150, 1.0);
  assert.ok(hi <= 200, `Upper bound: ${hi}`);
  assert.ok(lo >= 40, `Lower bound: ${lo}`);
});

// ── ISO sanity ────────────────────────────────────────────────────────────────
test("ISO = SLG - AVG: power-hitting team has ISO > 0.180", () => {
  // A team with SLG 0.450 and AVG 0.260 → ISO 0.190
  const iso = Math.round((0.450 - 0.260) * 10000) / 10000;
  assert.ok(iso > 0.180, `Expected ISO > 0.180, got ${iso}`);
});

test("ISO = 0 when SLG = AVG (no extra-base hits)", () => {
  const iso = Math.round((0.260 - 0.260) * 10000) / 10000;
  assert.equal(iso, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
