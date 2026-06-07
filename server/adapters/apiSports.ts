// api-sports.io baseball adapter — team offense ratings (RPG / OPS).
// https://v1.baseball.api-sports.io  Returns {} when API_SPORTS_KEY is unset.

import { getJson } from "./http";
import type { TeamOffense } from "../sports/mlb/ratings";

const BASE = "https://v1.baseball.api-sports.io";

export function hasApiSportsKey(): boolean {
  return Boolean(process.env.API_SPORTS_KEY);
}

interface RawTeamStats {
  response?: {
    runs?: { for?: { average?: { all?: string | number } } };
    // api-sports shapes vary by plan; we read defensively below
  };
}

// Best-effort team offense fetch. On any failure returns an unavailable
// offense object — the model falls back to league-average RPG/OPS.
export async function fetchTeamOffense(teamId: number | null, season: number): Promise<TeamOffense> {
  if (!hasApiSportsKey() || !teamId) return { available: false };

  const res = await getJson<RawTeamStats>(
    `${BASE}/teams/statistics`,
    { team: teamId, season },
    { "x-apisports-key": process.env.API_SPORTS_KEY as string },
  );
  if (!res.ok || !res.data?.response) return { available: false };

  const rpgRaw = res.data.response.runs?.for?.average?.all;
  const rpg = rpgRaw === undefined ? null : Number(rpgRaw);
  if (rpg === null || Number.isNaN(rpg) || rpg <= 0) return { available: false };

  return { available: true, rpg };
}
