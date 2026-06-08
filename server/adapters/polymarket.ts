// Polymarket adapter — fetches prediction-market probability for a game's
// pick side. Uses the Gamma API (public, no auth required).
//
// Polymarket has individual MLB game markets for the current season under
// slugs like "mlb-yankees-vs-guardians-YYYY-MM-DD". The matcher tries several
// normalisation strategies (city names, common abbreviations, sorted order).
// When no market is found we return { found: false, reason: "no market available" }
// so the UI can show "—" with an honest tooltip instead of a blank bar.

import { getJson } from "./http";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

export interface PolymarketResult {
  found: boolean;
  pct: number | null;       // 0-100 win prob for the pick side, null when not found
  reason?: string;           // human-readable reason when found=false
  title?: string | null;     // market title for debugging
}

// Full team name → city / common search token used in Polymarket titles.
const TEAM_CITY_MAP: Record<string, string> = {
  // AL East
  "New York Yankees": "Yankees",
  "Boston Red Sox": "Red Sox",
  "Tampa Bay Rays": "Rays",
  "Toronto Blue Jays": "Blue Jays",
  "Baltimore Orioles": "Orioles",
  // AL Central
  "Cleveland Guardians": "Guardians",
  "Minnesota Twins": "Twins",
  "Detroit Tigers": "Tigers",
  "Chicago White Sox": "White Sox",
  "Kansas City Royals": "Royals",
  // AL West
  "Houston Astros": "Astros",
  "Texas Rangers": "Rangers",
  "Seattle Mariners": "Mariners",
  "Los Angeles Angels": "Angels",
  "Oakland Athletics": "Athletics",
  // NL East
  "Atlanta Braves": "Braves",
  "New York Mets": "Mets",
  "Philadelphia Phillies": "Phillies",
  "Miami Marlins": "Marlins",
  "Washington Nationals": "Nationals",
  // NL Central
  "Chicago Cubs": "Cubs",
  "Milwaukee Brewers": "Brewers",
  "St. Louis Cardinals": "Cardinals",
  "Cincinnati Reds": "Reds",
  "Pittsburgh Pirates": "Pirates",
  // NL West
  "Los Angeles Dodgers": "Dodgers",
  "San Francisco Giants": "Giants",
  "San Diego Padres": "Padres",
  "Colorado Rockies": "Rockies",
  "Arizona Diamondbacks": "Diamondbacks",
};

// Normalise a full team name to the token Polymarket uses in market titles.
function teamToken(fullName: string): string {
  return TEAM_CITY_MAP[fullName] ?? fullName.split(" ").pop() ?? fullName;
}

interface GammaMarket {
  question: string;
  endDate: string;
  outcomePrices: string;   // JSON-encoded string array e.g. '["0.56","0.44"]'
  outcomes: string;        // JSON-encoded string array e.g. '["Yankees","Guardians"]'
  active: boolean;
  closed: boolean;
}

// Parse outcomePrices + outcomes into { [teamToken]: prob (0-1) }.
function parseOutcomes(market: GammaMarket): Record<string, number> | null {
  try {
    const prices: string[] = JSON.parse(market.outcomePrices);
    const labels: string[] = JSON.parse(market.outcomes);
    if (prices.length !== labels.length) return null;
    const result: Record<string, number> = {};
    for (let i = 0; i < labels.length; i++) {
      result[labels[i].toLowerCase()] = parseFloat(prices[i]);
    }
    return result;
  } catch {
    return null;
  }
}

// Fetch Polymarket markets for a given date and pair of team names.
// Returns a PolymarketResult for the pick side.
export async function fetchPolymarketForGame(
  homeTeamFull: string,
  awayTeamFull: string,
  gameDateIso: string,  // YYYY-MM-DD
  pickSide: "home" | "away",
): Promise<PolymarketResult> {
  const homeToken = teamToken(homeTeamFull);
  const awayToken = teamToken(awayTeamFull);
  const pickToken = (pickSide === "home" ? homeToken : awayToken).toLowerCase();

  // Build a search query from both team tokens
  const q = `${awayToken} vs ${homeToken}`;

  const res = await getJson<GammaMarket[]>(`${GAMMA_BASE}/markets`, {
    q,
    limit: "10",
    active: "true",
    closed: "false",
  });

  if (!res.ok || !Array.isArray(res.data)) {
    return { found: false, pct: null, reason: "polymarket api unavailable" };
  }

  // Filter to markets whose endDate is the game date or the next day (games
  // scheduled for late ET can resolve the following UTC day).
  const gameDate = new Date(gameDateIso + "T00:00:00Z");
  const dayAfter = new Date(gameDate.getTime() + 2 * 86400_000); // +2 day buffer

  const candidates = (res.data as GammaMarket[]).filter((m) => {
    if (!m.active || m.closed) return false;
    const end = new Date(m.endDate);
    if (end < gameDate || end > dayAfter) return false;
    // Question must contain both team tokens (case-insensitive)
    const q = m.question.toLowerCase();
    return q.includes(homeToken.toLowerCase()) && q.includes(awayToken.toLowerCase());
  });

  if (candidates.length === 0) {
    return { found: false, pct: null, reason: "no market available" };
  }

  // Pick the best match: prefer the one whose question mentions "vs" (game ML)
  const best = candidates.find((m) => m.question.toLowerCase().includes(" vs ")) ?? candidates[0];

  const probs = parseOutcomes(best);
  if (!probs) {
    return { found: false, pct: null, reason: "malformed market data" };
  }

  // Find the probability for the pick side. Try exact token match first,
  // then partial (e.g. "red sox" in "Boston Red Sox").
  let prob: number | null = null;
  for (const [label, p] of Object.entries(probs)) {
    if (label.includes(pickToken) || pickToken.includes(label)) {
      prob = p;
      break;
    }
  }

  if (prob === null) {
    return { found: false, pct: null, reason: "pick team not in market outcomes", title: best.question };
  }

  return {
    found: true,
    pct: Math.round(prob * 1000) / 10, // 0.56 → 56.0
    title: best.question,
  };
}
