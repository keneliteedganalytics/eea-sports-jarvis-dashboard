import { fmtLine, TIER_META } from "@/lib/format";
import type { Market } from "@/lib/types";

// Inline total (over/under) row:
//   O/U  Over 8.5 (-110) · fair -104 · RECON +2.1pp
export function TotalRow({ market }: { market: Market }) {
  if (!market.available || !market.pick) {
    return (
      <div className="flex items-center gap-2 text-[11px] tabular-nums" data-testid="total-row">
        <span className="w-7 shrink-0 text-muted-foreground">O/U</span>
        <span className="text-muted-foreground/60" title="No total line posted for this game">
          No market
        </span>
      </div>
    );
  }
  const edge = market.edgePp;
  return (
    <div className="flex items-center gap-2 text-[11px] tabular-nums" data-testid="total-row">
      <span className="w-7 shrink-0 text-muted-foreground">O/U</span>
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
