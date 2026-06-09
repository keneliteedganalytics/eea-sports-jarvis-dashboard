// Line movement + Pinnacle oracle. Verifies the pure movement math (opening vs
// current, CLV cents, steam window, sharp confirm/fade), the JSONL history
// round-trip, and the confidence delta. No network — the Odds API and Pinnacle
// price are passed in directly.
// Run: tsx server/__tests__/lineMovement.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHist = path.join(os.tmpdir(), `line_history_${process.pid}.jsonl`);
process.env.LINE_HISTORY_PATH = tmpHist;
try {
  fs.unlinkSync(tmpHist);
} catch {
  /* ignore */
}

const {
  computeMovement,
  captureSnapshot,
  readHistory,
  pinnacleMoneyline,
  sharpConfidenceDelta,
  NEUTRAL_MOVEMENT,
  STEAM_CENTS,
} = await import("../adapters/lineMovement");

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log("line movement + Pinnacle oracle");

const T0 = 1_000_000_000_000;
function snap(ts: number, homeMl: number, awayMl: number) {
  return { ts, eventId: "evt1", sport: "mlb", homeMl, awayMl, pinnacleHomeMl: null, pinnacleAwayMl: null };
}

test("empty history → neutral signal (carries Pinnacle fair prob)", () => {
  const m = computeMovement([], "home", 0.58, 0.55, T0);
  assert.equal(m.openingLine, null);
  assert.equal(m.sharpSignal, "neutral");
  assert.equal(m.pinnacleFairProb, 0.58);
});

test("opening vs current + CLV cents (home side)", () => {
  const hist = [snap(T0, -120, 110), snap(T0 + 60_000, -130, 120)];
  const m = computeMovement(hist, "home", null, null, T0 + 60_000);
  assert.equal(m.openingLine, -120);
  assert.equal(m.currentLine, -130);
  assert.equal(m.clvCents, -10);
});

test("steam fires on a large move inside the window", () => {
  const hist = [snap(T0, -120, 110), snap(T0 + 60_000, -120 - STEAM_CENTS, 120)];
  const m = computeMovement(hist, "home", null, null, T0 + 60_000);
  assert.equal(m.steam, true);
});

test("no steam when the move is small", () => {
  const hist = [snap(T0, -120, 110), snap(T0 + 60_000, -121, 111)];
  const m = computeMovement(hist, "home", null, null, T0 + 60_000);
  assert.equal(m.steam, false);
});

test("Pinnacle above price → sharp_confirms_pick", () => {
  const m = computeMovement([snap(T0, -120, 110)], "home", 0.62, 0.55, T0);
  assert.equal(m.sharpSignal, "sharp_confirms_pick");
});

test("Pinnacle below price → sharp_fades_pick", () => {
  const m = computeMovement([snap(T0, -120, 110)], "home", 0.50, 0.58, T0);
  assert.equal(m.sharpSignal, "sharp_fades_pick");
});

test("reverse line move: line worsens but Pinnacle confirms", () => {
  const hist = [snap(T0, -120, 110), snap(T0 + 60_000, -135, 125)];
  const m = computeMovement(hist, "home", 0.64, 0.57, T0 + 60_000);
  assert.equal(m.clvCents! < 0, true);
  assert.equal(m.reverseLineMove, "sharp_confirms_pick");
});

test("sharpConfidenceDelta: +5 confirm, -10 fade, 0 neutral", () => {
  assert.equal(sharpConfidenceDelta("sharp_confirms_pick"), 5);
  assert.equal(sharpConfidenceDelta("sharp_fades_pick"), -10);
  assert.equal(sharpConfidenceDelta("neutral"), 0);
});

test("pinnacleMoneyline reads the pinnacle book off an event", () => {
  const ev = {
    eventId: "e",
    startIso: "",
    homeTeam: "NYY",
    awayTeam: "BOS",
    homeTeamFull: "New York Yankees",
    awayTeamFull: "Boston Red Sox",
    books: [],
    spread: { homeLine: null, homePrice: null, awayLine: null, awayPrice: null, book: null },
    total: { line: null, overPrice: null, underPrice: null, book: null },
    rawBookmakers: [
      {
        key: "pinnacle",
        title: "Pinnacle",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "New York Yankees", price: -140 },
              { name: "Boston Red Sox", price: 125 },
            ],
          },
        ],
      },
    ],
  } as any;
  const pin = pinnacleMoneyline(ev);
  assert.equal(pin.home, -140);
  assert.equal(pin.away, 125);
});

test("captureSnapshot + readHistory round-trip via JSONL", () => {
  const ev = {
    eventId: "round-trip-evt",
    startIso: "",
    homeTeam: "NYY",
    awayTeam: "BOS",
    homeTeamFull: "New York Yankees",
    awayTeamFull: "Boston Red Sox",
    books: [
      { book: "draftkings", homePrice: -130, awayPrice: 115 },
      { book: "fanduel", homePrice: -125, awayPrice: 110 },
    ],
    spread: { homeLine: null, homePrice: null, awayLine: null, awayPrice: null, book: null },
    total: { line: null, overPrice: null, underPrice: null, book: null },
    rawBookmakers: [],
  } as any;
  captureSnapshot([ev], "mlb", T0);
  const hist = readHistory("round-trip-evt");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].eventId, "round-trip-evt");
  assert.equal(hist[0].sport, "mlb");
  assert.ok(hist[0].homeMl !== null);
});

test("NEUTRAL_MOVEMENT is fully neutral", () => {
  assert.equal(NEUTRAL_MOVEMENT.sharpSignal, "neutral");
  assert.equal(NEUTRAL_MOVEMENT.steam, false);
  assert.equal(NEUTRAL_MOVEMENT.clvCents, null);
});

try {
  fs.unlinkSync(tmpHist);
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
