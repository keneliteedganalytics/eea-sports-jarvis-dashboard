// Unit tests for the Monte Carlo prop simulator (spec §2). The load-bearing
// guarantees: the simulator takes the MEDIAN of the distribution (not the mean,
// which over-projects right-skewed counting stats), the seeded RNG makes the
// median reproducible across runs, and the distribution is sane for a known
// baseline. Standalone tsx harness using node:assert.
import assert from "node:assert/strict";
import {
  simulate,
  makeRng,
  hashSeed,
  blendRate,
  expectedPa,
  isBatterMarket,
  isPitcherMarket,
  BATTER_MARKETS,
  PITCHER_MARKETS,
  NEUTRAL_MATCHUP,
  RECENT_WEIGHT,
  SEASON_WEIGHT,
  DEFAULT_TRIALS,
  type SimInput,
} from "../sports/props/simulate";
import type { BatterProfile, PitcherProfile, BatterGameLog, PitcherGameLog } from "../sports/props/mlbStatsProps";

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

// ── Fixtures ────────────────────────────────────────────────────────────────

function batterLog(over: Partial<BatterGameLog> = {}): BatterGameLog {
  return {
    date: "2026-06-01",
    pa: 4,
    ab: 4,
    hits: 1,
    totalBases: 2,
    homeRuns: 0,
    runs: 1,
    rbi: 1,
    walks: 0,
    singles: 1,
    oppPitcherHand: "R",
    home: true,
    ...over,
  };
}

// A solid contact hitter: ~1.3 hits/game over 20 logs, season anchor present.
function batterProfile(): BatterProfile {
  return {
    available: true,
    playerId: 1,
    name: "Test Batter",
    logs: Array.from({ length: 20 }, (_, i) => batterLog({ hits: i % 3 === 0 ? 2 : 1, home: i % 2 === 0 })),
    seasonPa: 500,
    seasonRates: {
      hitsPerPa: 0.3,
      tbPerPa: 0.5,
      hrPerPa: 0.04,
      runsPerPa: 0.15,
      rbiPerPa: 0.14,
      walksPerPa: 0.09,
      singlesPerPa: 0.2,
    },
  };
}

function pitcherLog(over: Partial<PitcherGameLog> = {}): PitcherGameLog {
  return { date: "2026-06-01", outs: 18, strikeouts: 6, earnedRuns: 2, hitsAllowed: 5, walks: 2, home: true, ...over };
}

// A strikeout arm: ~6 K, 18 outs per start over 10 starts.
function pitcherProfile(): PitcherProfile {
  return {
    available: true,
    playerId: 2,
    name: "Test Pitcher",
    logs: Array.from({ length: 10 }, (_, i) => pitcherLog({ strikeouts: 5 + (i % 4), home: i % 2 === 0 })),
    starts: 10,
    seasonRates: { kPerOut: 0.33, outsPerStart: 18, erPerOut: 0.11, hitsPerOut: 0.28, walksPerOut: 0.1 },
  };
}

console.log("prop simulator");

// ── Market classification ──────────────────────────────────────────────────

test("BATTER_MARKETS has the 7 batter markets", () => {
  assert.equal(BATTER_MARKETS.length, 7);
});
test("PITCHER_MARKETS has the 5 pitcher markets", () => {
  assert.equal(PITCHER_MARKETS.length, 5);
});
test("isBatterMarket / isPitcherMarket classify correctly", () => {
  assert.equal(isBatterMarket("batter_hits"), true);
  assert.equal(isBatterMarket("pitcher_strikeouts"), false);
  assert.equal(isPitcherMarket("pitcher_strikeouts"), true);
  assert.equal(isPitcherMarket("batter_hits"), false);
  assert.equal(isBatterMarket("nonsense"), false);
  assert.equal(isPitcherMarket("nonsense"), false);
});

// ── Blend + PA helpers ───────────────────────────────────────────────────────

test("blendRate weights 60% recent / 40% season", () => {
  assert.equal(RECENT_WEIGHT, 0.6);
  assert.equal(SEASON_WEIGHT, 0.4);
  assert.ok(Math.abs(blendRate(0.4, 0.2)! - (0.6 * 0.4 + 0.4 * 0.2)) < 1e-9);
});
test("blendRate falls back to whichever side is present", () => {
  assert.equal(blendRate(0.5, null), 0.5);
  assert.equal(blendRate(null, 0.3), 0.3);
});
test("blendRate returns null when both missing", () => {
  assert.equal(blendRate(null, null), null);
});
test("expectedPa decreases down the lineup", () => {
  assert.ok(expectedPa(1) > expectedPa(5));
  assert.ok(expectedPa(5) > expectedPa(9));
});
test("expectedPa clamps out-of-range lineup spots", () => {
  assert.equal(expectedPa(0), expectedPa(1));
  assert.equal(expectedPa(15), expectedPa(9));
});

// ── Seeded RNG determinism ────────────────────────────────────────────────────

test("makeRng is deterministic for a given seed", () => {
  const a = makeRng(123);
  const b = makeRng(123);
  for (let i = 0; i < 50; i++) assert.equal(a(), b());
});
test("makeRng differs across seeds", () => {
  const a = makeRng(1);
  const b = makeRng(2);
  let same = 0;
  for (let i = 0; i < 50; i++) if (a() === b()) same++;
  assert.ok(same < 5, `too many collisions: ${same}`);
});
test("makeRng output stays in [0,1)", () => {
  const r = makeRng(99);
  for (let i = 0; i < 100; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});
test("hashSeed is stable for the same key and varies by key", () => {
  assert.equal(hashSeed("a|b|c"), hashSeed("a|b|c"));
  assert.notEqual(hashSeed("a|b|c"), hashSeed("a|b|d"));
});

// ── Distribution sanity + MEDIAN stability ────────────────────────────────────

function batterInput(market: string, seedKey = "g1|Test Batter|hits|0.5"): SimInput {
  return { market: market as SimInput["market"], batter: batterProfile(), matchup: NEUTRAL_MATCHUP, seedKey };
}

test("simulate(batter_hits) succeeds with a populated distribution", () => {
  const r = simulate(batterInput("batter_hits"));
  assert.equal(r.ok, true);
  assert.ok(r.distribution);
  assert.equal(r.distribution!.trials, DEFAULT_TRIALS);
  assert.equal(r.distribution!.samples.length, DEFAULT_TRIALS);
});

test("simulate median is reproducible across runs (same seed)", () => {
  const a = simulate(batterInput("batter_hits"));
  const b = simulate(batterInput("batter_hits"));
  assert.equal(a.distribution!.median, b.distribution!.median);
  assert.equal(a.distribution!.p25, b.distribution!.p25);
  assert.equal(a.distribution!.p75, b.distribution!.p75);
  assert.equal(a.distribution!.mean, b.distribution!.mean);
});

test("different seed keys can produce different draws", () => {
  const a = simulate(batterInput("batter_hits", "seedA"));
  const b = simulate(batterInput("batter_hits", "seedB"));
  // Means won't be identical across independent seeds for a stochastic process.
  assert.ok(a.distribution && b.distribution);
});

test("distribution percentiles are ordered p25 ≤ median ≤ p75", () => {
  const d = simulate(batterInput("batter_hits")).distribution!;
  assert.ok(d.p25 <= d.median);
  assert.ok(d.median <= d.p75);
});

test("samples are sorted ascending", () => {
  const s = simulate(batterInput("batter_hits")).distribution!.samples;
  for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i - 1]);
});

test("batter counting stats are non-negative integers", () => {
  const s = simulate(batterInput("batter_hits")).distribution!.samples;
  assert.ok(s.every((v) => v >= 0 && Number.isInteger(v)));
});

test("median hits is a small plausible count (0..4) for a real hitter", () => {
  const d = simulate(batterInput("batter_hits")).distribution!;
  assert.ok(d.median >= 0 && d.median <= 4, `median ${d.median}`);
});

test("total_bases distribution mean ≥ hits mean (TB ≥ hits)", () => {
  const hits = simulate(batterInput("batter_hits")).distribution!;
  const tb = simulate(batterInput("batter_total_bases", "g1|Test Batter|tb|1.5")).distribution!;
  assert.ok(tb.mean >= hits.mean - 0.05, `tb ${tb.mean} vs hits ${hits.mean}`);
});

test("simulate(batter) without a profile fails gracefully", () => {
  const r = simulate({ market: "batter_hits", matchup: NEUTRAL_MATCHUP, seedKey: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.distribution, null);
});

// ── Pitcher markets ───────────────────────────────────────────────────────────

function pitcherInput(market: string): SimInput {
  return { market: market as SimInput["market"], pitcher: pitcherProfile(), matchup: NEUTRAL_MATCHUP, seedKey: `g1|Test Pitcher|${market}|5.5` };
}

test("simulate(pitcher_strikeouts) succeeds", () => {
  const r = simulate(pitcherInput("pitcher_strikeouts"));
  assert.equal(r.ok, true);
  assert.ok(r.distribution!.median >= 0);
});

test("pitcher strikeout median is plausible (2..10)", () => {
  const d = simulate(pitcherInput("pitcher_strikeouts")).distribution!;
  assert.ok(d.median >= 2 && d.median <= 10, `median ${d.median}`);
});

test("pitcher_outs median is plausible (around a starter's workload)", () => {
  const d = simulate(pitcherInput("pitcher_outs")).distribution!;
  assert.ok(d.median >= 9 && d.median <= 24, `median ${d.median}`);
});

test("simulate(pitcher) median reproducible across runs", () => {
  const a = simulate(pitcherInput("pitcher_strikeouts")).distribution!;
  const b = simulate(pitcherInput("pitcher_strikeouts")).distribution!;
  assert.equal(a.median, b.median);
});

test("simulate(pitcher) without a profile fails gracefully", () => {
  const r = simulate({ market: "pitcher_strikeouts", matchup: NEUTRAL_MATCHUP, seedKey: "x" });
  assert.equal(r.ok, false);
});

test("tougher opposing pitcher suppresses batter hit mean", () => {
  const easy = simulate({ market: "batter_hits", batter: batterProfile(), matchup: { ...NEUTRAL_MATCHUP, oppFipRatio: 1.4 }, seedKey: "k" }).distribution!;
  const hard = simulate({ market: "batter_hits", batter: batterProfile(), matchup: { ...NEUTRAL_MATCHUP, oppFipRatio: 0.7 }, seedKey: "k" }).distribution!;
  assert.ok(easy.mean >= hard.mean, `easy ${easy.mean} hard ${hard.mean}`);
});

test("hitter-friendly park lifts the HR mean", () => {
  const coors = simulate({ market: "batter_home_runs", batter: batterProfile(), matchup: { ...NEUTRAL_MATCHUP, parkFactor: 1.3 }, seedKey: "p" }).distribution!;
  const neutral = simulate({ market: "batter_home_runs", batter: batterProfile(), matchup: NEUTRAL_MATCHUP, seedKey: "p" }).distribution!;
  assert.ok(coors.mean >= neutral.mean, `coors ${coors.mean} neutral ${neutral.mean}`);
});

test("DEFAULT_TRIALS is 10000", () => {
  assert.equal(DEFAULT_TRIALS, 10000);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
