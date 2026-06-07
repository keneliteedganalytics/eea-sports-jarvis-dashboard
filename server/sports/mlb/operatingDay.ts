// Operating-day window: 6 AM ET → 6 AM ET. Game classification with a
// 60-minute tip cutoff. Ported from sports-engine sports/mlb/data.py.

export const OPERATING_DAY_BOUNDARY_HOUR = 6; // 6 AM ET
export const TOO_CLOSE_MINUTES = 60;

export type GameClassification = "PLAYABLE" | "TOO_CLOSE" | "STARTED" | "WRONG_DAY";

const ET_TZ = "America/New_York";

// Get the wall-clock parts of `date` as observed in US Eastern time.
function etParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute") };
}

// Returns the operating day as a YYYY-MM-DD string (ET). Before 6 AM ET the
// operating day is still "yesterday".
export function getOperatingDay(now: Date = new Date()): string {
  const p = etParts(now);
  let { year, month, day } = p;
  if (p.hour < OPERATING_DAY_BOUNDARY_HOUR) {
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() - 1);
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// True if the ET calendar date of `gameIso` matches the operating day window.
// The window is opDay 06:00 ET → opDay+1 06:00 ET, which collapses to: a game
// belongs to opDay if its own operating day equals opDay.
export function inOperatingWindow(gameIso: string, opDay: string): boolean {
  if (!gameIso) return false;
  const g = new Date(gameIso);
  if (Number.isNaN(g.getTime())) return false;
  return getOperatingDay(g) === opDay;
}

// Classify a game for playability. `startIso` is the commence time (UTC ISO).
export function classifyGame(startIso: string, opDay: string, now: Date = new Date()): GameClassification {
  if (!startIso) return "WRONG_DAY";
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return "WRONG_DAY";
  if (!inOperatingWindow(startIso, opDay)) return "WRONG_DAY";

  const minutesToStart = (start.getTime() - now.getTime()) / 60000;
  if (minutesToStart <= 0) return "STARTED";
  if (minutesToStart < TOO_CLOSE_MINUTES) return "TOO_CLOSE";
  return "PLAYABLE";
}

// Convert a UTC ISO timestamp into a short ET clock string, e.g. "9:45 PM ET".
export function utcIsoToEtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return `${t} ET`;
}
