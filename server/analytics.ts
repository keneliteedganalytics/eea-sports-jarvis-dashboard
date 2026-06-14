// Analytics aggregation layer. Reuses the graded bet log + hit-rate views that
// power the Track Record page and rolls them into the views the /analytics
// dashboard renders: headline KPIs, win-rate by tier, ROI by sport, a CLV trend
// line, a running drawdown curve, and a tier×window hit-rate heatmap. All figures
// are derived from the same graded book, so Analytics and Track Record never
// disagree. An empty book yields empty charts + zero KPIs — no fabricated data.
// Filters (sport / tier / since-date) are applied to the bet log.

import { hitRatesByTier, trackRecord, type BetLogEntry } from "./sports/mlb/trackRecord";
import { clvAggregate, gradedPropPicks, passSummary, availableEngineVersions, type ClvAggregate, type PassSummary } from "./gradedBook";

const TIER_ORDER = ["SNIPER", "EDGE", "RECON"];
const SPORTS = ["MLB", "NHL", "NBA", "SOCCER"];

export interface AnalyticsFilters {
  sport?: string | null; // "ALL" | one of SPORTS
  tier?: string | null; // "ALL" | one of TIER_ORDER
  since?: string | null; // YYYY-MM-DD inclusive lower bound
  engineVersion?: string | null; // "ALL" | "current" | a legacy bucket tag (v6.9.0)
}

export interface KpiCards {
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

export interface TrendPoint {
  date: string;
  clv: number; // cumulative CLV cents captured (running)
  cumUnits: number; // running net units (for the drawdown curve)
  drawdownUnits: number; // peak-to-current drawdown at this point (≤ 0)
}

export interface HeatCell {
  tier: string;
  windowDays: number;
  pct: number;
  decided: number;
}

// v6.7.7: graded record split by pick kind (game-line vs player-prop), so the
// unified Analytics page can show each stream's contribution to the totals.
export interface KindBreakdown {
  kind: "game" | "prop";
  bets: number;
  wins: number;
  losses: number;
  pushes: number;
  netUnits: number;
  roiPct: number;
}

// Count of PLAYED (graded) picks per actionable tier across both kinds.
export interface PlayedTier {
  tier: string;
  bets: number;
}

export interface AnalyticsPayload {
  filters: { sport: string; tier: string; since: string | null; engineVersion: string };
  available: { sports: string[]; tiers: string[]; engineVersions: string[] };
  kpis: KpiCards;
  winRateByTier: TierWinRate[];
  roiBySport: SportRoi[];
  trend: TrendPoint[];
  heatmap: HeatCell[];
  clv: ClvAggregate;
  // v6.7.7 unified additions
  byKind: KindBreakdown[];
  byTier: PlayedTier[];
  passSummary: PassSummary;
}

function num(v: string): number | null {
  const n = Number(v.replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Apply sport/tier/since filters to a bet log. Sport filtering is best-effort:
// the seeded MLB log has no sport column, so an explicit non-MLB sport filter
// yields an empty log rather than pretending every row is MLB.
function filterLog(log: BetLogEntry[], f: AnalyticsFilters): BetLogEntry[] {
  return log.filter((e) => {
    if (f.tier && f.tier !== "ALL" && e.tier !== f.tier) return false;
    if (f.since && e.date < f.since) return false;
    return true;
  });
}

function computeKpis(log: BetLogEntry[], clvPct: number): KpiCards {
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let netUnits = 0;
  let staked = 0;
  for (const e of log) {
    if (e.result === "W") wins++;
    else if (e.result === "L") losses++;
    else pushes++;
    netUnits += e.unitsWon;
    staked += e.units;
  }
  const decided = wins + losses;
  return {
    totalBets: log.length,
    winRatePct: decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0,
    roiPct: staked > 0 ? Math.round((netUnits / staked) * 1000) / 10 : 0,
    netUnits: Math.round(netUnits * 100) / 100,
    clvPct,
    maxDrawdownUnits: maxDrawdown(log),
  };
}

// Largest peak-to-trough drop of the running net-units curve, in units (≥ 0).
function maxDrawdown(log: BetLogEntry[]): number {
  const chron = [...log].sort((a, b) => a.date.localeCompare(b.date));
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const e of chron) {
    cum += e.unitsWon;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return Math.round(maxDd * 100) / 100;
}

function winRateByTier(log: BetLogEntry[]): TierWinRate[] {
  const by = new Map<string, TierWinRate>();
  for (const e of log) {
    if (!by.has(e.tier)) by.set(e.tier, { tier: e.tier, pct: 0, wins: 0, losses: 0, pushes: 0, netUnits: 0 });
    const r = by.get(e.tier)!;
    if (e.result === "W") r.wins++;
    else if (e.result === "L") r.losses++;
    else r.pushes++;
    r.netUnits = Math.round((r.netUnits + e.unitsWon) * 100) / 100;
  }
  for (const r of by.values()) {
    const decided = r.wins + r.losses;
    r.pct = decided > 0 ? Math.round((r.wins / decided) * 1000) / 10 : 0;
  }
  return [...by.values()].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
}

// ROI per sport. Only MLB carries a real settled log today; the other sports
// surface their seeded 90-day unit totals so the chart isn't empty.
function roiBySport(log: BetLogEntry[]): SportRoi[] {
  const out: SportRoi[] = [];
  // MLB from the filtered settled log.
  let mlbStaked = 0;
  let mlbNet = 0;
  for (const e of log) {
    mlbStaked += e.units;
    mlbNet += e.unitsWon;
  }
  out.push({
    sport: "MLB",
    roiPct: mlbStaked > 0 ? Math.round((mlbNet / mlbStaked) * 1000) / 10 : 0,
    netUnits: Math.round(mlbNet * 100) / 100,
    bets: log.length,
  });
  for (const sport of SPORTS.filter((s) => s !== "MLB")) {
    const tr = trackRecord(sport);
    const staked = tr.totalBets * 1.5;
    out.push({
      sport,
      roiPct: tr.roiPct,
      netUnits: tr.evRealizedUnits,
      bets: tr.totalBets,
    });
  }
  return out;
}

function trend(log: BetLogEntry[]): TrendPoint[] {
  const chron = [...log].sort((a, b) => a.date.localeCompare(b.date));
  const points: TrendPoint[] = [];
  let cumUnits = 0;
  let cumClv = 0;
  let peak = 0;
  for (const e of chron) {
    cumUnits = Math.round((cumUnits + e.unitsWon) * 100) / 100;
    const clvVal = num(e.clv);
    if (clvVal !== null) cumClv += clvVal > 0 ? 1 : clvVal < 0 ? -1 : 0; // direction tally
    if (cumUnits > peak) peak = cumUnits;
    points.push({
      date: e.date,
      clv: cumClv,
      cumUnits,
      drawdownUnits: Math.round((cumUnits - peak) * 100) / 100,
    });
  }
  return points;
}

function heatmap(sport: string, tierFilter: string | null): HeatCell[] {
  const tiers = hitRatesByTier(sport === "ALL" ? "MLB" : sport);
  const cells: HeatCell[] = [];
  for (const t of tiers) {
    if (tierFilter && tierFilter !== "ALL" && t.tier !== tierFilter) continue;
    for (const w of t.windows) {
      cells.push({
        tier: t.tier,
        windowDays: w.windowDays,
        pct: w.pct,
        decided: w.wins + w.losses,
      });
    }
  }
  return cells.sort(
    (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.windowDays - b.windowDays,
  );
}

// Graded prop rows → a KindBreakdown. Staked is 1u-equivalent per prop (matching
// buildPropAnalytics), netUnits from pl_units. Tier filter applied in-memory.
function propKindBreakdown(rows: { result: string | null; pl_units: number | null; tier: string }[]): KindBreakdown {
  let wins = 0, losses = 0, pushes = 0, netUnits = 0, staked = 0;
  for (const r of rows) {
    if (r.result === "W") wins++;
    else if (r.result === "L") losses++;
    else pushes++;
    netUnits += r.pl_units ?? 0;
    staked += 1;
  }
  return {
    kind: "prop",
    bets: rows.length,
    wins, losses, pushes,
    netUnits: Math.round(netUnits * 100) / 100,
    roiPct: staked > 0 ? Math.round((netUnits / staked) * 1000) / 10 : 0,
  };
}

function gameKindBreakdown(log: BetLogEntry[]): KindBreakdown {
  let wins = 0, losses = 0, pushes = 0, netUnits = 0, staked = 0;
  for (const e of log) {
    if (e.result === "W") wins++;
    else if (e.result === "L") losses++;
    else pushes++;
    netUnits += e.unitsWon;
    staked += e.units;
  }
  return {
    kind: "game",
    bets: log.length,
    wins, losses, pushes,
    netUnits: Math.round(netUnits * 100) / 100,
    roiPct: staked > 0 ? Math.round((netUnits / staked) * 1000) / 10 : 0,
  };
}

export function buildAnalytics(filters: AnalyticsFilters = {}): AnalyticsPayload {
  const sport = (filters.sport ?? "ALL").toUpperCase();
  const tier = (filters.tier ?? "ALL").toUpperCase();
  const since = filters.since ?? null;
  const engineVersion = (filters.engineVersion ?? "ALL");
  const ev = engineVersion.toUpperCase();

  const tr = trackRecord("MLB");
  // v6.9.0 engine-version filter on the game-line betLog: history rows are not yet
  // version-tagged per-row, so untagged game-line history == the "current" engine.
  // When the filter narrows to a legacy bucket, the game-line log is empty (those
  // rows predate per-row tagging); "current"/"ALL" keep the full log.
  const evIsLegacy = ev !== "ALL" && ev !== "CURRENT";
  const log = evIsLegacy ? [] : filterLog(tr.betLog, { sport, tier, since });

  // Player-prop graded rows (back-compat /api/props/analytics is unchanged; this
  // is the unified roll-up). Tier filter narrows to actionable tier when set.
  const propRows = gradedPropPicks({
    sport: sport === "ALL" ? null : sport,
    since,
    engineVersion,
  }).filter((r) => tier === "ALL" || (r.tier ?? "").toUpperCase() === tier);

  const game = gameKindBreakdown(log);
  const prop = propKindBreakdown(propRows);

  // Combined headline KPIs across both kinds.
  const combinedBets = game.bets + prop.bets;
  const combinedWins = game.wins + prop.wins;
  const combinedLosses = game.losses + prop.losses;
  const combinedDecided = combinedWins + combinedLosses;
  const combinedNet = Math.round((game.netUnits + prop.netUnits) * 100) / 100;
  const gameStaked = log.reduce((s, e) => s + e.units, 0);
  const combinedStaked = gameStaked + prop.bets; // props 1u-equivalent
  const baseKpis = computeKpis(log, tr.clvPct);
  const kpis: KpiCards = {
    ...baseKpis,
    totalBets: combinedBets,
    winRatePct: combinedDecided > 0 ? Math.round((combinedWins / combinedDecided) * 1000) / 10 : 0,
    roiPct: combinedStaked > 0 ? Math.round((combinedNet / combinedStaked) * 1000) / 10 : 0,
    netUnits: combinedNet,
  };

  // Played-tier counts across both kinds (actionable tiers only).
  const tierCounts = new Map<string, number>();
  for (const e of log) tierCounts.set(e.tier, (tierCounts.get(e.tier) ?? 0) + 1);
  for (const r of propRows) {
    const t = (r.tier ?? "").toUpperCase();
    if (TIER_ORDER.includes(t)) tierCounts.set(t, (tierCounts.get(t) ?? 0) + 1);
  }
  const byTier: PlayedTier[] = TIER_ORDER.map((t) => ({ tier: t, bets: tierCounts.get(t) ?? 0 }));

  return {
    filters: { sport, tier, since, engineVersion },
    available: {
      sports: ["ALL", ...SPORTS],
      tiers: ["ALL", ...TIER_ORDER],
      engineVersions: availableEngineVersions(),
    },
    kpis,
    winRateByTier: winRateByTier(log),
    roiBySport: roiBySport(log),
    trend: trend(log),
    heatmap: heatmap(sport, tier),
    clv: clvAggregate({ sport, tier, since }),
    byKind: [game, prop],
    byTier,
    passSummary: passSummary({ sport: sport === "ALL" ? null : sport, since }),
  };
}
