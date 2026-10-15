-- `bun run crashes`: crash reports from the last 7 days, the most frequent first.
SELECT
  COUNT(*) AS reports,
  kind,
  message,
  GROUP_CONCAT(DISTINCT version) AS versions,
  datetime(MAX(created_at), 'unixepoch') AS last_seen
FROM crashes
WHERE created_at > unixepoch() - 7 * 86400
GROUP BY kind, message
ORDER BY reports DESC
LIMIT 50;
