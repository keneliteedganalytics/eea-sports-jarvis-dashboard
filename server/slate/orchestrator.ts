// Cross-sport slate orchestrator. Runs MLB / NHL / NBA / SOCCER slate services
// in parallel via Promise.allSettled so one sport's upstream failure never
// blanks the whole board — a failed sport returns { picks: [], ok: false, error }.

import { getSlate, getPick } from "../sports/mlb/slate";
import { getNhlSlate, getNhlPick } from "../sports/nhl/slate";
import { getNbaSlate, getNbaPick } from "../sports/nba/slate";
import { getSoccerSlate, getSoccerPick } from "../sports/soccer/slate";
import { BANKROLL_USD, type BuiltPick } from "../sports/mlb/picksEngine";
import { applyExposureCap } from "../core/sizing";
import { persistPicks } from "../jobs/persistPicks";
import { picksForDate, pickId, getBankrollState, type GradedPick } from "../gradedBook";
import type { ClvBadge } from "../sports/mlb/picksEngine";

// Build the client-facing CLV badge from a graded row. Returns null until the
// pick has a posted price (every actionable pick gets one at posting time). The
// status is 'open' before the lock worker captures the close, then 'locked',
// then 'final' once the game completes.
function buildClvBadge(row: GradedPick): ClvBadge | null {
  if (row.postedOddsAmerican === null) return null;
  return {
    points: row.clvPoints ?? 0,
    percent: row.clvPercent ?? 0,
    status: row.lockStatus,
    postedOdds: row.postedOddsAmerican,
    closingOdds: row.closingOddsAmerican,
    closingSource: row.closingSource ?? undefined,
  };
}

export interface SportSlate {
  picks: BuiltPick[];
  ok: boolean;
  isDemo?: boolean;
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
    soccer: SportSlate;
  };
}

function settledToSport(
  r: PromiseSettledResult<{ picks: BuiltPick[]; isDemo?: boolean }>,
): SportSlate {
  if (r.status === "fulfilled") return { picks: r.value.picks, ok: true, isDemo: r.value.isDemo ?? false, error: null };
  return { picks: [], ok: false, isDemo: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
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
  const [mlbR, nhlR, nbaR, soccerR] = await Promise.allSettled([
    getSlate(bankroll, dateIso),
    getNhlSlate(bankroll, dateIso),
    getNbaSlate(bankroll, dateIso),
    getSoccerSlate(bankroll, dateIso),
  ]);

  const mlb = settledToSport(mlbR);
  const nhl = settledToSport(nhlR);
  const nba = settledToSport(nbaR);
  const soccer = settledToSport(soccerR);

  // 18% slate-wide exposure cap (SPEC §4): scale every actionable stake by one
  // common factor when the combined board exceeds 18% of bankroll.
  applySlateExposureCap([mlb, nhl, nba, soccer], bankroll);

  // Persist actionable picks into the graded book (post-cap sizing) so the
  // live-scoring job can settle them later. Pending rows are refreshed; graded
  // rows are never overwritten.
  persistPicks([mlb, nhl, nba, soccer].flatMap((s) => s.picks));

  // Operating day taken from whichever sport resolved (prefer MLB).
  // Top-level isDemo is true only if every sport is in demo mode (all keys absent).
  const resolved = [mlbR, nhlR, nbaR, soccerR].find((r) => r.status === "fulfilled") as
    | PromiseFulfilledResult<{ operatingDay: string; isDemo: boolean }>
    | undefined;

  const allDemo = [mlb, nhl, nba, soccer].every((s) => s.isDemo ?? false);

  const day = resolved?.value.operatingDay ?? operatingDay();
  attachGradedStatus([mlb, nhl, nba, soccer], day);

  // Sizing above used the configured (starting) bankroll; the board surfaces the
  // running bankroll, which adjusts as picks grade W/L.
  return {
    operatingDay: day,
    isDemo: allDemo,
    bankroll: getBankrollState().current,
    generatedAt: Date.now(),
    sports: { mlb, nhl, nba, soccer },
  };
}

// Decorate the day's picks with their graded-book status (W/L/P, live + final
// scores) so the cards can color-code. Picks not in the book stay unannotated.
function attachGradedStatus(slates: SportSlate[], day: string): void {
  decorateSlatePicks(slates.flatMap((s) => s.picks), day);
}

// Open-CLV fallback for a pick with no graded row yet. The lock worker has not
// run, but the pick already carries a posted price — surface the 'open' badge so
// the card shows the "Lock at first pitch" chip instead of a blank.
function openClvFromPick(p: BuiltPick): ClvBadge | null {
  if (p.pickMl === null || p.pickMl === undefined) return null;
  return {
    points: 0,
    percent: 0,
    status: "open",
    postedOdds: p.pickMl,
    closingOdds: null,
    closingSource: undefined,
  };
}

// Merge graded-book status onto a flat list of board picks (W/L/P, live + final
// scores, CLV badge, lock overlay). Used by both the cross-sport board and each
// per-sport slate route so every served pick carries the grade + CLV fields.
// A pick with no matching graded row still gets the 'open' CLV shape when it has
// a posted price, so the UI never sees an undefined clv where odds exist.
export function decorateSlatePicks(picks: BuiltPick[], day: string): void {
  const rows = picksForDate(day);
  const byId = new Map<string, GradedPick>();
  for (const r of rows) byId.set(r.id, r);
  for (const p of picks) {
    const row = byId.get(pickId(p.gameId, p.pickType, p.pickSide));
    if (!row) {
      p.clv = openClvFromPick(p);
      continue;
    }
    p.gradeStatus = row.status;
    p.gradeResult = row.result;
    p.gradePl = row.pl;
    p.clvPct = row.clvPct;
    p.clv = buildClvBadge(row) ?? openClvFromPick(p);
    p.liveAwayScore = row.liveAwayScore;
    p.liveHomeScore = row.liveHomeScore;
    p.liveStatusDetail = row.liveStatusDetail;
    p.finalAwayScore = row.finalAwayScore;
    p.finalHomeScore = row.finalHomeScore;
    if (row.locked) {
      p.locked = true;
      p.lockedAt = row.lockedAt;
      // row is already lock-overlaid by picksForDate, so tier/stake/odds carry
      // the frozen values — mirror them onto the board pick so the card and
      // analytics show the LOCKED tier, not a recompute.
      p.lockedTier = row.lockedTier;
      p.lockedStake = row.lockedStake;
      p.lockedOdds = row.lockedOdds;
      p.verdictTier = row.tier as typeof p.verdictTier;
      p.kellyStakeDollars = row.stakeDollars;
      p.pickMl = row.pickMl;
    }
  }
}

// Look up a single pick across all four sports (for /pick/:id detail + briefs).
export async function getAnyPick(id: string, bankroll = BANKROLL_USD): Promise<BuiltPick | null> {
  const [mlb, nhl, nba, soccer] = await Promise.allSettled([
    getPick(id, bankroll),
    getNhlPick(id, bankroll),
    getNbaPick(id, bankroll),
    getSoccerPick(id, bankroll),
  ]);
  for (const r of [mlb, nhl, nba, soccer]) {
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
