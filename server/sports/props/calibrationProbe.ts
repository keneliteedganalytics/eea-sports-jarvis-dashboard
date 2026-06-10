// Calibration probe (v6.7.6). Runs a single (player, market, line, side) through
// the real prop pipeline — resolve id → fetch profile → build matchup → simulate
// → edge — and returns a debug breakdown so we can spot-check the simulator's
// PA/rate plumbing live and confirm a fix landed. Read-only; no DB writes, no
// fabricated data (an unresolved player or missing profile returns available:false).

import { fetchSchedule } from "../../adapters/mlbStats";
import { fetchBatterProfile, fetchPitcherProfile } from "./mlbStatsProps";
import { resolveMlbPlayerId } from "./playerResolver";
import {
  simulate,
  expectedPa,
  isBatterMarket,
  isPitcherMarket,
  blendRate,
  NEUTRAL_MATCHUP,
  type PropMarket,
  type MatchupContext,
} from "./simulate";
import { overUnderProb } from "./edge";

export interface ProbeResult {
  available: boolean;
  player: string;
  playerId: number | null;
  market: string;
  line: number;
  side: "over" | "under";
  reason?: string;
  expectedPA?: number;
  lineupSpot?: number;
  hitsPerPA?: number | null;
  ratePerPA?: number | null; // the market's own per-PA (or per-out) rate
  distribution?: { median: number; mean: number; p25: number; p75: number; stdDev: number };
  modelProb?: number;
  probOver?: number;
  probUnder?: number;
}

export interface ProbeDeps {
  resolveId: typeof resolveMlbPlayerId;
  batterProfile: typeof fetchBatterProfile;
  pitcherProfile: typeof fetchPitcherProfile;
  schedule: typeof fetchSchedule;
}

const DEFAULT_PROBE_DEPS: ProbeDeps = {
  resolveId: resolveMlbPlayerId,
  batterProfile: fetchBatterProfile,
  pitcherProfile: fetchPitcherProfile,
  schedule: fetchSchedule,
};

export async function probeSimulator(
  player: string,
  market: PropMarket,
  line: number,
  side: "over" | "under",
  deps: ProbeDeps = DEFAULT_PROBE_DEPS,
): Promise<ProbeResult> {
  const base: ProbeResult = { available: false, player, playerId: null, market, line, side };

  if (!isBatterMarket(market) && !isPitcherMarket(market)) {
    return { ...base, reason: "unknown market" };
  }

  const playerId = await deps.resolveId(player).catch(() => null);
  if (playerId == null) return { ...base, reason: "player id unresolved" };

  // Neutral matchup keeps the probe a pure read of the player's own baseline; we
  // surface the lineup-spot-driven PA so the operator can sanity-check it.
  const matchup: MatchupContext = { ...NEUTRAL_MATCHUP };

  if (isBatterMarket(market)) {
    const profile = await deps.batterProfile(playerId, player, 20).catch(() => null);
    if (!profile || !profile.available) return { ...base, playerId, reason: "no batter profile" };

    const hitsPerPA = blendRate(
      recentRate(profile, "batter_hits"),
      profile.seasonRates?.hitsPerPa ?? null,
    );
    const ratePerPA = blendRate(
      recentRate(profile, market),
      seasonRate(profile, market),
    );
    const sim = simulate({ market, batter: profile, matchup, seedKey: `probe|${player}|${market}|${line}` });
    if (!sim.ok || !sim.distribution) return { ...base, playerId, reason: sim.reason ?? "sim failed" };
    const ou = overUnderProb(sim.distribution, line);
    return {
      available: true, player, playerId, market, line, side,
      expectedPA: round2(expectedPa(matchup.lineupSpot)),
      lineupSpot: matchup.lineupSpot,
      hitsPerPA: round3(hitsPerPA),
      ratePerPA: round3(ratePerPA),
      distribution: dist(sim.distribution),
      modelProb: side === "over" ? ou.probOver : ou.probUnder,
      probOver: ou.probOver,
      probUnder: ou.probUnder,
    };
  }

  const profile = await deps.pitcherProfile(playerId, player, 20).catch(() => null);
  if (!profile || !profile.available) return { ...base, playerId, reason: "no pitcher profile" };
  const sim = simulate({ market, pitcher: profile, matchup, seedKey: `probe|${player}|${market}|${line}` });
  if (!sim.ok || !sim.distribution) return { ...base, playerId, reason: sim.reason ?? "sim failed" };
  const ou = overUnderProb(sim.distribution, line);
  return {
    available: true, player, playerId, market, line, side,
    expectedPA: profile.seasonRates ? round2(profile.seasonRates.outsPerStart) : undefined,
    ratePerPA: profile.seasonRates ? round3(profile.seasonRates.kPerOut) : null,
    distribution: dist(sim.distribution),
    modelProb: side === "over" ? ou.probOver : ou.probUnder,
    probOver: ou.probOver,
    probUnder: ou.probUnder,
  };
}

function recentRate(
  profile: import("./mlbStatsProps").BatterProfile,
  market: import("./simulate").BatterMarket,
): number | null {
  const logs = profile.logs;
  if (logs.length === 0) return null;
  let stat = 0, pa = 0;
  for (const g of logs) {
    pa += g.pa;
    switch (market) {
      case "batter_hits": stat += g.hits; break;
      case "batter_total_bases": stat += g.totalBases; break;
      case "batter_home_runs": stat += g.homeRuns; break;
      case "batter_runs_scored": stat += g.runs; break;
      case "batter_rbis": stat += g.rbi; break;
      case "batter_walks": stat += g.walks; break;
      case "batter_singles": stat += g.singles; break;
    }
  }
  return pa > 0 ? stat / pa : null;
}

function seasonRate(
  profile: import("./mlbStatsProps").BatterProfile,
  market: import("./simulate").BatterMarket,
): number | null {
  const r = profile.seasonRates;
  if (!r) return null;
  switch (market) {
    case "batter_hits": return r.hitsPerPa;
    case "batter_total_bases": return r.tbPerPa;
    case "batter_home_runs": return r.hrPerPa;
    case "batter_runs_scored": return r.runsPerPa;
    case "batter_rbis": return r.rbiPerPa;
    case "batter_walks": return r.walksPerPa;
    case "batter_singles": return r.singlesPerPa;
  }
}

function dist(d: import("./simulate").SimDistribution) {
  return { median: d.median, mean: d.mean, p25: d.p25, p75: d.p75, stdDev: d.stdDev };
}
function round2(x: number): number { return Math.round(x * 100) / 100; }
function round3(x: number | null): number | null { return x == null ? null : Math.round(x * 1000) / 1000; }
