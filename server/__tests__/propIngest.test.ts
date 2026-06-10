// Unit tests for prop ingestion parsing (spec §1): the Odds API per-event payload
// is flattened to ONE ROW PER BOOK per market per player, Over and Under prices
// collapse onto the same row, the point becomes the line, and only the 12 known
// markets are kept. Standalone tsx harness using node:assert — no live key needed.
import assert from "node:assert/strict";
import { parseEventOdds, MLB_PROP_MARKETS, hasOddsKey } from "../sports/props/ingestMlbProps";

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

const DATE = "2026-06-11";

console.log("prop ingestion");

test("MLB_PROP_MARKETS covers all 12 batter+pitcher markets", () => {
  assert.equal(MLB_PROP_MARKETS.length, 12);
  assert.ok(MLB_PROP_MARKETS.includes("batter_hits"));
  assert.ok(MLB_PROP_MARKETS.includes("pitcher_strikeouts"));
});

test("hasOddsKey reflects the env var presence", () => {
  const prev = process.env.ODDS_API_KEY;
  delete process.env.ODDS_API_KEY;
  assert.equal(hasOddsKey(), false);
  process.env.ODDS_API_KEY = "abc";
  assert.equal(hasOddsKey(), true);
  if (prev === undefined) delete process.env.ODDS_API_KEY;
  else process.env.ODDS_API_KEY = prev;
});

test("one row per (book, market, player); Over+Under collapse onto it", () => {
  const raw = {
    id: "evt1",
    home_team: "Yankees",
    away_team: "Red Sox",
    bookmakers: [
      {
        key: "draftkings",
        markets: [
          {
            key: "batter_hits",
            outcomes: [
              { name: "Over", description: "Aaron Judge", price: -120, point: 0.5 },
              { name: "Under", description: "Aaron Judge", price: 100, point: 0.5 },
            ],
          },
        ],
      },
    ],
  };
  const rows = parseEventOdds(raw, DATE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].book, "draftkings");
  assert.equal(rows[0].player_name, "Aaron Judge");
  assert.equal(rows[0].market, "batter_hits");
  assert.equal(rows[0].over_price, -120);
  assert.equal(rows[0].under_price, 100);
  assert.equal(rows[0].line, 0.5);
  assert.equal(rows[0].game_date, DATE);
  assert.equal(rows[0].event_id, "evt1");
});

test("multiple books → one row each (line shopping needs every book)", () => {
  const raw = {
    id: "evt2",
    bookmakers: ["draftkings", "fanduel", "betmgm"].map((key) => ({
      key,
      markets: [
        {
          key: "batter_total_bases",
          outcomes: [
            { name: "Over", description: "Mookie Betts", price: -110, point: 1.5 },
            { name: "Under", description: "Mookie Betts", price: -110, point: 1.5 },
          ],
        },
      ],
    })),
  };
  const rows = parseEventOdds(raw, DATE);
  assert.equal(rows.length, 3);
  assert.deepEqual(new Set(rows.map((r) => r.book)), new Set(["draftkings", "fanduel", "betmgm"]));
  assert.ok(rows.every((r) => r.player_name === "Mookie Betts"));
});

test("multiple players in one market → one row per player", () => {
  const raw = {
    id: "evt3",
    bookmakers: [
      {
        key: "fanduel",
        markets: [
          {
            key: "batter_home_runs",
            outcomes: [
              { name: "Over", description: "Player A", price: 200, point: 0.5 },
              { name: "Under", description: "Player A", price: -260, point: 0.5 },
              { name: "Over", description: "Player B", price: 350, point: 0.5 },
              { name: "Under", description: "Player B", price: -450, point: 0.5 },
            ],
          },
        ],
      },
    ],
  };
  const rows = parseEventOdds(raw, DATE);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.player_name)), new Set(["Player A", "Player B"]));
});

test("unknown markets are dropped", () => {
  const raw = {
    id: "evt4",
    bookmakers: [
      {
        key: "dk",
        markets: [
          { key: "h2h", outcomes: [{ name: "Yankees", price: -150 }] },
          { key: "batter_walks", outcomes: [{ name: "Over", description: "X", price: 120, point: 0.5 }] },
        ],
      },
    ],
  };
  const rows = parseEventOdds(raw, DATE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].market, "batter_walks");
});

test("outcomes without a player description are skipped", () => {
  const raw = {
    id: "evt5",
    bookmakers: [
      {
        key: "dk",
        markets: [
          {
            key: "batter_hits",
            outcomes: [
              { name: "Over", price: -110, point: 0.5 }, // no description
              { name: "Over", description: "Real Player", price: -110, point: 0.5 },
            ],
          },
        ],
      },
    ],
  };
  const rows = parseEventOdds(raw, DATE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].player_name, "Real Player");
});

test("missing point defaults the line to 0.5", () => {
  const raw = {
    id: "evt6",
    bookmakers: [
      { key: "dk", markets: [{ key: "batter_hits", outcomes: [{ name: "Over", description: "Y", price: -110 }] }] },
    ],
  };
  const rows = parseEventOdds(raw, DATE);
  assert.equal(rows[0].line, 0.5);
});

test("empty / missing bookmakers → no rows (no fabricated data)", () => {
  assert.equal(parseEventOdds({ id: "e", bookmakers: [] }, DATE).length, 0);
  assert.equal(parseEventOdds({ id: "e" }, DATE).length, 0);
});

test("same player+market across pitcher markets stays distinct rows per market", () => {
  const raw = {
    id: "evt7",
    bookmakers: [
      {
        key: "dk",
        markets: [
          { key: "pitcher_strikeouts", outcomes: [{ name: "Over", description: "Ace", price: -115, point: 6.5 }] },
          { key: "pitcher_outs", outcomes: [{ name: "Over", description: "Ace", price: -120, point: 17.5 }] },
        ],
      },
    ],
  };
  const rows = parseEventOdds(raw, DATE);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.market)), new Set(["pitcher_strikeouts", "pitcher_outs"]));
});

test("sport is tagged mlb on every parsed row", () => {
  const raw = {
    id: "evt8",
    bookmakers: [{ key: "dk", markets: [{ key: "batter_rbis", outcomes: [{ name: "Over", description: "Z", price: 100, point: 0.5 }] }] }],
  };
  assert.equal(parseEventOdds(raw, DATE)[0].sport, "mlb");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
