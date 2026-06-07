import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { PickCard } from "@/components/PickCard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtMoney } from "@/lib/format";
import type { SlatePayload, Verdict } from "@/lib/types";

const TIERS: (Verdict | "ALL")[] = ["ALL", "BONUS", "SNIPER", "EDGE", "RECON", "VALUE", "LEAN"];
const MIN_EDGES = [0, 2, 4, 6, 8];
type SortKey = "units" | "edge" | "confidence" | "time";

export default function Home() {
  const { data, isLoading, isError } = useQuery<SlatePayload>({ queryKey: ["/api/mlb/slate"] });

  const [tier, setTier] = useState<Verdict | "ALL">("ALL");
  const [minEdge, setMinEdge] = useState(0);
  const [sort, setSort] = useState<SortKey>("units");

  const picks = useMemo(() => {
    const all = data?.picks ?? [];
    const filtered = all.filter((p) => {
      if (tier !== "ALL" && p.verdictTier !== tier) return false;
      if ((p.edgePp ?? 0) < minEdge) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      switch (sort) {
        case "edge":
          return (b.edgePp ?? 0) - (a.edgePp ?? 0);
        case "confidence":
          return b.confidence - a.confidence;
        case "time":
          return a.gameTimeEt.localeCompare(b.gameTimeEt);
        case "units":
        default:
          return b.units - a.units;
      }
    });
    return sorted;
  }, [data, tier, minEdge, sort]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today's Board</h1>
          <p className="text-xs text-muted-foreground">
            {data ? `Operating day ${data.operatingDay} · bankroll ${fmtMoney(data.bankroll)}` : "Loading slate…"}
          </p>
        </div>
      </div>

      {data?.isDemo && (
        <div
          className="flex items-start gap-2 rounded-xl border border-gold/25 bg-gold/5 p-3 text-xs text-gold-light"
          data-testid="demo-banner"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Demo slate — no live odds key configured. These games are illustrative so you can explore the desk.
            Add an Odds API key to pull the live board.
          </span>
        </div>
      )}

      {/* Slate filter row: Sport · Tier · Min Edge · Sort */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-card-border bg-navy-card p-3" data-testid="slate-filters">
        <FilterField label="Sport">
          <Select value="mlb" disabled>
            <SelectTrigger className="h-8 w-28 text-xs" data-testid="filter-sport">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mlb">MLB</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField label="Tier">
          <Select value={tier} onValueChange={(v) => setTier(v as Verdict | "ALL")}>
            <SelectTrigger className="h-8 w-32 text-xs" data-testid="filter-tier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIERS.map((t) => (
                <SelectItem key={t} value={t}>
                  {t === "ALL" ? "All tiers" : t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField label="Min Edge">
          <Select value={String(minEdge)} onValueChange={(v) => setMinEdge(Number(v))}>
            <SelectTrigger className="h-8 w-24 text-xs" data-testid="filter-min-edge">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MIN_EDGES.map((e) => (
                <SelectItem key={e} value={String(e)}>
                  {e}pp+
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField label="Sort">
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="h-8 w-32 text-xs" data-testid="filter-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="units">Units</SelectItem>
              <SelectItem value="edge">Edge</SelectItem>
              <SelectItem value="confidence">Confidence</SelectItem>
              <SelectItem value="time">Game time</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>

        <span className="ml-auto text-xs text-muted-foreground" data-testid="filter-count">
          {picks.length} pick{picks.length === 1 ? "" : "s"}
        </span>
      </div>

      {isLoading && <SkeletonGrid />}
      {isError && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground">
          Couldn't load the slate. The desk will retry shortly.
        </div>
      )}
      {data && picks.length === 0 && (
        <div
          className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground"
          data-testid="empty-slate"
        >
          No picks clear the board for these filters.
        </div>
      )}

      {data && picks.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="pick-grid">
          {picks.map((p) => (
            <PickCard key={p.gameId} pick={p} bankroll={data.bankroll} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-72 animate-pulse rounded-xl border border-card-border bg-navy-card" />
      ))}
    </div>
  );
}
