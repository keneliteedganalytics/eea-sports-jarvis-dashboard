// Deterministic NHL demo slate — renders a full hockey card set (ML/puck-line/
// total, goalie data, varied tiers) when no Odds key is configured. Numbers are
// illustrative, not live; the UI labels the slate as "demo".

import type { NhlGameInput } from "./picksEngine";
import type { TeamHockeyStats, GoalieStats } from "./model";

function team(gpg: number, gapg: number, xgfPct: number): TeamHockeyStats {
  return { available: true, gpg, gapg, xgfPct };
}
function goalie(name: string, svPct: number): GoalieStats {
  return { available: true, goalie: name, svPct };
}

// Synthesize a standard puck-line (±1.5) and a total around expected goals.
function withDerivedMarkets(g: NhlGameInput): NhlGameInput {
  const homeFav = (g.mlHome ?? 0) < (g.mlAway ?? 0);
  const hs = g._homeStats as TeamHockeyStats;
  const as = g._awayStats as TeamHockeyStats;
  const totalLine = round05(((hs?.gpg ?? 3.05) + (as?.gpg ?? 3.05)) * 0.95);
  return {
    ...g,
    spreadHomeLine: homeFav ? -1.5 : 1.5,
    spreadHomePrice: homeFav ? 175 : -210,
    spreadAwayLine: homeFav ? 1.5 : -1.5,
    spreadAwayPrice: homeFav ? -210 : 175,
    spreadBook: g.mlHomeBook ?? "draftkings",
    totalLine,
    totalOverPrice: -108,
    totalUnderPrice: -112,
    totalBook: g.mlAwayBook ?? "fanduel",
  };
}

function round05(x: number): number {
  return Math.round(x * 2) / 2;
}

export function DEMO_NHL_GAMES(dateEt: string): NhlGameInput[] {
  return RAW_DEMO_NHL(dateEt).map(withDerivedMarkets);
}

function RAW_DEMO_NHL(dateEt: string): NhlGameInput[] {
  return [
    {
      gameId: "demo-EDM-COL",
      gameDate: dateEt,
      gameTimeEt: "9:00 PM ET",
      venue: "Ball Arena",
      homeTeam: "COL",
      awayTeam: "EDM",
      homeTeamFull: "Colorado Avalanche",
      awayTeamFull: "Edmonton Oilers",
      homeGoalieName: "Mackenzie Blackwood",
      awayGoalieName: "Stuart Skinner",
      homeGoalieAvailable: true,
      awayGoalieAvailable: true,
      mlHome: -130,
      mlAway: 110,
      mlHomeBook: "draftkings",
      mlAwayBook: "fanduel",
      homeFairProb: 0.554,
      awayFairProb: 0.446,
      _homeStats: team(3.35, 2.78, 54.2),
      _awayStats: team(3.45, 2.95, 52.8),
      _homeGoalie: goalie("Mackenzie Blackwood", 0.913),
      _awayGoalie: goalie("Stuart Skinner", 0.901),
    },
    {
      gameId: "demo-FLA-TBL",
      gameDate: dateEt,
      gameTimeEt: "7:00 PM ET",
      venue: "Amerant Bank Arena",
      homeTeam: "FLA",
      awayTeam: "TBL",
      homeTeamFull: "Florida Panthers",
      awayTeamFull: "Tampa Bay Lightning",
      homeGoalieName: "Sergei Bobrovsky",
      awayGoalieName: "Andrei Vasilevskiy",
      homeGoalieAvailable: true,
      awayGoalieAvailable: true,
      mlHome: -118,
      mlAway: -102,
      mlHomeBook: "betmgm",
      mlAwayBook: "caesars",
      homeFairProb: 0.521,
      awayFairProb: 0.479,
      _homeStats: team(3.28, 2.65, 53.5),
      _awayStats: team(3.30, 2.88, 51.9),
      _homeGoalie: goalie("Sergei Bobrovsky", 0.910),
      _awayGoalie: goalie("Andrei Vasilevskiy", 0.918),
    },
    {
      gameId: "demo-TOR-BOS",
      gameDate: dateEt,
      gameTimeEt: "7:30 PM ET",
      venue: "TD Garden",
      homeTeam: "BOS",
      awayTeam: "TOR",
      homeTeamFull: "Boston Bruins",
      awayTeamFull: "Toronto Maple Leafs",
      homeGoalieName: "Jeremy Swayman",
      awayGoalieName: "Joseph Woll",
      homeGoalieAvailable: true,
      awayGoalieAvailable: true,
      mlHome: 100,
      mlAway: -120,
      mlHomeBook: "fanduel",
      mlAwayBook: "draftkings",
      homeFairProb: 0.484,
      awayFairProb: 0.516,
      _homeStats: team(3.05, 2.72, 50.8),
      _awayStats: team(3.40, 2.80, 53.1),
      _homeGoalie: goalie("Jeremy Swayman", 0.908),
      _awayGoalie: goalie("Joseph Woll", 0.905),
    },
  ];
}
