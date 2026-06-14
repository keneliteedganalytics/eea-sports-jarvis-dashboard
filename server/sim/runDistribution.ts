// Pillar 3 (v6.9.0) — score-distribution projection. The game model
// (model.ts/predictGame) emits a single Pythagenpat win probability; this module
// turns the two projected team run totals into a full Monte-Carlo run
// distribution so game-line picks can read P(win), P(cover −1.5), P(over X), the
// median margin, and a projected score — the richer Foxtail-style output.
//
// Runs are simulated per side as Poisson(projectedRuns) with a small negative-
// binomial-style overdispersion (baseball run totals are fatter-tailed than pure
// Poisson). Seeded mulberry32 RNG so a given (a,b,seed) is reproducible — mirrors
// the prop simulator's determinism contract.

import { bullpenFatigueRunBump } from "../sources/bullpenLoad";

export const DEFAULT_ITERATIONS = 1000;
// Overdispersion: probability of drawing the higher-variance run component for a
// side on a given iteration. Baseball run totals are slightly fatter-tailed than
// pure Poisson; this fattens the tail without shifting the mean. Env-overridable;
// default 0 keeps the model a clean Poisson (matches the spec's calibration).
export const OVERDISPERSION = (() => {
  const env = Number(process.env.RUNDIST_OVERDISPERSION);
  return Number.isFinite(env) && env >= 0 && env <= 1 ? env : 0;
})();

export interface RunDistributionInput {
  projRunsA: number; // projected runs for side A (e.g. home)
  projRunsB: number; // projected runs for side B (e.g. away)
  iterations?: number;
  seed?: number;
  overUnderLine?: number | null; // total line for P(over)
  // Pillar 5: 0..1 bullpen fatigue per side. A fatigued pen leaks late-inning
  // runs, so the OPPOSING side's projected runs are bumped by
  // bullpenFatigueRunBump(fatigue). Defaults 0 (no-op).
  fatigueA?: number;
  fatigueB?: number;
}

export interface RunDistributionResult {
  iterations: number;
  pAWins: number; // P(A strictly outscores B); ties split below
  pBWins: number;
  pTie: number;
  pACoversMinus1_5: number; // P(A wins by ≥2)
  pBCoversMinus1_5: number;
  pOver: number | null; // P(total > line), null when no line given
  medianMargin: number; // median of (A − B)
  meanTotal: number;
  projScoreA: number; // rounded mean runs A
  projScoreB: number;
}

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

// Poisson sample via Knuth's algorithm using the supplied uniform RNG.
function poisson(lambda: number, rng: () => number): number {
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

// One run draw with mild overdispersion: mix a Poisson(λ) with a Poisson(λ·1.5)
// at weight OVERDISPERSION to fatten the upper tail without shifting the mean
// much (we recenter by drawing the inflated component only OVERDISPERSION of the
// time around λ).
function drawRuns(lambda: number, rng: () => number): number {
  if (OVERDISPERSION > 0 && rng() < OVERDISPERSION) {
    // higher-variance component centered on the same mean
    return poisson(lambda * 0.6, rng) + poisson(lambda * 0.4 * 1.0, rng) + (rng() < 0.15 ? 1 : 0);
  }
  return poisson(lambda, rng);
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Monte-Carlo the run distribution for a single game. Pure given the seed.
export function simulateRunDistribution(input: RunDistributionInput): RunDistributionResult {
  const iterations = Math.max(1, input.iterations ?? DEFAULT_ITERATIONS);
  const seed = input.seed ?? 0x9e3779b9;
  const rng = mulberry32(seed);
  // A fatigued pen on side A lets side B score more late, and vice versa.
  const bumpFromA = bullpenFatigueRunBump(input.fatigueA ?? 0);
  const bumpFromB = bullpenFatigueRunBump(input.fatigueB ?? 0);
  const lambdaA = Math.max(0, input.projRunsA + bumpFromB);
  const lambdaB = Math.max(0, input.projRunsB + bumpFromA);

  let aWins = 0, bWins = 0, ties = 0, aCover = 0, bCover = 0, over = 0;
  let sumTotal = 0, sumA = 0, sumB = 0;
  const margins: number[] = new Array(iterations);

  for (let i = 0; i < iterations; i++) {
    const ra = drawRuns(lambdaA, rng);
    const rb = drawRuns(lambdaB, rng);
    const margin = ra - rb;
    margins[i] = margin;
    sumA += ra; sumB += rb; sumTotal += ra + rb;
    if (margin > 0) aWins++;
    else if (margin < 0) bWins++;
    else ties++;
    if (margin >= 2) aCover++;
    if (margin <= -2) bCover++;
    if (input.overUnderLine != null && ra + rb > input.overUnderLine) over++;
  }

  // Split ties evenly so pAWins + pBWins = 1 for line purposes (extra innings).
  const pAWins = (aWins + ties / 2) / iterations;
  const pBWins = (bWins + ties / 2) / iterations;
  margins.sort((x, y) => x - y);

  return {
    iterations,
    pAWins: round4(pAWins),
    pBWins: round4(pBWins),
    pTie: round4(ties / iterations),
    pACoversMinus1_5: round4(aCover / iterations),
    pBCoversMinus1_5: round4(bCover / iterations),
    pOver: input.overUnderLine != null ? round4(over / iterations) : null,
    medianMargin: median(margins),
    meanTotal: round2(sumTotal / iterations),
    projScoreA: round2(sumA / iterations),
    projScoreB: round2(sumB / iterations),
  };
}

function round2(x: number): number { return Math.round(x * 100) / 100; }
function round4(x: number): number { return Math.round(x * 10000) / 10000; }
