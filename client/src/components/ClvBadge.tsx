import { fmtLine } from "@/lib/format";
import type { BuiltPick, ClvBadge as ClvBadgeData } from "@/lib/types";

// Brand Board v3 CLV colors.
const POSITIVE = "#4ADE80"; // win green — beat the close
const NEGATIVE = "#EF4444"; // loss red — gave up value
const NEUTRAL = "#6B7A99"; // slate — flat / pre-lock

// Per-sport "lock at <event>" copy for the pre-lock chip.
const LOCK_LABEL: Record<string, string> = {
  mlb: "Lock at first pitch",
  nba: "Lock at tip",
  nhl: "Lock at puck drop",
};

function lockLabel(sport: string): string {
  return LOCK_LABEL[sport] ?? "Lock at start";
}

// Closing Line Value chip. Before the lock fires (status 'open') it shows a
// muted slate "Lock at <event>" placeholder; once 'locked'/'final' it renders
// the signed CLV badge with green/red/slate coloring + a posted/closed tooltip.
export function ClvBadge({ pick }: { pick: BuiltPick }) {
  const clv = pick.clv;
  if (!clv) return null;

  if (clv.status === "open" || clv.closingOdds === null) {
    return (
      <div className="flex items-center gap-1.5 text-[11px]" data-testid={`clv-open-${pick.gameId}`}>
        <span className="font-display text-[10px] font-bold uppercase tracking-wider text-slate">
          {lockLabel(pick.sport)}
        </span>
      </div>
    );
  }

  const positive = clv.percent > 0;
  const negative = clv.percent < 0;
  const color = positive ? POSITIVE : negative ? NEGATIVE : NEUTRAL;
  const icon = positive ? "▲" : negative ? "▼" : "•";
  const pct = `${clv.percent >= 0 ? "+" : ""}${clv.percent.toFixed(1)}%`;
  const pts = `${clv.points >= 0 ? "+" : ""}${clv.points.toFixed(1)} pts`;
  const tooltip = `Posted at ${fmtLine(clv.postedOdds)}, closed at ${fmtLine(clv.closingOdds)}${
    clv.closingSource ? ` (${clv.closingSource})` : ""
  }`;

  return (
    <div
      className="flex items-center gap-1.5 text-[11px] tabular-nums"
      title={tooltip}
      data-testid={`clv-badge-${pick.gameId}`}
    >
      <span className="font-display text-[10px] font-bold uppercase tracking-wider text-slate">CLV</span>
      <span className="font-sans font-semibold" style={{ color }}>
        {icon} {pct} ({pts})
      </span>
    </div>
  );
}
