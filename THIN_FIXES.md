# v6.12.0-thin — Thin Engine Item Fixes

Branch: `v6.12-thin` (off `master` @ `6328c85`)

This PR strengthens five "wired but thin" engine components without touching
`model.ts` or `picksEngine.ts` (owned by the parallel pillars PR). Merge this
**after** the pillars PR lands, then follow the integration TODOs below.

---

## Fix 1 — Wind direction run adjustment (`server/sports/mlb/weather.ts`)

**Problem:** `windDirectionRunAdjust()` always returned `{ runAdj: 0.0 }` unless
an adapter pre-computed `windRunAdj`.

**Solution:**
- Added `PARK_ORIENTATIONS: Record<string, number>` — center-field compass bearing
  from home plate for all 30 MLB parks (e.g. Wrigley CF ≈ 30°, Coors ≈ 0°,
  Fenway ≈ 45°, Yankee Stadium ≈ 0°). Parks where the bearing is uncertain are
  marked with `// ~uncertain` and default to 0°.
- New signature: also accepts `windBearingDeg` (direction wind blows TO, 0=N)
  and `windMph` directly on the `weatherRaw` object.
- Computes the wind component along the home-plate → CF axis via `cos(Δbearing)`.
- Rate: `+0.04 runs per mph` along the out-to-CF axis; clamped `±0.40 runs`.
- Crosswinds (perpendicular) → 0.
- **Backward compat:** `windRunAdj` pre-computed by an adapter still takes
  highest priority and bypasses the calculation entirely.

**Also updated:** `server/adapters/openWeather.ts` — now surfaces `windBearingDeg`
on the returned `WeatherRefined`. OpenWeather's `wind.deg` is a "coming from"
bearing; we convert to "blowing to" by adding 180° mod 360.

**Integration TODO (no action needed now):**
None — `windDirectionRunAdjust()` is called from `model.ts` which the parallel
agent controls. The new bearing path activates automatically once `weatherRaw`
carries `windBearingDeg` (provided by the updated `openWeather.ts` adapter).

---

## Fix 2 — Umpire K-rate / zone-size effect on totals (`server/sports/mlb/umpires.ts`)

**Problem:** `UmpireAdjustment` only carried `runScoreAdj`; no K-rate signal
for the totals market.

**Solution:**
- Added `kRateAdj: number` to `UmpireAdjustment` (pp K-rate shift vs league avg;
  positive = expanded zone, more Ks).
- `kRateAdj` is populated from `profile.kPctDelta` (same value; the new field
  gives `picksEngine.ts` a named consumption point distinct from `kPctDelta`).
- New utility `umpireTotalsImpactPp(ump)` — market-side prior: returns `±pp`
  shift on totals win-probability (`−0.25pp per pp of K-rate delta`; capped `±2pp`).
  Ks affect totals faster than runs, so this is a market-side signal, not a
  run-scoring adjustment.
- `NEUTRAL_UMPIRE` updated to include `kRateAdj: 0`.
- Added `data/umpires_kRate.json` stub with empirical zone%/K%-bias for 10 known
  umpires (Hoberg, Hernández, Bucknor, West, Diaz, Iassogna, Wolf, Carlson,
  Kulpa, Wendelstedt). Refresh from Baseball Savant umpire scorecards each season.

**Integration TODO (picksEngine.ts — parallel agent's domain, v6.12.1):**
```
// TODO(picksEngine): wire kRateAdj into total-side calibration.
// umpireAdjustmentForGame() now returns kRateAdj (pp K-rate delta).
// Call umpireTotalsImpactPp(ump) to get the market-side pp prior and
// apply it to the totals win-prob before the total gate threshold check.
// See server/sports/mlb/umpires.ts → umpireTotalsImpactPp().
```

---

## Fix 3 — ABS framing → FIP penalty derivation (`server/sports/mlb/abs.ts`)

**Problem:** `fipPenalty` was a flat multiplier of `framingDependency × weight`;
it did not account for the specific catcher's actual framing value being lost.

**Solution:**
- Added `catcherFRS?: number | null` field to `AbsAdjustment` (framing runs saved
  per 162 G for the assigned catcher; `+5` = great framer whose edge evaporates
  under ABS, `−5` = poor framer who never provided an edge).
- New function `derivedFipPenalty(absExposurePct, catcherFRS)`:
  - `lostRunsPerGame = max(0, catcherFRS) / 162`
  - `penalty = absExposurePct × lostRunsPerGame × 9 / 5.5` (FIP units)
  - Capped at `+0.40` FIP; floored at `0`.
  - Returns `0` when `absExposurePct = 0` (ABS opt-out).
- `absAdjustmentForPitcher()` accepts an optional `{ catcherFRS, absExposurePct }`
  options bag; uses `derivedFipPenalty()` when `catcherFRS` is provided, falls
  back to the flat `absFipPenalty()` formula otherwise.
- **Backward compat:** `absFipPenalty(framingDependency)` signature is unchanged.
  `model.ts` callers continue to work without modification.

**Integration TODO (model.ts — parallel agent's domain, v6.12.1):**
```
// TODO(model.ts): pass catcherFRS (from catcher FRS lookup) and absExposurePct
// into absAdjustmentForPitcher() options so derivedFipPenalty() activates.
// Until then, the flat absFipPenalty() path remains active.
```

---

## Fix 4 — Public HANDLE vs bet count (`server/core/consensus.ts`, `server/adapters/oddsApi.ts`)

**Problem:** `ConsensusResult` only tracked bet-count probabilities; sharp money
(dollar handle) was not captured even when Odds API exposes it.

**Solution:**
- New fields on `ConsensusResult`: `publicHandlePct: number | null` and
  `sharpHandlePct: number | null`.
- When `ODDS_API_HANDLE_ENABLED=true`, parses `handle_pct` from bookmaker
  outcome objects (available on Odds API premium tiers alongside `bet_pct`).
- New utility `handleVsBetDivergence(handlePct, betPct)` — returns the spread.
  When `handle > bet` by `>10pp` on one side, sharp money is there even when
  public bet count disagrees (classic sharp-money tell).
- `RawOutcome` in `oddsApi.ts` now includes `bet_pct?` and `handle_pct?` fields
  so the data flows through to `rawBookmakers` without being stripped.
- **Default behavior unchanged:** when `ODDS_API_HANDLE_ENABLED` is not `"true"`,
  both handle fields are `null` and all existing behavior is identical.

**Integration TODO (assembleSignals.ts — follow-up PR, v6.12.1):**
```
// TODO(assembleSignals): read consensus.publicHandlePct / sharpHandlePct from
// the consensus payload (now exposed on ConsensusResult). Use
// handleVsBetDivergence(sharpHandlePct, publicPct) > 10 as a sharp-money
// corroboration signal for the SHARP signal source.
// See server/core/consensus.ts → handleVsBetDivergence().
```

---

## Fix 5 — Park factor L/R split (`server/sports/mlb/weather.ts`)

**Problem:** `PARK_FACTORS` was a single scalar per park; no handedness split.

**Solution:**
- Added `PARK_FACTORS_HANDED: Record<string, { L: number; R: number }>` covering
  all 30 parks. Eight asymmetric parks have researched L/R splits:
  - **NYY** `{L: 1.10, R: 0.96}` — short RF porch heavily favors LHB
  - **BOS** `{L: 1.02, R: 1.08}` — Green Monster favors RHB
  - **HOU** `{L: 1.02, R: 0.98}` — Crawford Boxes slight LHB edge
  - **MIN** `{L: 1.01, R: 0.97}` — Target Field slight LHB favor
  - **PHI** `{L: 1.06, R: 1.02}` — Citizens Bank slight LHB favor
  - **SF**  `{L: 0.93, R: 0.95}` — Oracle Park suppresses LHB more
  - **COL** `{L: 1.20, R: 1.16}` — Coors broadly homer-friendly, LHB marginal edge
  - **ARI** `{L: 1.07, R: 1.03}` — Chase Field slight LHB edge
  - Remaining 22 parks: symmetric stubs at their scalar factor (v6.12.1 follow-up)
- New utility `parkFactorForBatterHand(triCode, hand)` — returns the L or R factor;
  falls back to `parkFactorForTeam()` scalar when `hand` is null or park not in table.
- **`parkFactorForTeam()` signature is unchanged.** The parallel agent wires
  the handed version in v6.12.1.

**Integration TODO (picksEngine.ts — parallel agent's domain, v6.12.1):**
```
// TODO(picksEngine): replace parkFactorForTeam(triCode) with
// parkFactorForBatterHand(triCode, batterHand) at the lineup-weighted
// park-factor calculation so opposing lineup handedness profiles are used.
// See server/sports/mlb/weather.ts → parkFactorForBatterHand().
```

---

## Tests

New test files (do NOT add to `package.json` test script until after pillars merge
to keep CI clean — run manually or add in the bump PR):

| File | Tests | Fixes covered |
|------|-------|---------------|
| `server/__tests__/windDirection.test.ts` | 17 | Fix 1, Fix 5 |
| `server/__tests__/umpireKRate.test.ts`   |  6 | Fix 2 |
| `server/__tests__/absDerivedFip.test.ts` |  9 | Fix 3 |
| `server/__tests__/consensusHandle.test.ts` | 11 | Fix 4 |
| **Total new** | **43** | |

**All 989 pre-existing tests continue to pass** (`npm test` exit 0).

To run the new tests:
```bash
tsx server/__tests__/windDirection.test.ts
tsx server/__tests__/umpireKRate.test.ts
tsx server/__tests__/absDerivedFip.test.ts
tsx server/__tests__/consensusHandle.test.ts
```

---

## Files modified

| File | Type | Fix |
|------|------|-----|
| `server/sports/mlb/weather.ts` | Modified | Fix 1, Fix 5 |
| `server/adapters/openWeather.ts` | Modified | Fix 1 |
| `server/sports/mlb/umpires.ts` | Modified | Fix 2 |
| `server/sports/mlb/abs.ts` | Modified | Fix 3 |
| `server/core/consensus.ts` | Modified | Fix 4 |
| `server/adapters/oddsApi.ts` | Modified | Fix 4 |
| `server/__tests__/windDirection.test.ts` | New | Fix 1, Fix 5 |
| `server/__tests__/umpireKRate.test.ts` | New | Fix 2 |
| `server/__tests__/absDerivedFip.test.ts` | New | Fix 3 |
| `server/__tests__/consensusHandle.test.ts` | New | Fix 4 |
| `data/umpires_kRate.json` | New | Fix 2 |

**NOT modified:** `model.ts`, `picksEngine.ts`, `tier.ts`, `sources/`, `package.json`

---

## Merge instructions

1. Land the pillars PR (shadow SHADOW pillars branch) first.
2. Rebase `v6.12-thin` onto the merged master: `git rebase master`.
3. Resolve any import conflicts (none expected — separate files).
4. Add new test files to the `test` script in `package.json`.
5. Bump version to `v6.12.0` in `package.json`.
6. Wire integration TODOs (see each fix above) — most are single-line calls in
   `picksEngine.ts` and `assembleSignals.ts`.
7. Merge to master.
