// Soccer league ID mapping for API-Sports v3 football.
// https://v3.football.api-sports.io
// Verified IDs as of SPEC v3.

export interface LeagueInfo {
  id: number;
  name: string;
  displayName: string;   // UI label (e.g. "Brasileirão")
  oddsKey: string;       // Odds API sport key
  season: number;        // Current season year
  isFifaEvent?: boolean; // true for World Cup / Club World Cup
}

export const SOCCER_LEAGUES: LeagueInfo[] = [
  {
    id: 1,
    name: "FIFA World Cup",
    displayName: "World Cup",
    oddsKey: "soccer_fifa_world_cup",
    season: 2026,
    isFifaEvent: true,
  },
  {
    id: 15,
    name: "FIFA Club World Cup",
    displayName: "Club World Cup",
    oddsKey: "soccer_fifa_world_cup",  // closest key available
    season: 2025,
    isFifaEvent: true,
  },
  {
    id: 39,
    name: "Premier League",
    displayName: "EPL",
    oddsKey: "soccer_epl",
    season: 2025,
  },
  {
    id: 140,
    name: "La Liga",
    displayName: "La Liga",
    oddsKey: "soccer_spain_la_liga",
    season: 2025,
  },
  {
    id: 78,
    name: "Bundesliga",
    displayName: "Bundesliga",
    oddsKey: "soccer_germany_bundesliga",
    season: 2025,
  },
  {
    id: 135,
    name: "Serie A",
    displayName: "Serie A",
    oddsKey: "soccer_italy_serie_a",
    season: 2025,
  },
  {
    id: 71,
    name: "Brazil Série A",
    displayName: "Brasileirão",
    oddsKey: "soccer_brazil_campeonato",
    season: 2026,
  },
];

// All Odds API sport keys we pull soccer odds for (in priority order).
export const SOCCER_ODDS_KEYS = [
  "soccer_fifa_world_cup",
  "soccer_brazil_campeonato",
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_germany_bundesliga",
  "soccer_italy_serie_a",
  "soccer_brazil_serie_b",
  "soccer_chile_campeonato",
  "soccer_china_superleague",
];

export function leagueByOddsKey(key: string): LeagueInfo | undefined {
  return SOCCER_LEAGUES.find((l) => l.oddsKey === key);
}

export function leagueById(id: number): LeagueInfo | undefined {
  return SOCCER_LEAGUES.find((l) => l.id === id);
}
