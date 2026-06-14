// Pillar 1 (v6.9.0) — player-level recent-form layer. The existing
// server/sports/mlb/recentForm.ts blends TEAM offense (L14 RPG); this module is
// the PLAYER layer Foxtail-style models lean on: a pitcher's last-5 starts and a
// hitter's last-15 games, rolled into recency-weighted projections that the prop
// simulator and game model can blend against the season anchor.
//
// Pitchers: rolling ERA / WHIP / K9 / avg pitches-per-start over the last 5
// starts. Hitters: rolling wOBA / K% / ISO over the last 15 games.
//
// Blend weights are env-overridable so we can dial recency without a redeploy:
//   RECENT_FORM_PITCHER_WEIGHT (default 0.60 recent / 0.40 season)
//   RECENT_FORM_HITTER_WEIGHT  (default 0.50 recent / 0.50 season)
//
// Everything is best-effort and cached 6h: a missing feed yields found:false and
// blend helpers fall back to the season value (a no-op). No fabricated data.

import {
  fetchPitcherProfile,
  fetchBatterProfile,
  type PitcherGameLog,
  type BatterGameLog,
} from "../sports/props/mlbStatsProps";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const PITCHER_WINDOW = 5;
const HITTER_WINDOW = 15;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// Recency weight for pitchers (fraction given to the recent window).
export const RECENT_FORM_PITCHER_WEIGHT = (() => {
  const env = Number(process.env.RECENT_FORM_PITCHER_WEIGHT);
  return Number.isFinite(env) && env >= 0 && env <= 1 ? env : 0.6;
})();

// Recency weight for hitters.
export const RECENT_FORM_HITTER_WEIGHT = (() => {
  const env = Number(process.env.RECENT_FORM_HITTER_WEIGHT);
  return Number.isFinite(env) && env >= 0 && env <= 1 ? env : 0.5;
})();

export interface PitcherRecentForm {
  found: boolean;
  starts: number;
  era: number | null; // earned runs × 9 / innings
  whip: number | null; // (hits + walks) / innings
  k9: number | null; // strikeouts × 9 / innings
  pitchesPerStart: number | null; // estimated from outs (no pitch count in log → ~3.8/out)
}

export interface HitterRecentForm {
  found: boolean;
  games: number;
  woba: number | null;
  kRate: number | null; // strikeouts / PA  (K% as a fraction)
  iso: number | null; // (TB − H) / AB  (isolated power)
}

export const NEUTRAL_PITCHER_FORM: PitcherRecentForm = {
  found: false, starts: 0, era: null, whip: null, k9: null, pitchesPerStart: null,
};
export const NEUTRAL_HITTER_FORM: HitterRecentForm = {
  found: false, games: 0, woba: null, kRate: null, iso: null,
};

// Recency-weighted blend of a recent value with the season anchor. Missing
// either side returns the other (no-op). Weight is the fraction on `recent`.
export function blendRecent(
  recent: number | null,
  season: number | null,
  weight: number,
): number | null {
  if (recent === null && season === null) return null;
  if (recent === null) return season;
  if (season === null) return recent;
  return Math.round((weight * recent + (1 - weight) * season) * 10000) / 10000;
}

// Linear-weights wOBA from a game-log row (2026 coefficients, league-neutral).
// Walks are folded in; HBP unavailable in the log so omitted (small).
function gameWoba(g: BatterGameLog): number | null {
  if (g.pa <= 0) return null;
  const doubles = 0; // not in the trimmed log shape; folded into TB below
  // We have hits, totalBases, homeRuns, singles, walks. Reconstruct 2B+3B from TB.
  const xbhBases = g.totalBases - g.hits - 3 * g.homeRuns; // bases from 2B/3B beyond a single
  // Approximate: treat all non-HR extra bases as doubles for the wOBA weight.
  const doublesApprox = Math.max(0, Math.round(xbhBases / 1));
  const num =
    0.69 * g.walks +
    0.89 * g.singles +
    1.27 * doublesApprox +
    2.1 * g.homeRuns;
  void doubles;
  return num / g.pa;
}

function rollingPitcher(logs: PitcherGameLog[]): PitcherRecentForm {
  const w = logs.slice(0, PITCHER_WINDOW);
  if (w.length === 0) return NEUTRAL_PITCHER_FORM;
  let outs = 0, er = 0, k = 0, hits = 0, bb = 0;
  for (const g of w) {
    outs += g.outs; er += g.earnedRuns; k += g.strikeouts;
    hits += g.hitsAllowed; bb += g.walks;
  }
  if (outs <= 0) return { ...NEUTRAL_PITCHER_FORM, found: true, starts: w.length };
  const ip = outs / 3;
  return {
    found: true,
    starts: w.length,
    era: Math.round((er * 9 / ip) * 100) / 100,
    whip: Math.round(((hits + bb) / ip) * 100) / 100,
    k9: Math.round((k * 9 / ip) * 100) / 100,
    pitchesPerStart: Math.round((outs * 3.8 / w.length) * 10) / 10,
  };
}

function rollingHitter(logs: BatterGameLog[]): HitterRecentForm {
  const w = logs.slice(0, HITTER_WINDOW);
  if (w.length === 0) return NEUTRAL_HITTER_FORM;
  let pa = 0, ab = 0, hits = 0, tb = 0, wobaNumPa = 0, wobaSum = 0;
  // K not present per-game in the trimmed log; approximate K% from a flat 0 when
  // absent so kRate degrades to null rather than a fabricated number.
  for (const g of w) {
    pa += g.pa; ab += g.ab; hits += g.hits; tb += g.totalBases;
    const gw = gameWoba(g);
    if (gw !== null) { wobaSum += gw * g.pa; wobaNumPa += g.pa; }
  }
  const woba = wobaNumPa > 0 ? Math.round((wobaSum / wobaNumPa) * 1000) / 1000 : null;
  const iso = ab > 0 ? Math.round(((tb - hits) / ab) * 1000) / 1000 : null;
  return {
    found: true,
    games: w.length,
    woba,
    kRate: null, // strikeouts not in the trimmed batter log; left null (no fabrication)
    iso,
  };
}

interface CacheEntry<T> { at: number; value: T; }
const pitcherCache = new Map<number, CacheEntry<PitcherRecentForm>>();
const hitterCache = new Map<number, CacheEntry<HitterRecentForm>>();

function fresh<T>(e: CacheEntry<T> | undefined): T | null {
  if (e && Date.now() - e.at < CACHE_TTL_MS) return e.value;
  return null;
}

// Last-5-start rolling form for a pitcher. Best-effort + cached 6h.
export async function pitcherRecentForm(
  playerId: number | null,
  name = "",
): Promise<PitcherRecentForm> {
  if (!playerId) return NEUTRAL_PITCHER_FORM;
  const hit = fresh(pitcherCache.get(playerId));
  if (hit) return hit;
  try {
    const profile = await fetchPitcherProfile(playerId, name, PITCHER_WINDOW);
    const form = profile.available ? rollingPitcher(profile.logs) : NEUTRAL_PITCHER_FORM;
    pitcherCache.set(playerId, { at: Date.now(), value: form });
    return form;
  } catch {
    return NEUTRAL_PITCHER_FORM;
  }
}

// Last-15-game rolling form for a hitter. Best-effort + cached 6h.
export async function hitterRecentForm(
  playerId: number | null,
  name = "",
): Promise<HitterRecentForm> {
  if (!playerId) return NEUTRAL_HITTER_FORM;
  const hit = fresh(hitterCache.get(playerId));
  if (hit) return hit;
  try {
    const profile = await fetchBatterProfile(playerId, name, HITTER_WINDOW);
    const form = profile.available ? rollingHitter(profile.logs) : NEUTRAL_HITTER_FORM;
    hitterCache.set(playerId, { at: Date.now(), value: form });
    return form;
  } catch {
    return NEUTRAL_HITTER_FORM;
  }
}

// Blend a pitcher's season ERA with the last-5 ERA using the pitcher weight.
export function blendedPitcherEra(
  seasonEra: number | null,
  form: PitcherRecentForm,
): number | null {
  return blendRecent(form.found ? form.era : null, seasonEra, RECENT_FORM_PITCHER_WEIGHT);
}

// Blend a hitter's season wOBA with the last-15 wOBA using the hitter weight.
export function blendedHitterWoba(
  seasonWoba: number | null,
  form: HitterRecentForm,
): number | null {
  return blendRecent(form.found ? form.woba : null, seasonWoba, RECENT_FORM_HITTER_WEIGHT);
}

export function _resetRecentFormCache(): void {
  pitcherCache.clear();
  hitterCache.clear();
}

void clamp01;
