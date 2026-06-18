// Spoken-English helpers for the Sharp Desk audio brief. These produce fully
// humanized words at brief-build time so the script never carries a digit,
// symbol, or stat acronym into the voice. The on-screen cards keep their
// compact forms ("5.38pp", "1.5u", "FIP"); only the audio is spelled out.

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

// Plain cardinal-to-words, e.g. 375 → "three hundred seventy-five".
export function intToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return "zero";
  const parts: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  if (millions > 0) {
    parts.push(`${intToWords(millions)} million`);
    n %= 1_000_000;
  }
  const thousands = Math.floor(n / 1000);
  if (thousands > 0) {
    parts.push(`${intToWords(thousands)} thousand`);
    n %= 1000;
  }
  const hundreds = Math.floor(n / 100);
  if (hundreds > 0) {
    parts.push(`${ONES[hundreds]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    parts.push(o === 0 ? TENS[t] : `${TENS[t]}-${ONES[o]}`);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(" ");
}

// A decimal value spoken naturally: 51.2 → "fifty-one point two",
// 7.8 → "seven point eight", 14 → "fourteen". Trailing-zero decimals collapse
// (7.0 → "seven"). Digits after the point are read individually.
export function spellNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const neg = n < 0;
  const abs = Math.abs(n);
  const intPart = Math.floor(abs);
  // Round to one decimal for spoken precision, then strip a trailing zero.
  const rounded = Math.round(abs * 10) / 10;
  const decDigit = Math.round((rounded - Math.floor(rounded)) * 10);
  let words = intToWords(Math.floor(rounded));
  if (decDigit > 0) words += ` point ${ONES[decDigit]}`;
  void intPart;
  return neg ? `minus ${words}` : words;
}

// American odds spoken as grouped words: +110 → "plus one ten",
// -180 → "minus one eighty", -105 → "minus one oh five",
// +1400 → "plus fourteen hundred", -150 → "minus one fifty".
export function spellMoneyLine(ml: number | null): string {
  if (ml === null || !Number.isFinite(ml)) return "even money";
  const sign = ml < 0 ? "minus" : "plus";
  const mag = Math.abs(Math.round(ml));
  return `${sign} ${spellLineMagnitude(mag)}`;
}

function spellLineMagnitude(mag: number): string {
  if (mag < 100) return intToWords(mag);
  if (mag >= 1000) {
    // 1400 → "fourteen hundred", 2000 → "twenty hundred" reads odd, so fall
    // back to plain words at/above 2000; gambling lines rarely exceed +1500.
    const hundredsTotal = Math.round(mag / 100);
    if (mag % 100 === 0 && hundredsTotal < 100) return `${intToWords(hundredsTotal)} hundred`;
    return intToWords(mag);
  }
  const hundreds = Math.floor(mag / 100);
  const rest = mag % 100;
  const head = ONES[hundreds] ?? intToWords(hundreds);
  if (rest === 0) return `${head} hundred`;
  if (rest < 10) return `${head} oh ${ONES[rest]}`; // 105 → "one oh five"
  if (rest < 20) return `${head} ${ONES[rest]}`;
  const t = Math.floor(rest / 10);
  const o = rest % 10;
  const tail = o === 0 ? TENS[t] : `${TENS[t]} ${ONES[o]}`;
  return `${head} ${tail}`;
}

// A percentage value spoken naturally: 51.2 → "fifty-one point two percent",
// 5.4 → "five point four percent", 60 → "sixty percent". One-decimal precision.
export function spellPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "an unknown percent";
  return `${spellNumber(value)} percent`;
}

// Unit size spoken naturally: 1.5 → "one and a half units", 1 → "one unit",
// 3 → "three units", 2.5 → "two and a half units".
export function spellUnits(u: number | null): string {
  if (u === null || !Number.isFinite(u)) return "no units";
  const whole = Math.floor(u);
  const isHalf = Math.abs(u - whole - 0.5) < 0.001;
  if (isHalf) {
    const base = whole === 0 ? "half a" : `${intToWords(whole)} and a half`;
    return `${base} units`;
  }
  const rounded = Math.round(u);
  return rounded === 1 ? "one unit" : `${intToWords(rounded)} units`;
}

// Dollar amount spoken naturally: 375 → "three hundred seventy-five dollars".
export function spellDollars(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "no dollars";
  const dollars = Math.round(n);
  return dollars === 1 ? "one dollar" : `${intToWords(dollars)} dollars`;
}

// Stat acronyms → fully spelled spoken forms. NO "that's X" wrapper — these
// drop straight into a sentence so the brief reads as natural prose. Sport
// codes (NHL/NBA/MLB/WC) keep their letters and are intentionally absent.
export const ACRONYM_SPOKEN: Record<string, string> = {
  // MLB
  FIP: "fielding independent pitching",
  xFIP: "expected fielding independent pitching",
  wOBA: "weighted on-base average",
  ERA: "earned run average",
  "ERA+": "park-adjusted earned run average",
  "BB/9": "walks per nine innings",
  "K/9": "strikeouts per nine innings",
  BABIP: "batting average on balls in play",
  ISO: "isolated power",
  SIERA: "skill-interactive earned run average",
  SP: "starting pitcher",
  IP: "innings pitched",
  // NHL
  "SV%": "save percentage",
  GAA: "goals against average",
  "xGF%": "expected goals for percentage",
  HDCF: "high danger chances for",
  // NBA
  ORtg: "offensive rating",
  DRtg: "defensive rating",
  "eFG%": "effective field goal percentage",
  "TS%": "true shooting percentage",
  "USG%": "usage rate",
  NetRtg: "net rating",
  // Advanced metrics
  xG: "expected goals",
  xGA: "expected goals against",
  PPDA: "passes per defensive action",
  // Betting shorthand
  ML: "money line",
  "O/U": "over under",
  AH: "asian handicap",
  CLV: "closing line value",
  EV: "expected value",
  ROI: "return on investment",
  pp: "percent",
  WC: "World Cup",
};

// Replace any known acronym (whole-token) with its spoken form. Unlike the old
// first-mention expander this spells EVERY occurrence and never injects extra
// commas, so the driver list reads cleanly aloud.
export function spellAcronym(text: string): string {
  const keys = Object.keys(ACRONYM_SPOKEN).sort((a, b) => b.length - a.length);
  const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![A-Za-z0-9])(${escaped.join("|")})(?![A-Za-z0-9])`, "g");
  return text.replace(pattern, (m) => ACRONYM_SPOKEN[m] ?? m);
}
