'use strict';

const BACKEND_URL = 'http://localhost:3000';

// ─── State ───────────────────────────────────────────────────────────────────

// WeakMap tracks which send buttons we've already attached handlers to
const attachedButtons = new WeakMap();
// WeakSet tracks compose windows currently being processed (prevents double-fire)
const processingComposes = new WeakSet();

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(...args) {
  console.log('[EmailTracker]', ...args);
}

function logError(...args) {
  console.error('[EmailTracker ERROR]', ...args);
}

// Generate a UUID v4 without crypto.randomUUID() for broader compatibility
function generateUUID() {
  return crypto.randomUUID();
}

// ─── Gmail DOM helpers ────────────────────────────────────────────────────────
// Gmail's DOM structure is not guaranteed to stay stable. We try multiple
// selectors and fall back gracefully. We NEVER rely on minified class names.

// Given a send button, find its compose container — either a dialog (new compose /
// pop-out reply) or the nearest ancestor that also contains the message body
// (inline reply within a thread).
function findComposeContainer(sendButton) {
  const dialog = sendButton.closest('[role="dialog"]');
  if (dialog) return dialog;

  // Inline reply: walk up until we find an ancestor that holds the editable body
  let el = sendButton.parentElement;
  while (el && el !== document.body) {
    if (getBodyElement(el)) return el;
    el = el.parentElement;
  }
  return null;
}

function findSendButton(compose) {
  // Try stable selectors first (aria-label, data-tooltip)
  const selectors = [
    '[data-tooltip*="Send"]',
    '[aria-label*="Send "]',
    '[data-tooltip="Send"]',
    '[jsaction*="send"]',
    'div[role="button"][tabindex="1"]'
  ];
  for (const sel of selectors) {
    const el = compose.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function getRecipientsFromField(compose, fieldLabel) {
  // Gmail recipient chips contain the email in various attributes.
  // We try in order: [email], [data-hovercard-id], title, and inner text patterns.
  const emails = new Set();

  // Strategy 1: Look for elements with an [email] attribute in the field area
  // Gmail sometimes marks chips with email=""
  const fieldSelectors = [
    `[aria-label="${fieldLabel}"]`,
    `[placeholder="${fieldLabel}"]`
  ];

  let fieldEl = null;
  for (const sel of fieldSelectors) {
    fieldEl = compose.querySelector(sel);
    if (fieldEl) break;
  }

  if (fieldEl) {
    // Walk up to the field container
    const container = fieldEl.closest('[data-name]') ||
                      fieldEl.closest('.az9') ||   // Gmail container class (may change)
                      fieldEl.parentElement?.parentElement;

    if (container) {
      // Strategy: find all elements with email data
      container.querySelectorAll('[email]').forEach(el => {
        const e = el.getAttribute('email');
        if (e && e.includes('@')) emails.add(e.toLowerCase().trim());
      });

      container.querySelectorAll('[data-hovercard-id]').forEach(el => {
        const id = el.getAttribute('data-hovercard-id');
        if (id && id.includes('@')) emails.add(id.toLowerCase().trim());
      });
    }
  }

  // Strategy 2: Scan the entire compose for chips matching the field
  compose.querySelectorAll('[email]').forEach(el => {
    const e = el.getAttribute('email');
    if (e && e.includes('@')) emails.add(e.toLowerCase().trim());
  });

  return [...emails];
}

function getSubject(compose) {
  const subjectEl =
    compose.querySelector('input[name="subjectbox"]') ||
    compose.querySelector('[name="subjectbox"]') ||
    compose.querySelector('[aria-label="Subject"]');
  if (subjectEl?.value?.trim()) return subjectEl.value.trim();

  // Inline reply: subject lives in the thread header, not in the compose box.
  // Gmail sets the page title to "Subject - email - Gmail" when a thread is open.
  const title = document.title.replace(/\s*-\s*[^-]+\s*-\s*Gmail\s*$/i, '').trim();
  return title || '(no subject)';
}

function getBodyElement(compose) {
  // Gmail's compose body is a contenteditable div
  const selectors = [
    '[aria-label="Message Body"]',
    '[role="textbox"][aria-multiline="true"]',
    '[g_editable="true"]',
    'div[contenteditable="true"][tabindex]'
  ];
  for (const sel of selectors) {
    const el = compose.querySelector(sel);
    if (el && el.contentEditable === 'true') return el;
  }
  return null;
}

function getBodyHtml(compose) {
  const bodyEl = getBodyElement(compose);
  return bodyEl ? bodyEl.innerHTML : '';
}

function setBodyHtml(compose, html) {
  const bodyEl = getBodyElement(compose);
  if (!bodyEl) {
    logError('Could not find compose body element');
    return false;
  }
  bodyEl.innerHTML = html;
  // Dispatch an input event so Gmail knows the content changed
  bodyEl.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

// ─── Tracking injection ───────────────────────────────────────────────────────

function extractLinks(bodyHtml) {
  // Parse the body and extract all <a> elements with href
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${bodyHtml}</div>`, 'text/html');
  const links = [];

  doc.querySelectorAll('a[href]').forEach(anchor => {
    const url = anchor.getAttribute('href');
    // Only track HTTP(S) links, not mailto:, tel:, etc.
    if (url && /^https?:\/\//i.test(url)) {
      links.push({ id: generateUUID(), url });
    }
  });

  return links;
}

function buildTrackedBody(originalHtml, signedEmailId, signedLinkMap, backendUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${originalHtml}</div>`, 'text/html');

  // Rewrite all tracked links
  doc.querySelectorAll('a[href]').forEach(anchor => {
    const url = anchor.getAttribute('href');
    if (!url || !/^https?:\/\//i.test(url)) return;

    // Find the signed link ID for this URL
    const entry = [...signedLinkMap.entries()].find(([, origUrl]) => origUrl === url);
    if (entry) {
      const [signedLinkId] = entry;
      anchor.href = `${backendUrl}/t/l/${signedLinkId}`;
    }
  });

  // Inject 1x1 tracking pixel at the very end of the body
  const pixel = doc.createElement('img');
  pixel.setAttribute('src', `${backendUrl}/t/o/${signedEmailId}`);
  pixel.setAttribute('width', '1');
  pixel.setAttribute('height', '1');
  pixel.setAttribute('alt', '');
  pixel.style.cssText = 'width:1px;height:1px;display:block;overflow:hidden;';
  doc.body.querySelector('div').appendChild(pixel);

  // Inject opt-out footer — required for compliance
  const footer = doc.createElement('div');
  footer.style.cssText = 'margin-top:32px;padding-top:8px;border-top:1px solid #eee;';
  footer.innerHTML =
    `<span style="font-size:9px;color:#aaaaaa;font-family:sans-serif;">` +
    `This email includes a read receipt. ` +
    `<a href="${backendUrl}/optout?id=${signedEmailId}" ` +
    `style="color:#aaaaaa;text-decoration:underline;">Opt out</a>.` +
    `</span>`;
  doc.body.querySelector('div').appendChild(footer);

  return doc.body.querySelector('div').innerHTML;
}

// ─── Core: register email with backend and inject tracking ────────────────────

async function registerAndInject(compose) {
  const to = getRecipientsFromField(compose, 'To');
  const cc = getRecipientsFromField(compose, 'Cc');
  const subject = getSubject(compose);
  const bodyHtml = getBodyHtml(compose);
  const links = extractLinks(bodyHtml);

  log(`Registering email: "${subject}", To: ${to.length}, CC: ${cc.length}, Links: ${links.length}`);

  let response;
  try {
    response = await fetch(`${BACKEND_URL}/api/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, to, cc, links })
    });
  } catch (networkErr) {
    // If backend is unreachable, send the email without tracking
    logError('Backend unreachable — sending without tracking:', networkErr.message);
    return false; // signals caller to send without modifications
  }

  if (!response.ok) {
    logError('Backend returned error:', response.status);
    return false;
  }

  const data = await response.json();
  const { signedEmailId, links: signedLinks = [] } = data;

  if (!signedEmailId) {
    logError('Backend returned no trackingId');
    return false;
  }

  // Build a Map from signedLinkId → originalUrl for body rewriting
  const signedLinkMap = new Map();
  for (const link of signedLinks) {
    const original = links.find(l => l.id === link.id);
    if (original) signedLinkMap.set(link.signedId, original.url);
  }

  const trackedHtml = buildTrackedBody(bodyHtml, signedEmailId, signedLinkMap, BACKEND_URL);
  const success = setBodyHtml(compose, trackedHtml);

  if (success) {
    log('Tracking injected successfully');
  }
  return success;
}

// ─── Send button interception ─────────────────────────────────────────────────

function attachSendHandler(compose, sendButton) {
  if (attachedButtons.has(sendButton)) return; // already attached
  attachedButtons.set(sendButton, true);
  log('Attaching send handler to button', sendButton);

  const handler = async function onSendClick(event) {
    // If this compose is already being processed (i.e. we're in the re-click),
    // remove the handler and let Gmail proceed
    if (processingComposes.has(compose)) {
      processingComposes.delete(compose);
      sendButton.removeEventListener('click', handler, true);
      return; // Gmail's handler fires normally
    }

    // First interception: stop Gmail from sending, inject tracking
    event.stopImmediatePropagation();
    event.preventDefault();

    processingComposes.add(compose);

    try {
      await registerAndInject(compose);
    } catch (err) {
      logError('Unexpected error in registerAndInject:', err);
      processingComposes.delete(compose);
    }

    // Re-trigger the send button click — our handler will see processingComposes
    // has this compose and will remove itself, letting Gmail proceed
    setTimeout(() => {
      sendButton.click();
    }, 80);
  };

  // Use capture phase so we fire before Gmail's own handler
  sendButton.addEventListener('click', handler, true);
}

function scanForComposes(root) {
  // Scan for send buttons anywhere in root — covers new compose dialogs,
  // pop-out replies, AND inline reply boxes within conversation threads.
  const sendButtonSelectors = [
    '[data-tooltip="Send"]',
    '[data-tooltip*="Send"]',
    '[aria-label*="Send "]',
  ];

  const seen = new Set();
  for (const sel of sendButtonSelectors) {
    const matches = [];
    if (root.matches?.(sel)) matches.push(root);
    root.querySelectorAll?.(sel).forEach(el => matches.push(el));
    for (const btn of matches) {
      if (seen.has(btn)) continue;
      seen.add(btn);
      const compose = findComposeContainer(btn);
      if (compose) attachSendHandler(compose, btn);
    }
  }
}

// ─── MutationObserver — watch for Gmail compose windows ──────────────────────

const observer = new MutationObserver(mutations => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      scanForComposes(node);
    }
  }
});

// Start observing
observer.observe(document.body, { childList: true, subtree: true });

// Initial scan in case Gmail compose is already open when extension loads
scanForComposes(document.body);

log('Email Tracker content script loaded on', location.hostname);
