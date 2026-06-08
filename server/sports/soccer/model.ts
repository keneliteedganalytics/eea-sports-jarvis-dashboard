// Dixon-Coles-lite Poisson model for soccer win probability.
// Attack/defense strength from goals-for / goals-against per team.
// Home advantage: +0.35 goals worth.
// MODEL_TRUST_WEIGHT=0.45 blend with market (same as MLB/NHL).

import { probToAmerican } from "../../core/odds";

export const SOCCER_LG_GPG = 1.35;       // league average goals per game per team
export const HOME_ADVANTAGE_GOALS = 0.35; // home team gets +0.35 goals boost
export const MODEL_TRUST_WEIGHT = 0.45;
export const PROB_CLAMP_LO = 0.05;
export const PROB_CLAMP_HI = 0.90;
export const POISSON_MAX_GOALS = 7;       // 0..6 scoreline matrix (7×7)

export interface TeamGoalStats {
  available: boolean;
  gpg?: number | null;   // goals for per game (attack)
  gapg?: number | null;  // goals against per game (defense weakness)
  form?: string | null;  // e.g. "WWLDW" (last 5 results)
}

export interface SoccerModelContext {
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  homeStats: TeamGoalStats | Record<string, never>;
  awayStats: TeamGoalStats | Record<string, never>;
  homeFairProb?: number | null;
  awayFairProb?: number | null;
  drawFairProb?: number | null;
  isFriendly?: boolean;
  isWorldCupMatchday1?: boolean; // both teams in WC tournament debut
  leagueName?: string | null;
}

export interface SoccerModelResult {
  canModel: boolean;
  reason: string | null;
  projHomeGoals: number;
  projAwayGoals: number;
  expectedTotalGoals: number;
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  homeWinProbFormula: number;   // pre-shrinkage
  drawProbFormula: number;
  awayWinProbFormula: number;
  shrinkageApplied: boolean;
  clampHit: boolean;
  fairHomeMl: number | null;
  fairDrawMl: number | null;
  fairAwayMl: number | null;
  dataQualityTier: string;
  hardPassReason: string | null;
  isSparseModel: boolean;
  trapSignal: boolean;
  trapGapPp: number | null;
  eliteFadeHome: boolean;
  eliteFadeAway: boolean;
  modelNotes: string[];
}

// Poisson PMF
function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

/**
 * Dixon-Coles low-score correction.
 * Adjusts probabilities for 0-0, 1-0, 0-1, 1-1 scorelines.
 * rho parameter typically around -0.13 for real soccer data.
 */
function dcCorrection(homeGoals: number, awayGoals: number, lambdaH: number, lambdaA: number, rho = -0.13): number {
  if (homeGoals === 0 && awayGoals === 0) return 1 - lambdaH * lambdaA * rho;
  if (homeGoals === 0 && awayGoals === 1) return 1 + lambdaH * rho;
  if (homeGoals === 1 && awayGoals === 0) return 1 + lambdaA * rho;
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function predictGame(ctx: SoccerModelContext): SoccerModelResult {
  const notes: string[] = [];
  const hStats = ctx.homeStats as TeamGoalStats;
  const aStats = ctx.awayStats as TeamGoalStats;

  const hGpg = num(hStats.gpg);
  const hGapg = num(hStats.gapg);
  const aGpg = num(aStats.gpg);
  const aGapg = num(aStats.gapg);

  const homeMktProb = ctx.homeFairProb ?? null;
  const awayMktProb = ctx.awayFairProb ?? null;
  const drawMktProb = ctx.drawFairProb ?? null;

  // Both teams missing goal data
  const bothMissingForm = (!hStats.available || hGpg === null) && (!aStats.available || aGpg === null);
  if (bothMissingForm) {
    // Only add the phantom-triggering note when market probs are ALSO absent.
    // When market fair probs are available, the blended model is legitimate
    // (market becomes the dominant prior), so we log an informational note
    // that does NOT trigger phantom-edge detection.
    const hasMkt = ctx.homeFairProb !== null && ctx.awayFairProb !== null && ctx.drawFairProb !== null;
    if (hasMkt) {
      notes.push("⚠️ no team stats — using league-average Poisson priors blended with market");
    } else {
      notes.push("missing team form — league-fallback goals used");
    }
    // Not crashing — fall through with league averages
  }

  // Determine attack / defense ratings
  const lambdaBaseline = SOCCER_LG_GPG;
  const homeAttack = hGpg ?? lambdaBaseline;
  const homeDef = hGapg ?? lambdaBaseline;     // own goals allowed
  const awayAttack = aGpg ?? lambdaBaseline;
  const awayDef = aGapg ?? lambdaBaseline;

  // Home attack boost: +0.35 goals worth
  const homeXgBoost = 1 + HOME_ADVANTAGE_GOALS / lambdaBaseline;

  // Goal rate: attack_own × defense_opp × boost
  let lambdaHome = homeAttack * (lambdaBaseline / (awayDef || 0.01)) * homeXgBoost;
  let lambdaAway = awayAttack * (lambdaBaseline / (homeDef || 0.01));

  // Clamp to sensible range
  lambdaHome = Math.max(0.3, Math.min(5.0, lambdaHome));
  lambdaAway = Math.max(0.3, Math.min(5.0, lambdaAway));

  // Build 7×7 Poisson scoreline matrix
  let pHomeWin = 0;
  let pDraw = 0;
  let pAwayWin = 0;
  const MAX = POISSON_MAX_GOALS;

  for (let h = 0; h < MAX; h++) {
    for (let a = 0; a < MAX; a++) {
      const ph = poissonPmf(lambdaHome, h);
      const pa = poissonPmf(lambdaAway, a);
      const dc = dcCorrection(h, a, lambdaHome, lambdaAway);
      const prob = ph * pa * dc;
      if (h > a) pHomeWin += prob;
      else if (h === a) pDraw += prob;
      else pAwayWin += prob;
    }
  }

  // Normalise (matrix only captures up to 6-6; tiny residual outside)
  const matrixSum = pHomeWin + pDraw + pAwayWin;
  if (matrixSum > 0) {
    pHomeWin /= matrixSum;
    pDraw /= matrixSum;
    pAwayWin /= matrixSum;
  } else {
    pHomeWin = 0.34;
    pDraw = 0.29;
    pAwayWin = 0.37;
  }

  const formulaHome = pHomeWin;
  const formulaDraw = pDraw;
  const formulaAway = pAwayWin;

  // MODEL_TRUST_WEIGHT blend with market fair probs
  let blendedHome: number;
  let blendedDraw: number;
  let blendedAway: number;
  let shrinkageApplied = false;

  if (homeMktProb !== null && awayMktProb !== null && drawMktProb !== null) {
    blendedHome = MODEL_TRUST_WEIGHT * pHomeWin + (1 - MODEL_TRUST_WEIGHT) * homeMktProb;
    blendedDraw = MODEL_TRUST_WEIGHT * pDraw + (1 - MODEL_TRUST_WEIGHT) * drawMktProb;
    blendedAway = MODEL_TRUST_WEIGHT * pAwayWin + (1 - MODEL_TRUST_WEIGHT) * awayMktProb;
    shrinkageApplied = true;
    // Re-normalise
    const s = blendedHome + blendedDraw + blendedAway;
    blendedHome /= s;
    blendedDraw /= s;
    blendedAway /= s;
  } else {
    blendedHome = pHomeWin;
    blendedDraw = pDraw;
    blendedAway = pAwayWin;
  }

  // Clamp
  let clampHit = false;
  const preClampHome = blendedHome;
  const preClampAway = blendedAway;
  blendedHome = clamp(blendedHome, PROB_CLAMP_LO, PROB_CLAMP_HI);
  blendedAway = clamp(blendedAway, PROB_CLAMP_LO, PROB_CLAMP_HI);
  if (blendedHome !== preClampHome || blendedAway !== preClampAway) clampHit = true;
  // Re-normalise after clamp
  const clampSum = blendedHome + blendedDraw + blendedAway;
  blendedHome /= clampSum;
  blendedDraw /= clampSum;
  blendedAway /= clampSum;

  // Trap detection: model strongly disagrees with market on a big line
  let trapSignal = false;
  let trapGapPp: number | null = null;
  if (homeMktProb !== null && awayMktProb !== null) {
    const mktFav = homeMktProb >= awayMktProb ? "home" : "away";
    const modelFav = blendedHome >= blendedAway ? "home" : "away";
    if (mktFav === "home" && modelFav === "away") {
      const gap = Math.abs(homeMktProb - blendedHome) * 100;
      if (gap >= 12) {
        trapSignal = true;
        trapGapPp = Math.round(gap * 10) / 10;
      }
    } else if (mktFav === "away" && modelFav === "home") {
      const gap = Math.abs(awayMktProb - blendedAway) * 100;
      if (gap >= 12) {
        trapSignal = true;
        trapGapPp = Math.round(gap * 10) / 10;
      }
    }
  }

  // Data quality tier
  const hasHomeData = hStats.available && hGpg !== null;
  const hasAwayData = aStats.available && aGpg !== null;
  let dataQualityTier = "FULL";
  let isSparseModel = false;
  if (!hasHomeData || !hasAwayData) {
    dataQualityTier = "SPARSE";
    isSparseModel = true;
  }
  if (bothMissingForm) {
    dataQualityTier = "LEAGUE_AVG";
    // Note already added above; avoid duplicating
  }

  // Only hard-pass when both team stats AND market probs are unavailable.
  // When market fair probs are present (from 3-way devig), the model can still
  // produce meaningful edge estimates even without team goal data — the market
  // itself becomes the prior and we compare vs our Poisson distribution.
  const hasMarketData = homeMktProb !== null && awayMktProb !== null && drawMktProb !== null;
  const hardPassReason = (bothMissingForm && !hasMarketData) ? "missing_team_form" : null;

  return {
    canModel: true,
    reason: null,
    projHomeGoals: Math.round(lambdaHome * 100) / 100,
    projAwayGoals: Math.round(lambdaAway * 100) / 100,
    expectedTotalGoals: Math.round((lambdaHome + lambdaAway) * 100) / 100,
    homeWinProb: Math.round(blendedHome * 10000) / 10000,
    drawProb: Math.round(blendedDraw * 10000) / 10000,
    awayWinProb: Math.round(blendedAway * 10000) / 10000,
    homeWinProbFormula: Math.round(formulaHome * 10000) / 10000,
    drawProbFormula: Math.round(formulaDraw * 10000) / 10000,
    awayWinProbFormula: Math.round(formulaAway * 10000) / 10000,
    shrinkageApplied,
    clampHit,
    fairHomeMl: probToAmerican(blendedHome),
    fairDrawMl: probToAmerican(blendedDraw),
    fairAwayMl: probToAmerican(blendedAway),
    dataQualityTier,
    hardPassReason,
    isSparseModel,
    trapSignal,
    trapGapPp,
    eliteFadeHome: false, // no elite-fade concept in soccer
    eliteFadeAway: false,
    modelNotes: notes,
  };
}
