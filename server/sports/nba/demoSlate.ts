// Deterministic NBA demo slate — renders a full basketball card set (ML/spread/
// total, efficiency data, varied tiers) when no Odds key is configured. Numbers
// are illustrative, not live; the UI labels the slate as "demo".

import type { NbaGameInput } from "./picksEngine";
import type { TeamHoopStats } from "./model";

function team(ortg: number, drtg: number, pace: number): TeamHoopStats {
  return { available: true, ortg, drtg, pace };
}

// Synthesize a standard spread and a total around expected points.
function withDerivedMarkets(g: NbaGameInput): NbaGameInput {
  const homeFav = (g.mlHome ?? 0) < (g.mlAway ?? 0);
  const hs = g._homeStats as TeamHoopStats;
  const as = g._awayStats as TeamHoopStats;
  const pace = ((hs?.pace ?? 99.5) + (as?.pace ?? 99.5)) / 2;
  const totalLine = roundHalf(((hs?.ortg ?? 114) + (as?.ortg ?? 114)) / 100 * pace + 2.5);
  return {
    ...g,
    spreadHomeLine: homeFav ? -4.5 : 4.5,
    spreadHomePrice: -110,
    spreadAwayLine: homeFav ? 4.5 : -4.5,
    spreadAwayPrice: -110,
    spreadBook: g.mlHomeBook ?? "draftkings",
    totalLine,
    totalOverPrice: -110,
    totalUnderPrice: -110,
    totalBook: g.mlAwayBook ?? "fanduel",
  };
}

function roundHalf(x: number): number {
  return Math.round(x * 2) / 2;
}

export function DEMO_NBA_GAMES(dateEt: string): NbaGameInput[] {
  return RAW_DEMO_NBA(dateEt).map(withDerivedMarkets);
}

function RAW_DEMO_NBA(dateEt: string): NbaGameInput[] {
  return [
    {
      gameId: "demo-BOS-DEN",
      gameDate: dateEt,
      gameTimeEt: "9:00 PM ET",
      venue: "Ball Arena",
      homeTeam: "DEN",
      awayTeam: "BOS",
      homeTeamFull: "Denver Nuggets",
      awayTeamFull: "Boston Celtics",
      mlHome: 105,
      mlAway: -125,
      mlHomeBook: "draftkings",
      mlAwayBook: "fanduel",
      homeFairProb: 0.473,
      awayFairProb: 0.527,
      _homeStats: team(118.5, 113.2, 98.1),
      _awayStats: team(120.1, 110.8, 99.8),
    },
    {
      gameId: "demo-LAL-GSW",
      gameDate: dateEt,
      gameTimeEt: "10:00 PM ET",
      venue: "Chase Center",
      homeTeam: "GSW",
      awayTeam: "LAL",
      homeTeamFull: "Golden State Warriors",
      awayTeamFull: "Los Angeles Lakers",
      mlHome: -140,
      mlAway: 118,
      mlHomeBook: "betmgm",
      mlAwayBook: "caesars",
      homeFairProb: 0.566,
      awayFairProb: 0.434,
      _homeStats: team(117.2, 112.5, 101.5),
      _awayStats: team(115.0, 114.0, 100.2),
    },
  ];
}
