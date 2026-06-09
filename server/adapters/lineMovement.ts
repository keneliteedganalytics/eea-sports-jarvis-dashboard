// Line movement + Pinnacle "oracle" (all sports). We append a moneyline
// snapshot for every event to a JSONL history every few minutes, then read that
// history back to derive per-pick movement signals: opening vs current line,
// closing-line-value drift in cents, steam (a fast move), and reverse-line
// movement read against Pinnacle's fair price (the sharpest book).
//
// Pinnacle confirming the pick side → small confidence bump; Pinnacle fading it
// → a larger haircut. Everything degrades to a neutral signal when history or
// the sharp price is missing, so the slate is never blocked.

import fs from "node:fs";
import path from "node:path";
import { americanToProb } from "../core/odds";
import type { OddsEvent } from "./oddsApi";

const HISTORY_PATH = process.env.LINE_HISTORY_PATH
  ? process.env.LINE_HISTORY_PATH
  : path.join(process.cwd(), "data", "line_history.jsonl");

// A move of this many cents (American odds) inside the steam window counts as
// "steam" — sharp money hitting fast.
export const STEAM_CENTS = 0.5 * 10; // 5 cents over the 15-min window
export const STEAM_WINDOW_MS = 15 * 60 * 1000;

export type SharpSignal = "sharp_confirms_pick" | "sharp_fades_pick" | "neutral";

export interface LineSnapshot {
  ts: number; // epoch ms
  eventId: string;
  sport: string;
  homeMl: number | null;
  awayMl: number | null;
  pinnacleHomeMl: number | null;
  pinnacleAwayMl: number | null;
}

export interface MovementSignal {
  openingLine: number | null; // pick-side American odds at first capture
  currentLine: number | null; // pick-side American odds now
  clvCents: number | null; // currentLine − openingLine, in cents (signed)
  steam: boolean; // a large move inside the steam window
  reverseLineMove: SharpSignal;
  sharpSignal: SharpSignal; // Pinnacle vs pick side
  pinnacleFairProb: number | null;
}

export const NEUTRAL_MOVEMENT: MovementSignal = {
  openingLine: null,
  currentLine: null,
  clvCents: null,
  steam: false,
  reverseLineMove: "neutral",
  sharpSignal: "neutral",
  pinnacleFairProb: null,
};

// Pinnacle's moneyline for an event, if present in the raw book list.
export function pinnacleMoneyline(ev: OddsEvent): { home: number | null; away: number | null } {
  const bm = ev.rawBookmakers?.find((b) => b.key === "pinnacle");
  if (!bm) return { home: null, away: null };
  const h2h = bm.markets?.find((m) => m.key === "h2h");
  if (!h2h) return { home: null, away: null };
  const home = h2h.outcomes.find((o) => o.name === ev.homeTeamFull)?.price ?? null;
  const away = h2h.outcomes.find((o) => o.name === ev.awayTeamFull)?.price ?? null;
  return { home, away };
}

// Median consensus moneyline across the trusted books already on the event.
function consensusMl(ev: OddsEvent): { home: number | null; away: number | null } {
  const homes = ev.books.map((b) => b.homePrice).filter((x): x is number => x !== null);
  const aways = ev.books.map((b) => b.awayPrice).filter((x): x is number => x !== null);
  const med = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };
  return { home: med(homes), away: med(aways) };
}

// Append a moneyline snapshot for each event to the JSONL history. Best-effort:
// any filesystem error is swallowed so capture never breaks the slate.
export function captureSnapshot(events: OddsEvent[], sport: string, now = Date.now()): void {
  try {
    const dir = path.dirname(HISTORY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = events.map((ev) => {
      const cons = consensusMl(ev);
      const pin = pinnacleMoneyline(ev);
      const snap: LineSnapshot = {
        ts: now,
        eventId: ev.eventId,
        sport,
        homeMl: cons.home,
        awayMl: cons.away,
        pinnacleHomeMl: pin.home,
        pinnacleAwayMl: pin.away,
      };
      return JSON.stringify(snap);
    });
    if (lines.length > 0) fs.appendFileSync(HISTORY_PATH, lines.join("\n") + "\n", "utf8");
  } catch {
    /* best-effort: never block the slate */
  }
}

// Read all snapshots for an event, oldest-first. Returns [] on any failure.
export function readHistory(eventId: string): LineSnapshot[] {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const raw = fs.readFileSync(HISTORY_PATH, "utf8");
    const out: LineSnapshot[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const snap = JSON.parse(t) as LineSnapshot;
        if (snap.eventId === eventId) out.push(snap);
      } catch {
        /* skip malformed rows */
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  } catch {
    return [];
  }
}

// Pure: derive the movement signal for a pick side from its snapshot history
// plus the live Pinnacle fair probability for the pick side. Exported for tests.
export function computeMovement(
  history: LineSnapshot[],
  pickSide: "home" | "away",
  pinnacleFairProbPickSide: number | null,
  pickImpliedProb: number | null,
  now = Date.now(),
): MovementSignal {
  if (history.length === 0) {
    return { ...NEUTRAL_MOVEMENT, pinnacleFairProb: pinnacleFairProbPickSide };
  }
  const lineAt = (s: LineSnapshot) => (pickSide === "home" ? s.homeMl : s.awayMl);
  const opening = lineAt(history[0]);
  const current = lineAt(history[history.length - 1]);
  const clvCents =
    opening !== null && current !== null ? Math.round((current - opening) * 10) / 10 : null;

  // Steam: largest absolute move between consecutive snapshots inside the window.
  let steam = false;
  for (let i = 1; i < history.length; i++) {
    if (now - history[i].ts > STEAM_WINDOW_MS) continue;
    const prev = lineAt(history[i - 1]);
    const cur = lineAt(history[i]);
    if (prev !== null && cur !== null && Math.abs(cur - prev) >= STEAM_CENTS) {
      steam = true;
      break;
    }
  }

  // Sharp signal: compare Pinnacle's fair probability for the pick side against
  // the market-implied probability the pick was priced at. Pinnacle higher than
  // the price we got → the sharp book agrees the side is underpriced (confirm);
  // lower → it disagrees (fade).
  let sharpSignal: SharpSignal = "neutral";
  if (pinnacleFairProbPickSide !== null && pickImpliedProb !== null) {
    const gap = pinnacleFairProbPickSide - pickImpliedProb;
    if (gap > 0.01) sharpSignal = "sharp_confirms_pick";
    else if (gap < -0.01) sharpSignal = "sharp_fades_pick";
  }

  // Reverse line move: the consensus line moved against the pick side (got
  // worse / less juice for us) yet Pinnacle still confirms — classic sharp tell.
  // We surface it through the same enum the brief consumes.
  let reverseLineMove: SharpSignal = "neutral";
  if (clvCents !== null && clvCents < 0 && sharpSignal === "sharp_confirms_pick") {
    reverseLineMove = "sharp_confirms_pick";
  } else if (clvCents !== null && clvCents > 0 && sharpSignal === "sharp_fades_pick") {
    reverseLineMove = "sharp_fades_pick";
  }

  return {
    openingLine: opening,
    currentLine: current,
    clvCents,
    steam,
    reverseLineMove,
    sharpSignal,
    pinnacleFairProb: pinnacleFairProbPickSide,
  };
}

// Resolve the full movement signal for a pick: read history, pull the live
// Pinnacle fair probability for the pick side off the event, and combine. Never
// throws; returns NEUTRAL_MOVEMENT on any failure.
export function movementForPick(
  ev: OddsEvent | null | undefined,
  pickSide: "home" | "away",
  pickImpliedProb: number | null,
  now = Date.now(),
): MovementSignal {
  try {
    if (!ev) return NEUTRAL_MOVEMENT;
    const pin = pinnacleMoneyline(ev);
    const pinMl = pickSide === "home" ? pin.home : pin.away;
    const pinFair = americanToProb(pinMl);
    const history = readHistory(ev.eventId);
    return computeMovement(history, pickSide, pinFair, pickImpliedProb, now);
  } catch {
    return NEUTRAL_MOVEMENT;
  }
}

// Confidence delta from a sharp signal: +5 confirm, −10 fade, 0 neutral.
export function sharpConfidenceDelta(signal: SharpSignal): number {
  if (signal === "sharp_confirms_pick") return 5;
  if (signal === "sharp_fades_pick") return -10;
  return 0;
}

// Reset paths for tests that point LINE_HISTORY_PATH at a temp file after import.
export function _historyPath(): string {
  return HISTORY_PATH;
}
