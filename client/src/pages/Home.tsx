import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, ExternalLink } from "lucide-react";
import { PickCard } from "@/components/PickCard";
import { CompactCard } from "@/components/CompactCard";
import { fmtMoney, fmtLine, fmtUnits, TIER_META } from "@/lib/format";
import { DISPLAY_TIMEZONE } from "@/lib/timezone";
import { PropCard } from "@/components/PropCard";
import { useIsMobile } from "@/hooks/use-mobile";
import { DkTapThroughSheet } from "@/components/DkTapThroughSheet";
import type { DailySlate, BuiltPick, Verdict, PropBoardPayload, PropLivePayload, DkSlipPayload } from "@/lib/types";

// v6.10: F5 pick shape from the /api/slate/f5 endpoint
interface F5PickDisplay {
  gameId: string;
  market: string;
  pickSide: string;
  line: number | null;
  price: number | null;
  edgePp: number | null;
  tier: string;
  projected_home_runs_f5: number | null;
  projected_away_runs_f5: number | null;
  reasoning_json: string | null;
}

type SportFilter = "ALL" | "MLB" | "NHL" | "NBA" | "PROPS";
const SPORT_CHIPS: { key: SportFilter; label: string; disabled?: boolean }[] = [
  { key: "ALL", label: "ALL" },
  { key: "MLB", label: "MLB" },
  { key: "NHL", label: "NHL" },
  { key: "NBA", label: "NBA" },
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

// v6.11.0: a locked, ungraded bet from /api/bets/live.
interface LiveBet {
  pickId: string;
  gameId: string;
  sport: string;
  awayTeam: string;
  homeTeam: string;
  commenceTime: string | null;
  side: string;
  market: string;
  lockedTier: Verdict | null;
  lockedOdds: number | null;
  lockedStake: number | null;
  lockedAt: string | null;
  liveAwayScore: number | null;
  liveHomeScore: number | null;
  liveStatusDetail: string | null;
  edgePp: number | null;
}

// Short relative age for the LOCKED badge, e.g. "3h ago", "12m ago", "just now".
function relativeAge(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function LiveBetCard({ bet }: { bet: LiveBet }) {
  const tierHex = bet.lockedTier ? TIER_META[bet.lockedTier]?.hex ?? "#C9A227" : "#C9A227";
  const hasScore = bet.liveAwayScore !== null && bet.liveHomeScore !== null;
  return (
    <div
      className="relative flex w-[220px] shrink-0 flex-col gap-2 rounded-xl border border-card-border bg-navy-card p-3"
      data-testid={`live-bet-${bet.pickId}`}
    >
      <span className="absolute right-2 top-2 rounded-full bg-gold/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-gold-light">
        Locked {relativeAge(bet.lockedAt)}
      </span>
      <div className="pr-16 text-[11px] uppercase tracking-wider text-muted-foreground">
        {bet.awayTeam} @ {bet.homeTeam}
      </div>
      <div className="text-center font-mono text-[34px] font-bold leading-none tabular-nums text-silver">
        {hasScore ? `${bet.liveAwayScore} - ${bet.liveHomeScore}` : "PREGAME"}
      </div>
      <div className="text-center text-xs text-muted-foreground">
        {bet.liveStatusDetail ?? "—"}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ backgroundColor: `${tierHex}22`, color: tierHex }}
        >
          {bet.lockedTier ?? "—"}
        </span>
        <span className="font-mono text-xs tabular-nums text-silver">
          {fmtLine(bet.lockedOdds)} · {fmtUnits(bet.lockedStake ?? 0)}
        </span>
      </div>
    </div>
  );
}

function LiveBetsSection() {
  const { data } = useQuery<{ bets: LiveBet[] }>({
    queryKey: ["/api/bets/live"],
    queryFn: () => fetch("/api/bets/live").then((r) => r.json()),
    refetchInterval: 30000,
    refetchOnWindowFocus: false,
  });
  const bets = data?.bets ?? [];
  if (bets.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="live-bets-section">
      <h2 className="text-sm font-bold uppercase tracking-wider text-gold-light">
        Live Bets
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-1 md:grid md:grid-flow-row md:auto-cols-auto md:[grid-template-columns:repeat(auto-fill,minmax(220px,1fr))] md:overflow-visible">
        {bets.map((bet) => (
          <LiveBetCard key={bet.pickId} bet={bet} />
        ))}
      </div>
    </div>
  );
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
  // v6.10: F5 (first-5-innings) toggle
  const [showF5, setShowF5] = useState(false);

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

  // v6.10: F5 picks query — loaded lazily when the F5 toggle is active.
  const { data: f5Data, isLoading: f5Loading } = useQuery<{ date: string; picks: F5PickDisplay[]; count: number }>({
    queryKey: [`/api/slate/f5?sport=mlb&date=${date}`],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: showF5,
  });

  const allPicks = useMemo<BuiltPick[]>(() => {
    if (!data) return [];
    const s = data.sports;
    return [
      ...s.mlb.picks,
      ...s.nhl.picks,
      ...s.nba.picks,
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
    const c = { mlb: 0, nhl: 0, nba: 0 };
    for (const p of allPicks) {
      if (p.sport === "mlb") c.mlb++;
      else if (p.sport === "nhl") c.nhl++;
      else if (p.sport === "nba") c.nba++;
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
      <LiveBetsSection />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today's Board</h1>
          <p className="text-[11px] uppercase tracking-wider text-gold-dark" data-testid="engine-subtitle">
            Engine v6.10.0 · Bankroll {data ? fmtMoney(data.bankroll) : "$25,000"}
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
        {/* v6.10: F5 toggle chip */}
        <button
          type="button"
          onClick={() => { setShowF5((v) => !v); if (!showF5) setSport("MLB"); }}
          className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider transition-colors ${
            showF5 ? "bg-amber-700/80 text-white" : "bg-background/40 text-muted-foreground hover:text-gold"
          }`}
          data-testid="chip-F5"
          title="First 5 innings picks"
        >
          F5
        </button>
        <span className="h-4 w-px bg-card-border" />
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

      {/* v6.10: F5 board view — first-5-innings picks */}
      {showF5 && sport !== "PROPS" && (
        <div className="space-y-3" data-testid="f5-board">
          <div className="flex items-center gap-2">
            <span
              className="font-display text-[11px] font-bold uppercase tracking-[0.18em]"
              style={{ color: "#9A7B1E" }}
            >
              First 5 Innings
            </span>
            <span className="text-[10px] text-muted-foreground">
              {f5Data ? `${f5Data.count} pick${f5Data.count !== 1 ? "s" : ""}` : f5Loading ? "loading…" : ""}
            </span>
          </div>
          {f5Loading && (
            <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground">
              Loading F5 picks…
            </div>
          )}
          {!f5Loading && f5Data && f5Data.count === 0 && (
            <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground" data-testid="f5-empty">
              No F5 picks available — F5 markets may not be offered yet today.
            </div>
          )}
          {!f5Loading && f5Data && f5Data.count > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {f5Data.picks.map((p) => (
                <div
                  key={`${p.gameId}:${p.market}:${p.pickSide}`}
                  className="rounded-xl border border-amber-800/30 bg-navy-card p-4"
                  data-testid="f5-card"
                >
                  {/* FIRST 5 badge */}
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className="rounded px-1.5 py-0.5 font-display text-[9px] font-bold uppercase tracking-[0.18em] text-white"
                      style={{ backgroundColor: "#9A7B1E" }}
                    >
                      FIRST 5
                    </span>
                    <span className="font-display text-[11px] font-bold uppercase tracking-wider" style={{ color: String(p.tier) === "SNIPER" ? "#C9A227" : String(p.tier) === "EDGE" ? "#3FB950" : "#8892A0" }}>
                      {String(p.tier ?? "")}
                    </span>
                  </div>
                  <div className="text-sm font-semibold">
                    {String(p.pickSide).toUpperCase()} {String(p.market).replace("h2h_f5", "ML").replace("totals_f5", "Total")}
                    {p.line != null && ` ${String(p.line)}`}
                    {" "}
                    <span className="tabular-nums">{p.price != null ? (Number(p.price) > 0 ? `+${String(p.price)}` : String(p.price)) : ""}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {`Edge ${p.edgePp != null ? `${Number(p.edgePp) >= 0 ? "+" : ""}${Number(p.edgePp).toFixed(1)}pp` : "—"} · F5 proj: ${Number(p.projected_home_runs_f5 ?? 0).toFixed(1)} · ${Number(p.projected_away_runs_f5 ?? 0).toFixed(1)}`}
                  </div>
                  {p.reasoning_json && (
                    <ul className="mt-1.5 space-y-0.5 text-[10px] text-muted-foreground/70">
                      {(JSON.parse(String(p.reasoning_json)) as string[]).slice(0, 3).map((r: string, i: number) => (
                        <li key={i}>→ {r}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {sport !== "PROPS" && isLoading && <SkeletonGrid />}
      {sport !== "PROPS" && isError && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground">
          Couldn't load the slate. The desk will retry shortly.
        </div>
      )}

      {sport !== "PROPS" && data && sport !== "ALL" && counts[sport.toLowerCase() as "mlb" | "nhl" | "nba"] === 0 && (
        <div className="rounded-xl border border-card-border bg-navy-card p-8 text-center text-sm text-muted-foreground" data-testid="empty-sport">
          {data.sports[sport.toLowerCase() as "mlb" | "nhl" | "nba"]?.emptyReason
            ? data.sports[sport.toLowerCase() as "mlb" | "nhl" | "nba"]?.emptyReason
            : `No ${sport} games on the board today.`}
        </div>
      )}

      {data && visible.length === 0 && !(sport !== "ALL" && counts[sport.toLowerCase() as "mlb" | "nhl" | "nba"] === 0) && (
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
