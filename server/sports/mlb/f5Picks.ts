// v6.10 — F5 (first-5-innings) pick builder.
//
// F5 grading isolates starters from the bullpen. The model uses only:
//   - Starter projected runs allowed (xFIP / recent form when available)
//   - Park factor (5/9 of full-game weight)
//   - Weather (same proportional weight)
// No bullpen, no umpire late-game adjustment, no reliever injuries.
//
// Monte Carlo: 100-iter Poisson per side with overdispersion 1.25.
// Tier thresholds mirror full-game; SNIPER chalk cap (−250 American) applies.

import type { OddsEvent, F5Prices } from "../../adapters/oddsApi";
import type { PitcherStats } from "./pitchers";
import { americanToProb, probToAmerican } from "../../core/odds";
import { isChalkierThanSniperCap } from "../../core/tier";

// ── Types ────────────────────────────────────────────────────────────

// PitcherSabermetrics supplied by the sibling subagent's new module.
// Typed structurally so f5Picks compiles whether or not that module ships first.
export interface PitcherSabermetrics {
  xfip?: number | null;
  kMinusBBPct?: number | null;   // K% − BB%, e.g. 0.184 = 18.4%
  whip?: number | null;
  era?: number | null;
  fip?: number | null;
}

export interface F5PickInput {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homePitcher: PitcherStats;
  awayPitcher: PitcherStats;
  parkFactor: number;     // full-game park factor; scaled to 5/9 internally
  weatherAdj: number;     // run adjustment; scaled to 5/9 internally
  marketF5: OddsEvent["f5"];
  homePitcherSaber?: PitcherSabermetrics | null;
  awayPitcherSaber?: PitcherSabermetrics | null;
}

export interface F5BuiltPick {
  gameId: string;
  market: "h2h_f5" | "totals_f5";
  pickSide: "home" | "away" | "over" | "under";
  line: number | null;
  price: number;
  modelProb: number;
  marketProb: number;
  edge: number;          // pp (percentage points)
  tier: "SNIPER" | "EDGE" | "RECON" | "PASS";
  projectedHomeRunsF5: number;
  projectedAwayRunsF5: number;
  reasoning: string[];
}

// ── Constants ────────────────────────────────────────────────────────
const LG_AVG_RPG = 4.5;          // league average runs/game
const F5_INNINGS_WEIGHT = 5 / 9; // ~0.556 — park/weather scale to 5 innings
const F5_OVERDISPERSION = 1.25;  // negative-binomial overdispersion for F5
const F5_ITERATIONS = 100;        // Monte Carlo iterations (smaller, faster)

// Tier edge floors (same as full-game)
const SNIPER_EDGE = 6.0;
const EDGE_EDGE = 4.0;
const RECON_EDGE = 2.5;

// ── Monte Carlo ──────────────────────────────────────────────────────

// Deterministic mulberry32 RNG so tests are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Poisson sample via Knuth's algorithm.
function poisson(lambda: number, rng: () => number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-Math.min(lambda, 30)); // guard large λ from underflow
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

// Draw runs with NB-style overdispersion: F5_OVERDISPERSION fraction of the
// time use λ * F5_OVERDISPERSION to fatten the tail without shifting the mean
// appreciably.
function drawRuns(lambda: number, rng: () => number): number {
  const inflated = F5_OVERDISPERSION > 1 && rng() < (F5_OVERDISPERSION - 1) / F5_OVERDISPERSION;
  return poisson(inflated ? lambda * F5_OVERDISPERSION : lambda, rng);
}

interface MonteCarloResult {
  pHomeWins: number;
  pAwayWins: number;
  pOver: number | null;
  projHomeRuns: number;
  projAwayRuns: number;
}

function monteCarlo(
  projHome: number,
  projAway: number,
  totalLine: number | null,
  seed = 42,
): MonteCarloResult {
  const rng = mulberry32(seed);
  let homeWins = 0;
  let awayWins = 0;
  let overs = 0;
  const N = F5_ITERATIONS;
  for (let i = 0; i < N; i++) {
    const h = drawRuns(projHome, rng);
    const a = drawRuns(projAway, rng);
    if (h > a) homeWins++;
    else if (a > h) awayWins++;
    // ties: split (each side gets 0.5)
    if (totalLine !== null && h + a > totalLine) overs++;
  }
  return {
    pHomeWins: (homeWins + (N - homeWins - awayWins) * 0.5) / N,
    pAwayWins: (awayWins + (N - homeWins - awayWins) * 0.5) / N,
    pOver: totalLine !== null ? overs / N : null,
    projHomeRuns: Math.round(projHome * 10) / 10,
    projAwayRuns: Math.round(projAway * 10) / 10,
  };
}

// ── Run projection ───────────────────────────────────────────────────

// ERA is sufficient as xFIP proxy when saber not available.
// Returns expected runs allowed per 5 innings (starter only — no bullpen).
function projectedRunsAllowed(
  pitcher: PitcherStats,
  saber: PitcherSabermetrics | null | undefined,
  parkF5: number,
  weatherF5: number,
): number {
  // Use xFIP if available, else FIP, else ERA, else league avg.
  const xfip = saber?.xfip ?? null;
  const fip = pitcher.fip ?? null;
  const era = pitcher.era ?? null;
  const base = xfip ?? fip ?? era ?? LG_AVG_RPG;

  // base is runs/9; scale to 5 innings and apply park + weather.
  const runsF5 = (base / 9) * 5;
  const parkAdj = (parkF5 - 1) * runsF5 * 0.5; // half-weight: park affects both sides
  return Math.max(0, runsF5 + parkAdj + weatherF5);
}

// ── Tier assignment ──────────────────────────────────────────────────

function assignF5Tier(
  edge: number,
  price: number,
): "SNIPER" | "EDGE" | "RECON" | "PASS" {
  if (isChalkierThanSniperCap(price)) {
    // Demote chalk picks: try EDGE, then PASS
    if (edge >= EDGE_EDGE) return "EDGE";
    if (edge >= RECON_EDGE) return "RECON";
    return "PASS";
  }
  if (edge >= SNIPER_EDGE) return "SNIPER";
  if (edge >= EDGE_EDGE) return "EDGE";
  if (edge >= RECON_EDGE) return "RECON";
  return "PASS";
}

// ── Main build function ──────────────────────────────────────────────

export function buildF5Picks(input: F5PickInput): F5BuiltPick[] {
  const { gameId, homeTeam, awayTeam, homePitcher, awayPitcher, parkFactor, weatherAdj, marketF5 } = input;
  if (!marketF5) return []; // no F5 market data — can't price

  const parkF5 = 1 + (parkFactor - 1) * F5_INNINGS_WEIGHT; // scaled park factor
  const wxF5 = weatherAdj * F5_INNINGS_WEIGHT;              // scaled weather adj

  // Project runs for each starter over 5 innings
  const projHome = projectedRunsAllowed(homePitcher, input.homePitcherSaber, parkF5, wxF5 / 2);
  const projAway = projectedRunsAllowed(awayPitcher, input.awayPitcherSaber, parkF5, wxF5 / 2);

  const picks: F5BuiltPick[] = [];

  // ── H2H pick ─────────────────────────────────────────────────────
  if (marketF5.h2h) {
    const totalLine = marketF5.totals?.line ?? null;
    const mc = monteCarlo(projHome, projAway, totalLine, 42);

    const homePrice = marketF5.h2h.home;
    const awayPrice = marketF5.h2h.away;
    const homeMarketProb = americanToProb(homePrice) ?? 0.5;
    const awayMarketProb = americanToProb(awayPrice) ?? 0.5;

    const homeEdge = (mc.pHomeWins - homeMarketProb) * 100;
    const awayEdge = (mc.pAwayWins - awayMarketProb) * 100;

    // Pick the better edge side (or skip if neither clears RECON)
    const useSide = homeEdge >= awayEdge ? "home" : "away";
    const edge = useSide === "home" ? homeEdge : awayEdge;
    const price = useSide === "home" ? homePrice : awayPrice;
    const modelProb = useSide === "home" ? mc.pHomeWins : mc.pAwayWins;
    const marketProb = useSide === "home" ? homeMarketProb : awayMarketProb;

    const tier = assignF5Tier(edge, price);
    const teamLabel = useSide === "home" ? homeTeam : awayTeam;
    const oppoLabel = useSide === "home" ? awayTeam : homeTeam;

    const reasoning: string[] = [
      `F5 model: ${homeTeam} ${mc.projHomeRuns} · ${awayTeam} ${mc.projAwayRuns} projected runs (5 inn)`,
      `Park factor (F5-scaled): ${parkF5.toFixed(3)}`,
      `Weather adj (F5-scaled): ${wxF5 >= 0 ? "+" : ""}${wxF5.toFixed(3)} runs`,
      `${teamLabel} F5 H2H edge ${edge >= 0 ? "+" : ""}${edge.toFixed(1)}pp vs ${oppoLabel}`,
    ];
    if (input.homePitcherSaber?.xfip) {
      reasoning.push(`${homeTeam} SP xFIP ${input.homePitcherSaber.xfip.toFixed(2)}`);
    }
    if (input.awayPitcherSaber?.xfip) {
      reasoning.push(`${awayTeam} SP xFIP ${input.awayPitcherSaber.xfip.toFixed(2)}`);
    }

    picks.push({
      gameId,
      market: "h2h_f5",
      pickSide: useSide,
      line: null,
      price,
      modelProb: Math.round(modelProb * 1000) / 1000,
      marketProb: Math.round(marketProb * 1000) / 1000,
      edge: Math.round(edge * 10) / 10,
      tier,
      projectedHomeRunsF5: mc.projHomeRuns,
      projectedAwayRunsF5: mc.projAwayRuns,
      reasoning,
    });
  }

  // ── Totals pick ───────────────────────────────────────────────────
  if (marketF5.totals && marketF5.h2h) {
    const { line, over: overPrice, under: underPrice } = marketF5.totals;
    const mc = monteCarlo(projHome, projAway, line, 99);

    if (mc.pOver !== null) {
      const pUnder = 1 - mc.pOver;
      const overMarketProb = americanToProb(overPrice) ?? 0.5;
      const underMarketProb = americanToProb(underPrice) ?? 0.5;

      const overEdge = (mc.pOver - overMarketProb) * 100;
      const underEdge = (pUnder - underMarketProb) * 100;

      const useSide = overEdge >= underEdge ? "over" : "under";
      const edge = useSide === "over" ? overEdge : underEdge;
      const price = useSide === "over" ? overPrice : underPrice;
      const modelProb = useSide === "over" ? mc.pOver : pUnder;
      const marketProb = useSide === "over" ? overMarketProb : underMarketProb;

      const tier = assignF5Tier(edge, price);

      const reasoning: string[] = [
        `F5 total line ${line}: model ${useSide === "over" ? "over" : "under"} ${(modelProb * 100).toFixed(1)}%`,
        `Projected: ${homeTeam} ${mc.projHomeRuns} + ${awayTeam} ${mc.projAwayRuns} = ${(mc.projHomeRuns + mc.projAwayRuns).toFixed(1)}`,
        `Edge vs market: ${edge >= 0 ? "+" : ""}${edge.toFixed(1)}pp`,
      ];

      picks.push({
        gameId,
        market: "totals_f5",
        pickSide: useSide,
        line,
        price,
        modelProb: Math.round(modelProb * 1000) / 1000,
        marketProb: Math.round(marketProb * 1000) / 1000,
        edge: Math.round(edge * 10) / 10,
        tier,
        projectedHomeRunsF5: mc.projHomeRuns,
        projectedAwayRunsF5: mc.projAwayRuns,
        reasoning,
      });
    }
  }

  return picks;
}
