// Prop ingestion + pick-build worker (v6.7). Every 30 minutes, ingest tomorrow's
// MLB prop offers from The Odds API (multi-book), then chain the pick builder so
// the PROPS board reflects fresh lines. Both steps are best-effort and void+catch
// guarded so a worker throw can't crash the process (same contract as the other
// background workers).

import { ingestMlbPropsForDate } from "../sports/props/ingestMlbProps";
import { buildMlbPropPicks } from "../sports/props/buildPropPicks";
import { getOperatingDay } from "../sports/mlb/operatingDay";
import { log } from "../index";

export const PROP_INGEST_INTERVAL_MS = 30 * 60_000; // 30 minutes

// Tomorrow's operating day (YYYY-MM-DD) — props are built one slate ahead.
export function tomorrowOperatingDay(now: Date = new Date()): string {
  const today = getOperatingDay(now);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// One ingest+build cycle. Returns the build summary for logging/tests.
export async function runPropCycle(date?: string): Promise<{ date: string; offers: number; written: number }> {
  const day = date ?? tomorrowOperatingDay();
  const ingest = await ingestMlbPropsForDate(day).catch((err) => {
    log(`prop ingest failed: ${(err as Error).message}`, "props");
    return { date: day, events: 0, offers: 0 };
  });
  const build = await buildMlbPropPicks(day).catch((err) => {
    log(`prop build failed: ${(err as Error).message}`, "props");
    return { date: day, considered: 0, written: 0, pickIds: [] as string[] };
  });
  if (ingest.offers > 0 || build.written > 0) {
    log(`prop cycle ${day}: ${ingest.offers} offers → ${build.written} picks`, "props");
  }
  return { date: day, offers: ingest.offers, written: build.written };
}

let timer: NodeJS.Timeout | null = null;

export function startPropIngestWorker(): void {
  // Fire one cycle immediately (after port bind), then settle into the cadence.
  void runPropCycle().catch(() => undefined);
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void runPropCycle().catch(() => undefined);
  }, PROP_INGEST_INTERVAL_MS);
}

export function stopPropIngestWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
