import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmtMoney, fmtUnits } from "@/lib/format";
import type { ArchivePage, ArchiveItem } from "@/lib/types";

type SportChip = "ALL" | "MLB" | "NHL" | "NBA" | "SOCCER";
type ResultChip = "ALL" | "W" | "L" | "P";
type TierChip = "ALL" | "SNIPER" | "EDGE" | "RECON";

const SPORTS: SportChip[] = ["ALL", "MLB", "NHL", "NBA", "SOCCER"];
const RESULTS: ResultChip[] = ["ALL", "W", "L", "P"];
const TIERS: TierChip[] = ["ALL", "SNIPER", "EDGE", "RECON"];
const PAGE_SIZE = 50;

const RESULT_META: Record<string, { label: string; color: string }> = {
  W: { label: "WON", color: "#4ADE80" },
  L: { label: "LOST", color: "#EF4444" },
  P: { label: "PUSH", color: "#6B7A99" },
};

function thirtyDaysAgo(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(Date.now() - 30 * 86_400_000));
}

export default function Archive() {
  const [sport, setSport] = useState<SportChip>("ALL");
  const [result, setResult] = useState<ResultChip>("ALL");
  const [tier, setTier] = useState<TierChip>("ALL");
  const [since, setSince] = useState<string>(() => thirtyDaysAgo());
  const [limit, setLimit] = useState(PAGE_SIZE);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (sport !== "ALL") p.set("sport", sport);
    if (result !== "ALL") p.set("result", result);
    if (tier !== "ALL") p.set("tier", tier);
    if (since) p.set("since", since);
    p.set("limit", String(limit));
    p.set("offset", "0");
    return `?${p.toString()}`;
  }, [sport, result, tier, since, limit]);

  const { data, isLoading, isError } = useQuery<ArchivePage>({
    queryKey: [`/api/archive${qs}`],
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const items = data?.items ?? [];
  const hasMore = data ? data.total > items.length : false;

  return (
    <div className="space-y-5" data-testid="archive-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Archive</h1>
        <p className="text-xs text-muted-foreground">
          Every settled pick, off the board and into the permanent record.
          {data ? ` ${data.total} archived.` : ""}
        </p>
      </div>

      {/* Filter chips */}
      <div className="flex flex-col gap-3 rounded-xl border border-card-border bg-navy-card p-3" data-testid="archive-filters">
        <ChipRow label="Sport" chips={SPORTS} value={sport} onChange={setSport} prefix="sport" />
        <ChipRow label="Result" chips={RESULTS} value={result} onChange={setResult} prefix="result" />
        <ChipRow label="Tier" chips={TIERS} value={tier} onChange={setTier} prefix="tier" />
        <div className="flex items-center gap-2">
          <span className="w-14 text-[10px] uppercase tracking-wider text-muted-foreground">Since</span>
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="rounded-lg border border-card-border bg-background/40 px-2 py-1.5 text-xs text-foreground"
            data-testid="archive-since"
          />
        </div>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg border border-card-border bg-navy-card" />
          ))}
        </div>
      )}
      {isError && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground">
          Couldn't load the archive. The desk will retry shortly.
        </div>
      )}

      {data && items.length === 0 && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground" data-testid="archive-empty">
          No archived picks match these filters.
        </div>
      )}

      {data && items.length > 0 && (
        <div className="space-y-2" data-testid="archive-list">
          {items.map((it) => (
            <ArchiveRow key={it.pick_id} item={it} />
          ))}
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setLimit((n) => n + PAGE_SIZE)}
            className="rounded-full border border-card-border bg-background/40 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-gold"
            data-testid="archive-load-more"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

function ChipRow<T extends string>({
  label, chips, value, onChange, prefix,
}: { label: string; chips: T[]; value: T; onChange: (v: T) => void; prefix: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-14 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {chips.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider transition-colors ${
            value === c ? "bg-gold text-background" : "bg-background/40 text-muted-foreground hover:text-gold"
          }`}
          data-testid={`archive-chip-${prefix}-${c}`}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

function ArchiveRow({ item }: { item: ArchiveItem }) {
  const rm = RESULT_META[item.result] ?? { label: item.result, color: "#8892A0" };
  const date = item.graded_at ? item.graded_at.slice(0, 10) : "";
  const plGood = (item.pl_units ?? 0) >= 0;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-card-border bg-navy-card px-3 py-2.5"
      data-testid={`archive-row-${item.pick_id}`}
    >
      <span className="text-[11px] tabular-nums text-muted-foreground">{date}</span>
      <span className="rounded-full bg-background/50 px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider text-gold-dark">
        {item.sport}
      </span>
      <span className="rounded-full bg-background/50 px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {item.tier}
      </span>
      <span className="text-sm font-medium text-foreground">{item.pick_label}</span>
      {item.final_score && (
        <span className="font-display text-[13px] uppercase tracking-[0.04em] text-[#C0C6D0]">
          {item.final_score}
        </span>
      )}
      <span
        className="rounded-full px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-[0.12em]"
        style={{ color: "#020810", backgroundColor: rm.color }}
        data-testid={`archive-result-${item.pick_id}`}
      >
        {rm.label}
      </span>
      <span className={`ml-auto text-xs font-bold tabular-nums ${plGood ? "text-tier-bonus" : "text-trap"}`}>
        {fmtUnits(item.pl_units)} · {fmtMoney(item.pl_dollars)}
      </span>
      {item.clv_pct != null && (
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${
            item.clv_pct >= 0 ? "bg-tier-bonus/15 text-tier-bonus" : "bg-trap/15 text-trap"
          }`}
        >
          CLV {item.clv_pct >= 0 ? "+" : ""}{item.clv_pct.toFixed(1)}%
        </span>
      )}
    </div>
  );
}
