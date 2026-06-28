// Baseball Savant CSV adapter (v6.13.1) — supplies the real Statcast inputs the
// Hatfield rules need (Rules 1-3): xERA, xBA-allowed, barrel%, sweet-spot%, BB%.
// The api-sports baseball plan does NOT expose true Statcast metrics, so without
// this feed Rules 1-3 degrade to league-average / no-op. Savant's public CSV
// leaderboards require no auth.
//
// All functions are best-effort and NEVER throw: any HTTP error, timeout, or
// malformed CSV degrades to an empty Map / null profile, so the slate is never
// blocked and the model simply falls back to its v6.13.0 no-op behavior.
//
// Verified live endpoints/columns (2026-06-28):
//  - expected_statistics: player_id, est_ba (xBA), era, xera
//  - statcast:            player_id, brl_percent (barrel%), anglesweetspotpercent
//  - custom (BB%):        player_id, bb_percent (selections pa,walk,k_percent,bb_percent)
//
// NOTE on the custom leaderboard `min`: min=q returns only ~58 rows (its
// qualified threshold is far stricter than the other boards' ~366), which omits
// most starters. We use min=1 (≈800 rows, all pitchers incl. relievers) so every
// starter we look up by id has a BB%. Lookups are by player_id, so the extra
// relievers are harmless.

import type { StarterStatcast } from "../sports/mlb/hatfieldRules";

const SAVANT_BASE = "https://baseballsavant.mlb.com";
const UA = "EE-Sports-Jarvis/6.13.1";
const TIMEOUT_MS = 30_000;
const RETRIES = 2;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — Savant updates at most daily.

function currentSeason(): number {
  return new Date().getUTCFullYear();
}

function num(v: string | undefined | null): number | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ── RFC 4180 CSV parser (quoted-field + embedded-comma + BOM safe) ──────────
// Savant's first column header is the quoted "last_name, first_name" (a quoted
// field containing a comma), so a naive split would corrupt every column. This
// returns an array of records keyed by header name.
export function parseCsv(text: string): Record<string, string>[] {
  // Strip a leading UTF-8 BOM if present.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // Handle CRLF and lone CR/LF; only close the row on a real line end.
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Flush the trailing field/row if the file didn't end with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0].trim() === "") continue; // skip blank line
    const rec: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) rec[header[c]] = cells[c] ?? "";
    out.push(rec);
  }
  return out;
}

// Fetch a CSV URL as text. Built-in fetch, browser-ish UA, 30s timeout, up to
// RETRIES retries with exponential backoff. Never throws — returns null on any
// failure or non-200.
async function fetchCsv(url: string): Promise<string | null> {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/csv,*/*" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 200) {
        const text = await res.text();
        return text;
      }
      // Retry transient 429/5xx; bail on other 4xx.
      if (res.status !== 429 && res.status < 500) return null;
    } catch {
      clearTimeout(timer);
    }
    if (attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4000)));
    }
  }
  return null;
}

// ── Expected statistics leaderboard (xBA / ERA / xERA) ──────────────────────
export interface ExpectedStats {
  playerId: number;
  xba: number | null;
  era: number | null;
  xera: number | null;
}

export async function fetchSavantExpectedStats(
  year: number = currentSeason(),
): Promise<Map<number, ExpectedStats>> {
  const url = `${SAVANT_BASE}/leaderboard/expected_statistics?type=pitcher&year=${year}&min=q&csv=true`;
  const text = await fetchCsv(url);
  const map = new Map<number, ExpectedStats>();
  if (!text) return map;
  try {
    for (const rec of parseCsv(text)) {
      const pid = num(rec["player_id"]);
      if (pid === null) continue;
      map.set(pid, {
        playerId: pid,
        xba: num(rec["est_ba"]),
        era: num(rec["era"]),
        xera: num(rec["xera"]),
      });
    }
  } catch {
    return new Map();
  }
  return map;
}

// ── Statcast leaderboard (barrel% / sweet-spot%) ────────────────────────────
export interface BarrelStats {
  playerId: number;
  barrelRatePct: number | null;
  sweetSpotPct: number | null;
}

export async function fetchSavantBarrels(
  year: number = currentSeason(),
): Promise<Map<number, BarrelStats>> {
  const url = `${SAVANT_BASE}/leaderboard/statcast?type=pitcher&year=${year}&min=q&csv=true`;
  const text = await fetchCsv(url);
  const map = new Map<number, BarrelStats>();
  if (!text) return map;
  try {
    for (const rec of parseCsv(text)) {
      const pid = num(rec["player_id"]);
      if (pid === null) continue;
      map.set(pid, {
        playerId: pid,
        barrelRatePct: num(rec["brl_percent"]),
        sweetSpotPct: num(rec["anglesweetspotpercent"]),
      });
    }
  } catch {
    return new Map();
  }
  return map;
}

// ── Custom leaderboard (walk rate) ──────────────────────────────────────────
export interface WalkStats {
  playerId: number;
  bbPct: number | null;
}

export async function fetchSavantWalkRates(
  year: number = currentSeason(),
): Promise<Map<number, WalkStats>> {
  const url = `${SAVANT_BASE}/leaderboard/custom?year=${year}&type=pitcher&filter=&min=1&selections=pa,walk,k_percent,bb_percent&csv=true`;
  const text = await fetchCsv(url);
  const map = new Map<number, WalkStats>();
  if (!text) return map;
  try {
    for (const rec of parseCsv(text)) {
      const pid = num(rec["player_id"]);
      if (pid === null) continue;
      map.set(pid, { playerId: pid, bbPct: num(rec["bb_percent"]) });
    }
  } catch {
    return new Map();
  }
  return map;
}

// ── Per-season merged Statcast tables (24h cached) ──────────────────────────
export interface SeasonTables {
  expected: Map<number, ExpectedStats>;
  barrels: Map<number, BarrelStats>;
  walks: Map<number, WalkStats>;
}

const seasonCache = new Map<number, { at: number; tables: Promise<SeasonTables> }>();

async function loadSeasonTables(year: number): Promise<SeasonTables> {
  const [expected, barrels, walks] = await Promise.all([
    fetchSavantExpectedStats(year),
    fetchSavantBarrels(year),
    fetchSavantWalkRates(year),
  ]);
  return { expected, barrels, walks };
}

function seasonTables(year: number): Promise<SeasonTables> {
  const hit = seasonCache.get(year);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tables;
  const tables = loadSeasonTables(year);
  seasonCache.set(year, { at: Date.now(), tables });
  return tables;
}

// Force a refresh of the season tables (used by the daily refresh job + boot).
export async function refreshSeasonTables(year: number = currentSeason()): Promise<SeasonTables> {
  const tables = loadSeasonTables(year);
  seasonCache.set(year, { at: Date.now(), tables });
  return tables;
}

// Clear the in-process cache (test hook).
export function _clearSavantCache(): void {
  seasonCache.clear();
}

// ── Merged per-pitcher profile ──────────────────────────────────────────────
// Combines the three leaderboards into the StarterStatcast shape the model
// consumes. Returns null when the pitcher isn't found in any table (no Statcast
// row → model falls back to league average / no-op, exactly as v6.13.0).
export async function fetchSavantPitcherProfile(
  playerId: number | null | undefined,
  year: number = currentSeason(),
): Promise<StarterStatcast | null> {
  if (!playerId) return null;
  const { expected, barrels, walks } = await seasonTables(year);
  const e = expected.get(playerId);
  const b = barrels.get(playerId);
  const w = walks.get(playerId);
  if (!e && !b && !w) return null;
  return {
    era: e?.era ?? null,
    xera: e?.xera ?? null,
    xbaAllowed: e?.xba ?? null,
    barrelRatePct: b?.barrelRatePct ?? null,
    sweetSpotPct: b?.sweetSpotPct ?? null,
    bbPct: w?.bbPct ?? null,
  };
}

// Cached convenience wrapper (the season tables are themselves cached, so this
// just resolves against them). Name kept distinct for call-site clarity.
export async function getCachedSavantProfile(
  playerId: number | null | undefined,
  year: number = currentSeason(),
): Promise<StarterStatcast | null> {
  return fetchSavantPitcherProfile(playerId, year);
}
