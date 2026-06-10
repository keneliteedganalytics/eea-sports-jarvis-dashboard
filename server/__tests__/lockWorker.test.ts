// CLV lock worker: window gating, Pinnacle-preferred closing-price selection,
// and end-to-end lock against a temp graded book. Network-free (events are
// supplied directly). Run: tsx server/__tests__/lockWorker.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OddsEvent } from "../adapters/oddsApi";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-lock-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const { upsertPick, pickId, getPick } = await import("../gradedBook");
const {
  lockWindowOpen,
  closingPriceForPick,
  applyLocks,
  LOCK_LEAD_MS,
  PINNACLE_WINDOW_MS,
} = await import("../jobs/lockWorker");

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

console.log("CLV lock worker");

// Build an OddsEvent with a Pinnacle moneyline + a couple of trusted books.
function evWith(opts: {
  eventId: string;
  homeFull: string;
  awayFull: string;
  pinHome?: number | null;
  pinAway?: number | null;
  books?: Array<{ book: string; homePrice: number | null; awayPrice: number | null }>;
}): OddsEvent {
  const rawBookmakers = [];
  if (opts.pinHome !== undefined || opts.pinAway !== undefined) {
    rawBookmakers.push({
      key: "pinnacle",
      title: "Pinnacle",
      markets: [
        {
          key: "h2h",
          outcomes: [
            { name: opts.homeFull, price: opts.pinHome ?? 0 },
            { name: opts.awayFull, price: opts.pinAway ?? 0 },
          ],
        },
      ],
    });
  }
  return {
    eventId: opts.eventId,
    startIso: "2026-06-10T23:05:00Z",
    homeTeam: "HOM",
    awayTeam: "AWY",
    homeTeamFull: opts.homeFull,
    awayTeamFull: opts.awayFull,
    books: opts.books ?? [],
    spread: { homeLine: null, homePrice: null, awayLine: null, awayPrice: null, book: null },
    total: { line: null, overPrice: null, underPrice: null, book: null },
    rawBookmakers,
  };
}

const START = Date.parse("2026-06-10T23:05:00Z");

const mkPick = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: "x",
    gameId: "evt1",
    sport: "mlb",
    pickSide: "home",
    gameStartIso: "2026-06-10T23:05:00Z",
    postedOddsAmerican: -110,
    // remaining GradedPick fields not read by the worker
  }) as unknown as Parameters<typeof closingPriceForPick>[0];

// ── window gating ───────────────────────────────────────────────────
test("window closed well before start", () => {
  assert.equal(lockWindowOpen(mkPick(), START - 5 * 60_000), false);
});
test("window opens at start − lead", () => {
  assert.equal(lockWindowOpen(mkPick(), START - LOCK_LEAD_MS + 1), true);
});
test("window open after start", () => {
  assert.equal(lockWindowOpen(mkPick(), START + 60_000), true);
});
test("no start time → never opens", () => {
  const p = mkPick();
  (p as { gameStartIso: string | null }).gameStartIso = null;
  assert.equal(lockWindowOpen(p, START + 999_999), false);
});

// ── closing-price selection ─────────────────────────────────────────
test("prefers Pinnacle inside the window", () => {
  const ev = evWith({ eventId: "evt1", homeFull: "Home FC", awayFull: "Away FC", pinHome: -120, pinAway: 110 });
  const p = mkPick();
  (p as { homeTeamFull?: string }).homeTeamFull = "Home FC";
  ev.homeTeamFull = "Home FC";
  ev.awayTeamFull = "Away FC";
  const close = closingPriceForPick(p, ev, START);
  assert.deepEqual(close, { price: -120, source: "pinnacle" });
});
test("falls back to best book when Pinnacle absent", () => {
  const ev = evWith({
    eventId: "evt1",
    homeFull: "Home FC",
    awayFull: "Away FC",
    books: [
      { book: "draftkings", homePrice: -125, awayPrice: 105 },
      { book: "fanduel", homePrice: -118, awayPrice: 100 },
    ],
  });
  const close = closingPriceForPick(mkPick(), ev, START);
  // best (highest) home price across books is -118 (fanduel)
  assert.deepEqual(close, { price: -118, source: "fanduel" });
});
test("falls back to best book when outside the ±10min Pinnacle window", () => {
  const ev = evWith({
    eventId: "evt1",
    homeFull: "Home FC",
    awayFull: "Away FC",
    pinHome: -120,
    pinAway: 110,
    books: [{ book: "betmgm", homePrice: -130, awayPrice: 108 }],
  });
  ev.homeTeamFull = "Home FC";
  const close = closingPriceForPick(mkPick(), ev, START + PINNACLE_WINDOW_MS + 60_000);
  assert.deepEqual(close, { price: -130, source: "betmgm" });
});

// ── end-to-end lock against the graded book ─────────────────────────
test("applyLocks writes closing line + CLV and flips status to locked", () => {
  const gameId = "lockEvt1";
  upsertPick({
    gameId,
    sport: "mlb",
    gameDate: "2026-06-10",
    gameTimeEt: "7:05 PM ET",
    matchup: "AWY @ HOM",
    homeTeam: "HOM",
    awayTeam: "AWY",
    homeTeamFull: "Home Team",
    awayTeamFull: "Away Team",
    pickSide: "home",
    pickTeam: "HOM",
    pickTeamFull: "Home Team",
    pickType: "ML",
    pickLine: null,
    pickMl: -110,
    pickBook: "DK",
    gameStartIso: "2026-06-10T23:05:00Z",
    tier: "EDGE",
    units: 2,
    stakeDollars: 600,
    pickWinProb: 0.5,
    pickImpliedProb: 0.524,
    edgePp: 3,
    evPer100: 4,
    confidence: 60,
    fairMl: -105,
  });
  const id = pickId(gameId, "ML", "home");

  const before = getPick(id)!;
  assert.equal(before.lockStatus, "open");
  assert.equal(before.postedOddsAmerican, -110);

  const ev = evWith({ eventId: gameId, homeFull: "Home Team", awayFull: "Away Team", pinHome: -120, pinAway: 110 });
  const byEvent = new Map([[gameId, ev]]);
  const summary = { date: "2026-06-10", scanned: 1, locked: 0 };
  applyLocks([getPick(id)!], byEvent, summary, START);

  assert.equal(summary.locked, 1);
  const after = getPick(id)!;
  assert.equal(after.lockStatus, "locked");
  assert.equal(after.closingOddsAmerican, -120);
  assert.equal(after.closingSource, "pinnacle");
  // posted -110 vs close -120 → positive CLV (we beat the close)
  assert.ok((after.clvPoints ?? 0) > 0, `clvPoints ${after.clvPoints} should be > 0`);
  assert.ok((after.clvPercent ?? 0) > 0, `clvPercent ${after.clvPercent} should be > 0`);
});

test("applyLocks skips picks whose window hasn't opened", () => {
  const gameId = "lockEvt2";
  upsertPick({
    gameId,
    sport: "nba",
    gameDate: "2026-06-10",
    gameTimeEt: "8:00 PM ET",
    matchup: "AWY @ HOM",
    homeTeam: "HOM",
    awayTeam: "AWY",
    homeTeamFull: "Home Team",
    awayTeamFull: "Away Team",
    pickSide: "away",
    pickTeam: "AWY",
    pickTeamFull: "Away Team",
    pickType: "ML",
    pickLine: null,
    pickMl: 120,
    pickBook: "DK",
    gameStartIso: "2026-06-10T23:05:00Z",
    tier: "RECON",
    units: 1,
    stakeDollars: 250,
    pickWinProb: 0.46,
    pickImpliedProb: 0.4545,
    edgePp: 2,
    evPer100: 3,
    confidence: 55,
    fairMl: 130,
  });
  const id = pickId(gameId, "ML", "away");
  const ev = evWith({ eventId: gameId, homeFull: "Home Team", awayFull: "Away Team", pinHome: -120, pinAway: 110 });
  const summary = { date: "2026-06-10", scanned: 1, locked: 0 };
  applyLocks([getPick(id)!], new Map([[gameId, ev]]), summary, START - 60 * 60_000);
  assert.equal(summary.locked, 0);
  assert.equal(getPick(id)!.lockStatus, "open");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
