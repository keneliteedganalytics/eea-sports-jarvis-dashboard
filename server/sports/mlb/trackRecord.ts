// Track Record + hit-rate cache. Seeds illustrative 30/60/90-day tier hit
// rates and a bet log so the /#/track-record route and per-card hit-rate
// footer render shell data on first boot. Real settlement would populate
// outcomes via the ESPN scoreboard adapter.

import { storage } from "../../storage";

export const HIT_RATE_WINDOWS = [30, 60, 90];

interface SeedRow {
  tier: string;
  byWindow: Record<number, { wins: number; losses: number; pushes: number; unitsWon: number }>;
}

// Illustrative seed data — descending hit rate by window, by tier strength.
const SEED: SeedRow[] = [
  { tier: "BONUS", byWindow: { 30: { wins: 9, losses: 4, pushes: 0, unitsWon: 6.8 }, 60: { wins: 17, losses: 9, pushes: 1, unitsWon: 11.2 }, 90: { wins: 24, losses: 15, pushes: 1, unitsWon: 13.5 } } },
  { tier: "SNIPER", byWindow: { 30: { wins: 12, losses: 7, pushes: 0, unitsWon: 5.1 }, 60: { wins: 22, losses: 15, pushes: 1, unitsWon: 7.4 }, 90: { wins: 31, losses: 24, pushes: 1, unitsWon: 8.9 } } },
  { tier: "EDGE", byWindow: { 30: { wins: 15, losses: 11, pushes: 1, unitsWon: 3.2 }, 60: { wins: 28, losses: 22, pushes: 1, unitsWon: 4.6 }, 90: { wins: 40, losses: 34, pushes: 2, unitsWon: 5.5 } } },
  { tier: "RECON", byWindow: { 30: { wins: 10, losses: 9, pushes: 0, unitsWon: 1.1 }, 60: { wins: 19, losses: 18, pushes: 1, unitsWon: 1.8 }, 90: { wins: 27, losses: 27, pushes: 1, unitsWon: 1.4 } } },
  { tier: "VALUE", byWindow: { 30: { wins: 8, losses: 8, pushes: 0, unitsWon: 0.4 }, 60: { wins: 15, losses: 16, pushes: 0, unitsWon: -0.3 }, 90: { wins: 22, losses: 23, pushes: 1, unitsWon: 0.2 } } },
];

export function seedHitRates(sport = "MLB"): void {
  const existing = storage.hitRates(sport);
  if (existing.length > 0) return;
  for (const row of SEED) {
    for (const w of HIT_RATE_WINDOWS) {
      const cell = row.byWindow[w];
      storage.upsertHitRate({
        sport,
        tier: row.tier,
        windowDays: w,
        wins: cell.wins,
        losses: cell.losses,
        pushes: cell.pushes,
        unitsWon: cell.unitsWon,
      });
    }
  }
}

export interface TierHitRate {
  tier: string;
  windows: { windowDays: number; pct: number; wins: number; losses: number; pushes: number; unitsWon: number }[];
}

export function hitRatesByTier(sport = "MLB"): TierHitRate[] {
  const rows = storage.hitRates(sport);
  const byTier = new Map<string, TierHitRate>();
  for (const r of rows) {
    if (!byTier.has(r.tier)) byTier.set(r.tier, { tier: r.tier, windows: [] });
    const decided = r.wins + r.losses;
    const pct = decided > 0 ? Math.round((r.wins / decided) * 100) : 0;
    byTier.get(r.tier)!.windows.push({
      windowDays: r.windowDays,
      pct,
      wins: r.wins,
      losses: r.losses,
      pushes: r.pushes,
      unitsWon: r.unitsWon,
    });
  }
  for (const t of byTier.values()) t.windows.sort((a, b) => a.windowDays - b.windowDays);
  return [...byTier.values()];
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

// Aggregate the 90-day window into headline track-record stats + a shell log.
export function trackRecord(sport = "MLB"): TrackRecordSummary {
  const rows = storage.hitRates(sport).filter((r) => r.windowDays === 90);
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let unitsWon = 0;
  for (const r of rows) {
    wins += r.wins;
    losses += r.losses;
    pushes += r.pushes;
    unitsWon += r.unitsWon;
  }
  const totalBets = wins + losses + pushes;
  const staked = totalBets * 1.5; // ~1.5u average stake
  const roiPct = staked > 0 ? Math.round((unitsWon / staked) * 1000) / 10 : 0;

  return {
    clvPct: 2.3,
    evRealizedUnits: Math.round(unitsWon * 10) / 10,
    roiPct,
    maxDrawdownUnits: 6.4,
    totalBets,
    record: { wins, losses, pushes },
    betLog: SAMPLE_LOG,
  };
}

const SAMPLE_LOG: BetLogEntry[] = [
  { date: "2026-06-06", matchup: "LAD @ SF", pick: "LAD ML -135", tier: "BONUS", units: 2.5, result: "W", clv: "-128", unitsWon: 1.85 },
  { date: "2026-06-06", matchup: "NYY @ BOS", pick: "NYY ML -165", tier: "SNIPER", units: 2.0, result: "W", clv: "-172", unitsWon: 1.21 },
  { date: "2026-06-05", matchup: "HOU @ SEA", pick: "SEA ML -110", tier: "EDGE", units: 1.5, result: "L", clv: "-105", unitsWon: -1.5 },
  { date: "2026-06-05", matchup: "ATL @ NYM", pick: "ATL ML -148", tier: "EDGE", units: 1.5, result: "W", clv: "-152", unitsWon: 1.01 },
  { date: "2026-06-04", matchup: "ARI @ COL", pick: "ARI ML -180", tier: "RECON", units: 1.0, result: "P", clv: "-178", unitsWon: 0 },
];
