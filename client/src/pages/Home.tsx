import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { PickCard } from "@/components/PickCard";
import { CompactCard } from "@/components/CompactCard";
import { fmtMoney } from "@/lib/format";
import type { DailySlate, BuiltPick, Verdict } from "@/lib/types";

type SportFilter = "ALL" | "MLB" | "NHL" | "NBA" | "SOCCER";
const SPORT_CHIPS: { key: SportFilter; label: string; disabled?: boolean }[] = [
  { key: "ALL", label: "ALL" },
  { key: "MLB", label: "MLB" },
  { key: "NHL", label: "NHL" },
  { key: "NBA", label: "NBA" },
  { key: "SOCCER", label: "SOCCER" },
];
const SOON_CHIPS = ["NFL soon", "NCAAF soon", "NCAAB soon"];

const TIER_RANK: Record<Verdict, number> = {
  BONUS: 0, SNIPER: 1, EDGE: 2, RECON: 3, VALUE: 4, LEAN: 5, PASS: 6,
};
const QUALIFYING: Verdict[] = ["BONUS", "SNIPER", "EDGE", "RECON", "VALUE", "LEAN"];

function todayEt(): string {
  // Operating-day date in YYYY-MM-DD (America/New_York).
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date());
}

type CardState = "qualifying" | "pass" | "hard_pass";
function cardState(p: BuiltPick): CardState {
  if (p.hardPassReason) return "hard_pass";
  if (QUALIFYING.includes(p.verdictTier)) return "qualifying";
  return "pass";
}

export default function Home() {
  // Read ?date= from URL search params; fall back to today's ET date.
  const [date, setDate] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("date") ?? todayEt();
  });
  const [sport, setSport] = useState<SportFilter>("ALL");
  const [showAll, setShowAll] = useState(false); // default: plays only

  // Keep date in sync if the URL changes (e.g. browser back/forward).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlDate = params.get("date");
    if (urlDate && urlDate !== date) setDate(urlDate);
  }, []);

  const { data, isLoading, isError } = useQuery<DailySlate>({
    queryKey: [`/api/slate?date=${date}`],
    staleTime: 5 * 60 * 1000,     // 5 min — don't re-fetch while still fresh
    gcTime: 10 * 60 * 1000,       // 10 min cache retention
    retry: 1,                      // one retry on network/upstream error
    refetchOnWindowFocus: false,
  });

  const allPicks = useMemo<BuiltPick[]>(() => {
    if (!data) return [];
    const s = data.sports;
    return [
      ...s.mlb.picks,
      ...s.nhl.picks,
      ...s.nba.picks,
      ...(s.soccer?.picks ?? []),
    ];
  }, [data]);

  const visible = useMemo(() => {
    let picks = allPicks;
    if (sport !== "ALL") picks = picks.filter((p) => p.sport.toUpperCase() === sport);
    if (!showAll) picks = picks.filter((p) => cardState(p) === "qualifying");

    // Order: qualifying (tier rank desc → edge) → PASS → HARD_PASS.
    const order: Record<CardState, number> = { qualifying: 0, pass: 1, hard_pass: 2 };
    return [...picks].sort((a, b) => {
      const sa = cardState(a), sb = cardState(b);
      if (order[sa] !== order[sb]) return order[sa] - order[sb];
      const r = TIER_RANK[a.verdictTier] - TIER_RANK[b.verdictTier];
      if (r !== 0) return r;
      return (b.edgePp ?? -999) - (a.edgePp ?? -999);
    });
  }, [allPicks, sport, showAll]);

  const counts = useMemo(() => {
    const c = { mlb: 0, nhl: 0, nba: 0, soccer: 0 };
    for (const p of allPicks) {
      if (p.sport === "mlb") c.mlb++;
      else if (p.sport === "nhl") c.nhl++;
      else if (p.sport === "nba") c.nba++;
      else if (p.sport === "soccer") c.soccer++;
    }
    return c;
  }, [allPicks]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today's Board</h1>
          <p className="text-xs text-muted-foreground">
            {data
              ? `Operating day ${data.operatingDay} · bankroll ${fmtMoney(data.bankroll)} · ${allPicks.length} games`
              : "Loading slate…"}
          </p>
        </div>
      </div>

      {data?.isDemo && (
        <div className="flex items-start gap-2 rounded-xl border border-gold/25 bg-gold/5 p-3 text-xs text-gold-light" data-testid="demo-banner">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Demo slate — no live odds key configured. These games are illustrative so you can explore the desk.
          </span>
        </div>
      )}

      {/* Sport chips + Show toggle */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-card-border bg-navy-card p-3" data-testid="slate-filters">
        {SPORT_CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setSport(c.key)}
            className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider transition-colors ${
              sport === c.key ? "bg-gold text-background" : "bg-background/40 text-muted-foreground hover:text-gold"
            }`}
            data-testid={`chip-${c.key}`}
          >
            {c.label}
          </button>
        ))}
        {SOON_CHIPS.map((s) => (
          <span key={s} className="rounded-full bg-background/30 px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
            {s}
          </span>
        ))}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Show</span>
          <div className="flex overflow-hidden rounded-full border border-card-border">
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className={`px-3 py-1 text-xs ${!showAll ? "bg-gold text-background" : "text-muted-foreground hover:text-gold"}`}
              data-testid="toggle-plays-only"
            >
              Plays only
            </button>
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className={`px-3 py-1 text-xs ${showAll ? "bg-gold text-background" : "text-muted-foreground hover:text-gold"}`}
              data-testid="toggle-all-games"
            >
              All games
            </button>
          </div>
        </div>
      </div>

      {isLoading && <SkeletonGrid />}
      {isError && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground">
          Couldn't load the slate. The desk will retry shortly.
        </div>
      )}

      {data && sport !== "ALL" && counts[sport.toLowerCase() as "mlb" | "nhl" | "nba" | "soccer"] === 0 && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground" data-testid="empty-sport">
          No {sport} games on the board today.
        </div>
      )}

      {data && visible.length === 0 && !(sport !== "ALL" && counts[sport.toLowerCase() as "mlb" | "nhl" | "nba" | "soccer"] === 0) && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground" data-testid="empty-slate">
          {showAll ? "No games on the board today." : "No qualifying plays. Switch to All games to see the full slate."}
        </div>
      )}

      {data && visible.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="pick-grid">
          {visible.map((p) =>
            cardState(p) === "qualifying" ? (
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

function SkeletonGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-72 animate-pulse rounded-xl border border-card-border bg-navy-card" />
      ))}
    </div>
  );
}
