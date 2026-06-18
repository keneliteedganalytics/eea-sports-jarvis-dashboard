// Polymarket adapter — fetches prediction-market win probability for a game's
// pick side. Uses the public Gamma API (no auth).
//
// Design (rebuilt 2026-06-08): the reliable source of game-level markets is the
// Gamma *events* endpoint, not /markets?q=. Each game is one event whose
// top-level (moneyline / match-winner) market carries `outcomes` =
// ["<TeamA>", "<TeamB>"] and `outcomePrices` = ["0.55","0.45"]. Event slugs
// follow `<league>-<away>-<home>-<YYYY-MM-DD>` (mlb/nhl/nba) or
// `fifwc-<away>-<home>-<date>` for the 2026 World Cup.
//
// Matching strategy, in order:
//   1. Fetch the sport-tagged event list (cached, 15-min TTL).
//   2. Keep events whose endDate falls inside a ±36h window around the game.
//   3. Fuzzy-match both team names against the event title + ML outcome labels
//      (full names, nicknames, abbreviations, country names).
//   4. Read the pick side's price off the matched ML market.
//
// On any miss we return an explicit { found:false, reason } so the UI can render
// an honest label ("No market" / "data unavailable") rather than a blank bar.

import { getJson } from "./http";

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15-min TTL per PRD
const POLY_TIMEOUT_MS = 8000;        // 8s hard cap with graceful fallback

export type PolySport = "mlb" | "nhl" | "nba";

export interface PolymarketResult {
  found: boolean;
  pct: number | null;       // 0-100 win prob for the pick side, null when not found
  reason?: string;           // human-readable reason when found=false
  title?: string | null;     // matched market title (debug / UI tooltip)
}

// Raw Gamma shapes (only the fields we use).
export interface GammaMarket {
  question?: string;
  slug?: string;
  outcomePrices?: string;   // JSON-encoded string array e.g. '["0.56","0.44"]'
  outcomes?: string;        // JSON-encoded string array e.g. '["Yankees","Guardians"]'
  active?: boolean;
  closed?: boolean;
  endDate?: string;
}
export interface GammaEvent {
  id?: string;
  slug?: string;
  ticker?: string;
  title?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  markets?: GammaMarket[];
}

// Polymarket tag slug per sport.
const TAG_SLUG: Record<PolySport, string> = {
  mlb: "mlb",
  nhl: "nhl",
  nba: "nba",
};

// ── in-memory cache of sport event lists ────────────────────────────
interface CacheEntry { at: number; events: GammaEvent[]; }
const cache = new Map<PolySport, CacheEntry>();

// Exposed for tests: clear the event-list cache.
export function __clearPolymarketCache(): void {
  cache.clear();
}

// Exposed for tests: seed the cache directly with fixture events (bypasses HTTP).
export function __seedPolymarketCache(sport: PolySport, events: GammaEvent[]): void {
  cache.set(sport, { at: Date.now(), events });
}

async function fetchSportEvents(sport: PolySport): Promise<GammaEvent[] | null> {
  const cached = cache.get(sport);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.events;

  const res = await getJson<GammaEvent[]>(
    `${GAMMA_BASE}/events`,
    { closed: "false", limit: "200", order: "startDate", ascending: "true", tag_slug: TAG_SLUG[sport] },
  );
  if (!res.ok || !Array.isArray(res.data)) {
    // keep stale cache usable on transient failure
    return cached?.events ?? null;
  }
  cache.set(sport, { at: Date.now(), events: res.data });
  return res.data;
}

// ── team-name normalisation / fuzzy matching ────────────────────────

// Strip accents, lowercase, drop punctuation → token set for fuzzy compares.
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Common league suffixes / generic tokens that don't help disambiguate.
const STOPWORDS = new Set([
  "fc", "sc", "cf", "afc", "sk", "cd", "ec", "club", "the", "of", "and",
  "republic", "ir", "dr", "united", "city",
]);

// Country aliases so World Cup country names match across sources.
const COUNTRY_ALIASES: Record<string, string[]> = {
  "united states": ["usa", "united states", "us", "usmnt"],
  "korea republic": ["south korea", "korea republic", "korea", "kor"],
  "ir iran": ["iran"],
  "cote d ivoire": ["ivory coast", "cote d ivoire"],
  "czechia": ["czech republic", "czechia"],
  "turkiye": ["turkey", "turkiye"],
  "bosnia and herzegovina": ["bosnia", "bosnia and herzegovina"],
  "cabo verde": ["cape verde", "cabo verde"],
  "curacao": ["curacao"],
  "dr congo": ["congo dr", "dr congo", "democratic republic of congo"],
};

// Produce a set of significant tokens for a team / country name.
function tokens(name: string): Set<string> {
  const norm = normalize(name);
  const out = new Set<string>();
  for (const t of norm.split(" ")) {
    if (t && !STOPWORDS.has(t)) out.add(t);
  }
  // include the last word (nickname) explicitly even if it's short
  const parts = norm.split(" ").filter(Boolean);
  if (parts.length) out.add(parts[parts.length - 1]);
  // country aliases
  for (const [canon, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (norm === canon || aliases.includes(norm)) {
      for (const a of aliases) for (const w of a.split(" ")) if (w) out.add(w);
      for (const w of canon.split(" ")) if (w) out.add(w);
    }
  }
  return out;
}

// Does a team name match a candidate label/title? True when the candidate text
// contains any significant token of the team name (nickname, city, country).
function nameMatchesText(teamName: string, text: string): boolean {
  const normText = normalize(text);
  const tks = tokens(teamName);
  for (const t of tks) {
    if (t.length < 3) continue;
    // word-boundary-ish containment
    if (normText.includes(t)) return true;
  }
  return false;
}

// Pull a YYYY-MM-DD out of an event slug (the real game date) if present.
function dateFromSlug(slug: string | undefined): string | null {
  if (!slug) return null;
  const m = slug.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function parseStrArray(s: string | undefined): string[] | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

// Find the moneyline / match-winner market in an event: the one whose outcomes
// are the two team labels (not Over/Under, not a spread).
function findMlMarket(ev: GammaEvent, homeTeam: string, awayTeam: string): GammaMarket | null {
  const markets = ev.markets ?? [];
  for (const m of markets) {
    if (m.closed) continue;
    const labels = parseStrArray(m.outcomes);
    if (!labels || labels.length < 2) continue;
    const lower = labels.map((l) => l.toLowerCase());
    // skip O/U and yes/no style markets
    if (lower.some((l) => l === "over" || l === "under" || l === "yes" || l === "no")) continue;
    const homeHit = labels.some((l) => nameMatchesText(homeTeam, l));
    const awayHit = labels.some((l) => nameMatchesText(awayTeam, l));
    if (homeHit && awayHit) return m;
  }
  return null;
}

// Resolve the pick-side win probability from an event, handling two shapes:
//   A. Two-outcome ML market: outcomes ["TeamA","TeamB"], prices ["0.55","0.45"].
//   B. Per-team Yes/No markets: "Will <Team> win on <date>?" with
//      outcomes ["Yes","No"]. We read the Yes price for the pick team.
function resolvePickProb(
  ev: GammaEvent,
  homeTeam: string,
  awayTeam: string,
  pickSide: "home" | "away",
): number | null {
  const target = pickSide === "home" ? homeTeam : awayTeam;

  // Shape A — two-team ML market.
  const ml = findMlMarket(ev, homeTeam, awayTeam);
  if (ml) {
    const labels = parseStrArray(ml.outcomes);
    const prices = parseStrArray(ml.outcomePrices);
    if (labels && prices && labels.length === prices.length) {
      for (let i = 0; i < labels.length; i++) {
        if (nameMatchesText(target, labels[i])) {
          const p = parseFloat(prices[i]);
          if (Number.isFinite(p)) return p;
        }
      }
    }
  }

  // Shape B — "Will <Team> win" Yes/No markets.
  for (const m of ev.markets ?? []) {
    if (m.closed) continue;
    const q = (m.question ?? "").toLowerCase();
    if (!q.includes("win")) continue;
    if (q.includes("draw")) continue;
    if (!nameMatchesText(target, m.question ?? "")) continue;
    const labels = parseStrArray(m.outcomes);
    const prices = parseStrArray(m.outcomePrices);
    if (!labels || !prices || labels.length !== prices.length) continue;
    const yesIdx = labels.findIndex((l) => l.toLowerCase() === "yes");
    if (yesIdx >= 0) {
      const p = parseFloat(prices[yesIdx]);
      if (Number.isFinite(p)) return p;
    }
  }
  return null;
}

// True if the event carries any market that can price this matchup.
function hasUsableMarket(ev: GammaEvent, homeTeam: string, awayTeam: string): boolean {
  if (findMlMarket(ev, homeTeam, awayTeam)) return true;
  for (const m of ev.markets ?? []) {
    const q = (m.question ?? "").toLowerCase();
    if (q.includes("win") && (nameMatchesText(homeTeam, m.question ?? "") || nameMatchesText(awayTeam, m.question ?? ""))) {
      return true;
    }
  }
  return false;
}

// Match an event to (home, away, date). Date match uses a ±36h window on the
// event's endDate vs the game date (games settle the following UTC day).
function eventMatches(
  ev: GammaEvent,
  homeTeam: string,
  awayTeam: string,
  gameDateIso: string,
): boolean {
  if (ev.closed) return false;
  // skip prop / season-long / "more markets" style events
  const slug = (ev.slug ?? "").toLowerCase();
  if (slug.includes("more-markets") || slug.includes("halftime") || slug.includes("exact-score")) return false;

  // Date match: prefer the date embedded in the slug (the real game date);
  // the event endDate is often a far-future resolution timestamp.
  const slugDate = dateFromSlug(slug);
  if (slugDate) {
    if (slugDate !== gameDateIso) {
      // allow ±1 day for ET/UTC boundary differences
      const a = new Date(slugDate + "T12:00:00Z").getTime();
      const b = new Date(gameDateIso + "T12:00:00Z").getTime();
      if (Math.abs(a - b) > 36 * 3_600_000) return false;
    }
  } else if (ev.endDate) {
    const end = new Date(ev.endDate).getTime();
    const game = new Date(gameDateIso + "T12:00:00Z").getTime();
    if (Number.isFinite(end)) {
      const diffH = Math.abs(end - game) / 3_600_000;
      if (diffH > 48) return false;
    }
  }

  const text = `${ev.title ?? ""} ${slug}`;
  const titleHome = nameMatchesText(homeTeam, text);
  const titleAway = nameMatchesText(awayTeam, text);
  if (titleHome && titleAway) return true;
  // Otherwise check the market outcomes (handles slug-only abbreviations).
  return hasUsableMarket(ev, homeTeam, awayTeam);
}

// Core matcher — given a sport's event list, find the best ML market + pick price.
export function matchEvent(
  events: GammaEvent[],
  homeTeam: string,
  awayTeam: string,
  gameDateIso: string,
  pickSide: "home" | "away",
): PolymarketResult {
  const candidates = events.filter((ev) => eventMatches(ev, homeTeam, awayTeam, gameDateIso));
  if (candidates.length === 0) {
    return { found: false, pct: null, reason: "no market" };
  }
  // Prefer the candidate that can price the pick side.
  for (const ev of candidates) {
    const prob = resolvePickProb(ev, homeTeam, awayTeam, pickSide);
    if (prob !== null && prob > 0 && prob < 1) {
      return {
        found: true,
        pct: Math.round(prob * 1000) / 10, // 0.56 → 56.0
        title: ev.title ?? null,
      };
    }
  }
  return { found: false, pct: null, reason: "pick side not priced", title: candidates[0].title ?? null };
}

// Public entry point. Failure (timeout / network / 4xx) is non-fatal and returns
// found:false with a reason, so the slate never blanks the PRISM bar.
export async function fetchPolymarketForGame(
  homeTeamFull: string,
  awayTeamFull: string,
  gameDateIso: string,   // YYYY-MM-DD (operating day)
  pickSide: "home" | "away",
  sport: PolySport = "mlb",
): Promise<PolymarketResult> {
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, POLY_TIMEOUT_MS);
  try {
    const events = await fetchSportEvents(sport);
    clearTimeout(timer);
    if (timedOut) return { found: false, pct: null, reason: "polymarket timeout" };
    if (!events) return { found: false, pct: null, reason: "polymarket data unavailable" };
    return matchEvent(events, homeTeamFull, awayTeamFull, gameDateIso, pickSide);
  } catch (e) {
    clearTimeout(timer);
    return {
      found: false,
      pct: null,
      reason: e instanceof Error ? `polymarket error: ${e.message}` : "polymarket error",
    };
  }
}
