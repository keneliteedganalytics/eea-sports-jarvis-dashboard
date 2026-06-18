// Bridge the engine's BuiltPick shape into the graded book. Actionable picks
// (units > 0, a real tier) are persisted as live board rows. v6.7.7: every
// evaluated game-line pick the engine produced but did NOT play (verdictTier
// 'PASS') is ALSO recorded — as an informational PASS row (units 0, stake $0,
// pass_reason). PASS rows never settle and never touch bankroll: openPicksForDate
// filters `units > 0`, so a units-0 PASS row is invisible to live scoring.

import { upsertPick, autoLockPick, pickId } from "../gradedBook";
import type { BuiltPick } from "../sports/mlb/picksEngine";

function commonFields(pick: BuiltPick) {
  return {
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
    gameStartIso: pick.gameStartIso ?? null,
    pickWinProb: pick.pickWinProb,
    pickImpliedProb: pick.pickImpliedProb,
    edgePp: pick.edgePp,
    evPer100: pick.evPer100,
    confidence: pick.confidence,
    fairMl: pick.fairMl,
  };
}

export function persistPick(pick: BuiltPick): boolean {
  if (!(pick.units > 0) || pick.verdictTier === "PASS") return false;
  const wrote = upsertPick({
    ...commonFields(pick),
    tier: pick.verdictTier,
    units: pick.units,
    stakeDollars: pick.kellyStakeDollars,
  });
  // v6.11.0: freeze qualifying picks into the immutable lock ledger on first
  // persist. autoLockPick is a no-op once the row is locked, so it never
  // clobbers a prior snapshot.
  if (wrote) autoLockPick(pickId(pick.gameId, pick.pickType, pick.pickSide));
  return wrote;
}

// Why a game-line pick was passed. A gate-driven PASS carries a hardPassReason /
// passReason; a pick that qualified but lost its slot to the daily cap or the
// RECON edge floor carries neither, so we attribute it to the cap.
function gamePassReason(pick: BuiltPick): string {
  const r = (pick.hardPassReason ?? pick.passReason ?? "").toLowerCase();
  if (!r) return "daily_cap";
  if (r.includes("chalk")) return "chalk_cap"; // v6.8.1 SNIPER chalk cap
  if (r.includes("data") || r.includes("sample")) return "low_data_quality";
  return "below_threshold";
}

// Record an evaluated-but-not-played game-line pick. units/stake forced to 0 so it
// can never settle or move bankroll, tier='PASS' so the live board hides it.
export function persistPassPick(pick: BuiltPick): boolean {
  return upsertPick({
    ...commonFields(pick),
    tier: "PASS",
    units: 0,
    stakeDollars: 0,
    pass_reason: gamePassReason(pick),
  });
}

export function persistPicks(picks: BuiltPick[]): number {
  let n = 0;
  for (const p of picks) {
    try {
      if (p.verdictTier === "PASS") {
        if (persistPassPick(p)) n++;
      } else if (persistPick(p)) {
        n++;
      }
    } catch {
      // best-effort; one bad row never blocks the slate response
    }
  }
  return n;
}
