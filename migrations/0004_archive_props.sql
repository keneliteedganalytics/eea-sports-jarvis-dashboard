-- Archive system + player-prop analytics scaffolding (v6.5) for the graded book
-- (server/gradedBook.ts → graded_book.db). gradedBook.ts applies these same
-- changes at runtime (CREATE TABLE for fresh DBs, ALTER TABLE ADD COLUMN via
-- ensureColumns for existing ones), so this file is the authoritative record for
-- anyone applying it manually. SQLite has no "ADD COLUMN IF NOT EXISTS"; run the
-- ALTERs only against a pre-v6.5 database.

-- Archive + final-score columns on the permanent pick_history ledger. archived_at
-- is set to graded_at on the final transition (immediate archive); existing rows
-- are backfilled to graded_at + 6h on boot.
ALTER TABLE pick_history ADD COLUMN archived_at TEXT;
ALTER TABLE pick_history ADD COLUMN final_away_score INTEGER;
ALTER TABLE pick_history ADD COLUMN final_home_score INTEGER;
ALTER TABLE pick_history ADD COLUMN home_team TEXT;
ALTER TABLE pick_history ADD COLUMN away_team TEXT;
CREATE INDEX IF NOT EXISTS idx_pick_history_archived_at ON pick_history(archived_at);

-- Player-prop pick ledger — a separate domain from game-line picks. One row per
-- (game, player, market, side). Storage + grading + API land now; prop generation
-- is a follow-up.
CREATE TABLE IF NOT EXISTS prop_picks (
  pick_id TEXT PRIMARY KEY,
  sport TEXT,
  game_id TEXT,
  player_name TEXT,
  player_id TEXT,
  team TEXT,
  opponent TEXT,
  market_type TEXT,
  line REAL,
  side TEXT,
  posted_odds INTEGER,
  closing_odds INTEGER,
  posted_at TEXT,
  graded_at TEXT,
  result TEXT,
  actual_value REAL,
  pl_units REAL,
  pl_dollars REAL,
  tier TEXT,
  confidence INTEGER,
  edge_pp REAL,
  data_quality_tier TEXT,
  clv_pct REAL
);
CREATE INDEX IF NOT EXISTS idx_prop_picks_sport ON prop_picks(sport);
CREATE INDEX IF NOT EXISTS idx_prop_picks_market ON prop_picks(market_type);
CREATE INDEX IF NOT EXISTS idx_prop_picks_player ON prop_picks(player_name);
