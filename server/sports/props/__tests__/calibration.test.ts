// Calibration anchors for the prop simulator (v6.7.6). These are the load-bearing
// guarantee that the simulator produces REAL-WORLD model probabilities from
// realistic inputs. The v6.7.3 corruption surfaced because the simulator produced
// ~90% UNDER probs (→ 30-50pp phantom edges) on hits/total-bases; the v6.7.6 fix
// recalibrates the per-PA hit/total-base sampler so a league-average regular's
// over/under probs match the book's fair (no-vig) truth. If the simulator can't
// hit these bands from clean inputs, it is broken — fail here, before it ships.
// Standalone tsx harness using node:assert.
import assert from "node:assert/strict";
import {
  simulate,
  type MatchupContext,
  type BatterMarket,
  type PitcherMarket,
} from "../simulate";
import { overUnderProb } from "../edge";
import type { BatterProfile, PitcherProfile, BatterGameLog, PitcherGameLog } from "../mlbStatsProps";

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

const TRIALS = 40000; // high trial count so the bands are tight and stable

function bLog(o: Partial<BatterGameLog> = {}): BatterGameLog {
  return { date: "2026-06-01", pa: 4, ab: 4, hits: 1, totalBases: 1, homeRuns: 0, runs: 0, rbi: 0, walks: 0, singles: 1, oppPitcherHand: "R", home: true, ...o };
}

// Build a batter whose recent-window rate AND season anchor both carry the exact
// target per-PA rates. We give the window a large total PA budget and one
// aggregate "log" so the summed window rate equals the target with no per-log
// rounding error (the simulator sums hits/PA across the window, so a single
// high-PA log is equivalent to many small ones for rate purposes). availability
// and the MIN-log gate aren't exercised here (this is a pure simulate() probe),
// so a representative high-PA window is the cleanest exact-rate fixture.
function batter(name: string, hitsPerPa: number, tbPerPa: number, hrPerPa: number): BatterProfile {
  const windowPa = 80; // ~20 games × 4 PA
  const hits = Math.round(hitsPerPa * windowPa);
  const tb = Math.round(tbPerPa * windowPa);
  const hr = Math.round(hrPerPa * windowPa);
  const logs: BatterGameLog[] = [
    bLog({ pa: windowPa, ab: windowPa, hits, totalBases: tb, homeRuns: hr, singles: Math.max(0, hits - hr) }),
  ];
  return {
    available: true, playerId: 1, name, logs, seasonPa: 600,
    seasonRates: {
      hitsPerPa, tbPerPa, hrPerPa,
      runsPerPa: 0.14, rbiPerPa: 0.13, walksPerPa: 0.08, singlesPerPa: Math.max(0, hitsPerPa - hrPerPa - 0.06),
    },
  };
}

function pLog(o: Partial<PitcherGameLog> = {}): PitcherGameLog {
  return { date: "2026-06-01", outs: 18, strikeouts: 6, earnedRuns: 2, hitsAllowed: 5, walks: 2, home: true, ...o };
}
function pitcher(name: string, kPerOut: number, outsPerStart: number): PitcherProfile {
  const logs = Array.from({ length: 12 }, () =>
    pLog({ outs: Math.round(outsPerStart), strikeouts: Math.round(kPerOut * outsPerStart) }),
  );
  return {
    available: true, playerId: 9, name, logs, starts: 12,
    seasonRates: { kPerOut, outsPerStart, erPerOut: 0.13, hitsPerOut: 0.3, walksPerOut: 0.11 },
  };
}

function ctx(lineupSpot: number): MatchupContext {
  return { oppFipRatio: 1, parkFactor: 1, lineupSpot, oppLineupKFactor: 1 };
}

function modelProb(
  market: BatterMarket | PitcherMarket,
  profile: BatterProfile | PitcherProfile,
  line: number,
  side: "over" | "under",
  lineupSpot: number,
): number {
  const isBat = "hitsPerPa" in (profile.seasonRates ?? {});
  const sim = simulate({
    market,
    batter: isBat ? (profile as BatterProfile) : undefined,
    pitcher: isBat ? undefined : (profile as PitcherProfile),
    matchup: ctx(lineupSpot),
    seedKey: `cal|${market}|${line}|${profile.name}`,
    trials: TRIALS,
  });
  assert.ok(sim.ok && sim.distribution, `sim failed: ${sim.reason}`);
  const ou = overUnderProb(sim.distribution!, line);
  return side === "over" ? ou.probOver : ou.probUnder;
}

function inBand(label: string, value: number, lo: number, hi: number) {
  assert.ok(value >= lo && value <= hi, `${label}: ${value.toFixed(3)} outside [${lo}, ${hi}]`);
}

console.log("prop simulator calibration anchors (v6.7.6)");

// Archetypes. Lineup spots reflect where each archetype actually bats so the
// expected-PA term is realistic (the calibration is PA-sensitive).
const avg = batter("Average Regular", 0.27, 0.43, 0.035);   // ~.267 BA, league-average TB
const elite = batter("Elite Contact", 0.33, 0.50, 0.04);    // top-of-order contact (Arraez-ish)
const power = batter("Power Bat", 0.24, 0.44, 0.045);        // lower contact, ~24 HR pace
const weak = batter("Slumping Bat", 0.22, 0.32, 0.02);       // weak / scuffling regular
const qs = pitcher("Quality Starter", 0.26, 17);             // ~7.0 K/9, ~5.7 IP

test("average hitter, OVER 1.5 hits → model_prob in [0.28, 0.42]", () => {
  inBand("avg O1.5 hits", modelProb("batter_hits", avg, 1.5, "over", 3), 0.28, 0.42);
});

test("average hitter, UNDER 1.5 hits → model_prob in [0.58, 0.72]", () => {
  inBand("avg U1.5 hits", modelProb("batter_hits", avg, 1.5, "under", 3), 0.58, 0.72);
});

test("elite contact, OVER 1.5 hits → model_prob in [0.38, 0.55]", () => {
  inBand("elite O1.5 hits", modelProb("batter_hits", elite, 1.5, "over", 2), 0.38, 0.55);
});

test("power hitter, OVER 0.5 HR → model_prob in [0.10, 0.20]", () => {
  inBand("power O0.5 HR", modelProb("batter_home_runs", power, 0.5, "over", 4), 0.1, 0.2);
});

test("quality starter, OVER 4.5 Ks → model_prob in [0.40, 0.65]", () => {
  inBand("qs O4.5 Ks", modelProb("pitcher_strikeouts", qs, 4.5, "over", 5), 0.4, 0.65);
});

// v6.7.6 root-cause anchors: total bases must NOT be suppressed. The prior
// sampler undershot E[TB/PA] ~15-18%, inflating UNDER probs — the dominant
// phantom-edge pattern on the live board. An average hitter's UNDER 1.5 TB
// should be a sane ~0.55-0.68, NOT the ~0.75+ the broken sampler produced.
test("average hitter, UNDER 1.5 total bases → model_prob in [0.52, 0.68] (no TB suppression)", () => {
  inBand("avg U1.5 TB", modelProb("batter_total_bases", avg, 1.5, "under", 3), 0.52, 0.68);
});

test("average hitter, OVER 0.5 total bases → model_prob in [0.62, 0.78]", () => {
  inBand("avg O0.5 TB", modelProb("batter_total_bases", avg, 0.5, "over", 3), 0.62, 0.78);
});

// A weak hitter's TB UNDER should be high but not absurd; the clamp + corrected
// sampler keep it under the old ~0.90 phantom regime.
test("slumping hitter, UNDER 1.5 total bases → model_prob in [0.62, 0.80]", () => {
  inBand("weak U1.5 TB", modelProb("batter_total_bases", weak, 1.5, "under", 7), 0.62, 0.8);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
