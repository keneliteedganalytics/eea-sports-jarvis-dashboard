// NBA adapter glue — composes Odds API (basketball_nba) prices with API-Sports
// basketball team efficiency into NbaGameInput records. Degrades gracefully:
// no Odds key → empty slate (slate service falls back to demo).

import { fetchOddsForSport, type OddsEvent, type BookPrice } from "../../adapters/oddsApi";
import { consensusSnhl, bestPrice, type Bookmaker } from "../../core/odds";
import { computePublicSharp, type RawBookmaker } from "../../core/consensus";
import { fetchHoopTeamStats } from "../../adapters/apiSportsBasketball";
import { nameToAbbr } from "./teams";
import type { NbaGameInput } from "./picksEngine";
import type { TeamHoopStats } from "./model";

const NBA_SEASON = "2025-2026";

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

export interface NbaSlateBuildResult {
  operatingDay: string;
  games: NbaGameInput[];
}

export async function buildNbaSlate(now: Date = new Date()): Promise<NbaSlateBuildResult> {
  const opDay = operatingDay(now);
  const oddsEvents = await fetchOddsForSport("basketball_nba", nameToAbbr);
  if (oddsEvents.length === 0) return { operatingDay: opDay, games: [] };

  const games: NbaGameInput[] = [];
  for (const ev of oddsEvents) {
    const bms = toBookmakers(ev);
    const consensus = consensusSnhl(bms, ev.homeTeamFull, ev.awayTeamFull, "shin");
    const [homeMl, homeBook] = bestPrice(bms, ev.homeTeamFull);
    const [awayMl, awayBook] = bestPrice(bms, ev.awayTeamFull);

    // Public / sharp consensus from raw bookmaker data
    const rawBms = ev.rawBookmakers ?? [];
    const { publicPct, sharpPct } = computePublicSharp(
      rawBms as RawBookmaker[],
      ev.homeTeamFull,
      ev.awayTeamFull,
    );

    const [homeStats, awayStats] = await Promise.all([
      fetchHoopTeamStats(ev.homeTeamFull, NBA_SEASON).catch(() => emptyStats()),
      fetchHoopTeamStats(ev.awayTeamFull, NBA_SEASON).catch(() => emptyStats()),
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
      _homeStats: homeStats,
      _awayStats: awayStats,
      _publicPct: publicPct,
      _sharpPct: sharpPct,
    });
  }

  return { operatingDay: opDay, games };
}

function emptyStats(): TeamHoopStats {
  return { available: false };
}
