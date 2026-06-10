// Unit tests for the hit-rate framework (spec §4): L5/L10/L20/season windows vs
// the posted line, home/away & vs-hand splits, the "100% Club" flag (full 5-game
// window all-over or all-under), the alignment helper used by the tier gate, and
// the per-(player,market,line) cache. Standalone tsx harness using node:assert.
import assert from "node:assert/strict";
import {
  computeHitRates,
  hitRateAligned,
  hitRateCacheKey,
  clearHitRateCache,
} from "../sports/props/hitRates";
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

function bLog(hits: number, over: Partial<BatterGameLog> = {}): BatterGameLog {
  return {
    date: "2026-06-01", pa: 4, ab: 4, hits, totalBases: hits, homeRuns: 0,
    runs: 0, rbi: 0, walks: 0, singles: hits, oppPitcherHand: "R", home: true, ...over,
  };
}
function batter(name: string, logs: BatterGameLog[]): BatterProfile {
  return { available: true, playerId: 1, name, logs, seasonPa: 400, seasonRates: null };
}
function pLog(k: number, over: Partial<PitcherGameLog> = {}): PitcherGameLog {
  return { date: "2026-06-01", outs: 18, strikeouts: k, earnedRuns: 2, hitsAllowed: 5, walks: 1, home: true, ...over };
}
function pitcher(name: string, logs: PitcherGameLog[]): PitcherProfile {
  return { available: true, playerId: 2, name, logs, starts: logs.length, seasonRates: null };
}

console.log("hit rates");

// ── Window counting ──────────────────────────────────────────────────────────

test("hitRateCacheKey composes player|market|line", () => {
  assert.equal(hitRateCacheKey("Aaron Judge", "batter_hits", 1.5), "Aaron Judge|batter_hits|1.5");
});

test("L5 counts only games strictly over the line", () => {
  clearHitRateCache();
  // last 5 hits: 2,1,2,0,2 vs line 0.5 → 4 over (the 0 is under)
  const logs = [bLog(2), bLog(1), bLog(2), bLog(0), bLog(2), bLog(1), bLog(1)];
  const hr = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("A", logs) });
  assert.equal(hr.l5.decided, 5);
  assert.equal(hr.l5.over, 4);
  assert.equal(hr.l5.rate, 0.8);
});

test("exactly on the line is NOT an over (push)", () => {
  clearHitRateCache();
  // line 1: a 1-hit game equals the line → not over
  const logs = [bLog(1), bLog(1), bLog(2), bLog(2), bLog(0)];
  const hr = computeHitRates({ market: "batter_hits", line: 1, batter: batter("B", logs) });
  assert.equal(hr.l5.over, 2); // only the two 2-hit games
});

test("L10 and L20 widen the window", () => {
  clearHitRateCache();
  const logs = Array.from({ length: 25 }, (_, i) => bLog(i < 12 ? 2 : 0));
  const hr = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("C", logs) });
  assert.equal(hr.l5.over, 5);
  assert.equal(hr.l10.over, 10);
  assert.equal(hr.l20.decided, 20);
});

test("season window uses all logs", () => {
  clearHitRateCache();
  const logs = Array.from({ length: 30 }, () => bLog(2));
  const hr = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("D", logs) });
  assert.equal(hr.season.decided, 30);
  assert.equal(hr.season.rate, 1);
});

test("empty logs → null rates, zero decided", () => {
  clearHitRateCache();
  const hr = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("E", []) });
  assert.equal(hr.l5.decided, 0);
  assert.equal(hr.l5.rate, null);
});

// ── Splits ────────────────────────────────────────────────────────────────────

test("home/away splits partition by venue", () => {
  clearHitRateCache();
  const logs = [bLog(2, { home: true }), bLog(0, { home: false }), bLog(2, { home: true }), bLog(0, { home: false })];
  const hr = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("F", logs) });
  assert.equal(hr.home.decided, 2);
  assert.equal(hr.home.rate, 1);
  assert.equal(hr.away.decided, 2);
  assert.equal(hr.away.rate, 0);
});

test("vs-hand splits partition by opposing pitcher hand", () => {
  clearHitRateCache();
  const logs = [bLog(2, { oppPitcherHand: "L" }), bLog(0, { oppPitcherHand: "R" }), bLog(2, { oppPitcherHand: "L" })];
  const hr = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("G", logs) });
  assert.equal(hr.vsLhp.decided, 2);
  assert.equal(hr.vsLhp.rate, 1);
  assert.equal(hr.vsRhp.decided, 1);
  assert.equal(hr.vsRhp.rate, 0);
});

// ── 100% Club ─────────────────────────────────────────────────────────────────

test("100% Club fires when L5 is all-over (rate 1.0)", () => {
  clearHitRateCache();
  const logs = Array.from({ length: 5 }, () => bLog(2));
  const hr = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("H", logs) });
  assert.equal(hr.hundredClub, true);
  assert.equal(hr.hundredClubDirection, "over");
});

test("100% Club fires when L5 is all-under (rate 0.0)", () => {
  clearHitRateCache();
  const logs = Array.from({ length: 5 }, () => bLog(0));
  const hr = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("I", logs) });
  assert.equal(hr.hundredClub, true);
  assert.equal(hr.hundredClubDirection, "under");
});

test("100% Club does NOT fire on a mixed L5", () => {
  clearHitRateCache();
  const logs = [bLog(2), bLog(0), bLog(2), bLog(2), bLog(2)];
  const hr = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("J", logs) });
  assert.equal(hr.hundredClub, false);
  assert.equal(hr.hundredClubDirection, null);
});

test("100% Club requires a full 5-game window (no 1-game streaks)", () => {
  clearHitRateCache();
  const logs = [bLog(2), bLog(2)]; // only 2 games, all over
  const hr = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("K", logs) });
  assert.equal(hr.hundredClub, false);
});

// ── Pitcher markets ───────────────────────────────────────────────────────────

test("pitcher strikeout hit rate counts overs vs the K line", () => {
  clearHitRateCache();
  const logs = [pLog(7), pLog(8), pLog(4), pLog(6), pLog(9)]; // vs 5.5: 7,8,6,9 over = 4
  const hr = computeHitRates({ market: "pitcher_strikeouts", line: 5.5, pitcher: pitcher("P", logs) });
  assert.equal(hr.l5.over, 4);
  assert.equal(hr.l5.rate, 0.8);
});

test("pitcher splits: vs-hand windows are empty (not tagged on the start log)", () => {
  clearHitRateCache();
  const hr = computeHitRates({ market: "pitcher_strikeouts", line: 5.5, pitcher: pitcher("Q", [pLog(7)]) });
  assert.equal(hr.vsLhp.decided, 0);
  assert.equal(hr.vsRhp.decided, 0);
});

// ── Alignment helper ──────────────────────────────────────────────────────────

test("hitRateAligned: OVER aligned when rate ≥ 0.50", () => {
  assert.equal(hitRateAligned({ decided: 10, over: 6, rate: 0.6 }, "over"), true);
  assert.equal(hitRateAligned({ decided: 10, over: 4, rate: 0.4 }, "over"), false);
});

test("hitRateAligned: UNDER aligned when rate ≤ 0.50", () => {
  assert.equal(hitRateAligned({ decided: 10, over: 4, rate: 0.4 }, "under"), true);
  assert.equal(hitRateAligned({ decided: 10, over: 6, rate: 0.6 }, "under"), false);
});

test("hitRateAligned: exactly 0.50 aligns both sides", () => {
  assert.equal(hitRateAligned({ decided: 10, over: 5, rate: 0.5 }, "over"), true);
  assert.equal(hitRateAligned({ decided: 10, over: 5, rate: 0.5 }, "under"), true);
});

test("hitRateAligned: null rate never aligns", () => {
  assert.equal(hitRateAligned({ decided: 0, over: 0, rate: null }, "over"), false);
  assert.equal(hitRateAligned({ decided: 0, over: 0, rate: null }, "under"), false);
});

// ── Cache ─────────────────────────────────────────────────────────────────────

test("cache returns the same object for the same key", () => {
  clearHitRateCache();
  const input = { market: "batter_hits" as const, line: 0.5, batter: batter("Z", [bLog(2)]) };
  const a = computeHitRates(input);
  const b = computeHitRates(input);
  assert.equal(a, b); // same reference
});

test("a different line is a different cache key", () => {
  clearHitRateCache();
  const logs = [bLog(2), bLog(2), bLog(2)];
  const a = computeHitRates({ market: "batter_hits", line: 0.5, batter: batter("Z2", logs) });
  const b = computeHitRates({ market: "batter_hits", line: 1.5, batter: batter("Z2", logs) });
  assert.notEqual(a, b);
  assert.equal(a.season.rate, 1); // all over 0.5
  assert.equal(b.season.rate, 1); // 2 > 1.5
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
