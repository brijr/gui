-- `bun run stats`: downloads and waitlist sign-ups, in total and for the last 7 and 30 days.
SELECT
  'downloads' AS what,
  COUNT(*) AS total,
  SUM(created_at > unixepoch() - 7 * 86400) AS last_7_days,
  SUM(created_at > unixepoch() - 30 * 86400) AS last_30_days
FROM downloads
UNION ALL
SELECT
  'waitlist ' || platform,
  COUNT(*),
  SUM(created_at > unixepoch() - 7 * 86400),
  SUM(created_at > unixepoch() - 30 * 86400)
FROM waitlist
GROUP BY platform;
