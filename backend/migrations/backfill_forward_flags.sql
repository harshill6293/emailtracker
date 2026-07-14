-- One-off backfill: correct is_forward / original_event_id values that were
-- mis-computed by the detectForward() bug (fixed in routes/track.js), where
-- Apple/Gmail prefetch rows (ip_prefix IS NULL) were used as the "first open"
-- baseline instead of being skipped. Any real open compared against a
-- prefetch baseline was unconditionally flagged as a forward.
--
-- This recomputes is_forward/original_event_id for every real 'open' event
-- (ip_prefix IS NOT NULL) using the earliest real open per email as the
-- baseline — the same logic the patched detectForward() now applies. Emails
-- whose baseline was already a real open are unaffected (idempotent no-op).

WITH real_opens AS (
  SELECT
    id,
    email_tracking_id,
    ip_prefix,
    session_fingerprint,
    FIRST_VALUE(id) OVER w                  AS baseline_id,
    FIRST_VALUE(ip_prefix) OVER w            AS baseline_ip,
    FIRST_VALUE(session_fingerprint) OVER w  AS baseline_fp
  FROM events
  WHERE event_type = 'open'
    AND ip_prefix IS NOT NULL
  WINDOW w AS (PARTITION BY email_tracking_id ORDER BY occurred_at ASC)
)
UPDATE events e
SET
  is_forward = (ro.id != ro.baseline_id
                AND ro.session_fingerprint != ro.baseline_fp
                AND ro.ip_prefix != ro.baseline_ip),
  original_event_id = CASE
    WHEN ro.id = ro.baseline_id THEN NULL
    WHEN ro.session_fingerprint != ro.baseline_fp
     AND ro.ip_prefix != ro.baseline_ip THEN ro.baseline_id
    ELSE NULL
  END
FROM real_opens ro
WHERE e.id = ro.id
  AND (e.is_forward IS DISTINCT FROM (ro.id != ro.baseline_id
                AND ro.session_fingerprint != ro.baseline_fp
                AND ro.ip_prefix != ro.baseline_ip)
       OR e.original_event_id IS DISTINCT FROM CASE
            WHEN ro.id = ro.baseline_id THEN NULL
            WHEN ro.session_fingerprint != ro.baseline_fp
             AND ro.ip_prefix != ro.baseline_ip THEN ro.baseline_id
            ELSE NULL
          END);
