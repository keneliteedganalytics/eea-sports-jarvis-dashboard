// Client-side mirror of the API payload shapes returned by the server. Kept
// minimal — only the fields the UI reads.

export type Verdict = "SNIPER" | "EDGE" | "RECON" | "PASS";

export interface Market {
  available: boolean;
  pick: string | null;
  line: number | null;
  priceAmerican: number | null;
  fairLine: number | null;
  edgePp: number | null;
  tier: Verdict;
  units: number;
  side: string | null;
  book: string | null;
}

export interface MarketSet {
  ml: Market;
  spread: Market;
  total: Market;
}

export interface ClvBadge {
  points: number;
  percent: number;
  status: "open" | "locked" | "final";
  postedOdds: number;
  closingOdds: number | null;
  closingSource?: string;
}

export interface BuiltPick {
  sport: string;
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
  markets: MarketSet;
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
  halfCut: boolean;
  phantomEdge: boolean;
  trimmed: boolean;
  subSampleWarning: boolean;
  subSampleDetails: string | null;
  alignmentSignalRaw: number | null;
  topPlay: boolean;
  verdict: "PLAY" | "PASS";
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
  polymarket: { found: boolean; pct?: number | null; reason?: string };
  publicPct: number | null;
  sharpPct: number | null;
  awaySp?: { available?: boolean; pitcher?: string; era?: number | null; fip?: number | null; ip?: number | null; whip?: number | null; svPct?: number | null };
  homeSp?: { available?: boolean; pitcher?: string; era?: number | null; fip?: number | null; ip?: number | null; whip?: number | null; svPct?: number | null };
  // NHL-only goalie fields (undefined on MLB/NBA picks)
  homeGoalie?: { available: boolean; name: string | null; svPct: number | null; gaa: number | null; gp: number | null } | null;
  awayGoalie?: { available: boolean; name: string | null; svPct: number | null; gaa: number | null; gp: number | null } | null;
  modelNotes: string[];
  // Graded-book status (attached when the slate is served). Drives card color.
  gradeStatus?: "pending" | "in_progress" | "final";
  gradeResult?: "W" | "L" | "P" | null;
  gradePl?: number | null;
  clvPct?: number | null;
  // Closing Line Value — null until the lock worker captures the close.
  clv?: ClvBadge | null;
  liveAwayScore?: number | null;
  liveHomeScore?: number | null;
  liveStatusDetail?: string | null;
  finalAwayScore?: number | null;
  finalHomeScore?: number | null;
  // Bet lock-in. locked=true once the user confirmed the bet; lockedTier/Stake/Odds
  // are the frozen values to display (edit controls greyed out).
  locked?: boolean;
  lockedAt?: string | null;
  lockedTier?: string | null;
  lockedStake?: number | null;
  lockedOdds?: number | null;
  // Soccer-only fields (undefined on other sports)
  leagueName?: string | null;
  leagueId?: number | null;
  leaguePrefix?: string;
  isFriendly?: boolean;
  isDraw?: boolean;
  homeForm?: string | null;
  awayForm?: string | null;
  drawProb?: number | null;
  mlDraw?: number | null;
  fairDrawMl?: number | null;
}

export interface BankrollState {
  starting: number;
  current: number;
  netDollars: number;
  netUnits: number;
  record: { wins: number; losses: number; pushes: number };
  roiPct: number;
  lastUpdated: string | null;
}

export interface SlatePayload {
  operatingDay: string;
  isDemo: boolean;
  bankroll: number;
  picks: BuiltPick[];
}

export interface SportSlate {
  picks: BuiltPick[];
  ok: boolean;
  isDemo?: boolean;
  error?: string | null;
}

export interface DailySlate {
  operatingDay: string;
  isDemo: boolean;
  bankroll: number;
  generatedAt: number;
  sports: {
    mlb: SportSlate;
    nhl: SportSlate;
    nba: SportSlate;
    soccer: SportSlate;
  };
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

export interface AnalyticsKpis {
  totalBets: number;
  winRatePct: number;
  roiPct: number;
  netUnits: number;
  clvPct: number;
  maxDrawdownUnits: number;
}

export interface TierWinRate {
  tier: string;
  pct: number;
  wins: number;
  losses: number;
  pushes: number;
  netUnits: number;
}

export interface SportRoi {
  sport: string;
  roiPct: number;
  netUnits: number;
  bets: number;
}

export interface AnalyticsTrendPoint {
  date: string;
  clv: number;
  cumUnits: number;
  drawdownUnits: number;
}

export interface AnalyticsHeatCell {
  tier: string;
  windowDays: number;
  pct: number;
  decided: number;
}

export interface ClvAggregate {
  meanPct: number;
  positiveRatePct: number;
  captured: number;
  byTier: { tier: string; meanPct: number; captured: number }[];
}

export interface AnalyticsPayload {
  filters: { sport: string; tier: string; since: string | null };
  available: { sports: string[]; tiers: string[] };
  kpis: AnalyticsKpis;
  winRateByTier: TierWinRate[];
  roiBySport: SportRoi[];
  trend: AnalyticsTrendPoint[];
  heatmap: AnalyticsHeatCell[];
  clv: ClvAggregate;
}

export interface ArchiveItem {
  pick_id: string;
  sport: string;
  graded_at: string;
  pick_label: string;
  tier: string;
  result: "W" | "L" | "P";
  stake_units: number;
  stake_dollars: number;
  pl_units: number;
  pl_dollars: number;
  posted_odds: number | null;
  closing_odds: number | null;
  clv_pct: number | null;
  final_score: string | null;
}

export interface ArchivePage {
  items: ArchiveItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface PropRecord {
  wins: number;
  losses: number;
  pushes: number;
}

export interface PropMarketBreakdown extends PropRecord {
  market_type: string;
  bets: number;
  roiPct: number;
  netUnits: number;
}

export interface PropPlayerBreakdown extends PropRecord {
  player_name: string;
  bets: number;
  netUnits: number;
}

export interface PropLineDistanceBucket {
  label: string;
  decided: number;
  hitRatePct: number;
}

export interface PropDataQualityBreakdown extends PropRecord {
  data_quality_tier: string;
  bets: number;
}

export interface PropAnalyticsPayload {
  totalPicks: number;
  record: PropRecord;
  roiPct: number;
  netUnits: number;
  clvMeanPct: number;
  byMarket: PropMarketBreakdown[];
  byPlayer: PropPlayerBreakdown[];
  byLineDistance: PropLineDistanceBucket[];
  byDataQuality: PropDataQualityBreakdown[];
}

export interface PropBoardItem {
  pick_id: string;
  sport: string;
  game_id: string;
  player_name: string;
  team: string | null;
  opponent: string | null;
  market_type: string;
  line: number;
  side: "over" | "under";
  posted_odds: number | null;
  tier: string;
  confidence: number | null;
  edge_pp: number | null;
  data_quality_tier: string | null;
}

export interface PropBoardPayload {
  sport: string;
  date: string | null;
  items: PropBoardItem[];
}
