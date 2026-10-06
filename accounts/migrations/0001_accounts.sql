CREATE TABLE users (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  name TEXT,
  email TEXT,
  updates INTEGER NOT NULL DEFAULT 0 CHECK (updates IN (0, 1)),
  preference_changed_at INTEGER,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  github_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at INTEGER NOT NULL,
  refresh_lock_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(github_id);
CREATE TABLE login_attempts (
  token_hash TEXT PRIMARY KEY,
  device_code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  interval_seconds INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL
);
