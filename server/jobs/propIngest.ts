// Prop ingestion + pick-build worker (v6.7). Every 30 minutes — and once on boot
// — ingest MLB prop offers from The Odds API (multi-book) for BOTH today and
// tomorrow, then chain the pick builder so the PROPS board reflects fresh lines.
//
// Why both days: most books post a day's props gradually, so tomorrow alone
// leaves today's (live/imminent) slate empty all day. We pull today first, then
// tomorrow. Every step is best-effort and void+catch guarded so a worker throw
// can't crash the process and a failure on one day never blocks the other.

import { ingestMlbPropsForDate } from "../sports/props/ingestMlbProps";
import { buildMlbPropPicks } from "../sports/props/buildPropPicks";
import { getOperatingDay, tomorrowOperatingDay } from "../sports/mlb/operatingDay";
import { runVirtualParlayBuild } from "./virtualParlayBuilder";

// Re-exported from the operating-day module (single source of truth) so existing
// importers of `propIngest.tomorrowOperatingDay` keep working unchanged.
export { tomorrowOperatingDay };

// Local logger (matches index.ts's prefixed format) so this module never imports
// ../index — that module's top-level IIFE boots the HTTP server on import, which
// would start a listening server whenever a test imports the worker.
function log(message: string, source = "props"): void {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [${source}] ${message}`);
}

export const PROP_INGEST_INTERVAL_MS = 30 * 60_000; // 30 minutes

// Injectable dependencies so the worker's day-routing logic is testable without
// a live key. Production passes nothing and the real adapters are used.
export interface PropCycleDeps {
  ingest: typeof ingestMlbPropsForDate;
  build: typeof buildMlbPropPicks;
}
const DEFAULT_DEPS: PropCycleDeps = { ingest: ingestMlbPropsForDate, build: buildMlbPropPicks };

// One ingest+build cycle. Returns the build summary for logging/tests.
export async function runPropCycle(
  date?: string,
  deps: PropCycleDeps = DEFAULT_DEPS,
): Promise<{ date: string; offers: number; written: number }> {
  const day = date ?? tomorrowOperatingDay();
  const ingest = await deps.ingest(day).catch((err) => {
    log(`prop ingest failed: ${(err as Error).message}`, "props");
    return { date: day, events: 0, offers: 0 };
  });
  const build = await deps.build(day).catch((err) => {
    log(`prop build failed: ${(err as Error).message}`, "props");
    return { date: day, considered: 0, written: 0, pickIds: [] as string[] };
  });
  if (ingest.offers > 0 || build.written > 0) {
    log(`prop cycle ${day}: ${ingest.offers} offers → ${build.written} picks`, "props");
  }
  return { date: day, offers: ingest.offers, written: build.written };
}

export interface BothCyclesSummary {
  ranAt: string;
  today: { date: string; offers: number; written: number };
  tomorrow: { date: string; offers: number; written: number };
}

// Last completed runBothCycles result, surfaced via the debug endpoint so we can
// confirm the worker is actually firing for both days. Null until the first run.
let lastIngestSummary: BothCyclesSummary | null = null;

export function getLastIngestSummary(): BothCyclesSummary | null {
  return lastIngestSummary;
}

// Run a full ingest+build for today AND tomorrow, today first. Best-effort: each
// day's cycle is independently guarded by runPropCycle so one failure can't block
// the other. Records the result in lastIngestSummary for the debug endpoint.
export async function runBothCycles(
  now: Date = new Date(),
  deps: PropCycleDeps = DEFAULT_DEPS,
): Promise<BothCyclesSummary> {
  const todayDate = getOperatingDay(now);
  const tomorrowDate = tomorrowOperatingDay(now);
  const today = await runPropCycle(todayDate, deps).catch(() => ({ date: todayDate, offers: 0, written: 0 }));
  const tomorrow = await runPropCycle(tomorrowDate, deps).catch(() => ({ date: tomorrowDate, offers: 0, written: 0 }));
  // v6.7.9: after the picks are fresh, (re)form the per-game virtual parlays for
  // today + tomorrow. Idempotent + best-effort: a builder throw can't disrupt the
  // ingest summary or the bankroll (virtual parlays are paper only).
  try {
    runVirtualParlayBuild(now);
  } catch {
    // best-effort; the next cycle retries
  }
  lastIngestSummary = { ranAt: new Date().toISOString(), today, tomorrow };
  return lastIngestSummary;
}

let timer: NodeJS.Timeout | null = null;

export function startPropIngestWorker(): void {
  // Fire one cycle immediately (after port bind), then settle into the cadence.
  // Both days run on the boot kickoff and on every tick.
  void runBothCycles().catch(() => undefined);
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void runBothCycles().catch(() => undefined);
  }, PROP_INGEST_INTERVAL_MS);
}

export function stopPropIngestWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
