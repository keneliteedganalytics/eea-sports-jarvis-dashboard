import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmtLine, fmtMoney } from "@/lib/format";
import { DISPLAY_TIMEZONE } from "@/lib/timezone";
import { SignalsBar } from "@/components/cards/SignalsBar";
import type {
  ParlayBoardPayload,
  ParlayItem,
  ParlayLeg,
  ParlayStatus,
} from "@/lib/types";

function todayEt(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date());
}

const STATUS_META: Record<ParlayStatus, { label: string; chip: string; dot: string }> = {
  live: { label: "Live", chip: "bg-gold/15 text-gold", dot: "bg-gold" },
  pending: { label: "Pending", chip: "bg-navy-card text-muted-foreground", dot: "bg-muted-foreground" },
  won: { label: "Cashed", chip: "bg-[#4ADE80]/15 text-[#4ADE80]", dot: "bg-[#4ADE80]" },
  busted: { label: "Busted", chip: "bg-[#EF4444]/15 text-[#EF4444]", dot: "bg-[#EF4444]" },
};

const LEG_DOT: Record<ParlayLeg["disposition"], string> = {
  won: "bg-[#4ADE80]",
  busted: "bg-[#EF4444]",
  live: "bg-gold",
  pending: "bg-muted-foreground/50",
};

function americanText(odds: number | null): string {
  return odds == null ? "—" : fmtLine(odds);
}

export default function Parlays() {
  const [date, setDate] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("date") ?? todayEt();
  });

  const { data, isLoading, isError } = useQuery<ParlayBoardPayload>({
    queryKey: [`/api/parlays/board?date=${date}`],
    // Auto-refresh every 15s while any parlay is still in flight; stop once the
    // day is fully settled.
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      const active = items.some((i) => i.status === "pending" || i.status === "live");
      return active ? 15_000 : false;
    },
    refetchOnWindowFocus: false,
  });

  const summary = data?.summary;
  const items = data?.items ?? [];

  return (
    <div className="space-y-6" data-testid="parlays-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Virtual Bets</h1>
          <p className="text-[11px] uppercase tracking-wider text-gold-dark" data-testid="engine-subtitle">
            Engine v6.9.0 · Bankroll $25,000
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Each SNIPER pick is tracked as its own $100 paper bet. P/L tracks live as picks settle —
            not real money, never touches the bankroll.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Operating day</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value || todayEt())}
            className="rounded-lg border border-card-border bg-navy-card px-2 py-1.5 text-xs text-foreground"
            data-testid="parlays-date"
          />
        </div>
      </div>

      {/* Summary strip */}
      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="parlays-summary">
          <Stat label="Bets" value={String(summary.count)} />
          <Stat label="Live" value={String(summary.live)} tone="gold" />
          <Stat label="Pending" value={String(summary.pending)} />
          <Stat label="Cashed" value={String(summary.won)} tone="good" />
          <Stat label="Busted" value={String(summary.busted)} tone="bad" />
          <Stat
            label="Realized P/L"
            value={`${summary.plDollars >= 0 ? "+" : "−"}${fmtMoney(Math.abs(summary.plDollars))}`}
            tone={summary.plDollars >= 0 ? "good" : "bad"}
          />
        </div>
      )}

      {isLoading && <div className="text-sm text-muted-foreground" data-testid="parlays-loading">Loading the portfolio…</div>}
      {isError && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground">
          Couldn't load virtual parlays. The desk will retry shortly.
        </div>
      )}
      {!isLoading && !isError && items.length === 0 && (
        <div
          className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground"
          data-testid="parlays-empty"
        >
          No virtual bets for this day — one forms automatically for each SNIPER pick.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2" data-testid="parlays-grid">
        {items.map((p) => (
          <ParlayCard key={p.parlayId} parlay={p} />
        ))}
      </div>
    </div>
  );
}

function ParlayCard({ parlay }: { parlay: ParlayItem }) {
  const meta = STATUS_META[parlay.status];
  const profit = parlay.potentialProfitDollars ?? 0;
  const settled = parlay.status === "won" || parlay.status === "busted";
  // Each card is a single $100 bet: its one leg IS the pick.
  const leg = parlay.legs[0];
  const pickTitle = leg
    ? `${leg.player} · ${leg.side?.toUpperCase() ?? ""} ${fmtLine(leg.line)} ${leg.market}`.trim()
    : (parlay.gameLabel ?? parlay.gameId);

  return (
    <div
      className="rounded-xl border border-card-border bg-navy-deep p-4"
      data-testid={`parlay-card-${parlay.parlayId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {leg && <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${LEG_DOT[leg.disposition]}`} />}
          <div className="min-w-0">
            <h2 className="font-display text-sm font-bold uppercase tracking-[0.12em] text-foreground">
              {pickTitle}
            </h2>
            <div className="mt-0.5 truncate text-[11px] uppercase tracking-wider text-muted-foreground">
              {parlay.gameLabel ?? parlay.gameId} · ${Math.round(parlay.stakeDollars)} stake
            </div>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 font-display text-[10px] font-bold uppercase tracking-[0.14em] ${meta.chip}`}
          data-testid={`parlay-status-${parlay.parlayId}`}
        >
          {meta.label}
        </span>
      </div>

      {/* Odds + payout line */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-display text-xl font-extrabold tabular-nums text-gold">
          {americanText(parlay.combinedAmerican)}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {parlay.combinedDecimal != null ? `${parlay.combinedDecimal.toFixed(2)}×` : ""}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {settled ? (
            <>
              P/L{" "}
              <span className={parlay.status === "won" ? "font-bold text-[#4ADE80]" : "font-bold text-[#EF4444]"}>
                {(parlay.plDollars ?? 0) >= 0 ? "+" : "−"}
                {fmtMoney(Math.abs(parlay.plDollars ?? 0))}
              </span>
            </>
          ) : (
            <>
              To win{" "}
              <span className="font-bold text-foreground">{fmtMoney(profit)}</span>
            </>
          )}
        </span>
      </div>

      {/* v6.9.1 five-source SignalsBar for this single pick */}
      {(parlay.signals ?? leg?.signals) && (
        <div className="mt-3">
          <SignalsBar signals={parlay.signals ?? leg?.signals} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "gold" }) {
  const toneClass =
    tone === "good" ? "text-[#4ADE80]" : tone === "bad" ? "text-[#EF4444]" : tone === "gold" ? "text-gold" : "text-foreground";
  return (
    <div className="rounded-xl border border-card-border bg-navy-card p-3" data-testid={`parlay-stat-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-bold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}
