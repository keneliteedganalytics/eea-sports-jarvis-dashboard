import { useQuery } from "@tanstack/react-query";
import { fmtMoney } from "@/lib/format";
import type { BankrollState } from "@/lib/types";

// Running bankroll chip for the header, next to the brand wordmark. Renders
// like "$25,143 · +0.6%": value in Brand Board v3 slate (#DCE8F0); the net % in
// green (#4ADE80) when positive, red (#EF4444) when negative, slate when flat.
export function BankrollBadge() {
  const { data } = useQuery<BankrollState>({
    queryKey: ["/api/bankroll"],
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  if (!data) return null;

  const net = data.netDollars;
  const pctColor = net > 0 ? "#4ADE80" : net < 0 ? "#EF4444" : "#DCE8F0";
  const sign = data.roiPct > 0 ? "+" : "";

  return (
    <span
      className="hidden items-center gap-1.5 rounded-lg border border-gold/15 px-2.5 py-1 text-xs font-semibold sm:inline-flex"
      data-testid="bankroll-badge"
      title={`Lifetime ${data.record.wins}-${data.record.losses}-${data.record.pushes} · net ${fmtMoney(net)}`}
    >
      <span style={{ color: "#DCE8F0" }}>{fmtMoney(data.current)}</span>
      <span className="text-muted-foreground/50">·</span>
      <span style={{ color: pctColor }}>
        {sign}
        {data.roiPct.toFixed(1)}%
      </span>
    </span>
  );
}
