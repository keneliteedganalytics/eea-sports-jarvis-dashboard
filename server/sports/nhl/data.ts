// NHL adapter glue — composes Odds API (icehockey_nhl) prices with API-Sports
// hockey team stats + goalie availability into NhlGameInput records. Degrades
// gracefully: no Odds key → empty slate (slate service falls back to demo).

import { fetchOddsForSport, type OddsEvent, type BookPrice } from "../../adapters/oddsApi";
import { DISPLAY_TIMEZONE } from "../../utils/timezone";
import { consensusSnhl, bestPrice, type Bookmaker } from "../../core/odds";
import { computePublicSharp, type RawBookmaker } from "../../core/consensus";
import { fetchHockeyTeamStats, fetchHockeyGoalies, type HockeyTeamStats, type GoalieAvail } from "../../adapters/apiSportsHockey";
import { fetchPolymarketForGame, type PolymarketResult } from "../../adapters/polymarket";
import { nameToAbbr } from "./teams";
import type { NhlGameInput } from "./picksEngine";
import type { GoalieStats, TeamHockeyStats } from "./model";

const NHL_SEASON = 2025;

function toBookmakers(ev: OddsEvent): Bookmaker[] {
  return ev.books.map((b: BookPrice) => ({
    key: b.book,
    title: b.book,
    markets: [
      {
        key: "h2h",
        outcomes: [
          ...(b.homePrice !== null ? [{ name: ev.homeTeamFull, price: b.homePrice }] : []),
          ...(b.awayPrice !== null ? [{ name: ev.awayTeamFull, price: b.awayPrice }] : []),
        ],
      },
    ],
  }));
}

function etClock(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: DISPLAY_TIMEZONE,
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
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export interface NhlSlateBuildResult {
  operatingDay: string;
  games: NhlGameInput[];
}

// Build today's NHL slate. Joins consensus odds with team stats + goalie data.
export async function buildNhlSlate(now: Date = new Date()): Promise<NhlSlateBuildResult> {
  const opDay = operatingDay(now);
  const oddsEvents = await fetchOddsForSport("icehockey_nhl", nameToAbbr);
  if (oddsEvents.length === 0) return { operatingDay: opDay, games: [] };

  // Goalie availability is fetched once for the day (defensive: may be empty).
  const goalies = await fetchHockeyGoalies(opDay).catch(() => [] as GoalieAvail[]);
  const goalieByTeam = new Map<string, GoalieAvail>();
  for (const g of goalies) goalieByTeam.set(g.teamAbbr, g);

  const games: NhlGameInput[] = [];
  for (const ev of oddsEvents) {
    const bms = toBookmakers(ev);
    const consensus = consensusSnhl(bms, ev.homeTeamFull, ev.awayTeamFull, "shin");
    const [homeMl, homeBook] = bestPrice(bms, ev.homeTeamFull);
    const [awayMl, awayBook] = bestPrice(bms, ev.awayTeamFull);

    // Public / sharp consensus from raw bookmaker data (same as MLB)
    const { publicPct, sharpPct } = computePublicSharp(
      (ev.rawBookmakers ?? []) as RawBookmaker[],
      ev.homeTeamFull,
      ev.awayTeamFull,
    );

    const [homeStats, awayStats, polyResult] = await Promise.all([
      fetchHockeyTeamStats(ev.homeTeamFull, NHL_SEASON).catch(() => emptyTeamStats()),
      fetchHockeyTeamStats(ev.awayTeamFull, NHL_SEASON).catch(() => emptyTeamStats()),
      fetchPolymarketForGame(ev.homeTeamFull, ev.awayTeamFull, opDay, "home", "nhl")
        .catch((): PolymarketResult => ({ found: false, pct: null, reason: "lookup error" })),
    ]);

    const homeG = goalieByTeam.get(ev.homeTeam);
    const awayG = goalieByTeam.get(ev.awayTeam);

    games.push({
      gameId: ev.eventId,
      gameDate: opDay,
      gameTimeEt: etClock(ev.startIso),
      gameStartIso: ev.startIso,
      venue: "",
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      homeTeamFull: ev.homeTeamFull,
      awayTeamFull: ev.awayTeamFull,
      homeGoalieName: homeG?.goalie ?? null,
      awayGoalieName: awayG?.goalie ?? null,
      homeGoalieAvailable: homeG?.available ?? false,
      awayGoalieAvailable: awayG?.available ?? false,
      mlHome: homeMl,
      mlAway: awayMl,
      mlHomeBook: homeBook,
      mlAwayBook: awayBook,
      homeFairProb: consensus?.homeFairProb ?? null,
      awayFairProb: consensus?.awayFairProb ?? null,
      spreadHomeLine: ev.spread.homeLine,
      spreadHomePrice: ev.spread.homePrice,
      spreadAwayLine: ev.spread.awayLine,
      spreadAwayPrice: ev.spread.awayPrice,
      spreadBook: ev.spread.book,
      totalLine: ev.total.line,
      totalOverPrice: ev.total.overPrice,
      totalUnderPrice: ev.total.underPrice,
      totalBook: ev.total.book,
      // stats carried for the model via the slate runner
      _homeStats: homeStats,
      _awayStats: awayStats,
      _homeGoalie: homeG ? { available: homeG.available, goalie: homeG.goalie, svPct: homeG.svPct ?? null, gaa: homeG.gaa ?? null, gp: homeG.gp ?? null } : null,
      _awayGoalie: awayG ? { available: awayG.available, goalie: awayG.goalie, svPct: awayG.svPct ?? null, gaa: awayG.gaa ?? null, gp: awayG.gp ?? null } : null,
      _publicPct: publicPct,
      _sharpPct: sharpPct,
      _polymarketData: polyResult.found
        ? { found: true, pct: polyResult.pct }
        : { found: false, pct: null, reason: polyResult.reason },
      _oddsEvent: ev,
    } as NhlGameInput);
  }

  return { operatingDay: opDay, games };
}

function emptyTeamStats(): HockeyTeamStats {
  return { available: false };
}
