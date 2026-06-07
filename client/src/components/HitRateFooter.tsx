import { useQuery } from "@tanstack/react-query";
import type { TierHitRate, Verdict } from "@/lib/types";

// 30d / 60d / 90d hit-rate footer keyed by the pick's tier. Renders nothing
// extra when the tier has no cached data.
export function HitRateFooter({ tier }: { tier: Verdict }) {
  const { data } = useQuery<TierHitRate[]>({ queryKey: ["/api/mlb/hit-rates"] });
  const row = data?.find((r) => r.tier === tier);
  if (!row) {
    return (
      <div className="text-[11px] tabular-nums text-muted-foreground" data-testid="hit-rate-footer">
        Track record building…
      </div>
    );
  }
  const byWindow = (d: number) => row.windows.find((w) => w.windowDays === d)?.pct ?? 0;
  return (
    <div className="flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground" data-testid="hit-rate-footer">
      <span>30d {byWindow(30)}%</span>
      <span className="text-white/15">·</span>
      <span>60d {byWindow(60)}%</span>
      <span className="text-white/15">·</span>
      <span>90d {byWindow(90)}%</span>
    </div>
  );
}
