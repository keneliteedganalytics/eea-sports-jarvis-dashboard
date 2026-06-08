// NHL win-probability + goals model. Poisson goals with a goalie Sv% blend,
// home-ice advantage, and market shrinkage at MODEL_TRUST_WEIGHT (mirrors MLB).

import { probToAmerican } from "../../core/odds";

export const NHL_LG_GPG = 3.05; // league goals per game per team (2024-25 baseline)
export const NHL_HOME_ICE_GOALS = 0.18; // home-ice goals advantage
export const NHL_LG_SV_PCT = 0.905; // league average save percentage
export const MODEL_TRUST_WEIGHT = 0.45;
export const PROB_CLAMP_LO = 0.15;
export const PROB_CLAMP_HI = 0.85;

export interface GoalieStats {
  available: boolean;
  goalie: string;
  svPct?: number | null; // 0..1
  gaa?: number | null;
  gp?: number | null;
}

export interface TeamHockeyStats {
  available: boolean;
  gpg?: number | null; // goals for per game
  gapg?: number | null; // goals against per game
  xgfPct?: number | null; // expected-goals share 0..100 (for brief)
}

export interface NhlModelContext {
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  homeStats: TeamHockeyStats | Record<string, never>;
  awayStats: TeamHockeyStats | Record<string, never>;
  homeGoalie?: GoalieStats | null;
  awayGoalie?: GoalieStats | null;
  homeFairProb?: number | null;
  awayFairProb?: number | null;
}

export interface NhlModelResult {
  canModel: boolean;
  reason: string | null;
  projHomeGoals: number;
  projAwayGoals: number;
  expectedTotalGoals: number;
  homeWinProb: number;
  awayWinProb: number;
  homeWinProbFormula: number;
  shrinkageApplied: boolean;
  clampHit: boolean;
  fairHomeMl: number | null;
  fairAwayMl: number | null;
  dataQualityTier: string;
  hardPassReason: string | null;
  homeXgfPct: number | null;
  awayXgfPct: number | null;
  homeSvPct: number | null;
  awaySvPct: number | null;
  modelNotes: string[];
}

function sf(v: unknown, dflt: number | null = null): number | null {
  if (v === null || v === undefined) return dflt;
  const f = Number(v);
  return Number.isNaN(f) ? dflt : f;
}

// Goalie save-pct adjustment: a better-than-league goalie suppresses opponent
// goals proportionally to the shot-stopping delta.
function goalieFactor(g: GoalieStats | null | undefined): number {
  const sv = g?.available ? sf(g.svPct) : null;
  if (sv === null || sv <= 0 || sv >= 1) return 1.0;
  // Expected goals scale with (1 - sv). Normalize vs league.
  return (1 - sv) / (1 - NHL_LG_SV_PCT);
}

// Poisson win probability for home team, splitting the regulation-tie mass
// evenly (NHL games always resolve, so a 50/50 OT proxy is reasonable).
function poissonWinProb(lamHome: number, lamAway: number): number {
  const maxG = 12;
  const pmf = (lam: number, k: number) => (Math.exp(-lam) * Math.pow(lam, k)) / factorial(k);
  let homeWin = 0;
  let tie = 0;
  for (let h = 0; h <= maxG; h++) {
    for (let a = 0; a <= maxG; a++) {
      const p = pmf(lamHome, h) * pmf(lamAway, a);
      if (h > a) homeWin += p;
      else if (h === a) tie += p;
    }
  }
  return homeWin + tie * 0.5;
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

export function predictGame(ctx: NhlModelContext): NhlModelResult {
  const warnings: string[] = [];
  const home = (ctx.homeStats ?? {}) as TeamHockeyStats;
  const away = (ctx.awayStats ?? {}) as TeamHockeyStats;

  const homeGpg = (home.available ? sf(home.gpg) : null) ?? NHL_LG_GPG;
  const awayGpg = (away.available ? sf(away.gpg) : null) ?? NHL_LG_GPG;
  const homeGapg = (home.available ? sf(home.gapg) : null) ?? NHL_LG_GPG;
  const awayGapg = (away.available ? sf(away.gapg) : null) ?? NHL_LG_GPG;

  if (!home.available) warnings.push("home team stats missing — using league GPG");
  if (!away.available) warnings.push("away team stats missing — using league GPG");

  // Expected goals = blend of own offense and opponent defense, tempered by the
  // opposing goalie, plus home-ice.
  const awayGFactor = goalieFactor(ctx.awayGoalie);
  const homeGFactor = goalieFactor(ctx.homeGoalie);

  let lamHome = ((homeGpg + awayGapg) / 2) * awayGFactor + NHL_HOME_ICE_GOALS;
  let lamAway = ((awayGpg + homeGapg) / 2) * homeGFactor;
  lamHome = Math.max(1.2, lamHome);
  lamAway = Math.max(1.2, lamAway);

  const homeProbFormula = poissonWinProb(lamHome, lamAway);

  // Market shrinkage.
  const homeFairMkt = sf(ctx.homeFairProb);
  let homeProb: number;
  let shrinkageApplied: boolean;
  if (homeFairMkt === null || homeFairMkt <= 0 || homeFairMkt >= 1) {
    homeProb = homeProbFormula;
    shrinkageApplied = false;
    warnings.push("no market prior — formula unshrunk");
  } else {
    const w = MODEL_TRUST_WEIGHT;
    homeProb = w * homeProbFormula + (1 - w) * homeFairMkt;
    shrinkageApplied = true;
  }

  const homeProbRaw = homeProb;
  homeProb = Math.max(PROB_CLAMP_LO, Math.min(PROB_CLAMP_HI, homeProb));
  const clampHit = Math.abs(homeProbRaw - homeProb) > 0.001;
  const awayProb = round4(1 - homeProb);
  homeProb = round4(homeProb);

  return {
    canModel: true,
    reason: null,
    projHomeGoals: round2(lamHome),
    projAwayGoals: round2(lamAway),
    expectedTotalGoals: round2(lamHome + lamAway),
    homeWinProb: homeProb,
    awayWinProb: awayProb,
    homeWinProbFormula: round4(homeProbFormula),
    shrinkageApplied,
    clampHit,
    fairHomeMl: probToAmerican(homeProb),
    fairAwayMl: probToAmerican(awayProb),
    dataQualityTier: home.available && away.available ? "HIGH" : "MEDIUM",
    hardPassReason: null,
    homeXgfPct: home.available ? sf(home.xgfPct) : null,
    awayXgfPct: away.available ? sf(away.xgfPct) : null,
    homeSvPct: ctx.homeGoalie?.available ? sf(ctx.homeGoalie.svPct) : null,
    awaySvPct: ctx.awayGoalie?.available ? sf(ctx.awayGoalie.svPct) : null,
    modelNotes: warnings,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
