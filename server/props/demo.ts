// Deterministic demo player props — renders the PropsPanel end-to-end with no
// Odds key. MLB props carry a real Poisson edge; NHL/NBA are display-only.

import { mlbPropEdge } from "./model";
import type { PropRow } from "./index";

interface Seed {
  gameId: string;
  playerName: string;
  market: string;
  line: number;
  overPrice: number;
  underPrice: number;
  rate: number;
  opp: number;
}

const MLB_SEEDS: Seed[] = [
  { gameId: "demo-LAD-SF", playerName: "Mookie Betts", market: "batter_home_runs", line: 0.5, overPrice: 280, underPrice: -360, rate: 0.08, opp: 4.3 },
  { gameId: "demo-LAD-SF", playerName: "Logan Webb", market: "pitcher_strikeouts", line: 5.5, overPrice: -120, underPrice: 100, rate: 1.0, opp: 6.0 },
  { gameId: "demo-NYY-BOS", playerName: "Aaron Judge", market: "batter_total_bases", line: 1.5, overPrice: -135, underPrice: 110, rate: 0.42, opp: 4.3 },
  { gameId: "demo-NYY-BOS", playerName: "Gerrit Cole", market: "pitcher_strikeouts", line: 6.5, overPrice: -110, underPrice: -110, rate: 1.05, opp: 6.2 },
  { gameId: "demo-HOU-SEA", playerName: "Yordan Alvarez", market: "batter_hits", line: 0.5, overPrice: -210, underPrice: 170, rate: 0.27, opp: 4.3 },
];

const NHL_SEEDS: Omit<Seed, "rate" | "opp">[] = [
  { gameId: "demo-EDM-COL", playerName: "Connor McDavid", market: "player_points", line: 1.5, overPrice: 105, underPrice: -130 },
  { gameId: "demo-EDM-COL", playerName: "Nathan MacKinnon", market: "player_shots_on_goal", line: 3.5, overPrice: -115, underPrice: -105 },
  { gameId: "demo-FLA-TBL", playerName: "Matthew Tkachuk", market: "player_goal_scorer_anytime", line: 0.5, overPrice: 145, underPrice: -180 },
];

const NBA_SEEDS: Omit<Seed, "rate" | "opp">[] = [
  { gameId: "demo-BOS-DEN", playerName: "Nikola Jokic", market: "player_rebounds", line: 12.5, overPrice: -120, underPrice: -110 },
  { gameId: "demo-BOS-DEN", playerName: "Jayson Tatum", market: "player_points", line: 27.5, overPrice: -110, underPrice: -110 },
  { gameId: "demo-LAL-GSW", playerName: "Stephen Curry", market: "player_threes", line: 4.5, overPrice: 100, underPrice: -120 },
];

export function demoProps(sport: string, _date: string): PropRow[] {
  if (sport === "mlb") {
    return MLB_SEEDS.map((s) => {
      const e = mlbPropEdge(s.rate, s.opp, s.line, s.overPrice, s.underPrice);
      return {
        gameId: s.gameId,
        sport,
        playerName: s.playerName,
        team: "",
        market: s.market,
        line: s.line,
        overPrice: s.overPrice,
        underPrice: s.underPrice,
        book: "draftkings",
        modelProb: e.modelProb,
        edgePp: e.edgePp,
        tier: e.tier,
        side: e.side,
        uncalibrated: e.uncalibrated,
      };
    });
  }
  const seeds = sport === "nhl" ? NHL_SEEDS : sport === "nba" ? NBA_SEEDS : [];
  return seeds.map((s) => ({
    gameId: s.gameId,
    sport,
    playerName: s.playerName,
    team: "",
    market: s.market,
    line: s.line,
    overPrice: s.overPrice,
    underPrice: s.underPrice,
    book: "draftkings",
    modelProb: null,
    edgePp: null,
    tier: null,
    side: null,
    uncalibrated: true,
  }));
}
