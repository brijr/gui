-- Sign-in moves to WorkOS AuthKit, which handles Google, Apple, GitHub, and email itself. An
-- account's sign-ins are now its WorkOS user and, from Gui's device flow, its GitHub user.

CREATE TABLE identities_workos (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'workos')),
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
INSERT INTO identities_workos
  SELECT provider, subject, account_id, email, created_at FROM identities
  WHERE provider = 'github';
DROP TABLE identities;
ALTER TABLE identities_workos RENAME TO identities;
CREATE INDEX identities_account ON identities(account_id);

-- Sign-ins in progress last 15 minutes; the email columns go with Gui's own email sign-in.
DROP TABLE auth_attempts;
CREATE TABLE auth_attempts (
  token_hash TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  port INTEGER NOT NULL,
  link_account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT,
  state_hash TEXT UNIQUE,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  exchange_hash TEXT,
  expires_at INTEGER NOT NULL
);
