// Pillar 4 (v6.9.0, v1) — pitch-mix matchup adjustment. A hitter who crushes
// sliders facing a slider-heavy pitcher is a real edge the season line misses.
// We pull pitcher arsenals (usage % by pitch type) and hitter wOBA-by-pitch-type
// from Baseball Savant CSV leaderboards (cached 24h, best-effort), then compute a
// weighted matchup delta: Σ (hitter wOBA vs pitch X − hitter overall wOBA) ×
// (pitcher usage of X). The delta is applied DAMPENED (×0.5) to the projection
// mean for strikeout + total-base props, because v1 arsenals are coarse.
//
// Savant URLs are validated defensively; any parse/shape failure is a no-op
// (returns delta 0). No fabricated arsenals.

const SAVANT = "https://baseballsavant.mlb.com/leaderboard";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const HTTP_TIMEOUT_MS = 12000;

// v1 dampener: arsenals are coarse, so only half the modeled delta is applied.
export const PITCH_MIX_DAMPENER = 0.5;

// Savant arsenal usage columns → canonical pitch type.
const USAGE_COLS: Record<string, string> = {
  n_ff: "FF", n_si: "SI", n_fc: "FC", n_sl: "SL", n_ch: "CH",
  n_cu: "CU", n_fs: "FS", n_kn: "KN", n_st: "ST", n_sv: "SV",
};

export interface PitcherArsenal {
  playerId: number;
  usage: Record<string, number>; // pitch type → fraction (sums ≈ 1)
}

export interface HitterPitchValues {
  playerId: number;
  overallWoba: number | null;
  wobaByPitch: Record<string, number>; // pitch type → wOBA vs that pitch
}

// Pure core: the matchup delta for a hitter vs a pitcher. Σ over the pitcher's
// arsenal of (hitter wOBA vs pitch − hitter overall) × usage. Returns 0 when we
// can't pair any pitch type (no fabrication). Exported for tests.
export function pitchMixDelta(
  arsenal: PitcherArsenal | null,
  hitter: HitterPitchValues | null,
): number {
  if (!arsenal || !hitter || hitter.overallWoba === null) return 0;
  let delta = 0;
  let usedUsage = 0;
  for (const [pt, usage] of Object.entries(arsenal.usage)) {
    const vs = hitter.wobaByPitch[pt];
    if (typeof vs === "number" && usage > 0) {
      delta += (vs - hitter.overallWoba) * usage;
      usedUsage += usage;
    }
  }
  if (usedUsage <= 0) return 0;
  // Normalize by the usage we could actually pair so partial arsenals aren't
  // diluted toward zero.
  return Math.round((delta / usedUsage) * 10000) / 10000;
}

// Dampened delta actually applied to a prop projection mean (v1 ×0.5).
export function pitchMixAdjustment(
  arsenal: PitcherArsenal | null,
  hitter: HitterPitchValues | null,
): number {
  return Math.round(pitchMixDelta(arsenal, hitter) * PITCH_MIX_DAMPENER * 10000) / 10000;
}

// ── CSV fetch (best-effort) ─────────────────────────────────────────────────

async function fetchText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "eea-sports-jarvis/1.0" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status !== 200) return null;
    return await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// Minimal CSV parser: handles quoted fields with embedded commas. Returns rows
// as objects keyed by the header row. Defensive — empty input → [].
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j] ?? "";
    out.push(row);
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur); cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function season(): number {
  return new Date().getUTCFullYear();
}

interface CacheEntry<T> { at: number; value: T; }
let arsenalCache: CacheEntry<Map<number, PitcherArsenal>> | null = null;

// Fetch + parse all pitcher arsenals for the season. Cached 24h. Empty map on
// any failure so callers degrade to a 0 delta.
export async function fetchPitcherArsenals(): Promise<Map<number, PitcherArsenal>> {
  if (arsenalCache && Date.now() - arsenalCache.at < CACHE_TTL_MS) return arsenalCache.value;
  const url = `${SAVANT}/pitch-arsenals?year=${season()}&min=100&type=n_&csv=true`;
  const text = await fetchText(url);
  const map = new Map<number, PitcherArsenal>();
  if (text) {
    for (const row of parseCsv(text)) {
      const id = num(row["player_id"] ?? row["pitcher"]);
      if (id === null) continue;
      const usage: Record<string, number> = {};
      for (const [col, pt] of Object.entries(USAGE_COLS)) {
        const pct = num(row[col]);
        if (pct !== null && pct > 0) usage[pt] = pct / 100; // Savant reports %.
      }
      if (Object.keys(usage).length > 0) map.set(id, { playerId: id, usage });
    }
  }
  arsenalCache = { at: Date.now(), value: map };
  return map;
}

export function _resetPitchMixCache(): void {
  arsenalCache = null;
}
