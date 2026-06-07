import { useQuery } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtUnits } from "@/lib/format";
import type { TierHitRate, TrackRecordSummary } from "@/lib/types";

export default function TrackRecord() {
  const { data: summary } = useQuery<TrackRecordSummary>({ queryKey: ["/api/mlb/track-record"] });
  const { data: hitRates } = useQuery<TierHitRate[]>({ queryKey: ["/api/mlb/hit-rates"] });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Track Record</h1>
        <p className="text-xs text-muted-foreground">Closing-line value and realized edge across the desk's graded book.</p>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="track-summary">
          <Metric label="CLV" value={`${summary.clvPct >= 0 ? "+" : ""}${summary.clvPct.toFixed(1)}%`} good={summary.clvPct >= 0} />
          <Metric label="EV realized" value={fmtUnits(summary.evRealizedUnits)} good={summary.evRealizedUnits >= 0} />
          <Metric label="ROI" value={`${summary.roiPct >= 0 ? "+" : ""}${summary.roiPct.toFixed(1)}%`} good={summary.roiPct >= 0} />
          <Metric label="Max drawdown" value={fmtUnits(summary.maxDrawdownUnits)} good={false} />
          <Metric label="Total bets" value={String(summary.totalBets)} />
          <Metric
            label="Record"
            value={`${summary.record.wins}-${summary.record.losses}-${summary.record.pushes}`}
          />
        </div>
      )}

      {hitRates && hitRates.length > 0 && (
        <div className="rounded-xl border border-card-border bg-navy-card p-4">
          <div className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Hit rate by tier</div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">30d</TableHead>
                  <TableHead className="text-right">60d</TableHead>
                  <TableHead className="text-right">90d</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hitRates.map((r) => {
                  const w = (d: number) => r.windows.find((x) => x.windowDays === d)?.pct ?? 0;
                  return (
                    <TableRow key={r.tier} data-testid={`hit-rate-row-${r.tier}`}>
                      <TableCell className="font-medium">{r.tier}</TableCell>
                      <TableCell className="text-right tabular-nums">{w(30)}%</TableCell>
                      <TableCell className="text-right tabular-nums">{w(60)}%</TableCell>
                      <TableCell className="text-right tabular-nums">{w(90)}%</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {summary && summary.betLog.length > 0 && (
        <div className="rounded-xl border border-card-border bg-navy-card p-4">
          <div className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">Graded book</div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Matchup</TableHead>
                  <TableHead>Pick</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-center">Result</TableHead>
                  <TableHead className="text-right">CLV</TableHead>
                  <TableHead className="text-right">P/L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.betLog.map((b, i) => (
                  <TableRow key={i} data-testid={`bet-log-row-${i}`}>
                    <TableCell className="tabular-nums text-muted-foreground">{b.date}</TableCell>
                    <TableCell>{b.matchup}</TableCell>
                    <TableCell>{b.pick}</TableCell>
                    <TableCell>{b.tier}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtUnits(b.units)}</TableCell>
                    <TableCell className="text-center">
                      <span
                        className={
                          b.result === "W"
                            ? "text-tier-bonus"
                            : b.result === "L"
                              ? "text-destructive"
                              : "text-muted-foreground"
                        }
                      >
                        {b.result}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{b.clv}</TableCell>
                    <TableCell className={`text-right tabular-nums ${b.unitsWon >= 0 ? "text-tier-bonus" : "text-destructive"}`}>
                      {b.unitsWon >= 0 ? "+" : ""}
                      {b.unitsWon.toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  const tone = good === undefined ? "text-foreground" : good ? "text-tier-bonus" : "text-trap";
  return (
    <div className="rounded-xl border border-card-border bg-navy-card p-3" data-testid={`metric-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
