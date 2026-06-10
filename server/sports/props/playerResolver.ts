// Player-name → MLB Stats playerId resolver (v6.7.2). The Odds API delivers prop
// offers with only player NAMES (no IDs), so every offer lands in prop_offers with
// player_id = null. The prop simulator's profile fetchers short-circuit on a null
// id, so without this resolver no offer ever yields a profile and zero picks are
// written. This maps a name to the numeric MLB Stats id via the public
// people/search endpoint, with an in-memory cache keyed by a normalized name.
//
// Best-effort: any network failure or empty result returns null and the caller
// skips the prop (no fabricated ids).

import { getJson } from "../../adapters/http";

const BASE = "https://statsapi.mlb.com/api/v1";

// Normalize a display name for cache-keying and lookup: lowercase, strip
// diacritics, drop generational suffixes (Jr./Sr./II/III/IV), strip punctuation,
// and collapse whitespace. "José Ramírez Jr." → "jose ramirez".
export function normalizePlayerName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritic marks
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\.?\b/g, "") // generational suffixes
    .replace(/[.,'’]/g, "") // punctuation (apostrophes, periods, commas)
    .replace(/\s+/g, " ")
    .trim();
}

interface PeopleSearchResult {
  people?: Array<{ id?: number; fullName?: string }>;
}

// Normalized-name → resolved id (or null when a prior lookup came back empty, so
// we don't re-hit the API for a name the search can't resolve).
const cache = new Map<string, number | null>();

// Resolve a player name to an MLB Stats numeric id. Returns null on no match /
// failure. Cached per normalized name for the life of the process.
export async function resolveMlbPlayerId(name: string): Promise<number | null> {
  const key = normalizePlayerName(name);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;

  const res = await getJson<PeopleSearchResult>(`${BASE}/people/search`, {
    names: name,
    sportId: 1,
  });
  let id: number | null = null;
  if (res.ok && res.data?.people && res.data.people.length > 0) {
    // Prefer an exact normalized-name match; fall back to the first result.
    const exact = res.data.people.find(
      (p) => p.fullName && normalizePlayerName(p.fullName) === key,
    );
    const chosen = exact ?? res.data.people[0];
    id = typeof chosen.id === "number" ? chosen.id : null;
  }
  cache.set(key, id);
  return id;
}

// Test-only: reset the in-memory cache so cache-behavior tests start clean.
export function _clearResolverCache(): void {
  cache.clear();
}
