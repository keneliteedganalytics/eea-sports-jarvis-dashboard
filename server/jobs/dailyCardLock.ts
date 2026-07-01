// v6.14.0 — daily card lock worker.
//
// Freezes the day's 3–5 best picks + parlays once per operating day. The MLB
// operating day flips at 6:00 AM ET (see operatingDay.ts), so "lock once at
// 6:00 AM ET" reduces to: whenever we observe an operating day whose card is
// not yet locked, build the slate and lock it. lockDailyCard is idempotent, so
// re-running (on boot, or on the interval) never overwrites a frozen card.
//
// Best-effort: never throws, logs a one-line summary. Run manually with
// `npm run lock:daily`.

import { getSlate } from "../sports/mlb/slate";
import { getOperatingDay } from "../sports/mlb/operatingDay";
import { getCard, lockDailyCard, type DailyCard } from "../core/dailyCard";
import { getBankrollState } from "../gradedBook";

// Check cadence. The operating day flips at 6 AM ET; a 15-minute poll locks the
// fresh card within a quarter-hour of the boundary without hammering the slate.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Lock today's card if it isn't already locked. force overwrites (admin
// regenerate). Returns the (possibly pre-existing) card, or null on failure.
export async function lockTodayCard(
  now: Date = new Date(),
  opts: { force?: boolean } = {},
): Promise<DailyCard | null> {
  const cardDate = getOperatingDay(now);
  try {
    if (!opts.force) {
      const existing = getCard(cardDate);
      if (existing) return existing;
    }
    const bankroll = getBankrollState().current;
    const slate = await getSlate(bankroll, cardDate);
    const card = lockDailyCard(cardDate, slate.picks, bankroll, opts);
    console.log(
      `[card lock] ${cardDate}: ${card.picks.length} picks, ${card.parlays.length} parlays` +
        (card.passReason ? ` (${card.passReason})` : ""),
    );
    return card;
  } catch (err) {
    console.warn(`[card lock] ${cardDate} failed: ${(err as Error).message}`);
    return null;
  }
}

// Attempt a lock now and schedule periodic checks. Fire-and-forget on boot.
export function startDailyCardLock(): void {
  void lockTodayCard();
  const timer = setInterval(() => void lockTodayCard(), CHECK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

// CLI one-shot: `npm run lock:daily` (or `tsx server/jobs/dailyCardLock.ts`).
// Guarded on argv (not import.meta) so the cjs bundle emits no warning.
const invokedDirectly = /dailyCardLock(\.ts|\.js)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  lockTodayCard(new Date(), { force: true }).then((card) => {
    console.log(`Daily card lock complete: ${JSON.stringify(card?.picks.length ?? 0)} picks`);
    process.exit(0);
  });
}
