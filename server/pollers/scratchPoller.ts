// Scratch poller — periodically re-reads the MLB probable pitchers and flags a
// SCRATCH alert when a starter changes from what was last seen for a game.
// Best-effort: relies only on the public MLB Stats API (no key gate).

import { fetchSchedule } from "../adapters/mlbStats";
import { getOperatingDay } from "../sports/mlb/operatingDay";
import { pushAlert } from "./alerts";

export const SCRATCH_INTERVAL_MS = 5 * 60_000; // 5 minutes

// gamePk → "homePitcher|awayPitcher" last seen.
const lastSeen = new Map<string, string>();
let timer: NodeJS.Timeout | null = null;

export async function pollScratchOnce(): Promise<void> {
  const opDay = getOperatingDay();
  const schedule = await fetchSchedule(opDay);

  for (const g of schedule) {
    const key = `${g.homePitcher ?? "TBD"}|${g.awayPitcher ?? "TBD"}`;
    const prev = lastSeen.get(g.gamePk);
    if (prev && prev !== key) {
      pushAlert("SCRATCH", g.gamePk, `Probable pitcher change: ${g.awayTeam} @ ${g.homeTeam} (${prev} → ${key})`);
    }
    lastSeen.set(g.gamePk, key);
  }
}

export function startScratchPoller(): void {
  if (timer) return;
  void pollScratchOnce().catch((e) => console.error("scratchPoller:", e));
  timer = setInterval(() => void pollScratchOnce().catch((e) => console.error("scratchPoller:", e)), SCRATCH_INTERVAL_MS);
}

export function stopScratchPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
