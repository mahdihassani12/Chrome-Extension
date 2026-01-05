// Soft Auto Reload - content script
// Runs on all pages, but only active when enabled for that tab.
// Sends a per-second countdown tick to background for badge updates.

let enabled = false;
let badgeCountdown = true;
let nextReloadAt = null;
let tickTimer = null;
// ------------------------------
// Phase 1 (HiPages) - New leads detection (DEV ONLY)
// - Runs ONLY on hipages.com.au
// - After each reload (when this content script runs), extracts visible leads,
//   compares with previously seen lead IDs stored in chrome.storage.local,
//   and console.logs ONLY the new leads.
// - No server calls, no clicking, no form submission.
// ------------------------------

const HIPAGES_SEEN_KEY = "hipages_seenLeadIds_v1";
let hipagesPhase1RanForThisLoad = false;

function isHiPagesLeadsContext() {
  const host = (location.hostname || "").toLowerCase();
  if (!host.endsWith("hipages.com.au")) return false;
  // Heuristic: run on any hipages page. If you want to restrict later, add path checks here.
  return true;
}

function uniqById(leads) {
  const map = new Map();
  for (const l of leads) {
    if (!l?.id) continue;
    if (!map.has(l.id)) map.set(l.id, l);
  }
  return Array.from(map.values());
}

function extractHiPagesLeads() {
  // Heuristics to locate lead links. Adjust patterns if HiPages changes.
  const anchors = Array.from(document.querySelectorAll('a[href]'))
    .filter(a => {
      const href = a.getAttribute("href") || "";
      // common patterns for lead/job detail pages
      return /\/job\//i.test(href) || /\/jobs\//i.test(href) || /\/lead/i.test(href);
    });

  const leads = anchors.map(a => {
    let url;
    try { url = new URL(a.href, location.href).href; } catch { url = a.href; }
    const card = a.closest("article, li, [role='listitem'], .card, .Card, .job, .lead") || a.parentElement;
    const cardText = (card?.innerText || "").replace(/\s+/g, " ").trim();

    // Title preference: anchor text, else first heading in the card, else first 80 chars of card text.
    let title = (a.textContent || "").replace(/\s+/g, " ").trim();
    if (!title || title.length < 4) {
      const h = card?.querySelector?.("h1,h2,h3,[data-testid*='title']");
      title = (h?.textContent || "").replace(/\s+/g, " ").trim() || cardText.slice(0, 80);
    }

    // Very light extraction for optional fields (best-effort)
    const locationMatch = cardText.match(/\b(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\b/i);
    const budgetMatch = cardText.match(/\$[\d,]+(?:\.\d+)?/);
    const postedMatch = cardText.match(/\b(\d+\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s*ago)\b/i);

    return {
      id: url, // primary stable identifier
      url,
      title,
      location: locationMatch ? locationMatch[0].toUpperCase() : null,
      budget: budgetMatch ? budgetMatch[0] : null,
      postedAt: postedMatch ? postedMatch[0] : null,
      description: cardText ? cardText.slice(0, 300) : null
    };
  });

  return uniqById(leads);
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
  if (hipagesPhase1RanForThisLoad) return;
  hipagesPhase1RanForThisLoad = true;

  const start = Date.now();
  const timeoutMs = 15000;
  let leads = [];

  while (Date.now() - start < timeoutMs) {
    leads = extractHiPagesLeads();
    if (leads.length > 0) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!leads.length) {
    console.log("[Where is the money?] HiPages Phase 1: No leads detected on this page load (selectors may need update).");
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
    console.log("[Where is the money?] HiPages Phase 1: No new leads this cycle.");
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
    if (enabled) startTicking();
      // Phase 1: HiPages new leads detection (read-only)
      setTimeout(() => { waitForLeadsAndLogNew().catch(() => {}); }, 750); else stopTicking();
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
