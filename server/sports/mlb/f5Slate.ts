// v6.10 — F5 (first-5-innings) slate builder.
// Fetches odds (with F5 markets), runs the F5 pick engine, and persists picks.

import { fetchOdds } from "../../adapters/oddsApi";
import { fetchSchedule, fetchPitcherStats } from "../../adapters/mlbStats";
import { getOperatingDay, inOperatingWindow } from "./operatingDay";
import { buildF5Picks } from "./f5Picks";
import { upsertF5Pick, getF5PicksForDate, type F5PickRow } from "../../gradedBook";
import { classifyPitcher } from "./pitchers";
import type { PitcherStats } from "./pitchers";

function withClassification(p: PitcherStats): PitcherStats {
  const c = classifyPitcher(p);
  return { ...p, classification: c.classification, hardPassReason: c.hardPassReason, sparse: c.sparse, sparseReason: c.sparseReason };
}

export interface F5SlateResult {
  operatingDay: string;
  picks: F5PickRow[];
  built: number;
  emptyReason?: string;
}

// Build today's F5 picks and persist them.
export async function buildF5Slate(now: Date = new Date()): Promise<F5SlateResult> {
  const opDay = getOperatingDay(now);
  const [oddsEvents, schedule] = await Promise.all([fetchOdds(), fetchSchedule(opDay)]);

  const inWindow = oddsEvents.filter((ev) => inOperatingWindow(ev.startIso, opDay));

  // If no events carry F5 data (markets not enabled or plan doesn't support them),
  // return a clean empty result instead of silently returning zero picks.
  const hasAnyF5 = inWindow.some((ev) => ev.f5 != null);
  if (!hasAnyF5) {
    return {
      operatingDay: opDay,
      picks: [],
      built: 0,
      emptyReason: "F5 markets not enabled on current odds plan",
    };
  }

  let built = 0;

  for (const ev of inWindow) {
    if (!ev.f5) continue; // no F5 market data for this game — skip

    // Match to schedule for pitcher IDs
    const sched = schedule.find(
      (s) =>
        (s.homeTeam === ev.homeTeam && s.awayTeam === ev.awayTeam) ||
        (s.homeTeamFull === ev.homeTeamFull && s.awayTeamFull === ev.awayTeamFull),
    );
    if (!sched || sched.homePitcherId === null || sched.awayPitcherId === null) continue;

    const [homePitcher, awayPitcher] = await Promise.all([
      fetchPitcherStats(sched.homePitcherId, sched.homePitcher),
      fetchPitcherStats(sched.awayPitcherId, sched.awayPitcher),
    ]);

    const hSP = withClassification(homePitcher);
    const aSP = withClassification(awayPitcher);

    // Skip games with a hard-pass pitcher (sub-15 IP etc.)
    if (hSP.hardPassReason || aSP.hardPassReason) continue;

    const picks = buildF5Picks({
      gameId: ev.eventId,
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      homePitcher: hSP,
      awayPitcher: aSP,
      parkFactor: 1.0,   // TODO: wire park factor when sabermetrics module ships
      weatherAdj: 0.0,   // TODO: wire weather when sabermetrics module ships
      marketF5: ev.f5,
    });

    for (const p of picks) {
      upsertF5Pick({
        gameId: p.gameId,
        gameDate: opDay,
        market: p.market,
        pickSide: p.pickSide,
        price: p.price,
        line: p.line,
        modelProb: p.modelProb,
        marketProb: p.marketProb,
        edgePp: p.edge,
        tier: p.tier,
        projected_home_runs_f5: p.projectedHomeRunsF5,
        projected_away_runs_f5: p.projectedAwayRunsF5,
        reasoning: p.reasoning,
      });
      built++;
    }
  }

  return {
    operatingDay: opDay,
    picks: getF5PicksForDate(opDay),
    built,
  };
}

// Return persisted F5 picks for a given date (no rebuild).
export function getF5PicksForDay(date: string): F5PickRow[] {
  return getF5PicksForDate(date);
}
