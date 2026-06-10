// Integration for the v6.7.4 BUG #2 fix: GET /api/props/board must surface the
// live-tracking fields on EVERY item, camelCased (liveState / currentValue /
// gameStatus), so cards can color on the FIRST render without waiting for the
// /api/props/live poll. We seed a pick on today's date, write a live state via
// the same helper the worker uses, then mount a copy of the board handler over a
// temp graded book and assert the camelCase fields ride on the item.
// Run: tsx server/__tests__/propBoardLiveState.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-prop-board-live-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const { upsertPropPick, updatePropPickLiveState, propBoard } = await import("../gradedBook");

// posted_at defaults to now() inside upsertPropPick, so the pick lands on today.
const TODAY = new Date().toISOString().slice(0, 10);

upsertPropPick({
  pick_id: "boardLive",
  sport: "mlb",
  game_id: "evtBoard",
  player_name: "Aaron Judge",
  market_type: "batter_hits",
  line: 1.5,
  side: "over",
  posted_odds: 110,
});
// Worker-style write: live_clear, value 1, game live.
updatePropPickLiveState("boardLive", "live_clear", 1, "live");

// Mirror of the real /api/props/board handler's mapping in routes.ts.
const app = express();
app.get("/api/props/board", (req, res) => {
  const sport = typeof req.query.sport === "string" ? req.query.sport : null;
  const date = typeof req.query.date === "string" ? req.query.date : null;
  const items = propBoard({ sport, date }).map((row) => ({
    ...row,
    liveState: row.live_state ?? "pending",
    currentValue: row.live_value,
    gameStatus: row.live_status ?? null,
  }));
  res.json({ sport: sport ?? "ALL", date, items });
});

const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
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

console.log("GET /api/props/board — live fields (v6.7.4)");

await test("board item carries camelCase liveState/currentValue/gameStatus", async () => {
  const res = await fetch(`${base}/api/props/board?sport=mlb&date=${TODAY}`);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.ok(Array.isArray(d.items) && d.items.length >= 1, "expected ≥1 board item");
  const it = d.items.find((x: { pick_id: string }) => x.pick_id === "boardLive");
  assert.ok(it, "seeded pick should be on the board");
  assert.equal(it.liveState, "live_clear");
  assert.equal(it.currentValue, 1);
  assert.equal(it.gameStatus, "live");
});

await test("a pick with no live state reads liveState=pending, gameStatus=null", async () => {
  upsertPropPick({
    pick_id: "boardNoLive",
    sport: "mlb",
    game_id: "evtBoard2",
    player_name: "Mike Trout",
    market_type: "batter_hits",
    line: 0.5,
    side: "over",
    posted_odds: -110,
  });
  const d = await (await fetch(`${base}/api/props/board?sport=mlb&date=${TODAY}`)).json();
  const it = d.items.find((x: { pick_id: string }) => x.pick_id === "boardNoLive");
  assert.ok(it, "second pick should be on the board");
  assert.equal(it.liveState, "pending");
  assert.equal(it.gameStatus, null);
  assert.equal(it.currentValue, null);
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
