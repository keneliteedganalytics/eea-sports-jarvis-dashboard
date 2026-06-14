// Virtual parlay builder (v6.8.0). Runs on every prop-ingest cycle and once on
// boot. Emits ONE $100 single-leg paper bet per SNIPER prop pick for today AND
// tomorrow — NO per-game grouping, never combined. (v6.7.9 grouped a game's
// SNIPER picks into one multi-leg ticket; the user rejected that — each pick is
// staked $100 independently.) The portfolio is PAPER: it never moves the
// bankroll. Formation is idempotent: parlay_id = "<operating_day>:<pick_id>", and
// upsertVirtualParlay only rewrites composition while status='pending', so a
// re-ingest can't disturb a single that's already being graded.
//
// Each single's odds ARE the pick's odds: combined_decimal = americanToDecimal,
// payout = $100 × decimal, profit = payout − $100. Best-effort: every step is
// void+catch guarded so a builder throw can't crash the ingest worker.

import {
  sniperPropPicksForDates,
  upsertVirtualParlay,
  deleteVirtualParlaysForDates,
  getSystemState,
  setSystemState,
  type SniperParlayLeg,
} from "../gradedBook";
import { americanToDecimal } from "../core/odds";
import { getOperatingDay, tomorrowOperatingDay, yesterdayOperatingDay } from "../sports/mlb/operatingDay";
import { runVirtualParlayTrackForDates } from "./virtualParlayTracker";

// One-shot idempotency flag. Once the backfill has walked history, it sets this
// so a redeploy doesn't re-walk. Bumped to v6_8_0 for the per-pick-singles
// rewrite: the boot backfill now WIPES the 7-day window (clearing the old
// per-game groupings) and rebuilds it as singles.
const BACKFILL_FLAG = "parlay_backfill_v6_8_0";

function log(message: string, source = "parlays"): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [${source}] ${message}`);
}

// A human label for the game group. Prefer the offer-side event teams (away @
// home), then the pick's own team/opponent, then a sport·id fallback.
function gameLabel(leg: SniperParlayLeg): string {
  if (leg.event_away && leg.event_home) return `${leg.event_away} @ ${leg.event_home}`;
  if (leg.event_home) return leg.event_home;
  if (leg.team) return `${leg.team}${leg.opponent ? ` vs ${leg.opponent}` : ""}`;
  return `${(leg.sport ?? "mlb").toUpperCase()} · ${leg.game_id}`;
}

// The price a leg actually carries. Prefer the locked posted_odds; fall back to
// the builder's best_price when posted_odds is null on an ungraded leg.
function legPrice(leg: SniperParlayLeg): number | null {
  if (leg.posted_odds != null) return leg.posted_odds;
  if (leg.best_price != null) return leg.best_price;
  return null;
}

export interface ParlayBuildSummary {
  dates: string[];
  groups: number; // distinct SNIPER picks seen
  built: number; // singles upserted (one per priced pick)
}

// Build/refresh per-pick singles for an explicit set of operating days. One $100
// single-leg paper bet per SNIPER pick — no game grouping. Shared by the ingest
// hook (today+tomorrow) and the boot backfill (last 7 days).
export function buildVirtualParlaysForDates(dates: string[]): ParlayBuildSummary {
  const uniqueDates = [...new Set(dates)].filter(Boolean);
  if (uniqueDates.length === 0) return { dates: [], groups: 0, built: 0 };

  const legs = sniperPropPicksForDates(uniqueDates);

  let built = 0;
  for (const pick of legs) {
    try {
      const price = legPrice(pick);
      if (price == null) continue;

      const decimal = americanToDecimal(price);
      if (decimal == null || decimal <= 1) continue;

      const stake = 100;
      const payout = Math.round(stake * decimal * 100) / 100;
      const profit = Math.round((payout - stake) * 100) / 100;

      // One single per pick: keyed on the pick id so each is independent.
      upsertVirtualParlay({
        parlay_id: `${pick.operating_day}:${pick.pick_id}`,
        operating_day: pick.operating_day,
        game_id: pick.game_id,
        game_label: gameLabel(pick),
        sport: (pick.sport ?? "mlb").toLowerCase(),
        leg_count: 1,
        leg_pick_ids: [pick.pick_id],
        combined_decimal: Math.round(decimal * 1e6) / 1e6,
        combined_american: price,
        potential_payout_dollars: payout,
        potential_profit_dollars: profit,
      });
      built++;
    } catch {
      // best-effort per pick; a failure on one never blocks the others
    }
  }

  return { dates: uniqueDates, groups: legs.length, built };
}

// The cycle hook: build singles for today AND tomorrow. Called right after each
// prop ingest+build cycle and on boot.
export function runVirtualParlayBuild(now: Date = new Date()): ParlayBuildSummary {
  const today = getOperatingDay(now);
  const tomorrow = tomorrowOperatingDay(now);
  const summary = buildVirtualParlaysForDates([today, tomorrow]);
  if (summary.built > 0) {
    log(`built/refreshed ${summary.built} virtual single(s)`);
  }
  return summary;
}

// The trailing 7 operating days (today back through today−6), oldest first.
function lastSevenDays(now: Date = new Date()): string[] {
  const days: string[] = [getOperatingDay(now)];
  let cursor = now;
  for (let i = 0; i < 6; i++) {
    // Step back ~a day at a time and recompute the operating day so DST/boundary
    // shifts stay correct.
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    days.push(yesterdayOperatingDay(new Date(`${days[days.length - 1]}T12:00:00Z`)));
  }
  return [...new Set(days)].sort();
}

// One-shot boot backfill (v6.8.0): wipe the prior virtual parlays over the last 7
// operating days (clearing v6.7.9's per-game groupings), then walk SNIPER prop
// picks for that window and rebuild each as a $100 single, and run the tracker
// once so any single whose pick is already graded lands on its final won/busted
// status immediately. Idempotent via the BACKFILL_FLAG system_state key.
// Best-effort: never throws to the caller.
export function backfillVirtualParlaysV680(now: Date = new Date()): {
  ran: boolean;
  build?: ParlayBuildSummary;
  wiped?: number;
} {
  try {
    if (getSystemState(BACKFILL_FLAG)) return { ran: false };
    const days = lastSevenDays(now);
    const wiped = deleteVirtualParlaysForDates(days);
    const build = buildVirtualParlaysForDates(days);
    runVirtualParlayTrackForDates(days);
    setSystemState(BACKFILL_FLAG, new Date().toISOString());
    log(`v6.8.0 backfill: wiped ${wiped}, built ${build.built} single(s) over ${days.length} day(s)`);
    return { ran: true, build, wiped };
  } catch {
    // best-effort; a backfill failure must never block boot
    return { ran: false };
  }
}
