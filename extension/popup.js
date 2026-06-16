'use strict';

const emailsList = document.getElementById('emails-list');
const lastFetchEl = document.getElementById('last-fetch');
const refreshBtn = document.getElementById('refresh-btn');
const errorBanner = document.getElementById('error-banner');

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return d.toLocaleDateString();
}

function makeEventRow(ev, linksMap) {
  const row = document.createElement('div');
  row.className = 'event-row';

  const dot = document.createElement('span');
  const text = document.createElement('span');

  if (ev.type === 'open') {
    const isPrefetch = ev.fingerprint === 'apple_prefetch';
    dot.className = isPrefetch ? 'event-dot' : 'event-dot dot-open';
    dot.style.background = isPrefetch ? '#ccc' : '';
    const fwdTag = ev.is_forward ? ' ↩ forwarded' : '';
    text.textContent = isPrefetch
      ? `Apple Mail prefetch — ${formatDate(ev.occurred_at)}`
      : `Opened${fwdTag} — ${formatDate(ev.occurred_at)}`;
  } else if (ev.type === 'click') {
    dot.className = 'event-dot dot-click';
    const linkUrl = linksMap[ev.link_id] || 'unknown link';
    const shortUrl = linkUrl.length > 40 ? linkUrl.slice(0, 40) + '…' : linkUrl;
    text.textContent = `Clicked "${shortUrl}" — ${formatDate(ev.occurred_at)}`;
  }

  row.appendChild(dot);
  row.appendChild(text);
  return row;
}

function renderEmails(emails) {
  emailsList.innerHTML = '';

  if (!emails || emails.length === 0) {
    emailsList.innerHTML = `
      <div class="empty-state">
        <div class="icon">📬</div>
        <div>No tracked emails yet.</div>
        <div style="margin-top:4px">Send a Gmail email and it will appear here.</div>
      </div>`;
    return;
  }

  emails.forEach(email => {
    const events = email.events || [];
    const links = email.links || [];
    const linksMap = Object.fromEntries(links.map(l => [l.id, l.url]));

    const opens = events.filter(e => e.type === 'open' && e.fingerprint !== 'apple_prefetch');
    const prefetches = events.filter(e => e.fingerprint === 'apple_prefetch');
    const clicks = events.filter(e => e.type === 'click');
    const forwards = opens.filter(e => e.is_forward);

    const card = document.createElement('div');
    card.className = 'email-card';

    // Header row
    const header = document.createElement('div');
    header.className = 'email-header';

    const subject = document.createElement('div');
    subject.className = 'email-subject';
    subject.textContent = email.subject || '(no subject)';

    const badges = document.createElement('div');
    badges.style.cssText = 'display:flex;gap:4px;flex-shrink:0';

    if (opens.length > 0) {
      const b = document.createElement('span');
      b.className = 'badge badge-open';
      b.textContent = `👁 ${opens.length}`;
      badges.appendChild(b);
    }
    if (clicks.length > 0) {
      const b = document.createElement('span');
      b.className = 'badge badge-click';
      b.textContent = `🔗 ${clicks.length}`;
      badges.appendChild(b);
    }
    if (forwards.length > 0) {
      const b = document.createElement('span');
      b.className = 'badge badge-fwd';
      b.textContent = `↩ fwd`;
      badges.appendChild(b);
    }
    if (opens.length === 0 && clicks.length === 0) {
      const b = document.createElement('span');
      b.className = 'badge badge-none';
      b.textContent = 'Not opened';
      badges.appendChild(b);
    }

    header.appendChild(subject);
    header.appendChild(badges);

    const meta = document.createElement('div');
    meta.className = 'email-meta';
    meta.textContent = `Sent ${formatDate(email.sent_at)}`;

    card.appendChild(header);
    card.appendChild(meta);

    // Events section (hidden by default, shown on click)
    const eventsEl = document.createElement('div');
    eventsEl.className = 'email-events';

    if (events.length === 0) {
      const none = document.createElement('div');
      none.style.cssText = 'font-size:11px;color:#aaa;';
      none.textContent = 'No events yet.';
      eventsEl.appendChild(none);
    } else {
      // Sort events by time
      const sorted = [...events].sort(
        (a, b) => new Date(a.occurred_at) - new Date(b.occurred_at)
      );
      sorted.forEach(ev => {
        eventsEl.appendChild(makeEventRow(ev, linksMap));
      });
    }

    if (prefetches.length > 0) {
      const note = document.createElement('div');
      note.className = 'prefetch-note';
      note.textContent = `${prefetches.length} Apple Mail prefetch(es) excluded from open count.`;
      eventsEl.appendChild(note);
    }

    card.appendChild(eventsEl);

    // Toggle expand on click
    card.addEventListener('click', () => {
      card.classList.toggle('expanded');
    });

    emailsList.appendChild(card);
  });
}

function loadData(forceRefresh = false) {
  lastFetchEl.textContent = 'Refreshing…';
  chrome.runtime.sendMessage(
    { type: forceRefresh ? 'FORCE_REFRESH' : 'GET_EMAILS' },
    response => {
      if (chrome.runtime.lastError) {
        errorBanner.style.display = 'block';
        errorBanner.textContent = 'Could not connect to extension background.';
        return;
      }
      errorBanner.style.display = 'none';
      const { emails, lastFetch } = response;
      renderEmails(emails);
      lastFetchEl.textContent = lastFetch
        ? `Last updated ${formatDate(lastFetch)}`
        : 'Never synced — is the backend running?';
    }
  );
}

refreshBtn.addEventListener('click', () => loadData(true));
document.addEventListener('DOMContentLoaded', () => loadData(false));
