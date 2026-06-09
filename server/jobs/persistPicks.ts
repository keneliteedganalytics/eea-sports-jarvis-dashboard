// Bridge the engine's BuiltPick shape into the graded book. Only actionable
// picks (units > 0 and a real tier, never PASS) are persisted — informational
// PASS/no-edge games are not bets and never enter the book. Existing non-pending
// rows are left untouched by upsertPick.

import { upsertPick } from "../gradedBook";
import type { BuiltPick } from "../sports/mlb/picksEngine";

export function persistPick(pick: BuiltPick): boolean {
  if (!(pick.units > 0) || pick.verdictTier === "PASS") return false;
  return upsertPick({
    gameId: pick.gameId,
    sport: pick.sport,
    gameDate: pick.gameDate,
    gameTimeEt: pick.gameTimeEt,
    matchup: pick.matchup,
    homeTeam: pick.homeTeam,
    awayTeam: pick.awayTeam,
    homeTeamFull: pick.homeTeamFull,
    awayTeamFull: pick.awayTeamFull,
    pickSide: pick.pickSide,
    pickTeam: pick.pickTeam,
    pickTeamFull: pick.pickTeamFull,
    pickType: pick.pickType,
    pickLine: null,
    pickMl: pick.pickMl,
    pickBook: pick.pickBook,
    tier: pick.verdictTier,
    units: pick.units,
    stakeDollars: pick.kellyStakeDollars,
    pickWinProb: pick.pickWinProb,
    pickImpliedProb: pick.pickImpliedProb,
    edgePp: pick.edgePp,
    evPer100: pick.evPer100,
    confidence: pick.confidence,
    fairMl: pick.fairMl,
  });
}

export function persistPicks(picks: BuiltPick[]): number {
  let n = 0;
  for (const p of picks) {
    try {
      if (persistPick(p)) n++;
    } catch {
      // best-effort; one bad row never blocks the slate response
    }
  }
  return n;
}
