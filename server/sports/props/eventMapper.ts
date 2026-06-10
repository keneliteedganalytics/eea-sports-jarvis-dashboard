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

// True when two team names refer to the same club. We accept an exact normalized
// match, a substring-containment match in either direction ("Yankees" ⊂ "New
// York Yankees", "Red Sox" ⊂ "Boston Red Sox"), or a guarded nickname-tail match
// for initialisms like "NY Yankees" ↔ "New York Yankees".
//
// The tail match is GUARDED to avoid a CRITICAL false positive: "Chicago White
// Sox" and "Boston Red Sox" share the tail "sox", which previously made a White
// Sox pick resolve to the Red Sox game; when that game was Final the prop was
// falsely graded (the v6.7.3 corruption). We only allow a tail match when the
// two names do NOT carry conflicting qualifier tokens before the shared tail
// (e.g. "white" vs "red"): if each name has a distinct word the other lacks, the
// shared nickname is a coincidence (two "Sox" clubs), not the same team.
export function teamNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  const tokensA = na.split(" ");
  const tokensB = nb.split(" ");
  const tailA = tokensA[tokensA.length - 1];
  const tailB = tokensB[tokensB.length - 1];
  if (tailA.length < 3 || tailA !== tailB) return false;

  // Shared tail. Compare the city/qualifier words before the nickname.
  const bodyA = tokensA.slice(0, -1);
  const bodyB = tokensB.slice(0, -1);
  const setA = new Set(bodyA);
  const setB = new Set(bodyB);
  const aHasUnique = bodyA.some((t) => !setB.has(t));
  const bHasUnique = bodyB.some((t) => !setA.has(t));
  // Only one side carries extra words ("red sox" vs just "sox") → same club.
  if (!(aHasUnique && bHasUnique)) return true;
  // Both sides have distinct words. Same club ONLY if one body is an initialism
  // of the other ("ny" ↔ "new york"); otherwise it's two clubs sharing a
  // nickname ("white sox" vs "red sox") and must NOT match.
  const initials = (parts: string[]): string => parts.map((p) => p[0] ?? "").join("");
  return initials(bodyA) === bodyB.join("") || initials(bodyB) === bodyA.join("");
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
