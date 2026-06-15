// LHP/RHP handedness splits — v6.10 engine.
// Fetches team batting splits vs. left-handed and right-handed pitching from
// the MLB Stats API (sitCodes=vl,vr).  Returns wOBA, OPS, K% for each platoon.
// Cache keyed by (teamId, season) with a 24-hour TTL.

import { getJson } from "../../adapters/http";

const BASE = "https://statsapi.mlb.com/api/v1";

// ── In-memory cache ──────────────────────────────────────────────────────────
interface CacheEntry {
  value: HandednessSplit;
  expiresAt: number;
}
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 24 * 60 * 60 * 1000;

function cacheKey(teamId: number, season: number): string {
  return `${teamId}:${season}`;
}

// ── Public interface ─────────────────────────────────────────────────────────

export interface HandednessSlice {
  wOBA: number | null;
  ops: number | null;
  kPct: number | null; // strikeouts / plate appearances (0-1 range)
}

export interface HandednessSplit {
  teamId: number;
  triCode: string;
  vsLHP: HandednessSlice;
  vsRHP: HandednessSlice;
  staleness: "fresh" | "cached" | "missing";
}

// ── MLB Stats API raw shapes ─────────────────────────────────────────────────

// Linear weights for wOBA (same constants as teamOffenseSaber.ts — 2026 calibration).
const W_uBB = 0.69;
const W_HBP  = 0.72;
const W_1B   = 0.89;
const W_2B   = 1.27;
const W_3B   = 1.62;
const W_HR   = 2.10;

interface RawSplitStat {
  atBats?: number | null;
  baseOnBalls?: number | null;
  intentionalWalks?: number | null;
  hitByPitch?: number | null;
  hits?: number | null;
  doubles?: number | null;
  triples?: number | null;
  homeRuns?: number | null;
  sacFlies?: number | null;
  strikeOuts?: number | null;
  plateAppearances?: number | null;
  ops?: string | number | null;
}

interface RawStatSplit {
  stat?: RawSplitStat;
  // sitCode is present when the split was requested via sitCodes param.
  // Values observed: "vl" (vs. left-handed), "vr" (vs. right-handed).
  sitCode?: string;
  split?: { code?: string };
}

interface RawTeamStatGroup {
  splits?: RawStatSplit[];
}

interface RawTeamStats {
  stats?: RawTeamStatGroup[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function wOBAFromStat(s: RawSplitStat): number | null {
  const ab   = toNum(s.atBats) ?? 0;
  const bb   = toNum(s.baseOnBalls) ?? 0;
  const ibb  = toNum(s.intentionalWalks) ?? 0;
  const hbp  = toNum(s.hitByPitch) ?? 0;
  const h    = toNum(s.hits) ?? 0;
  const d    = toNum(s.doubles) ?? 0;
  const t    = toNum(s.triples) ?? 0;
  const hr   = toNum(s.homeRuns) ?? 0;
  const sf   = toNum(s.sacFlies) ?? 0;

  const uBB = Math.max(0, bb - ibb);
  const singles = Math.max(0, h - d - t - hr);

  const num = W_uBB * uBB + W_HBP * hbp + W_1B * singles + W_2B * d + W_3B * t + W_HR * hr;
  const den = ab + uBB + sf + hbp;
  if (den <= 0) return null;
  return Math.round((num / den) * 10000) / 10000;
}

function kPctFromStat(s: RawSplitStat): number | null {
  const k = toNum(s.strikeOuts);
  const pa = toNum(s.plateAppearances);
  if (k === null || !pa || pa <= 0) return null;
  return Math.round((k / pa) * 10000) / 10000;
}

function sliceFromStat(s: RawSplitStat | undefined): HandednessSlice {
  if (!s) return { wOBA: null, ops: null, kPct: null };
  return {
    wOBA: wOBAFromStat(s),
    ops: toNum(s.ops),
    kPct: kPctFromStat(s),
  };
}

// Determine the sitCode from a split record.  MLB Stats API returns it either
// directly on the split object or nested under split.code.
function getSitCode(split: RawStatSplit): string | null {
  return split.sitCode ?? split.split?.code ?? null;
}

const EMPTY_SLICE: HandednessSlice = { wOBA: null, ops: null, kPct: null };

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch LHP/RHP handedness splits for a team for the given season.
 * Returns a MISSING entry (all null) if the API returns no data.
 */
export async function getHandednessSplit(
  teamId: number,
  triCode: string,
  season?: number,
): Promise<HandednessSplit> {
  const yr = season ?? new Date().getUTCFullYear();
  const key = cacheKey(teamId, yr);

  const cached = CACHE.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...cached.value, staleness: "cached" };
  }

  const missing: HandednessSplit = {
    teamId,
    triCode,
    vsLHP: { ...EMPTY_SLICE },
    vsRHP: { ...EMPTY_SLICE },
    staleness: "missing",
  };

  try {
    // MLB Stats API: statSplits with sitCodes=vl,vr returns two splits in the
    // same response.  One has sitCode "vl" (vs. LHP), one has "vr" (vs. RHP).
    const res = await getJson<RawTeamStats>(`${BASE}/teams/${teamId}/stats`, {
      stats: "statSplits",
      group: "hitting",
      sitCodes: "vl,vr",
      season: yr,
    });

    if (!res.ok || !res.data) {
      CACHE.set(key, { value: missing, expiresAt: Date.now() + TTL_MS });
      return missing;
    }

    // Flatten all splits across all stat groups.
    const allSplits: RawStatSplit[] = [];
    for (const sg of res.data.stats ?? []) {
      for (const sp of sg.splits ?? []) {
        allSplits.push(sp);
      }
    }

    const vsLHPSplit = allSplits.find((sp) => {
      const code = getSitCode(sp);
      return code === "vl" || code === "vsLeft" || code === "vs_lhp";
    });
    const vsRHPSplit = allSplits.find((sp) => {
      const code = getSitCode(sp);
      return code === "vr" || code === "vsRight" || code === "vs_rhp";
    });

    const result: HandednessSplit = {
      teamId,
      triCode,
      vsLHP: sliceFromStat(vsLHPSplit?.stat),
      vsRHP: sliceFromStat(vsRHPSplit?.stat),
      staleness: "fresh",
    };

    CACHE.set(key, { value: result, expiresAt: Date.now() + TTL_MS });
    return result;
  } catch {
    if (cached) return { ...cached.value, staleness: "cached" };
    return missing;
  }
}

/**
 * Compute the wOBA delta for a team facing a pitcher of the given handedness,
 * relative to their season-wide baseline wOBA.
 *
 * A team that crushes lefties might return +0.030 when opposingPitcherHand='L'.
 * Neutral (missing data) returns 0.
 *
 * @param team                 HandednessSplit record for the batting team.
 * @param opposingPitcherHand  'L' or 'R' — handedness of the opposing SP.
 * @param baselineWOBA         Team's season-wide wOBA (from TeamOffenseSaber).
 */
export function deltaVsOpposingHand(
  team: HandednessSplit,
  opposingPitcherHand: "L" | "R",
  baselineWOBA: number,
): number {
  const slice = opposingPitcherHand === "L" ? team.vsLHP : team.vsRHP;
  if (slice.wOBA === null) return 0;
  return Math.round((slice.wOBA - baselineWOBA) * 10000) / 10000;
}

/** Evict all cached entries (useful in tests). */
export function _clearHandednessSplitCache(): void {
  CACHE.clear();
}
