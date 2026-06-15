// Pitcher sabermetric metrics — xFIP, WHIP, K-BB% — v6.10 engine.
// All data sourced from MLB Stats API (no auth required).
// Cache keyed by (playerId, season) with a 24-hour TTL so slate builds never
// block on repeat fetches within the same operating day.

import { getJson } from "../../adapters/http";

const BASE = "https://statsapi.mlb.com/api/v1";

// ── League constants (FanGraphs-calibrated, 2026 season) ────────────────────
// cFIP is the FIP constant that normalises FIP to ERA scale.  Modern MLB ≈ 3.10.
const C_FIP = 3.10;

// ── In-memory 24-hour cache ──────────────────────────────────────────────────
interface CacheEntry {
  value: PitcherSabermetrics;
  expiresAt: number;
}
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 24 * 60 * 60 * 1000;

function cacheKey(playerId: number, season: number): string {
  return `${playerId}:${season}`;
}

// ── Public interface ─────────────────────────────────────────────────────────

export interface PitcherSabermetrics {
  playerId: number;
  season: number;
  // WHIP sourced directly from the MLB Stats API season log.
  whip: number | null;
  // K% - BB%, expressed as a decimal fraction (e.g. 0.18 = 18 pp).
  // Range roughly -0.50 … 0.50 in practice.
  kBBPct: number | null;
  // xFIP computed from the FanGraphs formula.  Proxy flag is true when we
  // had to use the groundOuts:airOuts ratio instead of an explicit FB%.
  xFIP: number | null;
  xFIPProxy: boolean;
  source: "mlb_stats";
  staleness: "fresh" | "cached" | "missing";
}

// ── MLB Stats API raw shapes ─────────────────────────────────────────────────

interface RawPitchingStat {
  inningsPitched?: string | number | null;
  era?: string | number | null;
  whip?: string | number | null;
  strikeOuts?: number | null;
  baseOnBalls?: number | null;
  hitByPitch?: number | null;
  battersFaced?: number | null;
  flyOuts?: number | null;         // air-outs (fly balls + line drives, proxy for FB%)
  groundOuts?: number | null;      // ground-ball outs
  homeRuns?: number | null;
}

interface RawStatSplit {
  stat?: RawPitchingStat;
}

interface RawPeopleStats {
  stats?: { splits?: RawStatSplit[] }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function parseIp(v: unknown): number | null {
  // MLB Stats API encodes 6⅓ IP as "6.1", 6⅔ as "6.2", etc.
  // We convert that to true decimal: 6.1 → 6 + (1/3) = 6.333…
  if (v === null || v === undefined) return null;
  const s = String(v);
  const parts = s.split(".");
  const whole = Number(parts[0]);
  const frac = parts[1] ? Number(parts[1]) : 0;
  if (Number.isNaN(whole) || Number.isNaN(frac)) return null;
  return whole + frac / 3;
}

// ── Core computation ─────────────────────────────────────────────────────────

/**
 * Compute xFIP using the standard FanGraphs formula:
 *
 *   xFIP = ((13 × (flyBalls × lgFBHR%)) + (3 × (BB + HBP)) − (2 × K)) / IP + cFIP
 *
 * where lgFBHR% is the league-wide HR/flyball rate (≈ 10.5% for modern MLB).
 *
 * When the MLB Stats API returns explicit flyOuts (air-outs), we use those.
 * Otherwise we estimate flyBalls from the groundOuts:airOuts ratio:
 *
 *   airOuts / (groundOuts + airOuts)  ≈  fly-ball + line-drive rate
 *
 * This proxy over-counts line-drives, but it is the best proxy available from
 * the public stats endpoint.  xFIPProxy is true when the proxy is used.
 */
function computeXFIP(s: RawPitchingStat, ip: number): { xFIP: number | null; xFIPProxy: boolean } {
  const k = toNum(s.strikeOuts);
  const bb = toNum(s.baseOnBalls) ?? 0;
  const hbp = toNum(s.hitByPitch) ?? 0;

  if (k === null || ip <= 0) return { xFIP: null, xFIPProxy: false };

  // League HR/FB rate: FanGraphs 2024/2025 average ≈ 10.5%
  const LG_HR_FB_PCT = 0.105;

  let flyBalls: number | null = null;
  let proxy = false;

  const flyOuts = toNum(s.flyOuts);
  const groundOuts = toNum(s.groundOuts);

  if (flyOuts !== null && flyOuts >= 0) {
    // Direct air-outs from the API (includes fly balls + line drives; MLB
    // "air outs" is a superset of pure fly balls, so this slightly over-estimates
    // xFIP, but is the closest available figure without a separate FB% feed).
    flyBalls = flyOuts;
    proxy = false;
  } else if (flyOuts !== null && groundOuts !== null && groundOuts + flyOuts > 0) {
    // Same field, different path — use groundOuts:airOuts ratio as a proxy.
    // airRate = airOuts / (groundOuts + airOuts).
    // We multiply that rate by a rough total batted-ball estimate to recover
    // absolute fly balls: BIP ≈ ip * 3 (three outs per inning, mostly in play).
    const airRate = flyOuts / (groundOuts + flyOuts);
    flyBalls = airRate * ip * 3;
    proxy = true;
  } else {
    // No batted-ball data at all: fall back to league-average FB rate (≈ 35%).
    const LG_FB_RATE = 0.35;
    const bip = ip * 3;
    flyBalls = LG_FB_RATE * bip;
    proxy = true;
  }

  const xFIP = (13 * (flyBalls * LG_HR_FB_PCT) + 3 * (bb + hbp) - 2 * k) / ip + C_FIP;
  // Soft-clamp to [0, 8] — anything outside is a data artefact.
  const clamped = Math.max(0, Math.min(8, xFIP));
  return { xFIP: Math.round(clamped * 100) / 100, xFIPProxy: proxy };
}

/**
 * K-BB%: (strikeouts / battersFaced) − (walks / battersFaced)
 * Expressed as a decimal (0.18 = 18 pp).  Returns null when battersFaced is 0.
 */
function computeKBBPct(s: RawPitchingStat): number | null {
  const k = toNum(s.strikeOuts);
  const bb = toNum(s.baseOnBalls);
  const bf = toNum(s.battersFaced);

  if (k === null || bb === null || !bf || bf <= 0) return null;
  const kBB = (k - bb) / bf;
  // Clamp to realistic range and round to 4 decimal places.
  return Math.max(-0.5, Math.min(0.5, Math.round(kBB * 10000) / 10000));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch pitcher sabermetrics (xFIP, WHIP, K-BB%) for the given player/season.
 * Returns a MISSING entry if the API returns no data rather than throwing.
 */
export async function getPitcherSabermetrics(
  playerId: number,
  season?: number,
): Promise<PitcherSabermetrics> {
  const yr = season ?? new Date().getUTCFullYear();
  const key = cacheKey(playerId, yr);

  const cached = CACHE.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...cached.value, staleness: "cached" };
  }

  const missing: PitcherSabermetrics = {
    playerId,
    season: yr,
    whip: null,
    kBBPct: null,
    xFIP: null,
    xFIPProxy: false,
    source: "mlb_stats",
    staleness: "missing",
  };

  try {
    const res = await getJson<RawPeopleStats>(`${BASE}/people/${playerId}/stats`, {
      stats: "season",
      group: "pitching",
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

    const ip = parseIp(split.inningsPitched) ?? 0;
    const whip = toNum(split.whip);
    const kBBPct = computeKBBPct(split);
    const { xFIP, xFIPProxy } = computeXFIP(split, ip);

    const result: PitcherSabermetrics = {
      playerId,
      season: yr,
      whip,
      kBBPct,
      xFIP,
      xFIPProxy,
      source: "mlb_stats",
      staleness: "fresh",
    };

    CACHE.set(key, { value: result, expiresAt: Date.now() + TTL_MS });
    return result;
  } catch {
    // Network / parse error — return stale if available, else missing.
    if (cached) return { ...cached.value, staleness: "cached" };
    return missing;
  }
}

/** Evict all cached entries (useful in tests). */
export function _clearPitcherSaberCache(): void {
  CACHE.clear();
}
