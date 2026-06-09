// Recent-form splits (MLB). A team's last-7 and last-14 game offense tells us
// whether the bats are hot or cold right now, which the season line lags. We
// fetch both windows from the public MLB Stats API (best-effort) and produce:
//   - a blended runs-per-game (30% last-14 + 70% season) the model can lean on
//   - a small confidence nudge off the last-7 form (hot → +2, cold → −2)
//
// Everything is best-effort: a missing window folds into NEUTRAL_FORM, which is
// a no-op for both the blend (returns the season value) and the confidence delta.

import { getJson } from "../../adapters/http";

const BASE = "https://statsapi.mlb.com/api/v1";

// Blend weights: recent form moves the needle but the season is the anchor.
export const L14_BLEND_WEIGHT = 0.3;
export const SEASON_BLEND_WEIGHT = 1 - L14_BLEND_WEIGHT; // 0.7

// League-average wRC+ is 100; we proxy it from OPS relative to league OPS so we
// don't need a per-player feed. A team OPS of ~.730 maps to roughly 100.
export const LG_OPS = 0.73;
export const HOT_WRC_PLUS = 130; // last-7 above this → bats are hot
export const COLD_WRC_PLUS = 80; // last-7 below this → bats are cold

export interface RecentForm {
  found: boolean;
  l7OpsPlus: number | null; // last-7 OPS+ proxy (100 = league average)
  l14Rpg: number | null; // last-14 runs per game
}

export const NEUTRAL_FORM: RecentForm = { found: false, l7OpsPlus: null, l14Rpg: null };

interface RawSplit {
  ops?: string | number;
  runs?: string | number;
  gamesPlayed?: string | number;
}
interface RawTeamStats {
  stats?: { splits?: { stat?: RawSplit }[] }[];
}

function toNum(v: string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// OPS → OPS+ proxy: (teamOps / leagueOps) × 100. League-average reads ~100.
export function opsPlus(ops: number | null): number | null {
  if (ops === null || ops <= 0) return null;
  return Math.round((ops / LG_OPS) * 100);
}

// Blend last-14 RPG with the season RPG. With no recent window we return the
// season value unchanged (a no-op).
export function blendedRpg(seasonRpg: number | null, l14Rpg: number | null): number | null {
  if (seasonRpg === null) return l14Rpg;
  if (l14Rpg === null) return seasonRpg;
  return Math.round((SEASON_BLEND_WEIGHT * seasonRpg + L14_BLEND_WEIGHT * l14Rpg) * 1000) / 1000;
}

// Confidence delta from last-7 form: hot bats on our side add a little, cold
// bats subtract. Pure: NEUTRAL/missing form returns 0.
export function recentFormConfidenceDelta(form: RecentForm): number {
  if (!form.found || form.l7OpsPlus === null) return 0;
  if (form.l7OpsPlus > HOT_WRC_PLUS) return 2;
  if (form.l7OpsPlus < COLD_WRC_PLUS) return -2;
  return 0;
}

// Fetch a single recent window's hitting split for a team. byDateRange isn't
// keyed by game count, so we use the lastXGames stat type the API exposes.
async function fetchWindow(teamId: number, games: number): Promise<RawSplit | null> {
  const res = await getJson<RawTeamStats>(`${BASE}/teams/${teamId}/stats`, {
    stats: "lastXGames",
    group: "hitting",
    limit: games,
    season: new Date().getUTCFullYear(),
  });
  if (!res.ok) return null;
  return res.data?.stats?.[0]?.splits?.[0]?.stat ?? null;
}

// Best-effort recent form for a team. Any failure on either window degrades to
// NEUTRAL_FORM so the slate is never blocked.
export async function recentFormForTeam(teamId: number | null): Promise<RecentForm> {
  try {
    if (!teamId) return NEUTRAL_FORM;
    const [l7, l14] = await Promise.all([
      fetchWindow(teamId, 7).catch(() => null),
      fetchWindow(teamId, 14).catch(() => null),
    ]);
    if (!l7 && !l14) return NEUTRAL_FORM;
    const l7OpsPlus = l7 ? opsPlus(toNum(l7.ops)) : null;
    let l14Rpg: number | null = null;
    if (l14) {
      const runs = toNum(l14.runs);
      const gp = toNum(l14.gamesPlayed);
      l14Rpg = runs !== null && gp !== null && gp > 0 ? Math.round((runs / gp) * 1000) / 1000 : null;
    }
    return { found: l7OpsPlus !== null || l14Rpg !== null, l7OpsPlus, l14Rpg };
  } catch {
    return NEUTRAL_FORM;
  }
}
