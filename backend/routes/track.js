const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');

const router = express.Router();

// 1x1 transparent GIF — the tracking pixel response
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// --- Helper: HMAC signing and verification ---
// All tracking IDs sent into the world are signed as "{uuid}.{hmac16}"
// The HMAC prevents recipients from forging or enumerating IDs.

function signId(uuid) {
  const mac = crypto
    .createHmac('sha256', process.env.HMAC_SECRET)
    .update(uuid)
    .digest('hex')
    .slice(0, 16);
  return `${uuid}.${mac}`;
}

function verifySignedId(signedId) {
  if (!signedId || typeof signedId !== 'string') return null;
  const dotIndex = signedId.lastIndexOf('.');
  if (dotIndex === -1) return null;
  const uuid = signedId.slice(0, dotIndex);
  const provided = signedId.slice(dotIndex + 1);
  const expected = crypto
    .createHmac('sha256', process.env.HMAC_SECRET)
    .update(uuid)
    .digest('hex')
    .slice(0, 16);
  // Use timingSafeEqual to prevent timing attacks
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(provided, 'hex'),
      Buffer.from(expected, 'hex')
    );
    return valid ? uuid : null;
  } catch {
    return null;
  }
}

// --- Helper: IP utilities ---

function getClientIp(req) {
  // Handle Cloudflare, load balancers, etc.
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.connection.remoteAddress ||
    req.ip ||
    '0.0.0.0'
  );
}

function truncateIp(ip) {
  if (!ip) return null;
  // IPv4: return first 3 octets (anonymise last octet)
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}`;
  // IPv6: return first 4 groups
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':');
  }
  return ip;
}

// --- Helper: Session fingerprint ---
// Combines truncated IP + User-Agent. Stable enough to identify same person,
// different enough to distinguish two people.

function sessionFingerprint(ip, userAgent) {
  return crypto
    .createHash('sha256')
    .update(`${truncateIp(ip)}|${(userAgent || '').slice(0, 200)}`)
    .digest('hex')
    .slice(0, 32);
}

// --- Helper: Forward detection ---
// An open event is a "possible forward" if the same email's tracking ID
// has already fired from a DIFFERENT IP prefix AND a DIFFERENT fingerprint.

async function detectForward(emailTrackingId, ipPrefix, fingerprint) {
  const result = await query(
    `SELECT ip_prefix, session_fingerprint
     FROM events
     WHERE email_tracking_id = $1
       AND event_type = 'open'
       AND is_forward = false
     ORDER BY occurred_at ASC
     LIMIT 1`,
    [emailTrackingId]
  );
  if (result.rows.length === 0) return { isForward: false, originalEventId: null };

  const first = result.rows[0];
  const isForward =
    first.session_fingerprint !== fingerprint &&
    first.ip_prefix !== ipPrefix;

  if (!isForward) return { isForward: false, originalEventId: null };

  // Get the ID of the original (first) event for chaining
  const origResult = await query(
    `SELECT id FROM events
     WHERE email_tracking_id = $1
       AND event_type = 'open'
       AND is_forward = false
     ORDER BY occurred_at ASC LIMIT 1`,
    [emailTrackingId]
  );
  return {
    isForward: true,
    originalEventId: origResult.rows[0]?.id || null
  };
}

// --- Helper: Apple Mail Privacy Protection detection ---
// Apple pre-fetches images before the user opens the email.
// Flag these to exclude from open counts in the dashboard.

function isApplePrefetch(userAgent) {
  if (!userAgent) return false;
  return (
    userAgent.includes('AppleExchangeWebServices') ||
    userAgent.includes('iOS Mail') ||
    userAgent.includes('Outlook-iOS') ||
    // Apple's iCloud relay uses this pattern
    userAgent.includes('Mimestream')
  );
}

// ============================================================
// ROUTE: GET /t/o/:signedId
// Email open tracking pixel.
// Always returns a 1x1 transparent GIF, even on error.
// ============================================================

router.get('/o/:signedId', async (req, res) => {
  // Always return the pixel immediately — never block on DB writes
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': TRANSPARENT_GIF.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(TRANSPARENT_GIF);

  // Log asynchronously — do not await
  setImmediate(async () => {
    try {
      const emailTrackingId = verifySignedId(req.params.signedId);
      if (!emailTrackingId) return; // Invalid or tampered ID — ignore silently

      // Verify email exists; fetch sender identity to filter out compose-window loads
      const emailCheck = await query(
        'SELECT id, sender_ip_prefix, sender_fingerprint FROM tracked_emails WHERE tracking_id = $1',
        [emailTrackingId]
      );
      if (emailCheck.rows.length === 0) return;

      const ip = getClientIp(req);
      const userAgent = req.headers['user-agent'] || '';
      const ipPrefix = truncateIp(ip);
      const fingerprint = sessionFingerprint(ip, userAgent);
      const prefetch = isApplePrefetch(userAgent);

      // Skip events from the sender's own browser loading the pixel while composing.
      // Require BOTH ip prefix and fingerprint (IP + User-Agent hash) to match so that
      // a recipient on the same network with a different email client is still counted.
      const { sender_ip_prefix: senderIpPrefix, sender_fingerprint: senderFingerprint } = emailCheck.rows[0];
      if (senderIpPrefix && senderFingerprint &&
          ipPrefix === senderIpPrefix &&
          fingerprint === senderFingerprint) return;

      const { isForward, originalEventId } = prefetch
        ? { isForward: false, originalEventId: null }
        : await detectForward(emailTrackingId, ipPrefix, fingerprint);

      await query(
        `INSERT INTO events
           (email_tracking_id, event_type, ip_prefix, session_fingerprint,
            is_forward, original_event_id, user_agent)
         VALUES ($1, 'open', $2, $3, $4, $5, $6)`,
        [
          emailTrackingId,
          prefetch ? null : ipPrefix,       // don't store IP for Apple prefetches
          prefetch ? 'apple_prefetch' : fingerprint,
          isForward,
          originalEventId,
          userAgent.slice(0, 500)
        ]
      );
    } catch (err) {
      console.error('Pixel logging error:', err.message);
    }
  });
});

// ============================================================
// ROUTE: GET /t/l/:signedId
// Link click tracking — logs event and redirects to original URL.
// ============================================================

router.get('/l/:signedId', async (req, res) => {
  let redirectUrl = null;

  try {
    const linkId = verifySignedId(req.params.signedId);
    if (!linkId) {
      return res.status(400).send('Invalid link');
    }

    // Look up original URL
    const linkResult = await query(
      `SELECT tl.original_url, te.tracking_id AS email_tracking_id
       FROM tracked_links tl
       JOIN tracked_emails te ON te.id = tl.email_id
       WHERE tl.link_id = $1`,
      [linkId]
    );

    if (linkResult.rows.length === 0) {
      return res.status(404).send('Link not found');
    }

    const { original_url, email_tracking_id } = linkResult.rows[0];
    redirectUrl = original_url;

    // Redirect immediately, log asynchronously
    res.redirect(302, redirectUrl);

    setImmediate(async () => {
      try {
        const ip = getClientIp(req);
        const userAgent = req.headers['user-agent'] || '';
        await query(
          `INSERT INTO events
             (email_tracking_id, link_id, event_type, ip_prefix,
              session_fingerprint, user_agent)
           VALUES ($1, $2, 'click', $3, $4, $5)`,
          [
            email_tracking_id,
            linkId,
            truncateIp(ip),
            sessionFingerprint(ip, userAgent),
            userAgent.slice(0, 500)
          ]
        );
      } catch (err) {
        console.error('Click log error:', err.message);
      }
    });

  } catch (err) {
    console.error('Link redirect error:', err.message);
    if (!res.headersSent) {
      if (redirectUrl) res.redirect(302, redirectUrl);
      else res.status(500).send('Error processing link');
    }
  }
});

// Export signId and IP helpers so api.js can use them
module.exports = router;
module.exports.signId = signId;
module.exports.getClientIp = getClientIp;
module.exports.truncateIp = truncateIp;
module.exports.sessionFingerprint = sessionFingerprint;
