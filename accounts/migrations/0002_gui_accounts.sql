-- A Gui account is the person, whichever way they sign in (GitHub, Google, Apple, or an
-- emailed link). `users` stays as the account's GitHub connection: the tokens behind
-- repositories, cloning, and pull requests.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  updates INTEGER NOT NULL DEFAULT 0 CHECK (updates IN (0, 1)),
  preference_changed_at INTEGER,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
CREATE INDEX accounts_email ON accounts(email COLLATE NOCASE);

CREATE TABLE identities (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google', 'apple', 'email')),
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_account ON identities(account_id);

-- Every GitHub user so far becomes an account with GitHub as its sign-in. Nobody was asked
-- about product updates (accounts with an email started subscribed), so only a choice made
-- in Settings carries over. Accounts are made first, so every reference to one is valid.
CREATE TABLE account_ids (github_id INTEGER PRIMARY KEY, id TEXT NOT NULL);
INSERT INTO account_ids SELECT github_id, lower(hex(randomblob(16))) FROM users;
INSERT INTO accounts (id, email, name, updates, preference_changed_at, created_at, last_login_at)
  SELECT account_ids.id, email, name,
    CASE WHEN preference_changed_at IS NULL THEN 0 ELSE updates END,
    preference_changed_at, created_at, last_login_at
  FROM users JOIN account_ids USING (github_id);
INSERT INTO identities (provider, subject, account_id, email, created_at)
  SELECT 'github', CAST(github_id AS TEXT), account_ids.id, email, created_at
  FROM users JOIN account_ids USING (github_id);
ALTER TABLE users ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE;
UPDATE users SET account_id = (SELECT id FROM account_ids WHERE account_ids.github_id = users.github_id);
CREATE UNIQUE INDEX users_account ON users(account_id);

-- Sessions belong to the account. Signed-in devices stay signed in.
CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
INSERT INTO account_sessions (token_hash, account_id, expires_at)
  SELECT sessions.token_hash, account_ids.id, sessions.expires_at
  FROM sessions JOIN account_ids USING (github_id);
DROP TABLE sessions;
ALTER TABLE account_sessions RENAME TO sessions;
CREATE INDEX sessions_account ON sessions(account_id);
DROP TABLE account_ids;

-- A sign-in from the desktop: the app holds the token (hashed here) and listens on a
-- loopback port; the browser finishes with a provider or an emailed link, and the app trades
-- the one-time exchange code for a session. With link_account_id, it adds a sign-in method
-- (GitHub) to that account instead.
CREATE TABLE auth_attempts (
  token_hash TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  port INTEGER NOT NULL,
  link_account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT,
  state_hash TEXT UNIQUE,
  email TEXT,
  email_code_hash TEXT,
  email_link_hash TEXT UNIQUE,
  email_tries INTEGER NOT NULL DEFAULT 0,
  emails_sent INTEGER NOT NULL DEFAULT 0,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  exchange_hash TEXT,
  expires_at INTEGER NOT NULL
);
