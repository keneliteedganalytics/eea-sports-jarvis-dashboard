// v6.9.5 — DraftKings universal link helper.
// iOS universal links (https://sportsbook.draftkings.com/…) are routed to the
// DK native app when installed and fall back to the web sportsbook otherwise.
// The old dk:// custom scheme produced "address is invalid" errors on iOS Safari
// because the exact path formats we used aren't registered by DK's app.
//
// Hierarchy (best → most reliable):
//   1. outcome.link or bookmaker.link from the-odds-api (real DK universal link)
//   2. Sport-level league page — always valid, opens DK reliably

export interface DkLinkInput {
  dk?: {
    selectionId?: string | null;
    eventId?: string | null;
    deepLink?: string | null;
  } | null;
  sport?: "mlb" | "nhl" | "nba";
  /** market_type field — used to detect prop vs game-line markets */
  marketType?: string | null;
}

const DK_BASE = "https://sportsbook.draftkings.com";

const SPORT_PATHS: Record<string, string> = {
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
  nba: "basketball/nba",
};

/** Returns true when a market type string represents a player-prop market. */
export function isPropMarket(marketType: string | null | undefined): boolean {
  if (!marketType) return false;
  return marketType.startsWith("batter_") || marketType.startsWith("pitcher_");
}

/**
 * Resolve the best available DraftKings universal link for a pick.
 *
 * Rule 1: If pick.dk.deepLink is already a valid https://sportsbook.draftkings.com URL, use it.
 * Rule 2: Otherwise fall back to the sport-level league page (with props query param when applicable).
 *
 * Every returned URL starts with https://sportsbook.draftkings.com/ — no dk:// scheme.
 */
export function pickToDkLink(pick: DkLinkInput): string {
  // Rule 1: use the API-supplied deepLink if it's already a valid DK https URL.
  if (pick.dk?.deepLink?.startsWith(`${DK_BASE}/`)) {
    return pick.dk.deepLink;
  }

  // Rule 2: fall back to sport-level league page.
  const path = SPORT_PATHS[pick.sport ?? "mlb"] ?? SPORT_PATHS.mlb;
  const propsSuffix = isPropMarket(pick.marketType)
    ? "?category=odds&subcategory=player-props"
    : "";
  return `${DK_BASE}/leagues/${path}${propsSuffix}`;
}
