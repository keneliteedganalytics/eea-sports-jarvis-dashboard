// Team offensive sabermetric aggregates — wRC+, wOBA, ISO — v6.10 engine.
// All data sourced from MLB Stats API (no auth required).
// Cache keyed by (teamId, season) with a 24-hour TTL.

import { getJson } from "../../adapters/http";
import { parkFactorForTeam } from "./weather";

const BASE = "https://statsapi.mlb.com/api/v1";

// ── League constants (calibrated to 2026 MLB-wide rates) ─────────────────────
// These mirror FanGraphs park-adjusted league baselines for the current season.
export const LG_WOBA = 0.318;        // league-average wOBA
export const WOBA_SCALE = 1.16;      // wOBAscale (converts wOBA to runs above average per PA)
export const LG_RUNS_PER_PA = 0.119; // league runs/PA ≈ 4.3 R/G ÷ 36 PA/G

// Linear weights for the wOBA formula (2026 calibration, FanGraphs standard).
const W_uBB  = 0.69;
const W_HBP  = 0.72;
const W_1B   = 0.89;
const W_2B   = 1.27;
const W_3B   = 1.62;
const W_HR   = 2.10;

// ── In-memory cache ──────────────────────────────────────────────────────────
interface CacheEntry {
  value: TeamOffenseSaber;
  expiresAt: number;
}
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 24 * 60 * 60 * 1000;

function cacheKey(teamId: number, season: number): string {
  return `${teamId}:${season}`;
}

// ── Public interface ─────────────────────────────────────────────────────────

export interface TeamOffenseSaber {
  teamId: number;
  triCode: string;
  season: number;
  // wOBA computed from counting stats using linear-weight formula.
  wOBA: number | null;
  // ISO = SLG - AVG (extra-base power metric).
  iso: number | null;
  // wRC+ = park- and league-adjusted wRC.  100 = exactly league average.
  wRCplus: number | null;
  staleness: "fresh" | "cached" | "missing";
}

// ── MLB Stats API raw shapes ─────────────────────────────────────────────────

interface RawHittingStat {
  atBats?: number | null;
  baseOnBalls?: number | null;       // walks (BB), includes IBB
  intentionalWalks?: number | null;  // IBB (to subtract)
  hitByPitch?: number | null;
  hits?: number | null;
  doubles?: number | null;
  triples?: number | null;
  homeRuns?: number | null;
  sacFlies?: number | null;
  avg?: string | number | null;
  slg?: string | number | null;
}

interface RawStatSplit {
  stat?: RawHittingStat;
}

interface RawTeamStats {
  stats?: { splits?: RawStatSplit[] }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// ── Core computation ─────────────────────────────────────────────────────────

/**
 * Compute team wOBA from counting stats using the standard linear-weights formula:
 *
 *   wOBA = (0.69·uBB + 0.72·HBP + 0.89·1B + 1.27·2B + 1.62·3B + 2.10·HR)
 *          / (AB + BB − IBB + SF + HBP)
 */
function computeWOBA(s: RawHittingStat): number | null {
  const ab   = toNum(s.atBats) ?? 0;
  const bb   = toNum(s.baseOnBalls) ?? 0;
  const ibb  = toNum(s.intentionalWalks) ?? 0;
  const hbp  = toNum(s.hitByPitch) ?? 0;
  const h    = toNum(s.hits) ?? 0;
  const d    = toNum(s.doubles) ?? 0;
  const t    = toNum(s.triples) ?? 0;
  const hr   = toNum(s.homeRuns) ?? 0;
  const sf   = toNum(s.sacFlies) ?? 0;

  const uBB = bb - ibb; // unintentional walks only
  const singles = h - d - t - hr;

  const numerator = W_uBB * uBB + W_HBP * hbp + W_1B * singles + W_2B * d + W_3B * t + W_HR * hr;
  const denominator = ab + uBB + sf + hbp;

  if (denominator <= 0) return null;
  const wOBA = numerator / denominator;
  return Math.round(wOBA * 10000) / 10000;
}

/**
 * Compute wRC+ using the park-factor- and league-adjusted formula:
 *
 *   wRC+ = (((wOBA − lgWOBA) / wOBAscale + lgRunsPerPA) / (lgRunsPerPA × parkFactor)) × 100
 *
 * Returns 100 for a league-average team, >100 for above-average.
 */
function computeWRCplus(wOBA: number, parkFactor: number): number {
  const wRCperPA = (wOBA - LG_WOBA) / WOBA_SCALE + LG_RUNS_PER_PA;
  const lgWRCperPA = LG_RUNS_PER_PA * parkFactor;
  if (lgWRCperPA <= 0) return 100;
  const wRCplus = (wRCperPA / lgWRCperPA) * 100;
  // Clamp to a realistic range (40–200) to prevent data-artefact blow-ups.
  return Math.round(Math.max(40, Math.min(200, wRCplus)));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch team offensive sabermetrics (wRC+, wOBA, ISO) for the given team/season.
 * Returns a MISSING entry if the API returns no data rather than throwing.
 *
 * @param teamId  MLB Stats API numeric team id.
 * @param triCode Team tri-code (for park factor lookup).
 * @param season  Season year; defaults to current UTC year.
 */
export async function getTeamOffenseSaber(
  teamId: number,
  triCode: string,
  season?: number,
): Promise<TeamOffenseSaber> {
  const yr = season ?? new Date().getUTCFullYear();
  const key = cacheKey(teamId, yr);

  const cached = CACHE.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...cached.value, staleness: "cached" };
  }

  const missing: TeamOffenseSaber = {
    teamId,
    triCode,
    season: yr,
    wOBA: null,
    iso: null,
    wRCplus: null,
    staleness: "missing",
  };

  try {
    const res = await getJson<RawTeamStats>(`${BASE}/teams/${teamId}/stats`, {
      stats: "season",
      group: "hitting",
      season: yr,
    });

    if (!res.ok || !res.data) {
      CACHE.set(key, { value: missing, expiresAt: Date.now() + TTL_MS });
      return missing;
    }

    const split = res.data.stats?.[0]?.splits?.[0]?.stat;
    if (!split) {
      CACHE.set(key, { value: missing, expiresAt: Date.now() + TTL_MS });
      return missing;
    }

    const wOBA = computeWOBA(split);
    const slg = toNum(split.slg);
    const avg = toNum(split.avg);
    const iso = slg !== null && avg !== null ? Math.round((slg - avg) * 10000) / 10000 : null;

    let wRCplus: number | null = null;
    if (wOBA !== null) {
      const parkFactor = parkFactorForTeam(triCode);
      wRCplus = computeWRCplus(wOBA, parkFactor);
    }

    const result: TeamOffenseSaber = {
      teamId,
      triCode,
      season: yr,
      wOBA,
      iso,
      wRCplus,
      staleness: "fresh",
    };

    CACHE.set(key, { value: result, expiresAt: Date.now() + TTL_MS });
    return result;
  } catch {
    if (cached) return { ...cached.value, staleness: "cached" };
    return missing;
  }
}

/** Evict all cached entries (useful in tests). */
export function _clearTeamOffenseSaberCache(): void {
  CACHE.clear();
}

// Re-export helpers for tests
export { computeWOBA as _computeWOBA, computeWRCplus as _computeWRCplus };
