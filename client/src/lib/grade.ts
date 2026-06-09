// Visual treatment for a pick's graded-book status. Shared by PickCard and
// CompactCard so the colored border, status badge, and score line stay
// consistent. Returns null when the pick has no graded status (pre-persist or
// still pending with no live data) — cards then render their existing style.

import type { BuiltPick } from "./types";

export interface GradeVisual {
  borderColor: string;
  badgeText: string;
  badgeColor: string;
  pulse: boolean;
  scoreLine: string | null;
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
    const scoreLine = a !== null && a !== undefined && h !== null && h !== undefined
      ? `Final: ${away} ${a} — ${home} ${h}`
      : null;
    if (pick.gradeResult === "W") {
      return { borderColor: "#4ADE80", badgeText: `WON +${fmtPl(pick.gradePl)}u`, badgeColor: "#4ADE80", pulse: false, scoreLine };
    }
    if (pick.gradeResult === "L") {
      return { borderColor: "#EF4444", badgeText: `LOST -${fmtPl(pick.gradePl)}u`, badgeColor: "#EF4444", pulse: false, scoreLine };
    }
    return { borderColor: "#6B7A99", badgeText: "PUSH", badgeColor: "#6B7A99", pulse: false, scoreLine };
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
      pulse: true,
      scoreLine: pick.liveStatusDetail ? `Live: ${away} ${score} ${home} · ${pick.liveStatusDetail}` : `Live: ${away} ${score} ${home}`,
    };
  }

  // pending — keep existing card styling, no override.
  return null;
}
