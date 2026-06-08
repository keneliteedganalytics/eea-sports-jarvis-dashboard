// Soccer slate data adapter.
// Joins Odds API soccer prices (h2h with Draw, spreads, totals) with
// API-Sports v3 team goal stats to produce SoccerGameInput records.
// Degrades gracefully: no keys → empty slate (demo slate used by slate.ts).

import { fetchOddsForSport, type OddsEvent } from "../../adapters/oddsApi";
import { fetchFootballTeamStats, isFriendlyLeague, seasonForLeague } from "../../adapters/apiSportsFootball";
import { SOCCER_LEAGUES } from "./leagues";
import { extractDrawOdds } from "./oddsMath";
import { devigThreeWay } from "../../core/odds";
import { computePublicSharp, type RawBookmaker } from "../../core/consensus";
import { nameToAbbr } from "./teams";
import { SOCCER_ODDS_KEYS, leagueByOddsKey } from "./leagues";
import { fetchPolymarketForGame, type PolymarketResult } from "../../adapters/polymarket";
import type { SoccerGameInput } from "./picksEngine";
import type { TeamGoalStats } from "./model";

const BATCH_SIZE = 8; // parallel team-stats requests per batch

function etClock(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso)) + " ET";
  } catch {
    return "";
  }
}

function operatingDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// Deduplicate events by home+away team pair (same game can appear in multiple sport keys).
function dedupeEvents(events: OddsEvent[]): OddsEvent[] {
  const seen = new Set<string>();
  const out: OddsEvent[] = [];
  for (const ev of events) {
    const k = `${ev.homeTeamFull}|${ev.awayTeamFull}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(ev);
    }
  }
  return out;
}

// Run an array of async tasks in parallel batches of `batchSize`.
async function batchRun<T>(tasks: (() => Promise<T>)[], batchSize: number): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((t) => t()));
    results.push(...batchResults);
  }
  return results;
}

// Extract the per-event market data (prices, devig, consensus) without any async work.
interface EventMarkets {
  bestHomeMl: number | null;
  bestAwayMl: number | null;
  bestHomeBook: string | null;
  bestAwayBook: string | null;
  drawMl: number | null;
  homeFairProb: number | null;
  drawFairProb: number | null;
  awayFairProb: number | null;
  publicPct: number | null;
  sharpPct: number | null;
  leagueName: string;
  leagueId: number | null;
  isFriendly: boolean;
  season: number;
}

function extractEventMarkets(ev: OddsEvent & { sportKey?: string }): EventMarkets {
  const sportKey = ev.sportKey ?? "";
  const leagueInfo = leagueByOddsKey(sportKey);
  const leagueName = leagueInfo?.name ?? sportKey.replace("soccer_", "").replace(/_/g, " ");
  const leagueId = leagueInfo?.id ?? null;
  const isFriendly = isFriendlyLeague(leagueName);
  const season = leagueInfo ? leagueInfo.season : seasonForLeague(leagueId ?? 71);

  const rawBms = ev.rawBookmakers ?? [];
  const drawMl = extractDrawOdds(rawBms);

  let bestHomeMl: number | null = null;
  let bestAwayMl: number | null = null;
  let bestHomeBook: string | null = null;
  let bestAwayBook: string | null = null;

  for (const bm of rawBms) {
    const h2h = bm.markets?.find((m: { key: string }) => m.key === "h2h");
    if (!h2h) continue;
    const homeOut = h2h.outcomes.find((o: { name: string }) => o.name === ev.homeTeamFull);
    const awayOut = h2h.outcomes.find((o: { name: string }) => o.name === ev.awayTeamFull);
    if (homeOut && (bestHomeMl === null || homeOut.price > bestHomeMl)) {
      bestHomeMl = homeOut.price;
      bestHomeBook = bm.title ?? bm.key ?? null;
    }
    if (awayOut && (bestAwayMl === null || awayOut.price > bestAwayMl)) {
      bestAwayMl = awayOut.price;
      bestAwayBook = bm.title ?? bm.key ?? null;
    }
  }

  let homeFairProb: number | null = null;
  let drawFairProb: number | null = null;
  let awayFairProb: number | null = null;

  if (bestHomeMl !== null && drawMl !== null && bestAwayMl !== null) {
    const fair = devigThreeWay(bestHomeMl, drawMl, bestAwayMl);
    homeFairProb = fair.home;
    drawFairProb = fair.draw;
    awayFairProb = fair.away;
  }

  const { publicPct, sharpPct } = computePublicSharp(
    (rawBms ?? []) as RawBookmaker[],
    ev.homeTeamFull,
    ev.awayTeamFull,
  );

  return {
    bestHomeMl, bestAwayMl, bestHomeBook, bestAwayBook, drawMl,
    homeFairProb, drawFairProb, awayFairProb,
    publicPct, sharpPct,
    leagueName, leagueId, isFriendly, season,
  };
}

export interface SoccerSlateBuildResult {
  operatingDay: string;
  games: SoccerGameInput[];
}

export async function buildSoccerSlate(now: Date = new Date()): Promise<SoccerSlateBuildResult> {
  const opDay = operatingDay(now);

  // Fetch odds from all soccer sport keys in parallel; deduplicate
  const allOddsResults = await Promise.allSettled(
    SOCCER_ODDS_KEYS.map((key) => fetchOddsForSport(key, nameToAbbr)),
  );

  const allEvents: (OddsEvent & { sportKey?: string })[] = [];
  SOCCER_ODDS_KEYS.forEach((key, i) => {
    const r = allOddsResults[i];
    if (r.status === "fulfilled") {
      for (const ev of r.value) {
        (ev as OddsEvent & { sportKey?: string }).sportKey = key;
        allEvents.push(ev as OddsEvent & { sportKey?: string });
      }
    }
  });

  const events = dedupeEvents(allEvents);
  if (events.length === 0) return { operatingDay: opDay, games: [] };

  // Extract synchronous market data for each event
  const eventMarkets = events.map((ev) => extractEventMarkets(ev as OddsEvent & { sportKey?: string }));

  // Build team-stats fetch tasks for all events (home + away per event).
  // FIFA events (World Cup, Club World Cup) use national/special-event teams
  // that don't have season stats in API-Sports club database — skip them.
  const FIFA_LEAGUE_IDS = new Set(SOCCER_LEAGUES.filter((l) => l.isFifaEvent).map((l) => l.id));

  // Tasks are keyed by index so we can correlate back to events.
  const statsTasks: (() => Promise<TeamGoalStats>)[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const { leagueId, season } = eventMarkets[i];
    // Skip stats fetch for FIFA events (national teams lack club-season stats)
    const isFifaEvent = leagueId !== null && FIFA_LEAGUE_IDS.has(leagueId);
    const noStats = leagueId === null || isFifaEvent;
    statsTasks.push(
      noStats
        ? () => Promise.resolve({ available: false } as TeamGoalStats)
        : () => fetchFootballTeamStats(ev.homeTeamFull, leagueId!, season).catch(() => ({ available: false } as TeamGoalStats)),
    );
    statsTasks.push(
      noStats
        ? () => Promise.resolve({ available: false } as TeamGoalStats)
        : () => fetchFootballTeamStats(ev.awayTeamFull, leagueId!, season).catch(() => ({ available: false } as TeamGoalStats)),
    );
  }

  // Fetch all team stats in parallel batches of BATCH_SIZE to respect API rate limits.
  const allStats = await batchRun(statsTasks, BATCH_SIZE * 2);

  // Polymarket lookups (home-keyed; re-oriented per pick side in picksEngine).
  // The event-list is cached, so these N calls share one upstream request.
  const polyResults = await Promise.all(
    events.map((ev) =>
      fetchPolymarketForGame(ev.homeTeamFull, ev.awayTeamFull, opDay, "home", "soccer")
        .catch((): PolymarketResult => ({ found: false, pct: null, reason: "lookup error" })),
    ),
  );

  const games: SoccerGameInput[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const m = eventMarkets[i];
    const homeStats: TeamGoalStats = allStats[i * 2];
    const awayStats: TeamGoalStats = allStats[i * 2 + 1];
    const poly = polyResults[i];

    games.push({
      gameId: ev.eventId,
      gameDate: opDay,
      gameTimeEt: etClock(ev.startIso),
      venue: "",
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      homeTeamFull: ev.homeTeamFull,
      awayTeamFull: ev.awayTeamFull,
      leagueName: m.leagueName,
      leagueId: m.leagueId,
      isFriendly: m.isFriendly,
      isWorldCupMatchday1: false, // runtime check done in slate.ts
      homeForm: homeStats.form ?? null,
      awayForm: awayStats.form ?? null,
      mlHome: m.bestHomeMl,
      mlDraw: m.drawMl,
      mlAway: m.bestAwayMl,
      mlHomeBook: m.bestHomeBook,
      mlAwayBook: m.bestAwayBook,
      homeFairProb: m.homeFairProb,
      drawFairProb: m.drawFairProb,
      awayFairProb: m.awayFairProb,
      spreadHomeLine: ev.spread.homeLine,
      spreadHomePrice: ev.spread.homePrice,
      spreadAwayLine: ev.spread.awayLine,
      spreadAwayPrice: ev.spread.awayPrice,
      spreadBook: ev.spread.book,
      totalLine: ev.total.line,
      totalOverPrice: ev.total.overPrice,
      totalUnderPrice: ev.total.underPrice,
      totalBook: ev.total.book,
      openHomeMl: m.bestHomeMl,
      openAwayMl: m.bestAwayMl,
      _publicPct: m.publicPct,
      _sharpPct: m.sharpPct,
      _polymarketData: poly.found
        ? { found: true, pct: poly.pct }
        : { found: false, pct: null, reason: poly.reason },
      // Attach stats so slate.ts can forward to model
      _homeStats: homeStats,
      _awayStats: awayStats,
    } as SoccerGameInput & { _homeStats: typeof homeStats; _awayStats: typeof awayStats });
  }

  return { operatingDay: opDay, games };
}
