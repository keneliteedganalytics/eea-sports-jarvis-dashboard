// Analytics aggregation layer. Reuses the hit-rate cache + bet log that power
// the Track Record page and rolls them into the views the /analytics dashboard
// renders: headline KPIs, win-rate by tier, ROI by sport, a CLV trend line, a
// running drawdown curve, and a tier×window hit-rate heatmap. All figures are
// derived from the same seeded store, so Analytics and Track Record never
// disagree. Filters (sport / tier / since-date) are applied to the bet log.

import { hitRatesByTier, trackRecord, type BetLogEntry } from "./sports/mlb/trackRecord";

const TIER_ORDER = ["BONUS", "SNIPER", "EDGE", "RECON", "VALUE", "LEAN"];
const SPORTS = ["MLB", "NHL", "NBA", "SOCCER"];

export interface AnalyticsFilters {
  sport?: string | null; // "ALL" | one of SPORTS
  tier?: string | null; // "ALL" | one of TIER_ORDER
  since?: string | null; // YYYY-MM-DD inclusive lower bound
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

export interface AnalyticsPayload {
  filters: { sport: string; tier: string; since: string | null };
  available: { sports: string[]; tiers: string[] };
  kpis: KpiCards;
  winRateByTier: TierWinRate[];
  roiBySport: SportRoi[];
  trend: TrendPoint[];
  heatmap: HeatCell[];
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

export function buildAnalytics(filters: AnalyticsFilters = {}): AnalyticsPayload {
  const sport = (filters.sport ?? "ALL").toUpperCase();
  const tier = (filters.tier ?? "ALL").toUpperCase();
  const since = filters.since ?? null;

  const tr = trackRecord("MLB");
  const log = filterLog(tr.betLog, { sport, tier, since });

  return {
    filters: { sport, tier, since },
    available: { sports: ["ALL", ...SPORTS], tiers: ["ALL", ...TIER_ORDER] },
    kpis: computeKpis(log, tr.clvPct),
    winRateByTier: winRateByTier(log),
    roiBySport: roiBySport(log),
    trend: trend(log),
    heatmap: heatmap(sport, tier),
  };
}
