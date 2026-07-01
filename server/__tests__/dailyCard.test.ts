// v6.14.0 — daily card selection + lock persistence. selectDailyCard is pure
// (edge sort, floor-lowering to reach the 3-pick minimum, 5-pick cap, 1-per-game
// dedupe, best-market pick). lockDailyCard is idempotent (a locked card is frozen
// for the day) unless force is passed. Run in a temp cwd so data.db is scratch.
// Run: tsx server/__tests__/dailyCard.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BuiltPick } from "../sports/mlb/picksEngine";
import type { Market } from "../core/types";

// Scratch cwd BEFORE importing dailyCard so its data.db lands in a temp dir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-card-"));
process.chdir(tmpDir);

const {
  selectDailyCard,
  lockDailyCard,
  getCard,
  CARD_MAX_PICKS,
} = await import("../core/dailyCard");

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

function emptyMkt(): Market {
  return { available: false, pick: null, line: null, priceAmerican: null, fairLine: null, edgePp: null, tier: "PASS", units: 0, side: null, book: null };
}
function mlMkt(edge: number, price = -150): Market {
  return { available: true, pick: "AAA ML", line: null, priceAmerican: price, fairLine: -200, edgePp: edge, tier: "EDGE", units: 1, side: "home", book: "draftkings" };
}
function totalMkt(edge: number): Market {
  return { available: true, pick: "Over 8.5", line: 8.5, priceAmerican: -110, fairLine: -130, edgePp: edge, tier: "EDGE", units: 1, side: "over", book: "draftkings" };
}

let gid = 0;
function mkPick(opts: { verdict?: "PLAY" | "PASS"; ml?: Market; total?: Market; gameId?: string; winProb?: number }): BuiltPick {
  const id = opts.gameId ?? `g${gid++}`;
  return {
    verdict: opts.verdict ?? "PLAY",
    gameId: id,
    gameDate: "2026-07-01",
    gameTimeEt: "7:05 PM ET",
    gameStartIso: null,
    matchup: `AAA @ BBB ${id}`,
    homeTeam: "BBB",
    awayTeam: "AAA",
    pickTeam: "AAA",
    pickWinProb: opts.winProb ?? 0.58,
    markets: { ml: opts.ml ?? emptyMkt(), spread: emptyMkt(), total: opts.total ?? emptyMkt() },
  } as unknown as BuiltPick;
}

console.log("dailyCard — v6.14.0 selection + lock");

test("no PLAY picks → no_qualifying_plays", () => {
  gid = 0;
  const out = selectDailyCard([mkPick({ verdict: "PASS", ml: mlMkt(9) })]);
  assert.equal(out.picks.length, 0);
  assert.equal(out.passReason, "no_qualifying_plays");
});

test("five strong PLAY picks return five, sorted by edge DESC", () => {
  gid = 0;
  const picks = [5, 9, 7, 6, 8].map((e) => mkPick({ ml: mlMkt(e) }));
  const out = selectDailyCard(picks);
  assert.equal(out.passReason, null);
  assert.equal(out.picks.length, 5);
  const edges = out.picks.map((p) => p.edgePp);
  assert.deepEqual(edges, [9, 8, 7, 6, 5]);
});

test("caps at CARD_MAX_PICKS even with more candidates", () => {
  gid = 0;
  const picks = [9, 8.5, 8, 7.5, 7, 6.5, 6].map((e) => mkPick({ ml: mlMkt(e) }));
  const out = selectDailyCard(picks);
  assert.equal(out.picks.length, CARD_MAX_PICKS);
});

test("lowers the edge floor to reach the 3-pick minimum", () => {
  gid = 0;
  // Only one clears 4.0; two more sit between 2.5 and 4.0.
  const picks = [mkPick({ ml: mlMkt(9) }), mkPick({ ml: mlMkt(3.0) }), mkPick({ ml: mlMkt(2.7) })];
  const out = selectDailyCard(picks);
  assert.equal(out.picks.length, 3);
});

test("dedupes to one pick per game (keeps higher edge)", () => {
  gid = 0;
  const picks = [
    mkPick({ gameId: "dup", ml: mlMkt(9) }),
    mkPick({ gameId: "dup", total: totalMkt(4) }),
    mkPick({ gameId: "other", ml: mlMkt(8) }),
    mkPick({ gameId: "third", ml: mlMkt(7) }),
  ];
  const out = selectDailyCard(picks);
  const dupPicks = out.picks.filter((p) => p.gameId === "dup");
  assert.equal(dupPicks.length, 1);
  assert.equal(dupPicks[0].edgePp, 9); // kept the higher-edge market
});

test("bestCandidate picks the higher-edge market within a game", () => {
  gid = 0;
  // ML edge 3, Total edge 9 on the same pick → Total should win.
  const out = selectDailyCard([
    mkPick({ ml: mlMkt(3), total: totalMkt(9) }),
    mkPick({ ml: mlMkt(8) }),
    mkPick({ ml: mlMkt(7) }),
  ]);
  const top = out.picks[0];
  assert.equal(top.market, "Total");
  assert.equal(top.selection, "Over 8.5");
});

test("lockDailyCard is idempotent — a locked card is frozen for the day", () => {
  gid = 0;
  const picks = [9, 8, 7].map((e) => mkPick({ ml: mlMkt(e) }));
  const first = lockDailyCard("2026-07-01", picks, 25000);
  assert.equal(first.picks.length, 3);
  // Re-lock with different picks → original is returned untouched.
  const second = lockDailyCard("2026-07-01", [mkPick({ ml: mlMkt(2.9) })], 30000);
  assert.equal(second.lockedAt, first.lockedAt);
  assert.equal(second.picks.length, 3);
  assert.equal(second.bankrollAtLock, 25000);
  // Persisted row matches.
  const read = getCard("2026-07-01");
  assert.ok(read);
  assert.equal(read!.picks.length, 3);
});

test("lockDailyCard force=true overwrites the frozen card", () => {
  gid = 0;
  const forced = lockDailyCard("2026-07-01", [9, 8, 7, 6].map((e) => mkPick({ ml: mlMkt(e) })), 40000, { force: true });
  assert.equal(forced.picks.length, 4);
  assert.equal(forced.bankrollAtLock, 40000);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
