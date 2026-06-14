// Pillar 5 (v6.9.0) — bullpen fatigue. A pen that threw heavily the last three
// days is more likely to leak runs in the late innings. We count relief pitches
// (estimated from relief outs × ~16 pitches/inning) over the last 3 days from the
// team's game logs, normalize to a 0..1 fatigue score, and feed it to the
// run-distribution model: late-inning runs allowed by the fatigued team are
// nudged up by +0.15 × fatigue × 0.5 (dampened v1).
//
// Best-effort + cached 6h; a missing feed yields fatigue 0 (a no-op). No
// fabricated workloads.

import { getJson } from "../adapters/http";

const BASE = "https://statsapi.mlb.com/api/v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const FATIGUE_PITCH_CEILING = 350; // 3-day relief pitches that maps to fatigue 1.0
const PITCHES_PER_INNING = 16; // estimate when pitch counts aren't in the log

// Dampened late-inning run bump applied per unit fatigue (v1).
export const BULLPEN_FATIGUE_RUN_BUMP = 0.15 * 0.5; // 0.075 runs at full fatigue

export interface BullpenLoad {
  found: boolean;
  recent3DayPitches: number;
  fatigue: number; // 0..1
}

export const NEUTRAL_BULLPEN_LOAD: BullpenLoad = { found: false, recent3DayPitches: 0, fatigue: 0 };

// Pure: fatigue score from a 3-day relief pitch count. Exported for tests.
export function bullpenFatiguePct(recent3DayPitches: number): number {
  return Math.min(1, Math.max(0, recent3DayPitches) / FATIGUE_PITCH_CEILING);
}

// Pure: late-inning run bump for a side given its fatigue. Exported for tests.
export function bullpenFatigueRunBump(fatigue: number): number {
  return Math.round(BULLPEN_FATIGUE_RUN_BUMP * Math.min(1, Math.max(0, fatigue)) * 1000) / 1000;
}

interface RawGameLogSplit {
  date?: string;
  stat?: { inningsPitched?: string | number; gamesStarted?: number; numberOfPitches?: number | string };
}
interface RawTeamPitchingLog {
  stats?: { splits?: RawGameLogSplit[] }[];
}

function ipToOuts(ip: string | number | undefined): number {
  const s = String(ip ?? "0");
  const [w, f] = s.split(".");
  return Number(w || 0) * 3 + Math.min(Number(f?.[0] || 0), 2);
}

function withinDays(dateStr: string | undefined, days: number): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr + "T00:00:00Z").getTime();
  if (Number.isNaN(d)) return false;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return d >= cutoff;
}

// Pure core: estimate 3-day relief pitches from per-game team pitching logs.
// Relief outs ≈ total outs − ~5.5 starter innings (16.5 outs) per game, floored
// at 0; pitches ≈ relief outs / 3 × PITCHES_PER_INNING. Exported for tests.
export function estimateReliefPitches(splits: RawGameLogSplit[]): number {
  let pitches = 0;
  for (const sp of splits) {
    if (!withinDays(sp.date, 3)) continue;
    const explicit = Number(sp.stat?.numberOfPitches);
    const totalOuts = ipToOuts(sp.stat?.inningsPitched);
    const reliefOuts = Math.max(0, totalOuts - 16); // ~5.1 IP starter
    if (Number.isFinite(explicit) && explicit > 0) {
      // Scale the team's total pitches by the relief share of outs.
      pitches += totalOuts > 0 ? explicit * (reliefOuts / totalOuts) : 0;
    } else {
      pitches += (reliefOuts / 3) * PITCHES_PER_INNING;
    }
  }
  return Math.round(pitches);
}

interface CacheEntry { at: number; value: BullpenLoad; }
const cache = new Map<number, CacheEntry>();

// Best-effort 3-day bullpen load for a team. Cached 6h; degrades to NEUTRAL.
export async function bullpenLoadForTeam(teamId: number | null): Promise<BullpenLoad> {
  if (!teamId) return NEUTRAL_BULLPEN_LOAD;
  const hit = cache.get(teamId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const res = await getJson<RawTeamPitchingLog>(`${BASE}/teams/${teamId}/stats`, {
      stats: "gameLog",
      group: "pitching",
      season: new Date().getUTCFullYear(),
    });
    const splits = res.data?.stats?.[0]?.splits ?? [];
    const pitches = estimateReliefPitches(splits);
    const load: BullpenLoad = {
      found: splits.length > 0,
      recent3DayPitches: pitches,
      fatigue: bullpenFatiguePct(pitches),
    };
    cache.set(teamId, { at: Date.now(), value: load });
    return load;
  } catch {
    return NEUTRAL_BULLPEN_LOAD;
  }
}

export function _resetBullpenLoadCache(): void {
  cache.clear();
}
