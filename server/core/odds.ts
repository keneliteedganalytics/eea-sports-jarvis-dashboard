// Odds math — ported from sports-engine core/odds.py + sports/mlb/odds_math.py
// American <-> decimal <-> prob, Shin de-vig (brentq solver), additive de-vig, consensus.

export const TRUSTED_BOOKS = [
  "draftkings",
  "fanduel",
  "betmgm",
  "caesars",
  "pointsbetus",
  "betrivers",
  "wynnbet",
  "barstool",
  // §9.10 — props books stubbed in for v2
  "prizepicks",
  "underdog",
];

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

// 3-way additive devig for soccer Home/Draw/Away markets.
// Shin (1991) is designed for 2-outcome markets; for 3-way we use additive:
// each raw implied probability is divided by the total overround.
export interface ThreeWayFair {
  home: number;
  draw: number;
  away: number;
  overround: number;
}

export function devigThreeWay(
  homeOdds: number,
  drawOdds: number,
  awayOdds: number,
): ThreeWayFair {
  const ph = americanToProb(homeOdds) ?? 0;
  const pd = americanToProb(drawOdds) ?? 0;
  const pa = americanToProb(awayOdds) ?? 0;
  const overround = ph + pd + pa; // typically 1.04-1.08
  if (overround <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3, overround: 1 };
  return {
    home: ph / overround,
    draw: pd / overround,
    away: pa / overround,
    overround,
  };
}

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

  for (const bk of bookmakers) {
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
      const hold = ph + pa - 1.0;
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
