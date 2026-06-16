# Gmail Email Tracker

A Chrome extension + local Node.js/Express backend that tracks when your Gmail emails are opened and links clicked. All data stays on your machine — no third-party services, no cloud. The extension intercepts Gmail's compose window via DOM manipulation, injects a 1×1 tracking pixel and rewrites links before sending, then displays open events, link clicks, and forwarded-email detection in a popup dashboard.

---

## Prerequisites

- Node.js v20+
- PostgreSQL 15 (Docker recommended)
- Chrome browser

---

## Quick Start

### 1. Clone or download this project

```bash
git clone <repo-url>
cd email-tracker
```

### 2. Set up the database

```bash
# Start Postgres with Docker
docker run --name email-tracker-db \
  -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_DB=email_tracker \
  -p 5432:5432 \
  -d postgres:15

# Apply schema
cd backend && npm install
cp .env.example .env
npm run setup-db
```

### 3. Generate icons and start the backend

```bash
npm run generate-icons
npm run dev
# Backend running at http://localhost:3000
# Test it: curl http://localhost:3000/health
```

### 4. Load the extension in Chrome

- Open Chrome → `chrome://extensions`
- Enable **Developer mode** (top-right toggle)
- Click **Load unpacked** → select the `extension/` folder
- The "T" icon appears in the Chrome toolbar

### 5. Test it

Send a Gmail email and open it from another device or browser tab — the open event will appear in the popup.

---

## How It Works

1. **DOM interception**: The content script watches Gmail with a `MutationObserver`. When a compose window opens, it attaches a capture-phase click handler to the Send button.

2. **On Send**: The handler stops the click, extracts the subject, recipients, and body HTML, then calls `POST /api/email` on the local backend to register the email and its links.

3. **Pixel injection**: The backend returns a signed tracking ID. The content script injects a 1×1 `<img>` pointing to `GET /t/o/<signedId>` into the email body, then re-fires the send button so Gmail sends normally.

4. **Link rewriting**: All `http(s)://` links in the email body are rewritten to `GET /t/l/<signedLinkId>`, which logs the click and redirects to the original URL.

5. **Forward detection**: A second open from a different IP prefix + session fingerprint is flagged as a possible forward and shown separately in the popup.

6. **Popup**: The service worker polls `GET /api/emails` every 30 seconds and stores results in `chrome.storage.local`. The popup reads from local storage and renders the timeline.

---

## Security

- **HMAC-signed tracking IDs**: All IDs in URLs are signed as `{uuid}.{hmac16}` — recipients cannot forge or enumerate IDs.
- **Timing-safe comparison**: `crypto.timingSafeEqual` is used when verifying HMAC signatures.
- **IP anonymisation**: Only the first 3 octets of IPv4 addresses are stored. Full IPs are never persisted.
- **Email address hashing**: Recipient email addresses are stored as HMAC-SHA256 hashes. Raw addresses never touch the database.
- **Parameterised queries**: Every SQL query uses `$1, $2, ...` placeholders. No string interpolation anywhere.
- **Rate limiting**: 60 req/min on tracking endpoints, 100 req/min on API endpoints.
- **Helmet.js**: Security headers on all responses.
- **Opt-out footer**: Every tracked email includes a visible opt-out link — required for compliance.
- **Apple Mail prefetch filtering**: Pre-fetch requests from Apple's privacy relay are detected by User-Agent and excluded from open counts.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup shows "Never synced — is the backend running?" | Run `npm run dev` in `backend/` |
| Extension not intercepting sends | Reload the extension at `chrome://extensions`, then refresh Gmail |
| Gmail DOM changed / tracking not injecting | Open DevTools on the Gmail tab and look for `[EmailTracker ERROR]` in the console — the selectors may need updating |
| `ECONNREFUSED` on `setup-db` | Check your `DATABASE_URL` in `.env` and confirm Postgres is running |
| `npm run generate-icons` fails with node-gyp error | The `canvas` package requires native build tools. On macOS: `xcode-select --install`. On Linux: `apt install build-essential libcairo2-dev`. Alternatively, place any 16×16, 48×48, 128×128 PNG files in `extension/icons/` manually. |

---

## Upgrading to Production

1. Deploy the backend to a service like [Railway](https://railway.app) or a VPS.
2. Set `BACKEND_URL` in `.env` to your public URL, e.g. `https://tracker.yourdomain.com`.
3. Update `HMAC_SECRET` and `EMAIL_HASH_SECRET` to strong random values (32+ chars).
4. In `extension/manifest.json`, add your domain to `host_permissions` and **remove** `"http://localhost/*"`.
5. In `backend/server.js`, lock CORS to your extension's origin: replace the `allowedOrigins` array with `[/^chrome-extension:\/\/YOUR_EXTENSION_ID$/]`.
6. Submit the extension to the Chrome Web Store or distribute it privately.
