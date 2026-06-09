// TTS sanitizer — baseball variant. Ported from horse-jarvis (number-to-words,
// money) and extended with the §11 MLB rules (ML lines, totals, F5/1H/1P, PK,
// decimal odds, tri-codes → full team names).

import { abbrToName } from "../sports/mlb/teams";

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function intToWords(n: number): string {
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

function speakMoney(raw: string): string {
  const cleaned = raw.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return raw;
  const dollars = Math.floor(n);
  const cents = Math.round((n - dollars) * 100);
  if (dollars === 0 && cents === 0) return "zero dollars";
  if (dollars === 0) return `${intToWords(cents)} cents`;
  const dWord = dollars === 1 ? "one dollar" : `${intToWords(dollars)} dollars`;
  if (cents === 0) return dWord;
  const cWord = cents === 1 ? "one cent" : `${intToWords(cents)} cents`;
  return `${dWord} and ${cWord}`;
}

// Speak an American line magnitude as grouped words: 180 → "one eighty",
// 165 → "one sixty five", 110 → "one ten", 95 → "ninety five".
function speakLineMagnitude(mag: number): string {
  if (mag < 100) return intToWords(mag);
  const hundreds = Math.floor(mag / 100);
  const rest = mag % 100;
  const head = ONES[hundreds] ?? intToWords(hundreds);
  if (rest === 0) return `${head} hundred`;
  if (rest < 10) return `${head} oh ${ONES[rest]}`; // 105 -> "one oh five"
  if (rest < 20) return `${head} ${ONES[rest]}`;
  const t = Math.floor(rest / 10);
  const o = rest % 10;
  const tail = o === 0 ? TENS[t] : `${TENS[t]} ${ONES[o]}`;
  return `${head} ${tail}`;
}

function decimalToWords(raw: string): string {
  const [intPart, decPart] = raw.split(".");
  const intWords = intToWords(Number(intPart));
  const decWords = decPart
    .split("")
    .map((d) => ONES[Number(d)])
    .join(" ");
  return `${intWords} point ${decWords}`;
}

// Speak a clock time "7:05 PM" → "seven oh five PM", "1:35" → "one thirty-five",
// "10:00" → "ten o'clock". Keeps any trailing AM/PM token.
function speakClock(h: number, m: number): string {
  const hourWord = intToWords(h);
  if (m === 0) return `${hourWord} o'clock`;
  if (m < 10) return `${hourWord} oh ${ONES[m]}`;
  const t = Math.floor(m / 10);
  const o = m % 10;
  const minWord = o === 0 ? TENS[t] : `${TENS[t]}-${ONES[o]}`;
  return `${hourWord} ${minWord}`;
}

// Speak a percent "23.5%" → "twenty-three and a half percent", "60%" → "sixty percent".
function speakPercent(intPart: string, half: boolean): string {
  const base = intToWords(Number(intPart));
  return half ? `${base} and a half percent` : `${base} percent`;
}

export function sanitizeForTTS(text: string): string {
  let s = text;

  // Money first.
  s = s.replace(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\$\s?\d+(?:\.\d{1,2})?/g, (m) => speakMoney(m));

  // Clock times BEFORE generic number handling: "7:05 PM", "10:00", "1:35 PM Eastern".
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h, mn) => speakClock(Number(h), Number(mn)));

  // Timezone abbreviations → spoken words.
  s = s.replace(/\bET\b/g, "Eastern");
  s = s.replace(/\bEST\b/g, "Eastern");
  s = s.replace(/\bEDT\b/g, "Eastern");

  // Percentages: "23.5%" → "twenty-three and a half percent", "60%" → "sixty percent".
  s = s.replace(/\b(\d{1,3})\.5%/g, (_m, n) => speakPercent(n, true));
  s = s.replace(/\b(\d{1,3})%/g, (_m, n) => speakPercent(n, false));

  // Tri-codes → full team names (before number handling). Word-boundary safe.
  s = s.replace(/\b([A-Z]{2,3})\b/g, (m) => {
    const full = abbrToName(m);
    return full !== m ? full : m;
  });

  // Period / segment shorthand.
  s = s.replace(/\bF5\b/g, "first five innings");
  s = s.replace(/\b1H\b/g, "first half");
  s = s.replace(/\b1P\b/g, "first period");
  s = s.replace(/\bO\/U\b/gi, "over under");
  s = s.replace(/\bPK\b/g, "pick em");
  s = s.replace(/\bML\b/g, "money line");
  s = s.replace(/\bCLV\b/g, "closing line value");
  s = s.replace(/\bEV\b/g, "expected value");

  // Decimal odds like "2.35" → "two point three five" (small leading int).
  s = s.replace(/\b([1-9])\.(\d{2})\b/g, (m) => decimalToWords(m));

  // American lines: -180 / +165 / -3.5 (signed). Half-points read explicitly.
  s = s.replace(/([+-])(\d+)\.5\b/g, (_m, sign, n) => {
    const word = sign === "-" ? "minus" : "plus";
    return `${word} ${intToWords(Number(n))} and a half`;
  });
  s = s.replace(/([+-])(\d{2,4})\b/g, (_m, sign, n) => {
    const word = sign === "-" ? "minus" : "plus";
    return `${word} ${speakLineMagnitude(Number(n))}`;
  });

  // Units: "2.5u" → "two and a half units", "3.0u" → "three units", "1u" → "one unit".
  s = s.replace(/\b(\d+)\.5u\b/g, (_m, n) => `${intToWords(Number(n))} and a half units`);
  s = s.replace(/\b(\d+)\.0u\b/g, (_m, n) => (Number(n) === 1 ? "one unit" : `${intToWords(Number(n))} units`));
  s = s.replace(/\b1u\b/g, "one unit");
  s = s.replace(/\b(\d+)u\b/g, (_m, n) => `${intToWords(Number(n))} units`);

  // Tier names → Title case for natural prosody.
  s = s.replace(/\bSNIPER\b/g, "Sniper");
  s = s.replace(/\bEDGE\b/g, "Edge");
  s = s.replace(/\bRECON\b/g, "Recon");
  s = s.replace(/\bPASS\b/g, "pass");

  s = s.replace(/\s+/g, " ").trim();
  return s;
}
