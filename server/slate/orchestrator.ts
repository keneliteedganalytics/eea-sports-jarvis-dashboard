// Cross-sport slate orchestrator. Runs MLB / NHL / NBA slate services in
// parallel via Promise.allSettled so one sport's upstream failure never blanks
// the whole board — a failed sport returns { picks: [], ok: false, error }.

import { getSlate, getPick } from "../sports/mlb/slate";
import { getNhlSlate, getNhlPick } from "../sports/nhl/slate";
import { getNbaSlate, getNbaPick } from "../sports/nba/slate";
import { BANKROLL_USD, type BuiltPick } from "../sports/mlb/picksEngine";

export interface SportSlate {
  picks: BuiltPick[];
  ok: boolean;
  error?: string | null;
}

export interface DailySlate {
  operatingDay: string;
  isDemo: boolean;
  bankroll: number;
  generatedAt: number;
  sports: {
    mlb: SportSlate;
    nhl: SportSlate;
    nba: SportSlate;
  };
}

function settledToSport(
  r: PromiseSettledResult<{ picks: BuiltPick[] }>,
): SportSlate {
  if (r.status === "fulfilled") return { picks: r.value.picks, ok: true, error: null };
  return { picks: [], ok: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
}

export async function getDailySlate(bankroll = BANKROLL_USD): Promise<DailySlate> {
  const [mlbR, nhlR, nbaR] = await Promise.allSettled([
    getSlate(bankroll),
    getNhlSlate(bankroll),
    getNbaSlate(bankroll),
  ]);

  const mlb = settledToSport(mlbR);
  const nhl = settledToSport(nhlR);
  const nba = settledToSport(nbaR);

  // Operating day / demo flag taken from whichever sport resolved (prefer MLB).
  const resolved = [mlbR, nhlR, nbaR].find((r) => r.status === "fulfilled") as
    | PromiseFulfilledResult<{ operatingDay: string; isDemo: boolean }>
    | undefined;

  return {
    operatingDay: resolved?.value.operatingDay ?? operatingDay(),
    isDemo: resolved?.value.isDemo ?? true,
    bankroll,
    generatedAt: Date.now(),
    sports: { mlb, nhl, nba },
  };
}

// Look up a single pick across all three sports (for /pick/:id detail + briefs).
export async function getAnyPick(id: string, bankroll = BANKROLL_USD): Promise<BuiltPick | null> {
  const [mlb, nhl, nba] = await Promise.allSettled([
    getPick(id, bankroll),
    getNhlPick(id, bankroll),
    getNbaPick(id, bankroll),
  ]);
  for (const r of [mlb, nhl, nba]) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}

function operatingDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
