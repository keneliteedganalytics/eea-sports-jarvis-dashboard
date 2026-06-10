// Player-prop storage + grading. Covers upsert/never-overwrite-graded, the
// over/under rule at the line (W/L/P), and that the board / graded queries split
// on result. Run: tsx server/__tests__/propPick.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-props-"));
const dbFile = path.join(tmpDir, "test_book.db");
process.env.GRADED_BOOK_PATH = dbFile;
process.env.BANKROLL_USD = "25000";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log("prop_picks");

const { gradedDb, upsertPropPick, getPropPick, propBoard, gradedPropPicks } = await import("../gradedBook");
const { gradePropResult, gradePropPick } = await import("../sports/props/gradeProp");

gradedDb();

// ── Pure rule ───────────────────────────────────────────────────────────────
await test("gradePropResult over: actual above line wins", () => {
  assert.equal(gradePropResult("over", 2.5, 3), "W");
});
await test("gradePropResult over: actual below line loses", () => {
  assert.equal(gradePropResult("over", 2.5, 2), "L");
});
await test("gradePropResult under: actual below line wins", () => {
  assert.equal(gradePropResult("under", 2.5, 2), "W");
});
await test("gradePropResult under: actual above line loses", () => {
  assert.equal(gradePropResult("under", 2.5, 3), "L");
});
await test("gradePropResult at the line pushes (over)", () => {
  assert.equal(gradePropResult("over", 3, 3), "P");
});
await test("gradePropResult at the line pushes (under)", () => {
  assert.equal(gradePropResult("under", 3, 3), "P");
});

// ── Storage ───────────────────────────────────────────────────────────────
await test("upsertPropPick stores a board row (ungraded)", () => {
  upsertPropPick({
    pick_id: "p1",
    sport: "nba",
    game_id: "g1",
    player_name: "Jayson Tatum",
    team: "BOS",
    opponent: "LAL",
    market_type: "points",
    line: 27.5,
    side: "over",
    posted_odds: -110,
    posted_at: "2026-06-08T18:00:00Z",
    tier: "EDGE",
    confidence: 60,
    edge_pp: 4.2,
    data_quality_tier: "full",
  });
  const row = getPropPick("p1");
  assert.ok(row);
  assert.equal(row!.player_name, "Jayson Tatum");
  assert.equal(row!.sport, "nba");
  assert.equal(row!.line, 27.5);
  assert.equal(row!.side, "over");
  assert.equal(row!.result, null);
});

await test("propBoard returns ungraded picks; gradedPropPicks excludes them", () => {
  const board = propBoard();
  assert.ok(board.some((r) => r.pick_id === "p1"));
  const graded = gradedPropPicks();
  assert.ok(!graded.some((r) => r.pick_id === "p1"));
});

// ── Grading W/L/P ───────────────────────────────────────────────────────────
await test("gradePropPick W: over hits, +odds payout, settles the row", () => {
  upsertPropPick({
    pick_id: "pW", sport: "nba", game_id: "gW", player_name: "Luka Doncic",
    market_type: "assists", line: 8.5, side: "over", posted_odds: 100, tier: "SNIPER",
  });
  const out = gradePropPick("pW", 10);
  assert.ok(out);
  assert.equal(out!.result, "W");
  assert.equal(out!.actualValue, 10);
  assert.equal(out!.plUnits, 1); // +100 → 1u profit on a 1u stake
  const row = getPropPick("pW")!;
  assert.equal(row.result, "W");
  assert.equal(row.actual_value, 10);
  assert.ok(row.graded_at);
});

await test("gradePropPick L: under misses, -1u on the stake", () => {
  upsertPropPick({
    pick_id: "pL", sport: "nba", game_id: "gL", player_name: "Nikola Jokic",
    market_type: "rebounds", line: 11.5, side: "under", posted_odds: -120, tier: "RECON",
  });
  const out = gradePropPick("pL", 14);
  assert.equal(out!.result, "L");
  assert.equal(out!.plUnits, -1);
});

await test("gradePropPick P: actual at the line, zero P/L", () => {
  upsertPropPick({
    pick_id: "pP", sport: "nhl", game_id: "gP", player_name: "Connor McDavid",
    market_type: "shots", line: 4, side: "over", posted_odds: -110, tier: "EDGE",
  });
  const out = gradePropPick("pP", 4);
  assert.equal(out!.result, "P");
  assert.equal(out!.plUnits, 0);
});

await test("gradePropPick returns null for an unknown pick id", () => {
  assert.equal(gradePropPick("nope", 1), null);
});

await test("upsertPropPick never overwrites a graded prop", () => {
  // pW is already graded W. A re-upsert with a different line must be ignored.
  upsertPropPick({
    pick_id: "pW", sport: "nba", game_id: "gW", player_name: "Luka Doncic",
    market_type: "assists", line: 99, side: "under", posted_odds: -500, tier: "RECON",
  });
  const row = getPropPick("pW")!;
  assert.equal(row.line, 8.5); // unchanged
  assert.equal(row.side, "over"); // unchanged
  assert.equal(row.result, "W"); // still graded
});

await test("graded picks now show in gradedPropPicks", () => {
  const graded = gradedPropPicks();
  const ids = graded.map((r) => r.pick_id);
  assert.ok(ids.includes("pW"));
  assert.ok(ids.includes("pL"));
  assert.ok(ids.includes("pP"));
});

await test("sport filter narrows the graded set", () => {
  const nhl = gradedPropPicks({ sport: "NHL" });
  assert.ok(nhl.every((r) => r.sport === "nhl"));
  assert.ok(nhl.some((r) => r.pick_id === "pP"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
