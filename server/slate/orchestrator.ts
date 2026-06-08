// Cross-sport slate orchestrator. Runs MLB / NHL / NBA slate services in
// parallel via Promise.allSettled so one sport's upstream failure never blanks
// the whole board — a failed sport returns { picks: [], ok: false, error }.

import { getSlate, getPick } from "../sports/mlb/slate";
import { getNhlSlate, getNhlPick } from "../sports/nhl/slate";
import { getNbaSlate, getNbaPick } from "../sports/nba/slate";
import { BANKROLL_USD, type BuiltPick } from "../sports/mlb/picksEngine";
import { applyExposureCap } from "../core/sizing";

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

// Mutate actionable picks in place so the combined board honors the 18% cap.
function applySlateExposureCap(slates: SportSlate[], bankroll: number): void {
  const actionable = slates
    .flatMap((s) => s.picks)
    .filter((p) => p.qualifies && p.kellyStakeDollars > 0);
  if (actionable.length === 0) return;

  const capped = applyExposureCap(
    actionable.map((p) => ({ units: p.units, stakeDollars: p.kellyStakeDollars })),
    bankroll,
  );
  actionable.forEach((p, i) => {
    p.units = capped[i].units;
    p.kellyStakeDollars = capped[i].stakeDollars;
    if (capped[i].trimmed) p.trimmed = true;
  });
}

export async function getDailySlate(bankroll = BANKROLL_USD, dateIso?: string): Promise<DailySlate> {
  const [mlbR, nhlR, nbaR] = await Promise.allSettled([
    getSlate(bankroll, dateIso),
    getNhlSlate(bankroll, dateIso),
    getNbaSlate(bankroll, dateIso),
  ]);

  const mlb = settledToSport(mlbR);
  const nhl = settledToSport(nhlR);
  const nba = settledToSport(nbaR);

  // 18% slate-wide exposure cap (SPEC §4): scale every actionable stake by one
  // common factor when the combined board exceeds 18% of bankroll.
  applySlateExposureCap([mlb, nhl, nba], bankroll);

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
