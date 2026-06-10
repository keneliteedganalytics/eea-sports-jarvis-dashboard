// Monte Carlo prop simulator — the heart of the prop engine.
//
// METHODOLOGY (do not "fix" this to use the mean): sportsbook prop lines are set
// at the MEDIAN of expected outcomes (the 50/50 point). Most projection systems
// output a mean, which over-projects on the right-skewed count distributions
// that dominate baseball props (hits, total bases, strikeouts). Taking the mean
// systematically tilts toward Overs. We run a per-player Monte Carlo, build the
// full outcome distribution, and compare the line to the distribution's MEDIAN.
//
// For each (player, market, game):
//   1. baseline rate = 60% recent-form (L20) + 40% season  (right blend anchor)
//   2. matchup adjustment: opposing pitcher quality (FIP-relative), park factor
//      for the stat type, lineup-spot expected PA
//   3. 10,000 trials: sample PA/AB count, then sample each PA's outcome from the
//      adjusted rate, aggregate to the prop stat
//   4. output the full distribution → median, p25, p75, mean (mean for diagnostics)
//
// RNG is seeded (mulberry32) off a stable key so the median is reproducible
// across runs — a tester can assert median stability, and two builds of the same
// slate produce the same picks.

import type { BatterProfile, PitcherProfile } from "./mlbStatsProps";

export const DEFAULT_TRIALS = 10000;

// Recent-form / season blend (spec §2). Recent form leads; season anchors.
export const RECENT_WEIGHT = 0.6;
export const SEASON_WEIGHT = 0.4;

// ── Markets ─────────────────────────────────────────────────────────────────

export type BatterMarket =
  | "batter_hits"
  | "batter_total_bases"
  | "batter_home_runs"
  | "batter_runs_scored"
  | "batter_rbis"
  | "batter_walks"
  | "batter_singles";

export type PitcherMarket =
  | "pitcher_strikeouts"
  | "pitcher_outs"
  | "pitcher_earned_runs"
  | "pitcher_hits_allowed"
  | "pitcher_walks";

export type PropMarket = BatterMarket | PitcherMarket;

export const BATTER_MARKETS: BatterMarket[] = [
  "batter_hits",
  "batter_total_bases",
  "batter_home_runs",
  "batter_runs_scored",
  "batter_rbis",
  "batter_walks",
  "batter_singles",
];
export const PITCHER_MARKETS: PitcherMarket[] = [
  "pitcher_strikeouts",
  "pitcher_outs",
  "pitcher_earned_runs",
  "pitcher_hits_allowed",
  "pitcher_walks",
];

export function isPitcherMarket(m: string): m is PitcherMarket {
  return (PITCHER_MARKETS as string[]).includes(m);
}
export function isBatterMarket(m: string): m is BatterMarket {
  return (BATTER_MARKETS as string[]).includes(m);
}

// ── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stable 32-bit string hash so a (player|market|game) key seeds deterministically.
export function hashSeed(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── Distribution summary ──────────────────────────────────────────────────────

export interface SimDistribution {
  trials: number;
  median: number;
  p25: number;
  p75: number;
  mean: number;
  // P(X > line), P(X == line) for half-push handling; computed by the edge step,
  // but we expose the raw sorted samples count helpers here.
  samples: number[]; // sorted ascending (kept for percentile + over/under counts)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function summarize(samples: number[]): SimDistribution {
  const sorted = [...samples].sort((x, y) => x - y);
  const mean = sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length);
  return {
    trials: sorted.length,
    median: percentile(sorted, 0.5),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    mean: Math.round(mean * 1000) / 1000,
    samples: sorted,
  };
}

// ── Matchup context ───────────────────────────────────────────────────────────

export interface MatchupContext {
  // Opposing pitcher's FIP relative to league (≈4.00). >1 means a tougher arm
  // → fewer hits/TB for the batter, more K for nobody (handled per market).
  oppFipRatio: number; // oppFIP / 4.00, clamped [0.7, 1.4]
  parkFactor: number; // 1.0 neutral; >1 hitter-friendly (Coors ≈ 1.15)
  lineupSpot: number; // 1..9; drives expected PA
  // For pitcher markets: opposing lineup K-propensity (1.0 neutral; >1 whiffs more)
  oppLineupKFactor: number;
}

export const NEUTRAL_MATCHUP: MatchupContext = {
  oppFipRatio: 1.0,
  parkFactor: 1.0,
  lineupSpot: 5,
  oppLineupKFactor: 1.0,
};

// Expected plate appearances by lineup spot over a 9-inning game. Top of the
// order gets ~4.6 PA, bottom ~3.7. Used as the mean of a small PA distribution.
export function expectedPa(lineupSpot: number): number {
  const spot = Math.min(9, Math.max(1, lineupSpot));
  return 4.65 - (spot - 1) * 0.11;
}

// Per-stat park sensitivity. HR and TB swing most with park; walks barely move.
const PARK_SENSITIVITY: Record<BatterMarket, number> = {
  batter_hits: 0.5,
  batter_total_bases: 0.8,
  batter_home_runs: 1.0,
  batter_runs_scored: 0.6,
  batter_rbis: 0.6,
  batter_walks: 0.1,
  batter_singles: 0.4,
};

// ── Baseline rate blend ─────────────────────────────────────────────────────

// Blend a recent-window rate with a season rate (60/40). When one side is
// missing, fall back to the other. Returns null when neither is available.
export function blendRate(recent: number | null, season: number | null): number | null {
  if (recent === null && season === null) return null;
  if (recent === null) return season;
  if (season === null) return recent;
  return RECENT_WEIGHT * recent + SEASON_WEIGHT * season;
}

// Per-PA recent rate for a batter market over the last N logs.
function recentBatterRate(profile: BatterProfile, market: BatterMarket): number | null {
  const logs = profile.logs;
  if (logs.length === 0) return null;
  let stat = 0;
  let pa = 0;
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

function seasonBatterRate(profile: BatterProfile, market: BatterMarket): number | null {
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

// ── Batter simulation ───────────────────────────────────────────────────────

// Total bases are not Bernoulli (a PA can yield 0..4 bases), so we sample a TB
// value per PA from a small categorical built off the hit/HR mix. For all other
// batter markets the per-PA outcome is a Bernoulli on the blended per-PA rate.
function sampleTotalBasesPerPa(rng: () => number, tbPerPa: number, hrPerPa: number): number {
  // Decompose expected TB/PA into a rough hit-type mix. Most TB come from
  // singles+doubles; HR contributes 4 each. We keep it simple and stable: draw
  // whether a hit happens at rate (tbPerPa capped), then assign bases.
  const hitProb = Math.min(0.6, tbPerPa * 0.42); // hits/PA roughly tbPerPa×0.42
  if (rng() >= hitProb) return 0;
  // Given a hit, pick the base count. HR share derived from hrPerPa vs hitProb.
  const hrShare = hitProb > 0 ? Math.min(0.5, hrPerPa / hitProb) : 0;
  const r = rng();
  if (r < hrShare) return 4; // home run
  const r2 = rng();
  if (r2 < 0.62) return 1; // single
  if (r2 < 0.88) return 2; // double
  return 3; // triple (rare)
}

export interface SimInput {
  market: PropMarket;
  batter?: BatterProfile;
  pitcher?: PitcherProfile;
  matchup?: MatchupContext;
  trials?: number;
  seedKey: string; // stable key → reproducible draws
}

export interface SimResult {
  ok: boolean;
  market: PropMarket;
  distribution: SimDistribution | null;
  reason?: string;
}

export function simulateBatter(
  profile: BatterProfile,
  market: BatterMarket,
  matchup: MatchupContext,
  trials: number,
  rng: () => number,
): SimResult {
  const recent = recentBatterRate(profile, market);
  const season = seasonBatterRate(profile, market);
  const baseRate = blendRate(recent, season);
  if (baseRate === null) {
    return { ok: false, market, distribution: null, reason: "no batter rate" };
  }

  // Matchup multiplier: tougher pitcher (oppFipRatio < 1 means better pitcher,
  // since lower FIP is better) suppresses offense. We invert: a pitcher with FIP
  // below league (ratio < 1) lowers the batter's rate.
  const pitcherAdj = 0.6 + 0.4 * matchup.oppFipRatio; // ratio 1 → 1.0; 0.7 → 0.88; 1.4 → 1.16
  const parkAdj = 1 + (matchup.parkFactor - 1) * PARK_SENSITIVITY[market];
  const adjRate = Math.max(0, baseRate * pitcherAdj * parkAdj);

  const meanPa = expectedPa(matchup.lineupSpot);
  const hrPerPa = blendRate(
    recentBatterRate(profile, "batter_home_runs"),
    seasonBatterRate(profile, "batter_home_runs"),
  ) ?? 0;
  const tbPerPaAdj = market === "batter_total_bases" ? adjRate : 0;

  const samples: number[] = new Array(trials);
  for (let t = 0; t < trials; t++) {
    // Sample PA count: Poisson-ish around meanPa, floored at a realistic 2..6.
    const pa = samplePaCount(rng, meanPa);
    let stat = 0;
    for (let i = 0; i < pa; i++) {
      if (market === "batter_total_bases") {
        stat += sampleTotalBasesPerPa(rng, tbPerPaAdj, hrPerPa * pitcherAdj);
      } else {
        // Bernoulli per PA on the adjusted rate (rate already per-PA).
        if (rng() < Math.min(0.95, adjRate)) stat += 1;
      }
    }
    samples[t] = stat;
  }
  return { ok: true, market, distribution: summarize(samples) };
}

// PA count per game: centered on meanPa, clamped to [2,6]. A simple rounded
// normal-ish draw via two uniforms keeps it cheap and stable.
function samplePaCount(rng: () => number, meanPa: number): number {
  const jitter = (rng() + rng() - 1) * 0.9; // ~[-0.9,0.9], triangular
  const pa = Math.round(meanPa + jitter);
  return Math.min(6, Math.max(2, pa));
}

export function simulatePitcher(
  profile: PitcherProfile,
  market: PitcherMarket,
  matchup: MatchupContext,
  trials: number,
  rng: () => number,
): SimResult {
  const r = profile.seasonRates;
  // Recent per-out rates from the log window.
  const recentRates = recentPitcherRates(profile);
  if (!r && !recentRates) {
    return { ok: false, market, distribution: null, reason: "no pitcher rate" };
  }

  const outsPerStart = blendRate(
    recentRates?.outsPerStart ?? null,
    r?.outsPerStart ?? null,
  ) ?? 17; // ~5.2 IP fallback

  let perOutRate: number;
  switch (market) {
    case "pitcher_strikeouts":
      perOutRate = (blendRate(recentRates?.kPerOut ?? null, r?.kPerOut ?? null) ?? 0.28) *
        matchup.oppLineupKFactor;
      break;
    case "pitcher_earned_runs":
      perOutRate = blendRate(recentRates?.erPerOut ?? null, r?.erPerOut ?? null) ?? 0.13;
      break;
    case "pitcher_hits_allowed":
      perOutRate = blendRate(recentRates?.hitsPerOut ?? null, r?.hitsPerOut ?? null) ?? 0.3;
      break;
    case "pitcher_walks":
      perOutRate = blendRate(recentRates?.walksPerOut ?? null, r?.walksPerOut ?? null) ?? 0.11;
      break;
    case "pitcher_outs":
      perOutRate = 0; // outs market simulates the out count directly
      break;
  }

  const samples: number[] = new Array(trials);
  for (let t = 0; t < trials; t++) {
    const outs = sampleOuts(rng, outsPerStart);
    if (market === "pitcher_outs") {
      samples[t] = outs;
      continue;
    }
    // Each recorded out is a Bernoulli trial for the per-out event (K, ER, etc.).
    // ER/hits/walks can exceed 1 per out in reality, so we sample a small Poisson
    // count per out for the rate-heavy markets; K is capped at 1 per out (a K is
    // itself an out, but strikeouts-per-out < 1 captures that).
    let stat = 0;
    for (let o = 0; o < outs; o++) {
      if (market === "pitcher_strikeouts") {
        if (rng() < Math.min(0.95, perOutRate)) stat += 1;
      } else {
        stat += samplePoissonSmall(rng, perOutRate);
      }
    }
    samples[t] = stat;
  }
  return { ok: true, market, distribution: summarize(samples) };
}

function recentPitcherRates(profile: PitcherProfile): PitcherProfile["seasonRates"] | null {
  const logs = profile.logs;
  if (logs.length === 0) return null;
  let outs = 0, k = 0, er = 0, h = 0, bb = 0;
  for (const g of logs) {
    outs += g.outs;
    k += g.strikeouts;
    er += g.earnedRuns;
    h += g.hitsAllowed;
    bb += g.walks;
  }
  if (outs <= 0) return null;
  return {
    kPerOut: k / outs,
    outsPerStart: outs / logs.length,
    erPerOut: er / outs,
    hitsPerOut: h / outs,
    walksPerOut: bb / outs,
  };
}

function sampleOuts(rng: () => number, meanOuts: number): number {
  // Outs per start: centered on meanOuts with ±5 outs spread, clamped [6,27].
  const jitter = (rng() + rng() + rng() - 1.5) * 4; // ~triangular, wider
  const outs = Math.round(meanOuts + jitter);
  return Math.min(27, Math.max(6, outs));
}

// Small-count Poisson via Knuth, fine for the low lambdas (<1) here.
function samplePoissonSmall(rng: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

// ── Public entry ──────────────────────────────────────────────────────────────

export function simulate(input: SimInput): SimResult {
  const trials = input.trials ?? DEFAULT_TRIALS;
  const matchup = input.matchup ?? NEUTRAL_MATCHUP;
  const rng = makeRng(hashSeed(input.seedKey));

  if (isBatterMarket(input.market)) {
    if (!input.batter) return { ok: false, market: input.market, distribution: null, reason: "no batter profile" };
    return simulateBatter(input.batter, input.market, matchup, trials, rng);
  }
  if (isPitcherMarket(input.market)) {
    if (!input.pitcher) return { ok: false, market: input.market, distribution: null, reason: "no pitcher profile" };
    return simulatePitcher(input.pitcher, input.market, matchup, trials, rng);
  }
  return { ok: false, market: input.market, distribution: null, reason: "unknown market" };
}
