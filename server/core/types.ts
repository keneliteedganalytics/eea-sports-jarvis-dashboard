// Shared engine types — ported from sports-engine/core/types.py

export type Sport = "MLB" | "NBA" | "NHL" | "NCAAF" | "NCAAB" | "NFL";
export type Verdict =
  | "BONUS"
  | "SNIPER"
  | "EDGE"
  | "RECON"
  | "VALUE"
  | "LEAN"
  | "PASS";
export type Side = "home" | "away";

export interface StarterInfo {
  name: string;
  handedness?: string | null;
  ip?: number | null;
  fip?: number | null;
  era?: number | null;
  whip?: number | null;
  k9?: number | null;
  classification?: string | null;
  sparse?: boolean;
}

export interface FiveLineAnalysis {
  sharpsThesis: string;
  bookmakersCounter: string;
  interception: string;
  clvSignal: string;
  conviction: string;
}

export interface PolymarketSentiment {
  found: boolean;
  pct?: number | null; // 0..100 agreement for the pick side
  homePct?: number | null;
  awayPct?: number | null;
  title?: string | null;
  note?: string;
}

// 3-bar component input: public (book consensus), sharp (model), PRISM (poly)
export interface SignalBars {
  publicPct: number; // book-implied
  sharpPct: number; // model
  prismPct: number; // polymarket
}

export interface ConfidenceSignals {
  edgePp: number;
  evPer100: number;
  modelProb: number;
  hasPickTeamOffense?: boolean;
  hasOppTeamOffense?: boolean;
  hasPickStarter?: boolean;
  hasOppStarter?: boolean;
  sampleReliabilityRaw?: number;
  primarySignalFavorsPick?: boolean | null;
  secondarySignalFavorsPick?: boolean | null;
  polymarketPctForPick?: number | null;
  isSparse?: boolean;
  sparseSeverity?: number;
}
