CREATE TABLE journals (
  owner TEXT PRIMARY KEY,
  profile_id TEXT,
  envelope TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  CHECK ((profile_id IS NULL) = (envelope IS NULL))
) WITHOUT ROWID;
