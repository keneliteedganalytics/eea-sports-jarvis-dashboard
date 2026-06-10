-- Foxtail-grade MLB prop engine (v6.7) for the graded book
-- (server/gradedBook.ts → graded_book.db). gradedBook.ts applies these same
-- changes at runtime (CREATE TABLE for fresh DBs, ALTER TABLE ADD COLUMN via
-- ensureColumns for existing ones), so this file is the authoritative record for
-- anyone applying it manually. SQLite has no "ADD COLUMN IF NOT EXISTS"; run the
-- ALTERs only against a pre-v6.7 database.

-- Raw multi-book prop offerings. One row per book per market per player so the
-- pick builder can shop the best price. Refreshed each ingest run (quotes, not a
-- permanent ledger). Composite key dedupes a re-ingest of the same quote.
CREATE TABLE IF NOT EXISTS prop_offers (
  event_id TEXT,
  sport TEXT,
  game_date TEXT,
  player_name TEXT,
  player_id TEXT,
  team TEXT,
  market TEXT,
  line REAL,
  over_price INTEGER,
  under_price INTEGER,
  book TEXT,
  fetched_at TEXT,
  PRIMARY KEY (event_id, market, player_name, book)
);
CREATE INDEX IF NOT EXISTS idx_prop_offers_date ON prop_offers(game_date);
CREATE INDEX IF NOT EXISTS idx_prop_offers_event ON prop_offers(event_id);
CREATE INDEX IF NOT EXISTS idx_prop_offers_lookup ON prop_offers(player_name, market);

-- Simulation summary + hit-rate snapshot + best-book price on each prop pick.
ALTER TABLE prop_picks ADD COLUMN model_prob REAL;
ALTER TABLE prop_picks ADD COLUMN sim_median REAL;
ALTER TABLE prop_picks ADD COLUMN sim_p25 REAL;
ALTER TABLE prop_picks ADD COLUMN sim_p75 REAL;
ALTER TABLE prop_picks ADD COLUMN sim_mean REAL;
ALTER TABLE prop_picks ADD COLUMN sim_trials INTEGER;
ALTER TABLE prop_picks ADD COLUMN hit_rates_json TEXT;
ALTER TABLE prop_picks ADD COLUMN matchup_json TEXT;
ALTER TABLE prop_picks ADD COLUMN best_book TEXT;
ALTER TABLE prop_picks ADD COLUMN best_price INTEGER;
ALTER TABLE prop_picks ADD COLUMN market_label TEXT;
ALTER TABLE prop_picks ADD COLUMN stake_units REAL;
ALTER TABLE prop_picks ADD COLUMN hundred_club INTEGER NOT NULL DEFAULT 0;
