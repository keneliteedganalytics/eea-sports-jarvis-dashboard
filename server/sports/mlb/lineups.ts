// Lineup confirmation (MLB). Once a team posts its starting lineup, we know
// whether a key bat is in or out. The MLB Stats API hydrates batting orders on
// the schedule feed; we read that, and if a known star (>120 wRC+) on the pick's
// team is missing from the posted lineup we flag it.
//
// "Star out" on the side we're backing is a real downgrade: confidence drops and
// the tier steps down one rung. Everything is best-effort — before lineups post
// (or on any failure) we return "pending", which is a no-op for sizing.

import { getJson } from "../../adapters/http";

const SCHED_URL = "https://statsapi.mlb.com/api/v1/schedule";

export type LineupStatus = "confirmed" | "pending" | "star_out" | "star_questionable";

export interface LineupResult {
  status: LineupStatus;
  missingStar: string | null; // name of the absent star, when known
}

export const PENDING_LINEUP: LineupResult = { status: "pending", missingStar: null };

// A star is a bat whose 365-day wRC+ clears this bar. Profiles are supplied by
// the caller (from team-offense data); we don't fetch per-player stats here.
export const STAR_WRC_PLUS = 120;

interface RawLineupPlayer {
  id?: number;
  fullName?: string;
}
interface RawLineupGame {
  gamePk?: number;
  lineups?: {
    homePlayers?: RawLineupPlayer[];
    awayPlayers?: RawLineupPlayer[];
  };
  status?: { abstractGameState?: string };
}
interface RawLineupSchedule {
  dates?: { games?: RawLineupGame[] }[];
}

// Fetch posted batting orders for a date, keyed by gamePk. Returns {} on any
// failure so the caller degrades to "pending".
export async function fetchLineups(
  dateStr: string,
): Promise<Record<string, { home: string[]; away: string[] }>> {
  try {
    const res = await getJson<RawLineupSchedule>(SCHED_URL, {
      sportId: 1,
      date: dateStr,
      hydrate: "lineups",
    });
    if (!res.ok || !res.data?.dates) return {};
    const out: Record<string, { home: string[]; away: string[] }> = {};
    for (const d of res.data.dates) {
      for (const g of d.games ?? []) {
        if (g.gamePk === undefined) continue;
        const home = (g.lineups?.homePlayers ?? [])
          .map((p) => p.fullName ?? "")
          .filter(Boolean);
        const away = (g.lineups?.awayPlayers ?? [])
          .map((p) => p.fullName ?? "")
          .filter(Boolean);
        out[String(g.gamePk)] = { home, away };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function normName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Pure: decide the lineup status for the pick's side given the posted lineup and
// the side's known stars. Exported for tests.
//   - no lineup posted yet            → "pending"
//   - lineup posted, all stars present → "confirmed"
//   - lineup posted, a star absent     → "star_out"
export function lineupStatusForSide(
  postedLineup: string[] | null | undefined,
  sideStars: string[],
): LineupResult {
  if (!postedLineup || postedLineup.length === 0) return PENDING_LINEUP;
  const present = new Set(postedLineup.map(normName));
  for (const star of sideStars) {
    if (!present.has(normName(star))) {
      return { status: "star_out", missingStar: star };
    }
  }
  return { status: "confirmed", missingStar: null };
}

// Resolve the lineup status for a pick. Best-effort: returns PENDING on any
// failure. `pickSideStars` are the star bats on the team we're backing.
export async function lineupForPick(
  gamePk: string | null | undefined,
  pickSide: "home" | "away",
  pickSideStars: string[],
  dateStr: string,
): Promise<LineupResult> {
  try {
    if (!gamePk || pickSideStars.length === 0) return PENDING_LINEUP;
    const lineups = await fetchLineups(dateStr);
    const game = lineups[String(gamePk)];
    if (!game) return PENDING_LINEUP;
    const posted = pickSide === "home" ? game.home : game.away;
    return lineupStatusForSide(posted, pickSideStars);
  } catch {
    return PENDING_LINEUP;
  }
}

// Confidence delta from a lineup status: −10 when a star is out on our side,
// +5 when the lineup is confirmed with our stars in, 0 otherwise.
export function lineupConfidenceDelta(status: LineupStatus): number {
  if (status === "star_out") return -10;
  if (status === "confirmed") return 5;
  return 0;
}

// Whether a status should downgrade the tier by one rung.
export function lineupForcesDowngrade(status: LineupStatus): boolean {
  return status === "star_out";
}
