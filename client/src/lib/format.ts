import type { Verdict } from "./types";

export const TIER_META: Record<Verdict, { label: string; hex: string }> = {
  SNIPER: { label: "SNIPER PLAY", hex: "#E8C14A" },
  EDGE: { label: "EDGE PLAY", hex: "#C9A227" },
  RECON: { label: "RECON PLAY", hex: "#9A7B1E" },
  PASS: { label: "PASS", hex: "#6B7A99" },
};

export function fmtLine(ml: number | null | undefined): string {
  if (ml === null || ml === undefined) return "—";
  return ml > 0 ? `+${ml}` : `${ml}`;
}

export function fmtPct(p: number | null | undefined, digits = 1): string {
  if (p === null || p === undefined) return "—";
  return `${(p * 100).toFixed(digits)}%`;
}

export function fmtUnits(u: number): string {
  if (u === 0) return "0u";
  return `${u % 1 === 0 ? u.toFixed(0) : u.toFixed(1)}u`;
}

export function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// Format a YYYY-MM-DD operating day as "Mon Jun 8" in America/New_York.
// Parsed as a noon-UTC instant so the calendar date never slips a day under
// the ET offset. Returns "" for malformed input so the header degrades cleanly.
export function fmtGameDate(isoDate: string | null | undefined): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return "";
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}

// Normalize a server clock string ("8:30 PM ET") to "8:30 PM Eastern" for the
// card header. Leaves already-normalized or empty strings untouched.
export function fmtGameTime(timeEt: string | null | undefined): string {
  if (!timeEt) return "";
  return timeEt.replace(/\bE[TD]T?\b/, "Eastern").trim();
}

// Line-movement delta for a side. Returns direction + cents moved.
export function lineMovement(
  open: number | null,
  current: number | null,
): { dir: "up" | "down" | "flat"; cents: number } {
  if (open === null || current === null) return { dir: "flat", cents: 0 };
  const cents = Math.abs(Math.abs(current) - Math.abs(open));
  if (cents < 1) return { dir: "flat", cents: 0 };
  // "Down" = line got more expensive (shorter price) for the favorite side.
  const dir = current < open ? "down" : "up";
  return { dir, cents };
}
