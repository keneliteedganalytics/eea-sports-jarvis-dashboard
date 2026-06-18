// CLV lock worker. When a pick's game start window opens (first pitch / tip /
// puck drop / kickoff), snapshot the closing line and compute Closing Line Value
// vs the price the pick was posted at. Runs every 5 minutes; piggybacks on the
// same Odds API path the slate uses (Pinnacle preferred, best book as fallback).

import { fetchOddsForSport, type OddsEvent } from "../adapters/oddsApi";
import { pinnacleMoneyline } from "../adapters/lineMovement";
import { nameToAbbr } from "../sports/mlb/teams";
import { computeClv } from "../lib/clv";
import { openLockPicksForDate, lockClosingLine, type GradedPick } from "../gradedBook";
import { DISPLAY_TIMEZONE } from "../utils/timezone";

// How early before the listed start the lock window opens (spec: now ≥ start − 60s).
export const LOCK_LEAD_MS = 60_000;
// Window inside which a Pinnacle price is still treated as the "close"; outside
// it we fall back to the best available book.
export const PINNACLE_WINDOW_MS = 10 * 60_000;

const SPORT_ODDS_KEYS: Record<string, string[]> = {
  mlb: ["baseball_mlb"],
  nhl: ["icehockey_nhl"],
  nba: ["basketball_nba"],
};

export interface LockSummary {
  date: string;
  scanned: number;
  locked: number;
}

// Best (highest) American price for the pick side across the trusted books on the
// event. Returns the price and a source label, or null when no book has it.
function bestBookPrice(ev: OddsEvent, side: "home" | "away"): { price: number; source: string } | null {
  let best: number | null = null;
  let bestBook: string | null = null;
  for (const b of ev.books) {
    const price = side === "home" ? b.homePrice : b.awayPrice;
    if (price === null) continue;
    if (best === null || price > best) {
      best = price;
      bestBook = b.book;
    }
  }
  return best === null ? null : { price: best, source: bestBook ?? "consensus" };
}

// Resolve the closing price for a pick from its live odds event. Pinnacle is the
// closing snapshot when it's available and we're inside the ±10-min window; else
// the best available book price, tagged with its source.
export function closingPriceForPick(
  pick: GradedPick,
  ev: OddsEvent,
  now: number,
): { price: number; source: string } | null {
  const side = pick.pickSide === "home" ? "home" : "away";
  const startMs = pick.gameStartIso ? Date.parse(pick.gameStartIso) : NaN;
  const withinPinnacleWindow =
    Number.isFinite(startMs) && Math.abs(now - startMs) <= PINNACLE_WINDOW_MS;

  if (withinPinnacleWindow) {
    const pin = pinnacleMoneyline(ev);
    const pinPrice = side === "home" ? pin.home : pin.away;
    if (pinPrice !== null) return { price: pinPrice, source: "pinnacle" };
  }
  return bestBookPrice(ev, side);
}

// Whether the lock window has opened for a pick (now ≥ start − lead).
export function lockWindowOpen(pick: GradedPick, now: number): boolean {
  if (!pick.gameStartIso) return false;
  const startMs = Date.parse(pick.gameStartIso);
  if (!Number.isFinite(startMs)) return false;
  return now >= startMs - LOCK_LEAD_MS;
}

// Pure: given the open picks and an eventId→event map, capture closing lines and
// compute CLV. Network-free so it's directly testable.
export function applyLocks(
  picks: GradedPick[],
  byEvent: Map<string, OddsEvent>,
  summary: LockSummary,
  now: number,
): void {
  for (const pick of picks) {
    if (pick.postedOddsAmerican === null) continue;
    if (!lockWindowOpen(pick, now)) continue;
    const ev = byEvent.get(pick.gameId);
    if (!ev) continue;
    const close = closingPriceForPick(pick, ev, now);
    if (!close) continue;
    const { clvPoints, clvPercent } = computeClv(pick.postedOddsAmerican, close.price);
    lockClosingLine(pick.id, {
      closingOddsAmerican: close.price,
      closingSource: close.source,
      clvPoints,
      clvPercent,
    });
    summary.locked++;
    console.log(
      `[lockWorker] locked ${pick.id} posted=${pick.postedOddsAmerican} ` +
        `closing=${close.price} (${close.source}) clvPts=${clvPoints} clvPct=${clvPercent}%`,
    );
  }
}

// Fetch every relevant sport's current odds once, build an eventId→event map.
async function fetchEventsForSports(sports: Set<string>): Promise<Map<string, OddsEvent>> {
  const byEvent = new Map<string, OddsEvent>();
  const keys = new Set<string>();
  for (const sport of sports) for (const k of SPORT_ODDS_KEYS[sport] ?? []) keys.add(k);

  await Promise.all(
    [...keys].map(async (key) => {
      try {
        const events = await fetchOddsForSport(key, nameToAbbr);
        for (const ev of events) byEvent.set(ev.eventId, ev);
      } catch (e) {
        console.error(`[lockWorker] odds fetch threw for ${key}:`, e instanceof Error ? e.message : e);
      }
    }),
  );
  return byEvent;
}

// Run one lock sweep for a date: capture closing lines for any open pick whose
// window has opened. Never throws.
export async function runLockSweep(date: string, now = Date.now()): Promise<LockSummary> {
  const open = openLockPicksForDate(date);
  const summary: LockSummary = { date, scanned: open.length, locked: 0 };
  if (open.length === 0) return summary;

  const due = open.filter((p) => lockWindowOpen(p, now));
  if (due.length === 0) return summary;

  const sports = new Set(due.map((p) => p.sport));
  const byEvent = await fetchEventsForSports(sports);
  if (byEvent.size === 0) return summary;

  applyLocks(due, byEvent, summary, now);
  return summary;
}

const SWEEP_INTERVAL_MS = 5 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

function todayEt(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function yesterdayEt(now: Date = new Date()): string {
  return todayEt(new Date(now.getTime() - 86_400_000));
}

async function sweepNow(): Promise<void> {
  try {
    await runLockSweep(todayEt());
    await runLockSweep(yesterdayEt());
  } catch (e) {
    console.error("lockWorker sweep failed:", e instanceof Error ? e.message : e);
  }
}

export function startLockWorker(): void {
  if (timer) return;
  void sweepNow();
  timer = setInterval(() => void sweepNow(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}
