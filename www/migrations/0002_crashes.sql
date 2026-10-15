-- One row per crash report from an installed Gui (src/main/crash-reports.ts): what failed and
-- where, with the Gui and macOS versions. No IP addresses, code, files, or chats.
CREATE TABLE crashes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  version TEXT NOT NULL,
  os TEXT,
  arch TEXT,
  country TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX crashes_created ON crashes(created_at);
