// Visual treatment for a pick's graded-book status. Shared by PickCard and
// CompactCard so the colored border, status badge, and score line stay
// consistent. Returns null when the pick has no graded status (pre-persist or
// still pending with no live data) — cards then render their existing style.

import type { BuiltPick } from "./types";

export interface GradeVisual {
  borderColor: string;
  badgeText: string;
  badgeColor: string;
  live: boolean;
  scoreLine: string | null;
  // Final-card treatment (status === 'final' only). glow is a box-shadow value
  // (empty string when none, e.g. PUSH); finalScoreLine is the prominent
  // "FINAL · Away 3 — Home 2" row; dim drops card opacity so finals settle.
  isFinal: boolean;
  glow: string;
  finalScoreLine: string | null;
  dim: number; // card opacity (1 = none)
}

function fmtPl(pl: number | null | undefined): string {
  const n = pl ?? 0;
  const abs = Math.abs(n).toFixed(2).replace(/\.?0+$/, "");
  return abs;
}

export function gradeVisual(pick: BuiltPick): GradeVisual | null {
  const status = pick.gradeStatus;
  if (!status) return null;

  const away = pick.awayTeam;
  const home = pick.homeTeam;

  if (status === "final" && pick.gradeResult) {
    const a = pick.finalAwayScore ?? pick.liveAwayScore;
    const h = pick.finalHomeScore ?? pick.liveHomeScore;
    const hasScore = a !== null && a !== undefined && h !== null && h !== undefined;
    const scoreLine = hasScore ? `Final: ${away} ${a} — ${home} ${h}` : null;
    const finalScoreLine = hasScore ? `FINAL · ${away} ${a} — ${home} ${h}` : null;
    const base = { live: false, scoreLine, isFinal: true, finalScoreLine, dim: 0.92 };
    if (pick.gradeResult === "W") {
      return {
        ...base,
        borderColor: "#4ADE80",
        badgeText: `WON +${fmtPl(pick.gradePl)}u`,
        badgeColor: "#4ADE80",
        glow: "0 0 24px rgba(74, 222, 128, 0.35)",
      };
    }
    if (pick.gradeResult === "L") {
      return {
        ...base,
        borderColor: "#EF4444",
        badgeText: `LOST -${fmtPl(pick.gradePl)}u`,
        badgeColor: "#EF4444",
        glow: "0 0 24px rgba(239, 68, 68, 0.35)",
      };
    }
    return { ...base, borderColor: "#6B7A99", badgeText: "PUSH", badgeColor: "#6B7A99", glow: "" };
  }

  if (status === "in_progress") {
    const a = pick.liveAwayScore;
    const h = pick.liveHomeScore;
    const detail = pick.liveStatusDetail ? ` · ${pick.liveStatusDetail}` : "";
    const score = a !== null && a !== undefined && h !== null && h !== undefined ? `${a}-${h}` : "—";
    return {
      borderColor: "#E8C14A",
      badgeText: `LIVE · ${away} ${score} ${home}${detail}`,
      badgeColor: "#E8C14A",
      live: true,
      scoreLine: pick.liveStatusDetail ? `Live: ${away} ${score} ${home} · ${pick.liveStatusDetail}` : `Live: ${away} ${score} ${home}`,
      isFinal: false,
      glow: "",
      finalScoreLine: null,
      dim: 1,
    };
  }

  // pending — keep existing card styling, no override.
  return null;
}
