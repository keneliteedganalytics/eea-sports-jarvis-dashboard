// v6.13.1 — Baseball Savant Statcast cache refresh.
//
// The Savant leaderboards update at most daily, so the adapter caches each
// season's tables for 24h. This job force-loads them (on boot and once a day)
// so the first slate of the day doesn't pay the cold-fetch latency and so the
// cache never silently ages out mid-day. Best-effort: never throws, logs a
// one-line summary. Run manually with `npm run refresh:savant`.

import { refreshSeasonTables } from "../adapters/savantStats";

const DAY_MS = 24 * 60 * 60 * 1000;

function currentSeason(): number {
  return new Date().getUTCFullYear();
}

// Load (and cache) the current season's Savant tables. Returns the row counts
// so callers/tests can assert the feed is live.
export async function refreshSavantCache(
  year: number = currentSeason(),
): Promise<{ expected: number; barrels: number; walks: number }> {
  try {
    const tables = await refreshSeasonTables(year);
    const counts = {
      expected: tables.expected.size,
      barrels: tables.barrels.size,
      walks: tables.walks.size,
    };
    console.log(
      `[savant refresh] ${year}: expected=${counts.expected} barrels=${counts.barrels} walks=${counts.walks}`,
    );
    return counts;
  } catch (err) {
    console.warn(`[savant refresh] failed: ${(err as Error).message}`);
    return { expected: 0, barrels: 0, walks: 0 };
  }
}

// Kick a refresh now and schedule a daily one. Fire-and-forget on boot.
export function startSavantRefresh(): void {
  void refreshSavantCache();
  const timer = setInterval(() => void refreshSavantCache(), DAY_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === "function") timer.unref();
}

// Allow `npm run refresh:savant` (and `tsx server/jobs/refreshSavant.ts`) to
// run a one-shot refresh from the CLI. Guarded on argv (not import.meta) so the
// cjs production bundle emits no import.meta warning.
const invokedDirectly = /refreshSavant(\.ts|\.js)?$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  refreshSavantCache().then((c) => {
    console.log(`Savant refresh complete: ${JSON.stringify(c)}`);
    process.exit(0);
  });
}
