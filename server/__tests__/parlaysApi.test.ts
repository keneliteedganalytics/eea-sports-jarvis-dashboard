// Integration: GET /api/parlays/board + /api/parlays/analytics (v6.7.9). Mounts
// copies of the real handlers over a temp graded book, seeds two SNIPER legs in a
// game, builds the parlay, and asserts the board shape (summary + items + nested
// legs) and the analytics aggregate. Run: tsx server/__tests__/parlaysApi.test.ts

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-parlays-api-"));
process.env.GRADED_BOOK_PATH = path.join(tmpDir, "test_book.db");

const {
  upsertPropOffer,
  upsertPropPick,
  getPropPick,
  getVirtualParlaysForDate,
  getVirtualParlayStats,
} = await import("../gradedBook");
const { buildVirtualParlaysForDates } = await import("../jobs/virtualParlayBuilder");

const DAY = "2026-06-13";

for (const player of ["Bryan Reynolds", "Ke'Bryan Hayes"]) {
  upsertPropOffer({
    event_id: "PITvsMIA", sport: "mlb", game_date: DAY, player_name: player,
    market: "batter_hits", line: 0.5, over_price: -120, under_price: 100, book: "draftkings",
    event_home: "Miami Marlins", event_away: "Pittsburgh Pirates",
  });
}
const postedAt = `${DAY}T15:00:00.000Z`;
upsertPropPick({ pick_id: "pit1", sport: "mlb", game_id: "PITvsMIA", player_name: "Bryan Reynolds", market_type: "batter_hits", market_label: "Hits", line: 0.5, side: "over", posted_odds: -150, tier: "SNIPER", posted_at: postedAt });
upsertPropPick({ pick_id: "pit2", sport: "mlb", game_id: "PITvsMIA", player_name: "Ke'Bryan Hayes", market_type: "batter_hits", market_label: "Hits", line: 0.5, side: "over", posted_odds: 120, tier: "SNIPER", posted_at: postedAt });
buildVirtualParlaysForDates([DAY]);

// Mirror of the real /api/parlays/board handler in routes.ts.
const app = express();
app.get("/api/parlays/board", (req, res) => {
  const date = (typeof req.query.date === "string" ? req.query.date : null) ?? DAY;
  const rows = getVirtualParlaysForDate(date, null);
  const legDisposition = (result: string | null, liveState: string | null): string => {
    if (result === "W") return "won";
    if (result === "L") return "busted";
    if (liveState === "busted") return "busted";
    if (liveState === "live_clear" || liveState === "live") return "live";
    return "pending";
  };
  const items = rows.map((p) => {
    let pickIds: string[] = [];
    try { pickIds = JSON.parse(p.leg_pick_ids ?? "[]") as string[]; } catch { pickIds = []; }
    const legs = pickIds
      .map((id) => getPropPick(id))
      .filter((row): row is NonNullable<typeof row> => row != null)
      .map((row) => ({
        pickId: row.pick_id, player: row.player_name, market: row.market_label ?? row.market_type,
        line: row.line, side: row.side, odds: row.posted_odds ?? row.best_price ?? null, tier: row.tier,
        result: row.result, liveState: row.live_state ?? "pending", currentValue: row.live_value,
        disposition: legDisposition(row.result, row.live_state),
      }));
    return {
      parlayId: p.parlay_id, gameId: p.game_id, gameLabel: p.game_label, sport: p.sport,
      stakeDollars: p.stake_dollars, legCount: p.leg_count, combinedDecimal: p.combined_decimal,
      combinedAmerican: p.combined_american, potentialPayoutDollars: p.potential_payout_dollars,
      potentialProfitDollars: p.potential_profit_dollars, status: p.status, legsWon: p.legs_won,
      legsBusted: p.legs_busted, legsPending: p.legs_pending, plDollars: p.pl_dollars,
      gradedAt: p.graded_at, legs,
    };
  });
  const summary = {
    date, count: items.length,
    live: items.filter((i) => i.status === "live").length,
    pending: items.filter((i) => i.status === "pending").length,
    won: items.filter((i) => i.status === "won").length,
    busted: items.filter((i) => i.status === "busted").length,
    plDollars: Math.round(items.filter((i) => i.status === "won" || i.status === "busted").reduce((s, i) => s + (i.plDollars ?? 0), 0) * 100) / 100,
  };
  res.json({ summary, items });
});
app.get("/api/parlays/analytics", (_req, res) => res.json(getVirtualParlayStats()));

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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

console.log("GET /api/parlays/board + /api/parlays/analytics");

await test("board returns summary + one item for the seeded game", async () => {
  const res = await fetch(`${base}/api/parlays/board?date=${DAY}`);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.summary.count, 1);
  assert.equal(d.summary.pending, 1);
  assert.equal(d.items.length, 1);
});

await test("the parlay item carries its nested legs (player/market/line/side/odds)", async () => {
  const d = await (await fetch(`${base}/api/parlays/board?date=${DAY}`)).json();
  const p = d.items[0];
  assert.equal(p.gameLabel, "Pittsburgh Pirates @ Miami Marlins");
  assert.equal(p.legCount, 2);
  assert.equal(p.legs.length, 2);
  const reynolds = p.legs.find((l: { player: string }) => l.player === "Bryan Reynolds");
  assert.ok(reynolds);
  assert.equal(reynolds.market, "Hits");
  assert.equal(reynolds.odds, -150);
  assert.equal(reynolds.disposition, "pending");
});

await test("combined american odds are surfaced and positive (two plus-ish legs)", async () => {
  const d = await (await fetch(`${base}/api/parlays/board?date=${DAY}`)).json();
  const p = d.items[0];
  assert.ok(typeof p.combinedAmerican === "number");
  assert.ok(p.potentialProfitDollars > 0);
});

await test("analytics aggregate exposes the expected keys", async () => {
  const d = await (await fetch(`${base}/api/parlays/analytics`)).json();
  for (const k of [
    "total_parlays", "won", "busted", "pending", "live", "win_rate_pct",
    "total_staked", "total_pl_dollars", "roi_pct", "by_day", "by_sport",
  ]) {
    assert.ok(k in d, `missing key: ${k}`);
  }
  assert.equal(d.total_parlays, 1);
  assert.equal(d.pending, 1);
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
