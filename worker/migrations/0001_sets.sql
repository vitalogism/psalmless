-- Challenge sets: a fixed, ordered list of songs that many players can play and compare.
-- Run once against an existing database (fresh installs get this from schema.sql):
--   npx wrangler d1 execute psalmless --remote --file=migrations/0001_sets.sql
CREATE TABLE IF NOT EXISTS sets (
  id TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  songs TEXT NOT NULL,        -- JSON track records in play order, easy to hard
  size INTEGER NOT NULL,
  mult REAL NOT NULL,
  pool TEXT NOT NULL,         -- JSON [artist, trackId] pairs: the hymnal the set was drawn from, for autocomplete
  settings TEXT NOT NULL,     -- JSON {artists, years, pop}
  creator TEXT,               -- name the first finisher inscribed
  plays INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS set_results (
  run TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  detail TEXT NOT NULL,       -- JSON per-song [{w, s, p}]: won, stage named at, points
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS set_results_set ON set_results(set_id, score DESC);

ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'survival';
ALTER TABLE runs ADD COLUMN set_id TEXT;
ALTER TABLE runs ADD COLUMN history TEXT NOT NULL DEFAULT '[]';
