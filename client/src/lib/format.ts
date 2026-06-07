import type { Verdict } from "./types";

export const TIER_META: Record<Verdict, { label: string; hex: string }> = {
  BONUS: { label: "★ BONUS PLAY", hex: "#4ADE80" },
  SNIPER: { label: "SNIPER PLAY", hex: "#E8C14A" },
  EDGE: { label: "EDGE PLAY", hex: "#C9A227" },
  RECON: { label: "RECON PLAY", hex: "#9A7B1E" },
  VALUE: { label: "VALUE PLAY", hex: "#A5B4FC" },
  LEAN: { label: "LEAN", hex: "#8892A0" },
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
