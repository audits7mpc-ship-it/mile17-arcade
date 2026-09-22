-- Mile 17 day pass — run this once in the D1 Console after creating the
-- database. It makes the single table the pass server writes to.

CREATE TABLE IF NOT EXISTS passes (
  id      TEXT PRIMARY KEY,   -- "2026-09-22:<device fingerprint>"
  day     TEXT NOT NULL,      -- the IST date this pass belongs to
  game    TEXT NOT NULL,      -- 'spin' (Jackpot) or 'wheel'
  tries   INTEGER NOT NULL,   -- 3 for Jackpot, 1 for the wheel
  spent   INTEGER NOT NULL DEFAULT 0,
  win_on  INTEGER,            -- which pull wins, or NULL. Never sent to the phone.
  won     INTEGER NOT NULL DEFAULT 0,
  code    TEXT,
  intro   INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS passes_day ON passes(day);
