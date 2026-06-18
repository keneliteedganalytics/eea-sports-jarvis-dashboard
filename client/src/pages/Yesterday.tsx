import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { PickCard } from "@/components/PickCard";
import { CompactCard } from "@/components/CompactCard";
import { fmtUnits } from "@/lib/format";
import { DISPLAY_TIMEZONE } from "@/lib/timezone";
import type { DailySlate, BuiltPick, Verdict } from "@/lib/types";

const QUALIFYING: Verdict[] = ["SNIPER", "EDGE", "RECON"];

function yesterdayEt(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(Date.now() - 86_400_000));
}

export default function Yesterday() {
  const date = useMemo(yesterdayEt, []);

  const { data, isLoading, isError } = useQuery<DailySlate>({
    queryKey: [`/api/slate?date=${date}`],
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const picks = useMemo<BuiltPick[]>(() => {
    if (!data) return [];
    const s = data.sports;
    return [...s.mlb.picks, ...s.nhl.picks, ...s.nba.picks];
  }, [data]);

  // Graded picks only (the bets we actually placed and settled).
  const graded = useMemo(
    () => picks.filter((p) => p.gradeStatus === "final" && p.gradeResult),
    [picks],
  );

  const summary = useMemo(() => {
    let wins = 0, losses = 0, pushes = 0, net = 0, staked = 0, clvSum = 0, clvN = 0;
    for (const p of graded) {
      if (p.gradeResult === "W") wins++;
      else if (p.gradeResult === "L") losses++;
      else pushes++;
      net += p.gradePl ?? 0;
      staked += p.units;
      if (p.clvPct != null) { clvSum += p.clvPct; clvN++; }
    }
    return {
      wins, losses, pushes,
      net: Math.round(net * 100) / 100,
      roi: staked > 0 ? Math.round((net / staked) * 1000) / 10 : 0,
      clv: clvN > 0 ? Math.round((clvSum / clvN) * 10) / 10 : 0,
    };
  }, [graded]);

  // Show every persisted pick (graded + live + still pending) for the day.
  const visible = useMemo(
    () => picks.filter((p) => p.gradeStatus),
    [picks],
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Yesterday</h1>
        <p className="text-xs text-muted-foreground">Graded results for {date}.</p>
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-72 animate-pulse rounded-xl border border-card-border bg-navy-card" />
          ))}
        </div>
      )}
      {isError && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground">
          Couldn't load yesterday's board. The desk will retry shortly.
        </div>
      )}

      {data && graded.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="yesterday-summary">
          <Tile label="Record" value={`${summary.wins}-${summary.losses}-${summary.pushes}`} />
          <Tile label="Net units" value={fmtUnits(summary.net)} good={summary.net >= 0} />
          <Tile label="ROI" value={`${summary.roi >= 0 ? "+" : ""}${summary.roi.toFixed(1)}%`} good={summary.roi >= 0} />
          <Tile label="CLV" value={`${summary.clv >= 0 ? "+" : ""}${summary.clv.toFixed(1)}%`} good={summary.clv >= 0} />
        </div>
      )}

      {data && visible.length === 0 && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground" data-testid="empty-yesterday">
          No graded picks yet for {date}.
        </div>
      )}

      {data && visible.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="yesterday-grid">
          {visible.map((p) =>
            QUALIFYING.includes(p.verdictTier) ? (
              <PickCard key={p.gameId} pick={p} bankroll={data.bankroll} />
            ) : (
              <CompactCard key={p.gameId} pick={p} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="rounded-xl border border-card-border bg-navy-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${good === undefined ? "" : good ? "text-tier-bonus" : "text-trap"}`}>
        {value}
      </div>
    </div>
  );
}
