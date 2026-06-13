// Virtual parlay live-state tracker (v6.7.9). Runs on the same tick as the live
// prop tracker. For each virtual parlay that is not yet terminal (won/busted), it
// recomputes leg dispositions from the underlying SNIPER prop picks and advances
// the parlay's status:
//
//   • any leg busted          → parlay BUSTED, pl = −$100 (the whole stake is lost)
//   • all legs won            → parlay WON,    pl = potential_profit
//   • >=1 won, or any live/bust→ parlay LIVE   (in flight; pl stays NULL)
//   • else                    → parlay PENDING (pl stays NULL)
//
// A leg is "won" when result='W', "busted" when result='L' OR live_state='busted',
// otherwise "pending". A push (result='P') is treated as a non-busting,
// non-winning leg (parlay leg voided → still pending unless other legs decide it).
//
// This tracker NEVER touches the bankroll — virtual parlays are paper only. Every
// step is best-effort + void/catch guarded so a tick throw can't crash the loop.

import {
  getVirtualParlaysForDate,
  sniperPropPicksForDates,
  updateVirtualParlayState,
  type SniperParlayLeg,
  type VirtualParlayRow,
} from "../gradedBook";
import { getOperatingDay, tomorrowOperatingDay } from "../sports/mlb/operatingDay";

function log(message: string, source = "parlays"): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [${source}] ${message}`);
}

type LegState = "won" | "busted" | "pending";

export function legDisposition(leg: { result: string | null; live_state: string | null }): LegState {
  if (leg.result === "W") return "won";
  if (leg.result === "L") return "busted";
  if (leg.live_state === "busted") return "busted";
  return "pending";
}

export interface ParlayTransition {
  status: string;
  legs_won: number;
  legs_busted: number;
  legs_pending: number;
  pl_dollars: number | null;
}

// Pure state machine: given a parlay row + the current dispositions of its legs,
// return the next stored state. Exported for unit testing.
export function computeParlayTransition(
  parlay: VirtualParlayRow,
  legStates: LegState[],
): ParlayTransition {
  const won = legStates.filter((s) => s === "won").length;
  const busted = legStates.filter((s) => s === "busted").length;
  const pending = legStates.filter((s) => s === "pending").length;

  // Any busted leg kills the whole parlay — stake lost.
  if (busted > 0) {
    return { status: "busted", legs_won: won, legs_busted: busted, legs_pending: pending, pl_dollars: -100 };
  }
  // Every leg won → parlay cashes for the full profit.
  if (pending === 0 && won === legStates.length && legStates.length > 0) {
    return {
      status: "won",
      legs_won: won,
      legs_busted: busted,
      legs_pending: pending,
      pl_dollars: parlay.potential_profit_dollars ?? 0,
    };
  }
  // Some legs have cleared but not all → in flight.
  if (won > 0) {
    return { status: "live", legs_won: won, legs_busted: busted, legs_pending: pending, pl_dollars: null };
  }
  // Nothing decided yet.
  return { status: "pending", legs_won: won, legs_busted: busted, legs_pending: pending, pl_dollars: null };
}

export interface ParlayTrackSummary {
  dates: string[];
  evaluated: number;
  transitions: number;
}

// One tracking pass for an explicit set of operating days. Reads each day's
// parlays and the SNIPER legs that compose them, recomputes state, and writes any
// change. A parlay already won/busted is skipped (frozen).
export function runVirtualParlayTrackForDates(dates: string[]): ParlayTrackSummary {
  const uniqueDates = [...new Set(dates)].filter(Boolean);
  if (uniqueDates.length === 0) return { dates: [], evaluated: 0, transitions: 0 };

  // Index every SNIPER leg by pick_id so a parlay's leg_pick_ids resolve in O(1).
  const legsById = new Map<string, SniperParlayLeg>();
  for (const leg of sniperPropPicksForDates(uniqueDates)) {
    legsById.set(leg.pick_id, leg);
  }

  let evaluated = 0;
  let transitions = 0;

  for (const date of uniqueDates) {
    let parlays: VirtualParlayRow[];
    try {
      parlays = getVirtualParlaysForDate(date);
    } catch {
      continue;
    }
    for (const parlay of parlays) {
      if (parlay.status === "won" || parlay.status === "busted") continue;
      evaluated++;

      let pickIds: string[] = [];
      try {
        pickIds = JSON.parse(parlay.leg_pick_ids ?? "[]") as string[];
      } catch {
        pickIds = [];
      }
      if (pickIds.length === 0) continue;

      const legStates: LegState[] = pickIds.map((id) => {
        const leg = legsById.get(id);
        // A leg whose row we can't find this tick reads as pending (don't bust on
        // a transient read miss).
        if (!leg) return "pending";
        return legDisposition(leg);
      });

      const next = computeParlayTransition(parlay, legStates);
      const changed =
        next.status !== parlay.status ||
        next.legs_won !== parlay.legs_won ||
        next.legs_busted !== parlay.legs_busted ||
        next.legs_pending !== parlay.legs_pending ||
        next.pl_dollars !== parlay.pl_dollars;
      if (!changed) continue;

      try {
        updateVirtualParlayState(parlay.parlay_id, next);
        transitions++;
      } catch {
        // best-effort; a failed write retries next tick
      }
    }
  }

  if (transitions > 0) {
    log(`parlay tick: ${evaluated} evaluated, ${transitions} state change(s)`);
  }
  return { dates: uniqueDates, evaluated, transitions };
}

// The cycle hook: track today AND tomorrow. Called on the live-prop tracker tick.
export function runVirtualParlayTrack(now: Date = new Date()): ParlayTrackSummary {
  return runVirtualParlayTrackForDates([getOperatingDay(now), tomorrowOperatingDay(now)]);
}
