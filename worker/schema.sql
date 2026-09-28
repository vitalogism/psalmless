-- per-artist song lists from Apple Music, refreshed every few days
CREATE TABLE IF NOT EXISTS artists (
  name TEXT PRIMARY KEY,      -- lowercased search term
  fetched INTEGER NOT NULL,
  data TEXT NOT NULL          -- JSON track records, most popular first
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  pool TEXT NOT NULL,         -- JSON track records the run deals from
  pool_size INTEGER NOT NULL,
  mult REAL NOT NULL,
  used TEXT NOT NULL DEFAULT '[]',
  round INTEGER NOT NULL DEFAULT 0,
  stage INTEGER NOT NULL DEFAULT 0,
  guesses TEXT NOT NULL DEFAULT '[]',
  lives INTEGER NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  track TEXT,                 -- JSON record of the song in play (never sent while playing)
  last TEXT,                  -- JSON result of the previous round, for the reveal
  state TEXT NOT NULL,        -- play | reveal | over
  submitted INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'survival',  -- survival | set
  set_id TEXT,                -- the challenge set a set-mode run plays
  history TEXT NOT NULL DEFAULT '[]'      -- JSON per-song [{w, s, p}] once each round ends
);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created);

CREATE TABLE IF NOT EXISTS scores (
  run TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  best_streak INTEGER NOT NULL,
  pool_size INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scores_score ON scores(score DESC);
CREATE INDEX IF NOT EXISTS scores_created ON scores(created);

-- challenge sets: a fixed, ordered list of songs many players can play and compare
CREATE TABLE IF NOT EXISTS sets (
  id TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  songs TEXT NOT NULL,        -- JSON track records in play order, easy to hard
  size INTEGER NOT NULL,
  mult REAL NOT NULL,
  pool TEXT NOT NULL,         -- JSON [artist, trackId] pairs the set was drawn from, for autocomplete
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
  detail TEXT NOT NULL,       -- JSON per-song [{w, s, p}]
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS set_results_set ON set_results(set_id, score DESC);
