// Client-side mirror of the API payload shapes returned by the server. Kept
// minimal — only the fields the UI reads.

export type Verdict = "BONUS" | "SNIPER" | "EDGE" | "RECON" | "VALUE" | "LEAN" | "PASS";

export interface BuiltPick {
  gameId: string;
  gameDate: string;
  gameTimeEt: string;
  venue: string;
  matchup: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamFull: string;
  awayTeamFull: string;
  homePitcher?: string;
  awayPitcher?: string;
  pickSide: "home" | "away";
  pickTeam: string;
  pickTeamFull: string;
  pickType: "ML";
  pickMl: number | null;
  pickBook: string | null;
  pickWinProb: number | null;
  pickImpliedProb: number | null;
  fairMl: number | null;
  edgePp: number | null;
  evPer100: number;
  confidence: number;
  units: number;
  kellyStakeDollars: number;
  kellyCapped: boolean;
  verdict: "PLAY" | "PASS" | "LEAN";
  verdictTier: Verdict;
  qualifies: boolean;
  trapSignal: boolean;
  trapGapPp: number | null;
  eliteFadeApplied: boolean;
  dataQualityTier: string;
  hardPassReason: string | null;
  isSparseModel: boolean;
  projHomeScore: number;
  projAwayScore: number;
  expectedTotal: number;
  homeMl: number | null;
  awayMl: number | null;
  openHomeMl: number | null;
  openAwayMl: number | null;
  homeFairProb: number | null;
  awayFairProb: number | null;
  homeWinProb: number | null;
  awayWinProb: number | null;
  polymarket: { found: boolean; pct?: number | null };
  modelNotes: string[];
}

export interface SlatePayload {
  operatingDay: string;
  isDemo: boolean;
  bankroll: number;
  picks: BuiltPick[];
}

export interface TierHitRate {
  tier: string;
  windows: { windowDays: number; pct: number; wins: number; losses: number; pushes: number; unitsWon: number }[];
}

export interface BetLogEntry {
  date: string;
  matchup: string;
  pick: string;
  tier: string;
  units: number;
  result: "W" | "L" | "P";
  clv: string;
  unitsWon: number;
}

export interface TrackRecordSummary {
  clvPct: number;
  evRealizedUnits: number;
  roiPct: number;
  maxDrawdownUnits: number;
  totalBets: number;
  record: { wins: number; losses: number; pushes: number };
  betLog: BetLogEntry[];
}

export interface AlertItem {
  id: number;
  kind: "STEAM" | "SCRATCH";
  gameId: string;
  message: string;
  ts: string;
}

export interface BriefResponse {
  text: string;
  audioUrl: string | null;
  available: boolean;
  cached?: boolean;
}
