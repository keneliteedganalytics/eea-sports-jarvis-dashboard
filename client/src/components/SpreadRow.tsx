import { fmtLine, TIER_META } from "@/lib/format";
import type { Market } from "@/lib/types";

// Inline spread (run-line / puck-line / point-spread) row:
//   RL  TB -1.5 (+155) · fair -132 · EDGE +2.3pp
export function SpreadRow({ market, label = "RL" }: { market: Market; label?: string }) {
  if (!market.available || !market.pick) {
    return (
      <div className="flex items-center gap-2 text-[11px] tabular-nums" data-testid="spread-row">
        <span className="w-7 shrink-0 text-muted-foreground">{label}</span>
        <span className="text-muted-foreground/60" title="No spread line posted for this game">
          No market
        </span>
      </div>
    );
  }
  const edge = market.edgePp;
  return (
    <div className="flex items-center gap-2 text-[11px] tabular-nums" data-testid="spread-row">
      <span className="w-7 shrink-0 text-muted-foreground">{label}</span>
      <span className="text-foreground/80">{market.pick}</span>
      {market.fairLine !== null && (
        <span className="text-muted-foreground">· fair {fmtLine(market.fairLine)}</span>
      )}
      {edge !== null && market.tier !== "PASS" && (
        <span className="font-semibold" style={{ color: TIER_META[market.tier].hex }}>
          · {market.tier} {edge >= 0 ? "+" : ""}
          {edge}pp
        </span>
      )}
    </div>
  );
}
