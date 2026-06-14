// Prop-specific analytics. Aggregates the graded prop_picks ledger into the
// shape the Analytics page's "Player props" section renders: headline record +
// ROI + CLV, a per-market breakdown, a per-player breakdown (top 10 by sample),
// accuracy by line distance, and a data-quality-tier breakdown. An empty ledger
// returns a zeroed shape (no fabricated rows) so the UI degrades gracefully.

import { gradedPropPicks, type PropPickRow } from "../../gradedBook";

export interface PropRecord {
  wins: number;
  losses: number;
  pushes: number;
}

export interface MarketBreakdown extends PropRecord {
  market_type: string;
  bets: number;
  roiPct: number;
  netUnits: number;
}

export interface PlayerBreakdown extends PropRecord {
  player_name: string;
  bets: number;
  netUnits: number;
}

export interface LineDistanceBucket {
  label: string; // e.g. "within 10%", "10–25%", "25%+"
  decided: number;
  hitRatePct: number;
}

export interface DataQualityBreakdown extends PropRecord {
  data_quality_tier: string;
  bets: number;
}

// Calibration check (spec §9): of the OVER picks where the player's L10 hit rate
// was ≥ 0.60 (a strong directional read), how often did the bet actually win? A
// well-calibrated model wins these well above 50%.
export interface CalibrationCheck {
  qualifying: number; // decided OVER picks with L10 ≥ 0.60
  wins: number;
  hitRatePct: number; // wins / qualifying
}

// Minimum graded props before the analytics tile stops flagging small-sample.
export const SAMPLE_WARNING_THRESHOLD = 100;
export const CALIBRATION_L10_FLOOR = 0.6;

export interface PropAnalyticsPayload {
  totalPicks: number;
  record: PropRecord;
  roiPct: number;
  netUnits: number;
  clvMeanPct: number;
  sampleWarning: boolean; // true until ≥ 100 graded props
  byMarket: MarketBreakdown[];
  byPlayer: PlayerBreakdown[];
  byLineDistance: LineDistanceBucket[];
  byDataQuality: DataQualityBreakdown[];
  calibration: CalibrationCheck;
}

function emptyRecord(): PropRecord {
  return { wins: 0, losses: 0, pushes: 0 };
}

function tally(rec: PropRecord, result: string): void {
  if (result === "W") rec.wins++;
  else if (result === "L") rec.losses++;
  else rec.pushes++;
}

function roi(netUnits: number, staked: number): number {
  return staked > 0 ? Math.round((netUnits / staked) * 1000) / 10 : 0;
}

export function buildPropAnalytics(
  opts: { sport?: string | null; since?: string | null; engineVersion?: string | null } = {},
): PropAnalyticsPayload {
  const rows = gradedPropPicks(opts);

  const record = emptyRecord();
  let netUnits = 0;
  let staked = 0;
  let clvSum = 0;
  let clvN = 0;
  for (const r of rows) {
    tally(record, r.result ?? "");
    netUnits += r.pl_units ?? 0;
    staked += 1; // 1-unit-equivalent stake per prop (see gradeProp)
    if (r.clv_pct != null) {
      clvSum += r.clv_pct;
      clvN++;
    }
  }

  return {
    totalPicks: rows.length,
    record,
    roiPct: roi(netUnits, staked),
    netUnits: Math.round(netUnits * 100) / 100,
    clvMeanPct: clvN > 0 ? Math.round((clvSum / clvN) * 100) / 100 : 0,
    sampleWarning: rows.length < SAMPLE_WARNING_THRESHOLD,
    byMarket: byMarket(rows),
    byPlayer: byPlayer(rows),
    byLineDistance: byLineDistance(rows),
    byDataQuality: byDataQuality(rows),
    calibration: calibrationCheck(rows),
  };
}

// Pull the stored L10 hit rate off the prop's hit_rates_json snapshot and test
// the OVER-side calibration claim. Pushes don't count as decided. Rows without a
// snapshot (pre-v6.7) are skipped.
function calibrationCheck(rows: PropPickRow[]): CalibrationCheck {
  let qualifying = 0;
  let wins = 0;
  for (const r of rows) {
    if (r.side !== "over" || r.result === "P" || !r.result) continue;
    const l10 = parseL10Rate(r.hit_rates_json);
    if (l10 === null || l10 < CALIBRATION_L10_FLOOR) continue;
    qualifying++;
    if (r.result === "W") wins++;
  }
  return {
    qualifying,
    wins,
    hitRatePct: qualifying > 0 ? Math.round((wins / qualifying) * 1000) / 10 : 0,
  };
}

function parseL10Rate(json: string | null): number | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { l10?: { rate?: number | null } };
    return parsed?.l10?.rate ?? null;
  } catch {
    return null;
  }
}

function byMarket(rows: PropPickRow[]): MarketBreakdown[] {
  const by = new Map<string, MarketBreakdown>();
  for (const r of rows) {
    const key = r.market_type;
    if (!by.has(key)) {
      by.set(key, { market_type: key, bets: 0, netUnits: 0, roiPct: 0, ...emptyRecord() });
    }
    const m = by.get(key)!;
    m.bets++;
    m.netUnits = Math.round((m.netUnits + (r.pl_units ?? 0)) * 100) / 100;
    tally(m, r.result ?? "");
  }
  for (const m of by.values()) m.roiPct = roi(m.netUnits, m.bets);
  return [...by.values()].sort((a, b) => b.bets - a.bets);
}

function byPlayer(rows: PropPickRow[]): PlayerBreakdown[] {
  const by = new Map<string, PlayerBreakdown>();
  for (const r of rows) {
    const key = r.player_name;
    if (!by.has(key)) {
      by.set(key, { player_name: key, bets: 0, netUnits: 0, ...emptyRecord() });
    }
    const p = by.get(key)!;
    p.bets++;
    p.netUnits = Math.round((p.netUnits + (r.pl_units ?? 0)) * 100) / 100;
    tally(p, r.result ?? "");
  }
  return [...by.values()].sort((a, b) => b.bets - a.bets).slice(0, 10);
}

// Accuracy by how far the posted line sat from the player's actual value, used
// as a stand-in for "distance from our projection" until per-prop projections
// are stored. Buckets: within 10%, 10–25%, 25%+ of the line.
function byLineDistance(rows: PropPickRow[]): LineDistanceBucket[] {
  const buckets: { label: string; max: number; decided: number; wins: number }[] = [
    { label: "within 10%", max: 0.1, decided: 0, wins: 0 },
    { label: "10–25%", max: 0.25, decided: 0, wins: 0 },
    { label: "25%+", max: Infinity, decided: 0, wins: 0 },
  ];
  for (const r of rows) {
    if (r.result === "P" || r.actual_value == null || r.line === 0) continue;
    const dist = Math.abs(r.actual_value - r.line) / Math.abs(r.line);
    const b = buckets.find((x) => dist <= x.max)!;
    b.decided++;
    if (r.result === "W") b.wins++;
  }
  return buckets.map((b) => ({
    label: b.label,
    decided: b.decided,
    hitRatePct: b.decided > 0 ? Math.round((b.wins / b.decided) * 1000) / 10 : 0,
  }));
}

function byDataQuality(rows: PropPickRow[]): DataQualityBreakdown[] {
  const by = new Map<string, DataQualityBreakdown>();
  for (const r of rows) {
    const key = r.data_quality_tier ?? "unknown";
    if (!by.has(key)) {
      by.set(key, { data_quality_tier: key, bets: 0, ...emptyRecord() });
    }
    const d = by.get(key)!;
    d.bets++;
    tally(d, r.result ?? "");
  }
  return [...by.values()].sort((a, b) => b.bets - a.bets);
}
