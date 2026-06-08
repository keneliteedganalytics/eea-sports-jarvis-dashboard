// Adapter glue — composes odds, schedule, pitcher stats, and weather into
// GameInput records the picks engine can consume. Degrades gracefully: with
// no API keys it returns an empty slate ("no slate today" in the UI).

import { fetchOdds, type OddsEvent, type BookPrice } from "../../adapters/oddsApi";
import { fetchSchedule, fetchPitcherStats, fetchTeamOffense, type ScheduleGame } from "../../adapters/mlbStats";
import { consensusSnhl, bestPrice, type Bookmaker } from "../../core/odds";
import { getOperatingDay, inOperatingWindow, utcIsoToEtClock } from "./operatingDay";
import { classifyPitcher } from "./pitchers";
import type { GameInput } from "./picksEngine";
import type { PitcherStats } from "./pitchers";
import type { TeamOffense } from "./ratings";

// Translate an OddsEvent's BookPrice[] into the Bookmaker[] shape that the
// consensus/best-price helpers expect (h2h market keyed by full team name).
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

function matchSchedule(ev: OddsEvent, schedule: ScheduleGame[]): ScheduleGame | undefined {
  return schedule.find(
    (s) =>
      (s.homeTeam === ev.homeTeam && s.awayTeam === ev.awayTeam) ||
      (s.homeTeamFull === ev.homeTeamFull && s.awayTeamFull === ev.awayTeamFull),
  );
}

function withClassification(p: PitcherStats): PitcherStats {
  const c = classifyPitcher(p);
  return { ...p, classification: c.classification, hardPassReason: c.hardPassReason, sparse: c.sparse, sparseReason: c.sparseReason };
}

export interface SlateBuildResult {
  operatingDay: string;
  games: GameInput[];
}

// Build today's MLB slate. Joins consensus odds with probable pitchers.
export async function buildSlate(now: Date = new Date()): Promise<SlateBuildResult> {
  const opDay = getOperatingDay(now);

  const [oddsEvents, schedule] = await Promise.all([fetchOdds(), fetchSchedule(opDay)]);

  // Filter to games inside the operating-day window.
  const inWindow = oddsEvents.filter((ev) => inOperatingWindow(ev.startIso, opDay));
  if (inWindow.length === 0) return { operatingDay: opDay, games: [] };

  const games: GameInput[] = [];
  for (const ev of inWindow) {
    const bms = toBookmakers(ev);
    const consensus = consensusSnhl(bms, ev.homeTeamFull, ev.awayTeamFull, "shin");
    const [homeMl, homeBook] = bestPrice(bms, ev.homeTeamFull);
    const [awayMl, awayBook] = bestPrice(bms, ev.awayTeamFull);

    const sched = matchSchedule(ev, schedule);

    // SPEC §3: drop games with an unannounced (TBD) probable starter — without
    // both starters the model has no real pitcher inputs, so the card is noise.
    if (!sched || sched.homePitcherId === null || sched.awayPitcherId === null) {
      continue;
    }

    const [h, a, homeOff, awayOff] = await Promise.all([
      fetchPitcherStats(sched.homePitcherId, sched.homePitcher),
      fetchPitcherStats(sched.awayPitcherId, sched.awayPitcher),
      fetchTeamOffense(sched.homeTeamId, sched.homeTeamFull).catch(() => ({ available: false }) as TeamOffense),
      fetchTeamOffense(sched.awayTeamId, sched.awayTeamFull).catch(() => ({ available: false }) as TeamOffense),
    ]);
    const homeSp: PitcherStats = withClassification(h);
    const awaySp: PitcherStats = withClassification(a);

    games.push({
      gameId: ev.eventId,
      gameDate: opDay,
      gameTimeEt: utcIsoToEtClock(ev.startIso),
      venue: sched?.venue ?? "",
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      homeTeamFull: ev.homeTeamFull,
      awayTeamFull: ev.awayTeamFull,
      homePitcher: sched?.homePitcher ?? undefined,
      awayPitcher: sched?.awayPitcher ?? undefined,
      mlHome: homeMl,
      mlAway: awayMl,
      mlHomeBook: homeBook,
      mlAwayBook: awayBook,
      homeFairProb: consensus?.homeFairProb ?? null,
      awayFairProb: consensus?.awayFairProb ?? null,
      homeSpStats: homeSp,
      awaySpStats: awaySp,
      homeOffStats: homeOff,
      awayOffStats: awayOff,
      openHomeMl: null,
      openAwayMl: null,
      spreadHomeLine: ev.spread.homeLine,
      spreadHomePrice: ev.spread.homePrice,
      spreadAwayLine: ev.spread.awayLine,
      spreadAwayPrice: ev.spread.awayPrice,
      spreadBook: ev.spread.book,
      totalLine: ev.total.line,
      totalOverPrice: ev.total.overPrice,
      totalUnderPrice: ev.total.underPrice,
      totalBook: ev.total.book,
    });
  }

  return { operatingDay: opDay, games };
}
