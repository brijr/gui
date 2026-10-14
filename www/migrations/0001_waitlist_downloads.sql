-- People who want Gui on Windows or Linux. One row per address.
CREATE TABLE waitlist (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'linux')),
  country TEXT,
  created_at INTEGER NOT NULL
);
-- One row per request to /download. No IP addresses or other personal data.
CREATE TABLE downloads (
  id INTEGER PRIMARY KEY,
  file TEXT NOT NULL,
  country TEXT,
  referrer TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX downloads_created ON downloads(created_at);
