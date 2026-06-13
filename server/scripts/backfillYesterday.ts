// One-shot backfill: run the live-scoring poller for a single date so any picks
// already in the graded book get matched to their ESPN final scores and graded.
// Defaults to yesterday's ET date; pass a YYYY-MM-DD as the first arg to target
// a specific day.
//   Run: tsx server/scripts/backfillYesterday.ts [YYYY-MM-DD]

import { pollEspnAndUpdate } from "../jobs/liveScoring";
import { DISPLAY_TIMEZONE } from "../utils/timezone";

function yesterdayEt(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() - 86_400_000));
}

async function main(): Promise<void> {
  const date = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : yesterdayEt();
  console.log(`Backfilling graded book for ${date} from the public ESPN scoreboard…`);
  const summary = await pollEspnAndUpdate(date);
  console.log(`Scanned ${summary.scanned} open pick(s) · updated ${summary.updated} · graded ${summary.graded}.`);
}

void main();
