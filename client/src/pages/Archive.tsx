import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmtMoney, fmtUnits } from "@/lib/format";
import { DISPLAY_TIMEZONE } from "@/lib/timezone";
import type { UnifiedPage, UnifiedItem } from "@/lib/types";

type TabKey = "PLAYS" | "PASSES";
type SportChip = "ALL" | "MLB" | "NHL" | "NBA";
type TypeChip = "ALL" | "game" | "prop";
type ResultChip = "ALL" | "W" | "L" | "P";
type TierChip = "ALL" | "SNIPER" | "EDGE" | "RECON";
type ReasonChip = "ALL" | "outlier" | "model_outlier_v676" | "below_threshold" | "low_data_quality" | "daily_cap" | "chalk_cap";

const SPORTS: SportChip[] = ["ALL", "MLB", "NHL", "NBA"];
const TYPES: TypeChip[] = ["ALL", "game", "prop"];
const RESULTS: ResultChip[] = ["ALL", "W", "L", "P"];
const TIERS: TierChip[] = ["ALL", "SNIPER", "EDGE", "RECON"];
const REASONS: ReasonChip[] = ["ALL", "outlier", "model_outlier_v676", "below_threshold", "low_data_quality", "daily_cap", "chalk_cap"];
const PAGE_SIZE = 50;

const RESULT_META: Record<string, { label: string; color: string }> = {
  W: { label: "WON", color: "#4ADE80" },
  L: { label: "LOST", color: "#EF4444" },
  P: { label: "PUSH", color: "#FACC15" },
};

const REASON_LABEL: Record<string, string> = {
  outlier: "OUTLIER",
  model_outlier_v676: "MODEL OUTLIER",
  below_threshold: "BELOW THRESHOLD",
  low_data_quality: "LOW DATA",
  daily_cap: "DAILY CAP",
  chalk_cap: "CHALK CAP",
  low_win_prob: "LOW WIN%",
  other: "OTHER",
};

function thirtyDaysAgo(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(Date.now() - 30 * 86_400_000));
}

export default function Archive() {
  const [tab, setTab] = useState<TabKey>("PLAYS");
  const [sport, setSport] = useState<SportChip>("ALL");
  const [type, setType] = useState<TypeChip>("ALL");
  const [result, setResult] = useState<ResultChip>("ALL");
  const [tier, setTier] = useState<TierChip>("ALL");
  const [reason, setReason] = useState<ReasonChip>("ALL");
  const [since, setSince] = useState<string>(() => thirtyDaysAgo());
  const [limit, setLimit] = useState(PAGE_SIZE);

  const isPasses = tab === "PASSES";

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("type", type);
    if (sport !== "ALL") p.set("sport", sport);
    if (since) p.set("since", since);
    if (isPasses) {
      if (reason !== "ALL") p.set("reason", reason);
    } else {
      p.set("tier", "ALL"); // PLAYS spans every actionable tier + (filtered below)
      if (result !== "ALL") p.set("result", result);
      if (tier !== "ALL") p.set("tier", tier);
    }
    p.set("limit", String(limit));
    p.set("offset", "0");
    return `?${p.toString()}`;
  }, [isPasses, sport, type, result, tier, reason, since, limit]);

  const path = isPasses ? "/api/passes" : "/api/archive";
  const { data, isLoading, isError } = useQuery<UnifiedPage>({
    queryKey: [`${path}${qs}`],
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Count badge for the Passes tab — a cheap separate fetch scoped to the window.
  const passCountQs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("type", "ALL");
    if (since) p.set("since", since);
    p.set("limit", "1");
    return `?${p.toString()}`;
  }, [since]);
  const { data: passMeta } = useQuery<UnifiedPage>({
    queryKey: [`/api/passes${passCountQs}`],
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
          {isPasses
            ? "Every pick the desk evaluated and passed on — recorded, never played."
            : "Every settled pick, off the board and into the permanent record."}
          {data ? ` ${data.total} ${isPasses ? "passes" : "plays"}.` : ""}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2" data-testid="archive-tabs">
        <TabButton active={tab === "PLAYS"} onClick={() => setTab("PLAYS")} testid="archive-tab-plays">
          PLAYS
        </TabButton>
        <TabButton active={tab === "PASSES"} onClick={() => setTab("PASSES")} testid="archive-tab-passes">
          PASSES
          {passMeta ? (
            <span className="ml-2 rounded-full bg-background/50 px-1.5 py-0.5 text-[10px] tabular-nums text-gold-dark">
              {passMeta.total}
            </span>
          ) : null}
        </TabButton>
      </div>

      {/* Filter chips */}
      <div className="flex flex-col gap-3 rounded-xl border border-card-border bg-navy-card p-3" data-testid="archive-filters">
        <ChipRow label="Sport" chips={SPORTS} value={sport} onChange={setSport} prefix="sport" />
        <ChipRow label="Type" chips={TYPES} value={type} onChange={setType} prefix="type" />
        {isPasses ? (
          <ChipRow label="Reason" chips={REASONS} value={reason} onChange={setReason} prefix="reason" />
        ) : (
          <>
            <ChipRow label="Result" chips={RESULTS} value={result} onChange={setResult} prefix="result" />
            <ChipRow label="Tier" chips={TIERS} value={tier} onChange={setTier} prefix="tier" />
          </>
        )}
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
          {isPasses ? "No passed-on picks match these filters." : "No archived picks match these filters."}
        </div>
      )}

      {data && items.length > 0 && (
        <div className="space-y-2" data-testid="archive-list">
          {items.map((it) => (
            <ArchiveRow key={`${it.kind}:${it.pick_id}`} item={it} />
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

function TabButton({
  active, onClick, children, testid,
}: { active: boolean; onClick: () => void; children: React.ReactNode; testid: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
        active ? "bg-gold text-background" : "border border-card-border bg-navy-card text-muted-foreground hover:text-gold"
      }`}
    >
      {children}
    </button>
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
          {REASON_LABEL[c] ?? c}
        </button>
      ))}
    </div>
  );
}

// Left border: green W / red L / gold P / slate for PASS + pending.
function borderColor(item: UnifiedItem): string {
  if (item.tier === "PASS") return "#3A4660";
  if (item.result === "W") return "#4ADE80";
  if (item.result === "L") return "#EF4444";
  if (item.result === "P") return "#FACC15";
  return "#3A4660";
}

function label(item: UnifiedItem): string {
  if (item.kind === "prop") {
    const side = item.side ? item.side.toUpperCase() : "";
    const line = item.line != null ? ` ${item.line}` : "";
    return `${item.player_name ?? ""} ${item.market_label} ${side}${line}`.trim();
  }
  return item.market_label;
}

function ArchiveRow({ item }: { item: UnifiedItem }) {
  const isPass = item.tier === "PASS";
  const rm = item.result ? RESULT_META[item.result] : null;
  const date = item.date ?? (item.graded_at ?? item.posted_at ?? "").slice(0, 10);
  const plGood = (item.pl_units ?? 0) >= 0;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-card-border bg-navy-card px-3 py-2.5"
      style={{ borderLeft: `3px solid ${borderColor(item)}` }}
      data-testid={`archive-row-${item.pick_id}`}
    >
      <span className="text-[11px] tabular-nums text-muted-foreground">{date}</span>
      <span className="rounded-full bg-background/50 px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider text-gold-dark">
        {item.sport}
      </span>
      <span className="rounded-full bg-background/50 px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {item.kind === "prop" ? "PROP" : "GAME"}
      </span>
      <span className="rounded-full bg-background/50 px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {item.tier}
      </span>
      <span className="text-sm font-medium text-foreground">{label(item)}</span>
      {item.final_score && (
        <span className="font-display text-[13px] uppercase tracking-[0.04em] text-[#C0C6D0]">
          {item.final_score}
        </span>
      )}
      {isPass && item.pass_reason && (
        <span
          className="rounded-full bg-[#3A4660]/30 px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-[0.12em] text-[#A9B4C8]"
          data-testid={`archive-reason-${item.pick_id}`}
        >
          {REASON_LABEL[item.pass_reason] ?? item.pass_reason}
        </span>
      )}
      {!isPass && rm && (
        <span
          className="rounded-full px-2 py-0.5 font-display text-[10px] font-bold uppercase tracking-[0.12em]"
          style={{ color: "#020810", backgroundColor: rm.color }}
          data-testid={`archive-result-${item.pick_id}`}
        >
          {rm.label}
        </span>
      )}
      {item.edge_pp != null && (
        <span className="rounded-full bg-background/40 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
          {item.edge_pp >= 0 ? "+" : ""}{item.edge_pp.toFixed(1)}pp
        </span>
      )}
      {!isPass && (
        <span className={`ml-auto text-xs font-bold tabular-nums ${plGood ? "text-tier-bonus" : "text-trap"}`}>
          {fmtUnits(item.pl_units ?? 0)} · {fmtMoney(item.pl_dollars ?? 0)}
        </span>
      )}
      {item.clv_pct != null && (
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${
            isPass ? "ml-auto" : ""
          } ${item.clv_pct >= 0 ? "bg-tier-bonus/15 text-tier-bonus" : "bg-trap/15 text-trap"}`}
        >
          CLV {item.clv_pct >= 0 ? "+" : ""}{item.clv_pct.toFixed(1)}%
        </span>
      )}
    </div>
  );
}
