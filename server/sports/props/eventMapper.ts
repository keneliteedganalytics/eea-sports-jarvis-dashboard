// Odds API event_id → MLB Stats gamePk mapper (v6.7.3). The Odds API tags each
// prop offer with its own hash event id, NOT an MLB gamePk, so any code that
// tried `schedule.find(s => s.gamePk === offer.eventId)` always missed and fell
// back to neutral matchup context (park factor 1, opp FIP 1). This resolves the
// real game by matching the event's team(s) against the day's MLB schedule.
//
// The offer rows carry a `team` field (the player's team full name) when the
// ingester captured it. We fuzzy-match that team to a scheduled game's home or
// away team. When the offer team is missing we can't disambiguate, so we return
// null and the caller keeps the neutral context (best-effort — never fabricate).

import type { ScheduleGame } from "../../adapters/mlbStats";

// Normalize a team name for fuzzy comparison: lowercase, drop punctuation, and
// collapse whitespace. "St. Louis Cardinals" → "st louis cardinals".
export function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// True when two team names refer to the same club. We accept either an exact
// normalized match or a containment match in either direction (so "Yankees"
// matches "New York Yankees" and vice-versa). The nickname (last token) is also
// compared, which handles "NY Yankees" vs "New York Yankees".
export function teamNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const tailA = na.split(" ").pop()!;
  const tailB = nb.split(" ").pop()!;
  return tailA.length >= 3 && tailA === tailB;
}

export interface EventTeams {
  // Either team known to be in the event (a player's team and/or the opponent).
  team: string | null;
  opponent?: string | null;
}

// Resolve an event's gamePk from the schedule by matching its team(s). Returns
// the gamePk string, or null when no team is known or no game matches.
export function resolveGamePk(
  event: EventTeams,
  schedule: ScheduleGame[],
): string | null {
  const candidates = [event.team, event.opponent].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  if (candidates.length === 0) return null;

  for (const g of schedule) {
    const hit = candidates.some(
      (t) => teamNamesMatch(t, g.homeTeamFull) || teamNamesMatch(t, g.awayTeamFull),
    );
    if (hit) return g.gamePk;
  }
  return null;
}

// Find the scheduled game for an event (same matching as resolveGamePk, but
// returns the full ScheduleGame so the caller can read venue / pitchers /
// lineups). Null when unresolved.
export function findGameForEvent(
  event: EventTeams,
  schedule: ScheduleGame[],
): ScheduleGame | null {
  const candidates = [event.team, event.opponent].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  if (candidates.length === 0) return null;

  for (const g of schedule) {
    const hit = candidates.some(
      (t) => teamNamesMatch(t, g.homeTeamFull) || teamNamesMatch(t, g.awayTeamFull),
    );
    if (hit) return g;
  }
  return null;
}

// Which side of the matched game the player's team is on. Returns "home",
// "away", or null when the team can't be placed (so the caller can pick the
// opposing pitcher correctly). `team` is the player's own team.
export function sideOfGame(
  team: string | null | undefined,
  game: ScheduleGame,
): "home" | "away" | null {
  if (team && teamNamesMatch(team, game.homeTeamFull)) return "home";
  if (team && teamNamesMatch(team, game.awayTeamFull)) return "away";
  return null;
}

// Lineup spot (1..9) for a resolved player id on the matched game. Reads the
// hydrated batting order for the player's side. Returns null when the lineup
// isn't posted or the player isn't in it.
export function lineupSpotFor(
  playerId: number | null,
  side: "home" | "away" | null,
  game: ScheduleGame,
): number | null {
  if (playerId == null || side == null) return null;
  const order = side === "home" ? game.homeBattingOrder : game.awayBattingOrder;
  const idx = order.indexOf(playerId);
  return idx >= 0 ? idx + 1 : null;
}
