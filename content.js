// Soft Auto Reload - content script
// Runs on all pages, but only active when enabled for that tab.
// Sends a per-second countdown tick to background for badge updates.

let enabled = false;
let badgeCountdown = true;
let nextReloadAt = null;
let tickTimer = null;
// ------------------------------
// HiPages - New leads detection
// - Runs ONLY on hipages.com.au leads pages.
// - After each reload (when this content script runs), extracts the first 5 visible leads,
//   compares with previously seen lead IDs stored in chrome.storage.local,
//   and console.logs ONLY the new leads.
// - No server calls, no clicking, no form submission.
// ------------------------------

const HIPAGES_SEEN_KEY = "hipages_seenLeadIds_v2";
let hipagesPhaseRanForThisLoad = false;

function isHiPagesLeadsContext() {
  const host = (location.hostname || "").toLowerCase();
  const path = (location.pathname || "").toLowerCase();
  if (!host.endsWith("hipages.com.au")) return false;
  return path.includes("lead") || path.includes("job");
}

function uniqById(leads) {
  const map = new Map();
  for (const l of leads) {
    if (!l?.id) continue;
    if (!map.has(l.id)) map.set(l.id, l);
  }
  return Array.from(map.values());
}

function isElementVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    style.opacity !== "0"
  );
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function extractQuestionAnswerPairs(container) {
  const pairs = [];

  // Definition lists: <dl><dt>Question</dt><dd>Answer</dd></dl>
  container.querySelectorAll("dl").forEach(dl => {
    const dts = Array.from(dl.querySelectorAll("dt"));
    dts.forEach(dt => {
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName.toLowerCase() !== "dd") return;
      const question = normalizeText(dt.textContent);
      const answer = normalizeText(dd.textContent);
      if (question && answer) pairs.push({ question, answer });
    });
  });

  // Generic label/value pairs: look for rows with 2 columns
  const rows = Array.from(container.querySelectorAll("[data-testid*='row'], .row, .Row, li, div"));
  rows.forEach(row => {
    const children = Array.from(row.children || []);
    if (children.length < 2) return;
    const first = normalizeText(children[0].textContent);
    const second = normalizeText(children[1].textContent);
    if (!first || !second) return;
    if (first.length > 80) return;
    if (second.length > 600) return;
    if (first === second) return;
    if (first.endsWith(":")) {
      pairs.push({ question: first.replace(/:$/, ""), answer: second });
      return;
    }
    if (first && second) {
      pairs.push({ question: first, answer: second });
    }
  });

  // Colon-delimited text nodes within list items
  container.querySelectorAll("li, p, div").forEach(node => {
    const text = normalizeText(node.textContent);
    if (!text || !text.includes(":")) return;
    const [label, ...rest] = text.split(":");
    const answer = normalizeText(rest.join(":"));
    if (!label || !answer) return;
    if (label.length > 80 || answer.length > 600) return;
    pairs.push({ question: label, answer });
  });

  // De-duplicate pairs
  const seen = new Set();
  return pairs.filter(pair => {
    const key = `${pair.question}::${pair.answer}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractLeadDetails(card, linkUrl) {
  const cardText = normalizeText(card?.innerText || "");
  const customerName =
    normalizeText(card?.querySelector?.("[data-testid*='customer'], .customer, .Customer, .name, .Name")?.textContent) ||
    normalizeText(card?.querySelector?.("h1,h2,h3")?.textContent);

  const postedAt =
    normalizeText(card?.querySelector?.("[data-testid*='posted'], time")?.textContent) ||
    (cardText.match(/\b(\d+\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago)\b/i) || [null])[0];

  const location =
    normalizeText(card?.querySelector?.("[data-testid*='location'], .location, .Location")?.textContent) ||
    (cardText.match(/\b(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\b/i) || [null])[0];

  const serviceCategory =
    normalizeText(card?.querySelector?.("[data-testid*='service'], .service, .category, .Category")?.textContent) || null;

  const requiredCredits =
    normalizeText(card?.querySelector?.("[data-testid*='credit'], .credit, .credits")?.textContent) ||
    (cardText.match(/\b(\d+)\s*credits?\b/i) || [null])[0];

  const questionAnswers = extractQuestionAnswerPairs(card);

  return {
    customerName: customerName || null,
    postedAt: postedAt || null,
    location: location || null,
    serviceCategory: serviceCategory || null,
    requiredCredits: requiredCredits || null,
    questionAnswers
  };
}

function buildLeadId(card, linkUrl) {
  const explicitId =
    card?.getAttribute?.("data-id") ||
    card?.getAttribute?.("data-lead-id") ||
    card?.id;
  if (explicitId) return explicitId;
  if (linkUrl) return linkUrl;
  const text = normalizeText(card?.innerText || "");
  return text ? `text:${text.slice(0, 200)}` : null;
}

function extractHiPagesLeads() {
  const anchors = Array.from(document.querySelectorAll('a[href]'))
    .filter(a => {
      const href = a.getAttribute("href") || "";
      return /\/job\//i.test(href) || /\/jobs\//i.test(href) || /\/lead/i.test(href);
    });

  const cards = anchors.map(a => a.closest("article, li, [role='listitem'], .card, .Card, .job, .lead")).filter(Boolean);
  const visibleCards = cards.filter(card => isElementVisible(card));

  const uniqueCards = Array.from(new Set(visibleCards));
  const firstFive = uniqueCards.slice(0, 5);

  const leads = firstFive.map(card => {
    const link = card.querySelector("a[href]");
    let url = null;
    if (link) {
      try {
        url = new URL(link.href, location.href).href;
      } catch {
        url = link.href;
      }
    }
    const details = extractLeadDetails(card, url);
    const id = buildLeadId(card, url);

    return {
      id,
      url,
      ...details,
      rawTextPreview: normalizeText(card?.innerText || "").slice(0, 300)
    };
  });

  return uniqById(leads).filter(l => l.id);
}

async function loadSeenLeadIds() {
  const res = await chrome.storage.local.get([HIPAGES_SEEN_KEY]);
  return res[HIPAGES_SEEN_KEY] || {};
}

async function saveSeenLeadIds(seen) {
  await chrome.storage.local.set({ [HIPAGES_SEEN_KEY]: seen });
}

async function waitForLeadsAndLogNew() {
  if (!isHiPagesLeadsContext()) return;
  if (hipagesPhaseRanForThisLoad) return;
  hipagesPhaseRanForThisLoad = true;

  const start = Date.now();
  const timeoutMs = 15000;
  let leads = [];

  while (Date.now() - start < timeoutMs) {
    leads = extractHiPagesLeads();
    if (leads.length > 0) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!leads.length) {
    console.log("[Where is the money?] HiPages: No leads detected on this page load (selectors may need update).");
    return;
  }

  const seen = await loadSeenLeadIds();
  const newLeads = leads.filter(l => !seen[l.id]);

  if (newLeads.length) {
    console.log("🆕 [Where is the money?] New HiPages leads detected:", newLeads);
    // Mark new leads as seen
    for (const l of newLeads) seen[l.id] = Date.now();
    await saveSeenLeadIds(seen);
  } else {
    console.log("[Where is the money?] HiPages: No new leads this cycle.");
  }
}


function startTicking() {
  stopTicking();
  tickTimer = setInterval(() => {
    if (!enabled || !badgeCountdown || !nextReloadAt) return;
    const remaining = Math.max(0, nextReloadAt - Date.now());
    chrome.runtime.sendMessage({ type: "TICK", remainingMs: remaining }).catch(() => {});
  }, 1000);
}

function stopTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "CONFIGURE") {
    enabled = !!msg.enabled;
    badgeCountdown = msg.badgeCountdown !== false;
    nextReloadAt = typeof msg.nextReloadAt === "number" ? msg.nextReloadAt : null;
    if (enabled) {
      startTicking();
      // HiPages new leads detection (read-only)
      setTimeout(() => { waitForLeadsAndLogNew().catch(() => {}); }, 750);
    } else {
      stopTicking();
    }
  }
  if (msg?.type === "PAUSE") {
    // Paused in background; stop ticks to reduce noise
    stopTicking();
  }
  if (msg?.type === "DISABLE") {
    enabled = false;
    nextReloadAt = null;
    stopTicking();
  }
});

// Tell background we exist (helpful after reload / service worker restart)
chrome.runtime.sendMessage({ type: "CS_READY" }).catch(() => {});