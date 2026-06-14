import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, ExternalLink } from "lucide-react";
import { PickCard } from "@/components/PickCard";
import { CompactCard } from "@/components/CompactCard";
import { fmtMoney } from "@/lib/format";
import { DISPLAY_TIMEZONE } from "@/lib/timezone";
import { PropCard } from "@/components/PropCard";
import { useIsMobile } from "@/hooks/use-mobile";
import { DkTapThroughSheet } from "@/components/DkTapThroughSheet";
import type { DailySlate, BuiltPick, Verdict, PropBoardPayload, PropLivePayload, DkSlipPayload } from "@/lib/types";

type SportFilter = "ALL" | "MLB" | "NHL" | "NBA" | "SOCCER" | "PROPS";
const SPORT_CHIPS: { key: SportFilter; label: string; disabled?: boolean }[] = [
  { key: "ALL", label: "ALL" },
  { key: "MLB", label: "MLB" },
  { key: "NHL", label: "NHL" },
  { key: "NBA", label: "NBA" },
  { key: "SOCCER", label: "SOCCER" },
  { key: "PROPS", label: "PROPS" },
];
const SOON_CHIPS = ["NFL soon", "NCAAF soon", "NCAAB soon"];

const TIER_RANK: Record<Verdict, number> = {
  SNIPER: 0, EDGE: 1, RECON: 2, PASS: 3,
};
const QUALIFYING: Verdict[] = ["SNIPER", "EDGE", "RECON"];

function todayEt(): string {
  // Operating-day date in YYYY-MM-DD (DISPLAY_TIMEZONE).
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIMEZONE,
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
  const [tapThroughOpen, setTapThroughOpen] = useState(false);

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

  // v6.9.3: mobile-only queries for multi-leg DK slip loader.
  const isMobile = useIsMobile();

  // Prop board — fetched at Home level so we can compute relatedSniperPropCount
  // per game card (how many SNIPER props share that game_id).
  const { data: propBoardData } = useQuery<PropBoardPayload>({
    queryKey: [`/api/props/board?date=${date}`],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: isMobile,
  });

  // Per-game SNIPER prop counts: { [gameId]: number }
  const sniperPropCountByGame = useMemo<Record<string, number>>(() => {
    const propItems = propBoardData?.items ?? [];
    const map: Record<string, number> = {};
    for (const it of propItems) {
      if (it.tier !== "SNIPER") continue;
      map[it.game_id] = (map[it.game_id] ?? 0) + 1;
    }
    return map;
  }, [propBoardData]);

  // Slip query for the sniper-singles aggregator button above the grid.
  const { data: sniperSlipData } = useQuery<DkSlipPayload>({
    queryKey: [`/api/dk/slip?scope=sniper-singles&date=${date}`],
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: isMobile,
  });

  // v6.9.4: determine whether to use the composite deep-link or tap-through.
  const sniperHasCompositeLink = !!(
    sniperSlipData && sniperSlipData.count > 0 && sniperSlipData.deepLink
  );
  const sniperHasTapThrough = !!(
    sniperSlipData &&
    sniperSlipData.count === 0 &&
    sniperSlipData.perEventLinks.length > 0
  );
  // Total count to show in label: count (composite) or perEventLinks.length (tap-through).
  const sniperDisplayCount = sniperSlipData
    ? sniperSlipData.count > 0
      ? sniperSlipData.count + sniperSlipData.skipped
      : sniperSlipData.perEventLinks.length
    : 0;

  function handleLoadAllSnipers() {
    if (!sniperSlipData) return;
    // Tap-through fallback: open the sheet when no composite link is available.
    if (sniperHasTapThrough) {
      setTapThroughOpen(true);
      return;
    }
    const url = sniperSlipData.deepLink ?? sniperSlipData.webFallback ?? null;
    if (!url) return;
    window.location.href = url;
    setTimeout(() => {
      if (
        !document.hidden &&
        sniperSlipData.webFallback &&
        url !== sniperSlipData.webFallback
      ) {
        window.location.href = sniperSlipData.webFallback;
      }
    }, 1500);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today's Board</h1>
          <p className="text-[11px] uppercase tracking-wider text-gold-dark" data-testid="engine-subtitle">
            Engine v6.9.4 · Bankroll {data ? fmtMoney(data.bankroll) : "$25,000"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {data
              ? `Operating day ${data.operatingDay} · bankroll ${fmtMoney(data.bankroll)} · ${allPicks.length} games`
              : "Loading slate…"}
          </p>
        </div>
      </div>

      {/* Global demo banner: shown only when ALL sports are running demo data (no live key at all). */}
      {data?.isDemo && (
        <div className="flex items-start gap-2 rounded-xl border border-gold/25 bg-gold/5 p-3 text-xs text-gold-light" data-testid="demo-banner">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Demo slate — no live odds key configured. These games are illustrative so you can explore the desk.
          </span>
        </div>
      )}
      {/* Per-sport demo notices: shown when a specific sport is demo but others are live. */}
      {data && !data.isDemo && (() => {
        const demoBadges: { sport: string; label: string }[] = [];
        if (data.sports.mlb?.isDemo) demoBadges.push({ sport: "mlb", label: "MLB" });
        if (data.sports.nhl?.isDemo) demoBadges.push({ sport: "nhl", label: "NHL" });
        if (data.sports.nba?.isDemo) demoBadges.push({ sport: "nba", label: "NBA" });
        if (data.sports.soccer?.isDemo) demoBadges.push({ sport: "soccer", label: "Soccer" });
        if (demoBadges.length === 0) return null;
        return (
          <div className="flex items-start gap-2 rounded-xl border border-gold/25 bg-gold/5 p-3 text-xs text-gold-light" data-testid="demo-banner-partial">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {demoBadges.map((b) => b.label).join(" & ")} showing illustrative demo games — live odds key is active for other sports.
            </span>
          </div>
        );
      })()}

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

      {/* PROPS board view — a separate board listing player-prop picks. */}
      {sport === "PROPS" && <PropsBoard date={date} />}

      {sport !== "PROPS" && isLoading && <SkeletonGrid />}
      {sport !== "PROPS" && isError && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground">
          Couldn't load the slate. The desk will retry shortly.
        </div>
      )}

      {sport !== "PROPS" && data && sport !== "ALL" && counts[sport.toLowerCase() as "mlb" | "nhl" | "nba" | "soccer"] === 0 && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground" data-testid="empty-sport">
          No {sport} games on the board today.
        </div>
      )}

      {data && visible.length === 0 && !(sport !== "ALL" && counts[sport.toLowerCase() as "mlb" | "nhl" | "nba" | "soccer"] === 0) && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground" data-testid="empty-slate">
          {showAll ? "No games on the board today." : "No qualifying plays. Switch to All games to see the full slate."}
        </div>
      )}

      {/* v6.9.4: Load all SNIPERs to DK — mobile-only.
          • Composite link available → behaves as today (count > 0).
          • Tap-through fallback → enabled when perEventLinks.length > 0 (count === 0).
          • Both empty → button disabled. */}
      {isMobile && sport !== "PROPS" && sniperSlipData && (sniperHasCompositeLink || sniperHasTapThrough) && (
        <>
          <button
            type="button"
            onClick={handleLoadAllSnipers}
            disabled={!sniperHasCompositeLink && !sniperHasTapThrough}
            className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 font-display text-[13px] font-bold uppercase tracking-[0.14em] text-black transition-opacity active:opacity-80 disabled:opacity-40"
            style={{ backgroundColor: "#53D337" }}
            data-testid="dk-load-all-snipers"
            aria-label={`Load all ${sniperDisplayCount} SNIPERs to DraftKings`}
          >
            <ExternalLink className="h-4 w-4 shrink-0" />
            {sniperHasTapThrough
              ? `Load ${sniperDisplayCount} SNIPERs to DK (tap-through)`
              : `Load all ${sniperDisplayCount} SNIPERs to DK`}
          </button>
          {/* v6.9.4: tap-through sheet */}
          {tapThroughOpen && sniperSlipData && (
            <DkTapThroughSheet
              payload={sniperSlipData}
              open={tapThroughOpen}
              onClose={() => setTapThroughOpen(false)}
            />
          )}
        </>
      )}

      {data && visible.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="pick-grid">
          {visible.map((p) =>
            cardState(p) === "qualifying" ? (
              <PickCard
                key={p.gameId}
                pick={p}
                bankroll={data.bankroll}
                relatedSniperPropCount={sniperPropCountByGame[p.gameId] ?? 0}
              />
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

const PROP_TIERS = ["SNIPER", "EDGE", "RECON"] as const;

function PropsBoard({ date }: { date: string }) {
  const { data, isLoading, isError } = useQuery<PropBoardPayload>({
    queryKey: [`/api/props/board?date=${date}`],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // v6.7.3 live in-game tracking. Poll every 15s while at least one card is still
  // pending or live (clearing); stop polling once every prop is busted or paid.
  const { data: liveData } = useQuery<PropLivePayload>({
    queryKey: [`/api/props/live?date=${date}`],
    refetchInterval: (query) => {
      const tracking = query.state.data?.tracking ?? {};
      const items = data?.items ?? [];
      const active = items.some((it) => {
        const ls = tracking[it.pick_id]?.liveState ?? "pending";
        return ls === "pending" || ls === "live_clear";
      });
      return active && items.length > 0 ? 15_000 : false;
    },
    refetchOnWindowFocus: false,
    enabled: (data?.items ?? []).length > 0,
  });
  const liveTracking = liveData?.tracking ?? {};

  const [tierFilter, setTierFilter] = useState<string>("ALL");
  const [sportFilter, setSportFilter] = useState<string>("ALL");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (isLoading) return <SkeletonGrid />;
  if (isError) {
    return (
      <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground">
        Couldn't load the prop board. The desk will retry shortly.
      </div>
    );
  }

  const allItems = (data?.items ?? []).map((it) => {
    const live = liveTracking[it.pick_id];
    if (!live) return it;
    return {
      ...it,
      liveState: live.liveState,
      currentValue: live.currentValue,
      gameStatus: live.gameStatus,
    };
  });
  if (allItems.length === 0) {
    return (
      <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground" data-testid="props-empty">
        No prop picks today.
      </div>
    );
  }

  const sportsPresent = [...new Set(allItems.map((it) => it.sport.toUpperCase()))];
  const items = allItems.filter(
    (it) =>
      (tierFilter === "ALL" || it.tier === tierFilter) &&
      (sportFilter === "ALL" || it.sport.toUpperCase() === sportFilter),
  );

  // Group by game so the board reads game-by-game (collapsible sections).
  const byGame = new Map<string, { label: string; rows: typeof items }>();
  for (const it of items) {
    const key = it.game_id;
    if (!byGame.has(key)) {
      const label = it.team
        ? `${it.team}${it.opponent ? ` vs ${it.opponent}` : ""}`
        : `${it.sport.toUpperCase()} · ${it.game_id}`;
      byGame.set(key, { label, rows: [] });
    }
    byGame.get(key)!.rows.push(it);
  }

  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 font-display text-[11px] font-bold uppercase tracking-[0.14em] transition-colors ${
      active ? "bg-gold text-navy-deep" : "bg-navy-card text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="space-y-4" data-testid="props-board">
      {/* Tier + sport filters */}
      <div className="flex flex-wrap items-center gap-2">
        <button className={chip(tierFilter === "ALL")} onClick={() => setTierFilter("ALL")} data-testid="prop-tier-all">
          All tiers
        </button>
        {PROP_TIERS.map((t) => (
          <button key={t} className={chip(tierFilter === t)} onClick={() => setTierFilter(t)} data-testid={`prop-tier-filter-${t}`}>
            {t}
          </button>
        ))}
        {sportsPresent.length > 1 && (
          <span className="mx-1 h-4 w-px bg-card-border" />
        )}
        {sportsPresent.length > 1 && (
          <button className={chip(sportFilter === "ALL")} onClick={() => setSportFilter("ALL")}>
            All sports
          </button>
        )}
        {sportsPresent.length > 1 &&
          sportsPresent.map((s) => (
            <button key={s} className={chip(sportFilter === s)} onClick={() => setSportFilter(s)}>
              {s}
            </button>
          ))}
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground" data-testid="props-filtered-empty">
          No props match this filter.
        </div>
      ) : (
        [...byGame.entries()].map(([gameId, { label, rows }]) => {
          const isCollapsed = collapsed[gameId] ?? false;
          return (
            <div key={gameId} className="space-y-2" data-testid={`prop-game-${gameId}`}>
              <button
                className="flex w-full items-center justify-between text-left"
                onClick={() => setCollapsed((c) => ({ ...c, [gameId]: !isCollapsed }))}
              >
                <h2 className="font-display text-sm font-bold uppercase tracking-[0.18em] text-gold-dark">
                  {label} <span className="text-muted-foreground">({rows.length})</span>
                </h2>
                <span className="text-muted-foreground">{isCollapsed ? "+" : "−"}</span>
              </button>
              {!isCollapsed && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {rows.map((it) => (
                    <PropCard key={it.pick_id} item={it} />
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
