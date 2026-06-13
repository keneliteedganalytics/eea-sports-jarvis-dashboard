// Virtual parlay builder (v6.7.9). Runs on every prop-ingest cycle and once on
// boot. Groups SNIPER prop picks by game_id for today AND tomorrow, and for each
// game with >=1 SNIPER pick auto-forms (or refreshes) a $100 virtual parlay using
// every SNIPER leg in that game. The parlay is a PAPER portfolio — it never moves
// the bankroll. Formation is idempotent: parlay_id = "<operating_day>:<game_id>",
// and upsertVirtualParlay only rewrites the leg composition while status='pending'
// so a re-ingest can't disturb a parlay that's already being graded.
//
// Combined odds = product of each leg's American→decimal price; potential payout =
// $100 × combined decimal; potential profit = payout − $100. Best-effort: every
// step is void+catch guarded so a builder throw can't crash the ingest worker.

import {
  sniperPropPicksForDates,
  upsertVirtualParlay,
  getSystemState,
  setSystemState,
  type SniperParlayLeg,
} from "../gradedBook";
import { americanToDecimal, decimalToAmerican } from "../core/odds";
import { getOperatingDay, tomorrowOperatingDay, yesterdayOperatingDay } from "../sports/mlb/operatingDay";
import { runVirtualParlayTrackForDates } from "./virtualParlayTracker";

// One-shot idempotency flag. Once the v6.7.9 backfill has walked history, it sets
// this so a redeploy doesn't re-walk (the build is idempotent anyway, but this
// keeps boot cheap).
// Bumped to _b after the v6.7.9 builder was fixed to date SNIPER picks by
// posted_at (the prior offer-join query found nothing on prod, so the first
// backfill ran empty and set the old flag). The new flag forces a clean re-walk.
const BACKFILL_FLAG = "virtual_parlays_v679_initialized_b";

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
  groups: number; // distinct game groups seen
  built: number; // parlays upserted (>=1 priced leg)
}

// Build/refresh parlays for an explicit set of operating days. Shared by the
// ingest hook (today+tomorrow) and the boot backfill (last 7 days).
export function buildVirtualParlaysForDates(dates: string[]): ParlayBuildSummary {
  const uniqueDates = [...new Set(dates)].filter(Boolean);
  if (uniqueDates.length === 0) return { dates: [], groups: 0, built: 0 };

  const legs = sniperPropPicksForDates(uniqueDates);

  // Group by the parlay key (operating_day + game_id). A game can technically host
  // legs on two operating days only across the date boundary; keying on both keeps
  // each civil day's parlay distinct.
  const groups = new Map<string, SniperParlayLeg[]>();
  for (const leg of legs) {
    const key = `${leg.operating_day}:${leg.game_id}`;
    const arr = groups.get(key) ?? [];
    arr.push(leg);
    groups.set(key, arr);
  }

  let built = 0;
  for (const [parlayId, groupLegs] of groups.entries()) {
    try {
      // Only legs with a usable price contribute to combined odds.
      const priced = groupLegs.filter((l) => legPrice(l) != null);
      if (priced.length === 0) continue;

      let combinedDecimal = 1;
      for (const l of priced) {
        const dec = americanToDecimal(legPrice(l));
        if (dec == null) continue;
        combinedDecimal *= dec;
      }
      if (combinedDecimal <= 1) continue;

      const combinedAmerican = decimalToAmerican(combinedDecimal);
      if (combinedAmerican == null) continue;

      const stake = 100;
      const payout = Math.round(stake * combinedDecimal * 100) / 100;
      const profit = Math.round((payout - stake) * 100) / 100;
      const first = priced[0];

      upsertVirtualParlay({
        parlay_id: parlayId,
        operating_day: first.operating_day,
        game_id: first.game_id,
        game_label: gameLabel(first),
        sport: (first.sport ?? "mlb").toLowerCase(),
        leg_count: priced.length,
        leg_pick_ids: priced.map((l) => l.pick_id),
        combined_decimal: Math.round(combinedDecimal * 1e6) / 1e6,
        combined_american: combinedAmerican,
        potential_payout_dollars: payout,
        potential_profit_dollars: profit,
      });
      built++;
    } catch {
      // best-effort per group; a failure on one game never blocks the others
    }
  }

  return { dates: uniqueDates, groups: groups.size, built };
}

// The cycle hook: build parlays for today AND tomorrow. Called right after each
// prop ingest+build cycle and on boot.
export function runVirtualParlayBuild(now: Date = new Date()): ParlayBuildSummary {
  const today = getOperatingDay(now);
  const tomorrow = tomorrowOperatingDay(now);
  const summary = buildVirtualParlaysForDates([today, tomorrow]);
  if (summary.built > 0) {
    log(`built/refreshed ${summary.built} virtual parlay(s) across ${summary.groups} game group(s)`);
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

// One-shot boot backfill: walk SNIPER prop picks over the last 7 operating days,
// build their parlays, then run the tracker once so any parlay whose legs are
// already graded lands on its final won/busted status immediately. Idempotent via
// the BACKFILL_FLAG system_state key. Best-effort: never throws to the caller.
export function backfillVirtualParlaysV679(now: Date = new Date()): {
  ran: boolean;
  build?: ParlayBuildSummary;
} {
  try {
    if (getSystemState(BACKFILL_FLAG)) return { ran: false };
    const days = lastSevenDays(now);
    const build = buildVirtualParlaysForDates(days);
    runVirtualParlayTrackForDates(days);
    setSystemState(BACKFILL_FLAG, new Date().toISOString());
    log(`v6.7.9 backfill: built ${build.built} parlay(s) over ${days.length} day(s)`);
    return { ran: true, build };
  } catch {
    // best-effort; a backfill failure must never block boot
    return { ran: false };
  }
}
