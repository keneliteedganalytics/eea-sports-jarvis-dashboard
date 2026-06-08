// Soccer slate data adapter.
// Joins Odds API soccer prices (h2h with Draw, spreads, totals) with
// API-Sports v3 team goal stats to produce SoccerGameInput records.
// Degrades gracefully: no keys → empty slate (demo slate used by slate.ts).

import { fetchOddsForSport, type OddsEvent } from "../../adapters/oddsApi";
import { fetchFootballTeamStats, isFriendlyLeague, seasonForLeague } from "../../adapters/apiSportsFootball";
import { extractDrawOdds } from "./oddsMath";
import { devigThreeWay } from "../../core/odds";
import { computePublicSharp, type RawBookmaker } from "../../core/consensus";
import { nameToAbbr } from "./teams";
import { SOCCER_ODDS_KEYS, leagueByOddsKey } from "./leagues";
import type { SoccerGameInput } from "./picksEngine";
import type { TeamGoalStats } from "./model";

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

  const games: SoccerGameInput[] = [];

  for (const ev of events) {
    const evWithKey = ev as OddsEvent & { sportKey?: string };
    const sportKey = evWithKey.sportKey ?? "";
    const leagueInfo = leagueByOddsKey(sportKey);
    const leagueName = leagueInfo?.name ?? sportKey.replace("soccer_", "").replace(/_/g, " ");
    const leagueId = leagueInfo?.id ?? null;
    const isFriendly = isFriendlyLeague(leagueName);

    // Extract draw odds from raw bookmakers
    const rawBms = ev.rawBookmakers ?? [];
    const drawMl = extractDrawOdds(rawBms);

    // Three-way devig if we have all three lines
    let homeFairProb: number | null = null;
    let drawFairProb: number | null = null;
    let awayFairProb: number | null = null;

    // Collect best home/away prices
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

    // Devig 3-way
    if (bestHomeMl !== null && drawMl !== null && bestAwayMl !== null) {
      const fair = devigThreeWay(bestHomeMl, drawMl, bestAwayMl);
      homeFairProb = fair.home;
      drawFairProb = fair.draw;
      awayFairProb = fair.away;
    }

    // Public / sharp consensus from raw bookmaker data
    const { publicPct, sharpPct } = computePublicSharp(
      (rawBms ?? []) as RawBookmaker[],
      ev.homeTeamFull,
      ev.awayTeamFull,
    );

    // Fetch team stats from API-Sports v3 (in parallel, best-effort)
    const season = leagueInfo ? leagueInfo.season : seasonForLeague(leagueId ?? 71);
    const [homeStats, awayStats] = await Promise.all([
      leagueId !== null
        ? fetchFootballTeamStats(ev.homeTeamFull, leagueId, season).catch(() => ({ available: false } as TeamGoalStats))
        : Promise.resolve({ available: false } as TeamGoalStats),
      leagueId !== null
        ? fetchFootballTeamStats(ev.awayTeamFull, leagueId, season).catch(() => ({ available: false } as TeamGoalStats))
        : Promise.resolve({ available: false } as TeamGoalStats),
    ]);

    games.push({
      gameId: ev.eventId,
      gameDate: opDay,
      gameTimeEt: etClock(ev.startIso),
      venue: "",
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      homeTeamFull: ev.homeTeamFull,
      awayTeamFull: ev.awayTeamFull,
      leagueName,
      leagueId,
      isFriendly,
      isWorldCupMatchday1: false, // runtime check done in slate.ts
      homeForm: homeStats.form ?? null,
      awayForm: awayStats.form ?? null,
      mlHome: bestHomeMl,
      mlDraw: drawMl,
      mlAway: bestAwayMl,
      mlHomeBook: bestHomeBook,
      mlAwayBook: bestAwayBook,
      homeFairProb,
      drawFairProb,
      awayFairProb,
      spreadHomeLine: ev.spread.homeLine,
      spreadHomePrice: ev.spread.homePrice,
      spreadAwayLine: ev.spread.awayLine,
      spreadAwayPrice: ev.spread.awayPrice,
      spreadBook: ev.spread.book,
      totalLine: ev.total.line,
      totalOverPrice: ev.total.overPrice,
      totalUnderPrice: ev.total.underPrice,
      totalBook: ev.total.book,
      openHomeMl: bestHomeMl,
      openAwayMl: bestAwayMl,
      _publicPct: publicPct,
      _sharpPct: sharpPct,
      // Attach stats so slate.ts can forward to model
      _homeStats: homeStats,
      _awayStats: awayStats,
    } as SoccerGameInput & { _homeStats: typeof homeStats; _awayStats: typeof awayStats });
  }

  return { operatingDay: opDay, games };
}
