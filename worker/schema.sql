-- One row per file ever seen, including deleted ones.
--
-- A deleted file keeps its row with hash NULL rather than being removed: without that tombstone, a skill
-- you delete on one machine is simply absent from the index, and the next machine to sync sees no reason
-- not to upload it again.
--
-- `seq` is a monotonic counter, not a timestamp. Clients poll with the highest seq they have applied, and
-- two machines writing in the same millisecond would otherwise let one of them be skipped forever.
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  hash       TEXT,
  seq        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS files_by_seq ON files(seq);

-- One row per machine that has signed in. The token itself is never stored — only its SHA-256 — so a
-- dump of this table cannot be replayed against the service.
--
-- Identity comes from Cloudflare Access, which authenticates the browser before the login request ever
-- reaches the Worker; this table only records that a device was handed a token on the back of it.
CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  machine    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);
