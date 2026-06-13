// Track Record + hit-rate views, computed entirely from the graded book — the
// desk's real, settled picks. There is no seed/sample data: an empty book yields
// empty arrays and zero KPIs, and the UI shows "No graded picks yet". Hit rates
// by tier are aggregated over rolling 30/60/90-day windows of graded picks.

import { gradedPicks, pickHistory, type GradedPick, type PickHistoryRow } from "../../gradedBook";
import { DISPLAY_TIMEZONE } from "../../utils/timezone";

export const HIT_RATE_WINDOWS = [30, 60, 90];

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

function daysAgoIso(days: number, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now.getTime() - days * 86_400_000));
}

// Hit rate by tier across the 30/60/90-day windows, from graded picks only.
export function hitRatesByTier(sport = "MLB", now: Date = new Date()): TierHitRate[] {
  const rows = gradedPicks(sport);
  const byTier = new Map<string, TierHitRate>();
  for (const w of HIT_RATE_WINDOWS) {
    const cutoff = daysAgoIso(w, now);
    for (const r of rows) {
      if (r.gameDate < cutoff) continue;
      if (!byTier.has(r.tier)) byTier.set(r.tier, { tier: r.tier, windows: [] });
      const t = byTier.get(r.tier)!;
      let cell = t.windows.find((x) => x.windowDays === w);
      if (!cell) {
        cell = { windowDays: w, pct: 0, wins: 0, losses: 0, pushes: 0, unitsWon: 0 };
        t.windows.push(cell);
      }
      if (r.result === "W") cell.wins++;
      else if (r.result === "L") cell.losses++;
      else if (r.result === "P") cell.pushes++;
      cell.unitsWon = Math.round((cell.unitsWon + (r.pl ?? 0)) * 100) / 100;
    }
  }
  for (const t of byTier.values()) {
    for (const c of t.windows) {
      const decided = c.wins + c.losses;
      c.pct = decided > 0 ? Math.round((c.wins / decided) * 100) : 0;
    }
    t.windows.sort((a, b) => a.windowDays - b.windowDays);
  }
  return [...byTier.values()];
}

// Date portion (YYYY-MM-DD) of an ISO graded_at timestamp, for the bet log's
// date field + the analytics since-filter (which compares date strings).
function gradedDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function toBetLog(rows: PickHistoryRow[]): BetLogEntry[] {
  return rows.map((r) => ({
    date: gradedDate(r.graded_at),
    matchup: r.pick_label,
    pick: r.pick_label,
    tier: r.tier,
    units: r.stake_units,
    result: (r.result ?? "P") as "W" | "L" | "P",
    clv: r.clv_pct !== null ? `${r.clv_pct.toFixed(1)}%` : "—",
    unitsWon: r.pl_units ?? 0,
  }));
}

// Headline track-record stats + full graded bet log. Aggregated from the
// permanent pick_history ledger so lifetime stats survive a wipe of the live
// picks table. An empty ledger returns zeroes and an empty log.
export function trackRecord(sport = "MLB"): TrackRecordSummary {
  const rows = pickHistory(sport);
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let netUnits = 0;
  let staked = 0;
  let clvSum = 0;
  let clvN = 0;
  for (const r of rows) {
    if (r.result === "W") wins++;
    else if (r.result === "L") losses++;
    else pushes++;
    netUnits += r.pl_units ?? 0;
    staked += r.stake_units;
    if (r.clv_pct !== null) {
      clvSum += r.clv_pct;
      clvN++;
    }
  }
  const totalBets = wins + losses + pushes;
  const roiPct = staked > 0 ? Math.round((netUnits / staked) * 1000) / 10 : 0;

  return {
    clvPct: clvN > 0 ? Math.round((clvSum / clvN) * 10) / 10 : 0,
    evRealizedUnits: Math.round(netUnits * 10) / 10,
    roiPct,
    maxDrawdownUnits: maxDrawdown(rows),
    totalBets,
    record: { wins, losses, pushes },
    betLog: toBetLog(rows),
  };
}

// Largest peak-to-trough drop of the running net-units curve (≥ 0), in units.
// Chronological by graded_at since history rows aren't game-dated.
function maxDrawdown(rows: PickHistoryRow[]): number {
  const chron = [...rows].sort((a, b) => a.graded_at.localeCompare(b.graded_at));
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const r of chron) {
    cum += r.pl_units ?? 0;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return Math.round(maxDd * 100) / 100;
}
