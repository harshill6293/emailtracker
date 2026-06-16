'use strict';

const BACKEND_URL = 'http://localhost:3000';
const POLL_ALARM = 'poll-events';
const POLL_INTERVAL_MINUTES = 0.5; // every 30 seconds

// ─── Alarm setup ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, {
    delayInMinutes: 0.1,
    periodInMinutes: POLL_INTERVAL_MINUTES
  });
  console.log('[EmailTracker BG] Installed. Polling alarm set.');
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) fetchAndStoreEvents();
});

// ─── Fetch events from backend and store locally ──────────────────────────────

async function fetchAndStoreEvents() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/emails`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) return;

    const data = await response.json();
    const emails = data.emails || [];

    // Load previously stored emails to detect new opens for notifications
    const { storedEmails = [] } = await chrome.storage.local.get('storedEmails');
    const prevOpenMap = new Map(storedEmails.map(e => [
      e.tracking_id,
      (e.events || []).filter(ev => ev.type === 'open').length
    ]));

    // Store fresh data
    await chrome.storage.local.set({ storedEmails: emails, lastFetch: Date.now() });

    // Fire notifications for new opens
    for (const email of emails) {
      const opens = (email.events || []).filter(ev => ev.type === 'open' && ev.fingerprint !== 'apple_prefetch');
      const prevCount = prevOpenMap.get(email.tracking_id) || 0;
      if (opens.length > prevCount && opens.length === 1) {
        // First open — notify
        chrome.notifications.create(`open-${email.tracking_id}`, {
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Email opened',
          message: `"${email.subject}" was just opened.`
        });
      }
    }

  } catch (err) {
    // Backend unreachable — silently skip (will retry on next alarm)
    console.log('[EmailTracker BG] Fetch skipped:', err.message);
  }
}

// ─── Message handler — popup requests data ────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_EMAILS') {
    chrome.storage.local.get(['storedEmails', 'lastFetch'], data => {
      sendResponse({
        emails: data.storedEmails || [],
        lastFetch: data.lastFetch || null
      });
    });
    return true; // keep channel open for async sendResponse
  }

  if (message.type === 'FORCE_REFRESH') {
    fetchAndStoreEvents().then(() => {
      chrome.storage.local.get(['storedEmails', 'lastFetch'], data => {
        sendResponse({ emails: data.storedEmails || [], lastFetch: data.lastFetch });
      });
    });
    return true;
  }
});
