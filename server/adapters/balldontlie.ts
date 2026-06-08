// balldontlie adapter — NBA advanced team stats + injuries. Requires
// BALLDONTLIE_API_KEY; without it every call returns an empty/unavailable
// result so the slate still builds (model falls back to league-average inputs).
//
// We use it for two model inputs the Odds API can't give us:
//   - star-availability point swing (injuries endpoint)
//   - a rolling advanced-stat sanity check (season averages)
// Failures are non-fatal: callers get { available:false } and degrade.

import { getJson } from "./http";

const BASE = "https://api.balldontlie.io/v1";

function key(): string | undefined {
  const k = process.env.BALLDONTLIE_API_KEY;
  return k && k.trim() ? k.trim() : undefined;
}

export function hasBalldontlieKey(): boolean {
  return Boolean(key());
}

export interface InjuryReport {
  available: boolean;
  // estimated point swing to dock from this team for its listed-out players
  outPts: number;
  players: string[];
}

interface RawInjury {
  player?: { first_name?: string; last_name?: string; team_id?: number };
  status?: string;
}
interface RawInjuries { data?: RawInjury[]; }

// Heuristic: each player listed Out/Doubtful docks points. We don't have a
// per-player impact feed, so we apply a flat, conservative per-absence value
// and cap the total so a long injury list can't swing the model wildly.
const PTS_PER_OUT = 2.5;
const MAX_INJURY_PTS = 8;

// Fetch the current injury report and bucket point-swings by team id.
// Returns a map keyed by balldontlie team_id. Empty when no key / on failure.
export async function fetchNbaInjuries(): Promise<Map<number, InjuryReport>> {
  const out = new Map<number, InjuryReport>();
  const k = key();
  if (!k) return out;

  const res = await getJson<RawInjuries>(
    `${BASE}/player_injuries`,
    { per_page: "100" },
    { Authorization: k },
  );
  if (!res.ok || !res.data?.data) return out;

  for (const inj of res.data.data) {
    const teamId = inj.player?.team_id;
    if (teamId === undefined) continue;
    const status = (inj.status ?? "").toLowerCase();
    if (!/out|doubtful/.test(status)) continue;
    const name = `${inj.player?.first_name ?? ""} ${inj.player?.last_name ?? ""}`.trim();
    const cur = out.get(teamId) ?? { available: true, outPts: 0, players: [] };
    cur.outPts = Math.min(MAX_INJURY_PTS, cur.outPts + PTS_PER_OUT);
    if (name) cur.players.push(name);
    out.set(teamId, cur);
  }
  return out;
}

export interface BdlTeam {
  id: number;
  full_name: string;
  abbreviation: string;
}
interface RawTeams { data?: BdlTeam[]; }

// Fetch the team directory so we can map full names → balldontlie team ids.
export async function fetchNbaTeams(): Promise<BdlTeam[]> {
  const k = key();
  if (!k) return [];
  const res = await getJson<RawTeams>(`${BASE}/teams`, { per_page: "100" }, { Authorization: k });
  if (!res.ok || !res.data?.data) return [];
  return res.data.data;
}
