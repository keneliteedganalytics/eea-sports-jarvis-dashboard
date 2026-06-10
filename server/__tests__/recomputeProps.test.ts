// Tests for the one-time v6.7.6 stale-edge recompute (server/jobs/recomputeProps.ts).
// The job snapshots today's undecided prop picks, re-runs the (fixed) build, then
// reconciles: a pick the rebuild still surfaces is counted as re-tiered in place;
// a pick it no longer surfaces is demoted to PASS. It is guarded by a system_state
// flag so a redeploy can't re-run it. We inject every dep (build + gradedBook
// accessors) so no live DB/HTTP is needed. Run: tsx server/__tests__/recomputeProps.test.ts
import assert from "node:assert/strict";
import {
  recomputePropsV676,
  RECOMPUTE_FLAG,
  RECOMPUTE_AT,
  type RecomputeDeps,
} from "../jobs/recomputeProps";
import type { PropPickRow } from "../gradedBook";

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

function row(pick_id: string, tier = "SNIPER"): PropPickRow {
  return {
    pick_id, sport: "mlb", game_id: "g1", player_name: "Test Player", player_id: null,
    team: null, opponent: null, market_type: "batter_hits", line: 1.5, side: "over",
    posted_odds: -110, closing_odds: null, posted_at: null, graded_at: null,
    result: null, actual_value: null, pl_units: null, pl_dollars: null, tier,
    confidence: null, edge_pp: 29, data_quality_tier: null, clv_pct: null,
    model_prob: 0.8, sim_median: null, sim_p25: null, sim_p75: null, sim_mean: null,
    sim_trials: null,
  } as PropPickRow;
}

// In-memory harness: a key/value system_state, a fixed set of "before" picks, and
// a build whose surviving pickIds + the post-build tier are configurable.
function harness(opts: {
  before: PropPickRow[];
  survivorIds: string[];
  flag?: string | null;
  tierAfter?: (id: string) => string; // tier the rebuild left on a survivor
}) {
  const state = new Map<string, string>();
  if (opts.flag != null) state.set(RECOMPUTE_FLAG, opts.flag);
  const passedIds: string[] = [];
  const deps: RecomputeDeps = {
    build: (async () => ({
      date: "2026-06-10", considered: opts.before.length,
      written: opts.survivorIds.length, pickIds: opts.survivorIds,
    })) as RecomputeDeps["build"],
    activePicks: () => opts.before,
    getPick: (id: string) => {
      if (!opts.survivorIds.includes(id)) return undefined;
      return row(id, opts.tierAfter ? opts.tierAfter(id) : "BIG_DOG");
    },
    markPass: (id: string) => { passedIds.push(id); },
    getState: (k: string) => state.get(k) ?? null,
    setState: (k: string, v: string) => { state.set(k, v); },
  };
  return { deps, state, passedIds };
}

console.log("recompute v6.7.6");

await test("survivors are counted re-tiered, non-survivors demoted to PASS", async () => {
  const before = [row("a"), row("b"), row("c")];
  const h = harness({ before, survivorIds: ["a", "b"] });
  const s = await recomputePropsV676("2026-06-10", h.deps);
  assert.equal(s.alreadyCompleted, false);
  assert.equal(s.scanned, 3);
  assert.equal(s.updated, 2, "a + b survived");
  assert.equal(s.passed, 1, "c demoted");
  assert.deepEqual(h.passedIds, ["c"]);
});

await test("a survivor the rebuild left as PASS is NOT counted as re-tiered", async () => {
  const before = [row("a"), row("b")];
  // 'a' survived the pickIds list but the rebuild stamped it PASS → not an update.
  const h = harness({ before, survivorIds: ["a", "b"], tierAfter: (id) => (id === "a" ? "PASS" : "SNIPER") });
  const s = await recomputePropsV676("2026-06-10", h.deps);
  assert.equal(s.updated, 1, "only b counts");
  assert.equal(s.passed, 0, "both were survivors, none demoted");
});

await test("idempotent: a prior completed flag is a no-op", async () => {
  const before = [row("a")];
  const h = harness({ before, survivorIds: ["a"], flag: "true" });
  const s = await recomputePropsV676("2026-06-10", h.deps);
  assert.equal(s.alreadyCompleted, true);
  assert.equal(s.scanned, 0);
  assert.equal(h.passedIds.length, 0, "no picks touched on a no-op run");
});

await test("a successful run stamps the completion + timestamp flags", async () => {
  const before = [row("a")];
  const h = harness({ before, survivorIds: [] });
  await recomputePropsV676("2026-06-10", h.deps);
  assert.equal(h.state.get(RECOMPUTE_FLAG), "true");
  assert.ok(h.state.get(RECOMPUTE_AT), "completion timestamp recorded");
});

await test("a build that throws is caught and every pick falls through to PASS", async () => {
  const before = [row("a"), row("b")];
  const h = harness({ before, survivorIds: [] });
  h.deps.build = (async () => { throw new Error("boom"); }) as RecomputeDeps["build"];
  const s = await recomputePropsV676("2026-06-10", h.deps);
  assert.equal(s.passed, 2, "no survivors → both demoted");
  assert.equal(s.updated, 0);
  assert.equal(h.state.get(RECOMPUTE_FLAG), "true", "flag still set so it won't re-run");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
