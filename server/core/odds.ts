// Odds math — ported from sports-engine core/odds.py + sports/mlb/odds_math.py
// American <-> decimal <-> prob, Shin de-vig (brentq solver), additive de-vig, consensus.

// v6.14.0: TRUSTED_BOOKS is the h2h/spreads/totals consensus set — real
// sportsbooks only. PrizePicks and Underdog are DFS/props operators; their
// "quotes" are not true two-way sportsbook prices and, when treated as h2h,
// produce garbage (−1 juice, +3300 on a mid-market ML, Over 5.5 totals) that
// manufactures phantom edges. They are ingested separately via PROPS_ONLY_BOOKS
// for the player-props surface only, never for game-line consensus.
export const TRUSTED_BOOKS = [
  "draftkings",
  "fanduel",
  "betmgm",
  "caesars",
  "pointsbetus",
  "betrivers",
  "wynnbet",
  "barstool",
];

// DFS / player-props operators — props surface only, never game-line consensus.
export const PROPS_ONLY_BOOKS = ["prizepicks", "underdog"];

// v6.14.0: a trusted-book h2h quote whose two-way implied vig lands outside this
// band is structurally broken (missing/placeholder side, DFS payout, etc.) and
// is dropped from the consensus median. Wider than the per-market maxHold so a
// merely-juicy-but-real book still counts.
export const BOOK_VIG_MIN = 0.95;
export const BOOK_VIG_MAX = 1.25;

// v6.14.0: consensus requires at least this many valid trusted-book quotes.
// Below quorum the market is not priceable (passReason "insufficient_book_quorum").
export const MIN_BOOK_QUORUM = 3;

// ── Conversions ───────────────────────────────────────────────────

export function americanToProb(odds: number | string | null | undefined): number | null {
  if (odds === null || odds === undefined) return null;
  const m = parseFloat(String(odds).replace("+", ""));
  if (Number.isNaN(m) || m === 0) return null;
  return m < 0 ? -m / (-m + 100.0) : 100.0 / (m + 100.0);
}

export function probToAmerican(p: number | null | undefined): number | null {
  if (p === null || p === undefined || p <= 0 || p >= 1) return null;
  if (p >= 0.5) return Math.round((-100.0 * p) / (1.0 - p));
  return Math.round((100.0 * (1.0 - p)) / p);
}

export function americanToDecimal(odds: number | string | null | undefined): number | null {
  if (odds === null || odds === undefined) return null;
  const o = parseFloat(String(odds));
  if (Number.isNaN(o) || o === 0) return null;
  return 1.0 + (o > 0 ? o / 100.0 : 100.0 / -o);
}

export function decimalToAmerican(dec: number | string | null | undefined): number | null {
  if (dec === null || dec === undefined) return null;
  const d = parseFloat(String(dec));
  if (Number.isNaN(d) || d <= 1.0) return null;
  if (d >= 2.0) return Math.round((d - 1) * 100);
  return Math.round(-100 / (d - 1));
}

// ── De-vig ────────────────────────────────────────────────────────

export function devigAdditive(
  oddsA: number,
  oddsB: number,
): [number | null, number | null, number | null] {
  const pa = americanToProb(oddsA);
  const pb = americanToProb(oddsB);
  if (pa === null || pb === null) return [null, null, null];
  const total = pa + pb;
  if (total <= 0) return [null, null, null];
  return [pa / total, pb / total, total - 1.0];
}

// Brent's method root-finder (ports scipy.optimize.brentq for the Shin residual).
function brentq(
  f: (x: number) => number,
  a: number,
  b: number,
  xtol = 1e-9,
  maxIter = 100,
): number {
  let fa = f(a);
  let fb = f(b);
  if (fa * fb > 0) throw new Error("brentq: root not bracketed");
  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }
  let c = a;
  let fc = fa;
  let mflag = true;
  let d = c;
  for (let i = 0; i < maxIter; i++) {
    if (Math.abs(b - a) < xtol) break;
    let s: number;
    if (fa !== fc && fb !== fc) {
      // inverse quadratic interpolation
      s =
        (a * fb * fc) / ((fa - fb) * (fa - fc)) +
        (b * fa * fc) / ((fb - fa) * (fb - fc)) +
        (c * fa * fb) / ((fc - fa) * (fc - fb));
    } else {
      // secant
      s = b - (fb * (b - a)) / (fb - fa);
    }
    const cond1 = !((s > (3 * a + b) / 4 && s < b) || (s < (3 * a + b) / 4 && s > b));
    const cond2 = mflag && Math.abs(s - b) >= Math.abs(b - c) / 2;
    const cond3 = !mflag && Math.abs(s - b) >= Math.abs(c - d) / 2;
    const cond4 = mflag && Math.abs(b - c) < xtol;
    const cond5 = !mflag && Math.abs(c - d) < xtol;
    if (cond1 || cond2 || cond3 || cond4 || cond5) {
      s = (a + b) / 2;
      mflag = true;
    } else {
      mflag = false;
    }
    const fs = f(s);
    d = c;
    c = b;
    fc = fb;
    if (fa * fs < 0) {
      b = s;
      fb = fs;
    } else {
      a = s;
      fa = fs;
    }
    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a];
      [fa, fb] = [fb, fa];
    }
  }
  return b;
}

// Shin (1991) multiplicative de-vig. Returns [probA, probB, z]. Falls back to additive.
export function devigShin(
  priceA: number,
  priceB: number,
): [number | null, number | null, number | null] {
  const paRaw = americanToProb(priceA);
  const pbRaw = americanToProb(priceB);
  if (paRaw === null || pbRaw === null) return [null, null, null];

  const hold = paRaw + pbRaw - 1.0;
  if (hold <= 0) return [paRaw, pbRaw, 0.0];

  const S = paRaw + pbRaw;

  const residual = (z: number): number => {
    if (z >= 1) return 1e6;
    const denom = 2.0 * (1.0 - z);
    const discA = z * z + 4.0 * (1.0 - z) * (paRaw / S);
    const discB = z * z + 4.0 * (1.0 - z) * (pbRaw / S);
    if (discA < 0 || discB < 0) return 1e6;
    return (Math.sqrt(discA) - z) / denom + (Math.sqrt(discB) - z) / denom - 1.0;
  };

  let z: number;
  try {
    z = brentq(residual, 0.0, 0.5, 1e-9);
  } catch {
    const total = paRaw + pbRaw;
    return [paRaw / total, pbRaw / total, null];
  }

  const denom = 2.0 * (1.0 - z);
  const probA = (Math.sqrt(z * z + 4 * (1 - z) * (paRaw / S)) - z) / denom;
  const probB = (Math.sqrt(z * z + 4 * (1 - z) * (pbRaw / S)) - z) / denom;
  return [probA, probB, z];
}

export interface SNHL {
  homeFairProb: number;
  awayFairProb: number;
  homeFairLine: number | null;
  awayFairLine: number | null;
  hold: number;
  z: number | null;
  method: string;
}

export function syntheticNoHoldLine(
  homePrice: number,
  awayPrice: number,
  method: "shin" | "additive" = "shin",
): SNHL | null {
  let pa: number | null;
  let pb: number | null;
  let z: number | null;
  if (method === "shin") {
    [pa, pb, z] = devigShin(homePrice, awayPrice);
  } else {
    [pa, pb] = devigAdditive(homePrice, awayPrice);
    z = null;
  }
  if (pa === null || pb === null) return null;

  const phRaw = americanToProb(homePrice);
  const paRaw = americanToProb(awayPrice);
  const hold = phRaw !== null && paRaw !== null ? phRaw + paRaw - 1.0 : 0.0;

  return {
    homeFairProb: round(pa, 5),
    awayFairProb: round(pb, 5),
    homeFairLine: probToAmerican(pa),
    awayFairLine: probToAmerican(pb),
    hold: round(hold, 4),
    z: z !== null ? round(z, 5) : null,
    method,
  };
}

// ── Consensus across books ────────────────────────────────────────

export interface Bookmaker {
  key?: string;
  title?: string;
  markets?: Array<{
    key: string;
    outcomes: Array<{ name: string; price: number }>;
  }>;
}

export interface Consensus {
  homeFairProb: number;
  awayFairProb: number;
  homeFairLine: number | null;
  awayFairLine: number | null;
  medianHold: number;
  booksCounted: number;
  method: string;
  // v6.14.0: true when booksCounted >= MIN_BOOK_QUORUM. When false the caller
  // should treat the market as unavailable (passReason "insufficient_book_quorum").
  quorumMet: boolean;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function consensusSnhl(
  bookmakers: Bookmaker[],
  homeName: string,
  awayName: string,
  method: "shin" | "additive" = "shin",
  maxHold = 0.15,
): Consensus | null {
  const homeFairs: number[] = [];
  const awayFairs: number[] = [];
  const holds: number[] = [];

  // Only real sportsbooks feed the game-line median — DFS/props operators
  // (PROPS_ONLY_BOOKS) never do, even if they appear in the raw feed.
  const propsOnly = new Set(PROPS_ONLY_BOOKS);

  for (const bk of bookmakers) {
    if (bk.key && propsOnly.has(bk.key)) continue;
    for (const mk of bk.markets ?? []) {
      if (mk.key !== "h2h") continue;
      const prices: Record<string, number> = {};
      for (const o of mk.outcomes ?? []) prices[o.name] = o.price;
      const hp = prices[homeName];
      const ap = prices[awayName];
      if (hp === undefined || ap === undefined) continue;
      const ph = americanToProb(hp);
      const pa = americanToProb(ap);
      if (ph === null || pa === null) continue;
      const vig = ph + pa; // two-way implied total (1.0 = no vig)
      // v6.14.0 book-level sanity: drop a book whose two-way vig is structurally
      // broken (a placeholder/DFS side pushes it outside [0.95, 1.25]).
      if (vig < BOOK_VIG_MIN || vig > BOOK_VIG_MAX) continue;
      const hold = vig - 1.0;
      if (hold > maxHold) continue;
      const result = syntheticNoHoldLine(hp, ap, method);
      if (result) {
        homeFairs.push(result.homeFairProb);
        awayFairs.push(result.awayFairProb);
        holds.push(result.hold);
      }
    }
  }

  if (homeFairs.length === 0) {
    if (method === "shin") {
      return consensusSnhl(bookmakers, homeName, awayName, "additive", maxHold);
    }
    return null;
  }

  const hFair = median(homeFairs);
  const aFair = median(awayFairs);
  return {
    homeFairProb: hFair,
    awayFairProb: aFair,
    homeFairLine: probToAmerican(hFair),
    awayFairLine: probToAmerican(aFair),
    medianHold: median(holds),
    booksCounted: homeFairs.length,
    method,
    quorumMet: homeFairs.length >= MIN_BOOK_QUORUM,
  };
}

export function bestPrice(
  bookmakers: Bookmaker[],
  teamName: string,
): [number | null, string | null] {
  let best: number | null = null;
  let bestBook: string | null = null;
  for (const bk of bookmakers) {
    for (const mk of bk.markets ?? []) {
      if (mk.key !== "h2h") continue;
      for (const o of mk.outcomes ?? []) {
        if (o.name === teamName && (best === null || o.price > best)) {
          best = o.price;
          bestBook = bk.title ?? bk.key ?? "?";
        }
      }
    }
  }
  return [best, bestBook];
}

export function medianPrice(bookmakers: Bookmaker[], teamName: string): number | null {
  const prices: number[] = [];
  for (const bk of bookmakers) {
    for (const mk of bk.markets ?? []) {
      if (mk.key !== "h2h") continue;
      for (const o of mk.outcomes ?? []) {
        if (o.name === teamName && o.price !== null && o.price !== undefined) {
          prices.push(Math.round(o.price));
        }
      }
    }
  }
  return prices.length ? Math.round(median(prices)) : null;
}

function round(x: number, places: number): number {
  const f = Math.pow(10, places);
  return Math.round(x * f) / f;
}
