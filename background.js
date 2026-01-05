// Soft Auto Reload - background service worker (MV3)
// Features:
// 1) Custom time input (in popup)
// 2) Per-tab timers
// 3) Badge countdown (active tab) via content script ticks
// 4) Auto-start on page load
// 5) Pause when tab inactive

const STORAGE_KEY = "tabStates";

// In-memory cache: { [tabId: string]: TabState }
let tabStates = {};

// TabState shape:
// {
//   enabled: boolean,
//   intervalMs: number,
//   autoStart: boolean,
//   pauseWhenInactive: boolean,
//   badgeCountdown: boolean,
//   paused: boolean,
//   remainingMs: number | null,   // used when paused
//   nextReloadAt: number | null   // epoch ms
// }

function alarmName(tabId) {
  return `reload_${tabId}`;
}

async function loadStates() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  tabStates = data?.[STORAGE_KEY] ?? {};
}

async function saveStates() {
  await chrome.storage.local.set({ [STORAGE_KEY]: tabStates });
}

function safeSend(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

function setBadge(text) {
  chrome.action.setBadgeText({ text: text ?? "" });
}

function formatMMSS(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${mm}:${ss}`;
}

async function clearReloadAlarm(tabId) {
  await chrome.alarms.clear(alarmName(tabId));
}

async function scheduleReload(tabId, delayMs) {
  // Alarms accept fractional minutes, but Chrome may clamp; still works for typical minute+ intervals.
  const when = Date.now() + Math.max(1000, delayMs);
  chrome.alarms.create(alarmName(tabId), { when });
}

function ensureState(tabId) {
  const key = String(tabId);
  if (!tabStates[key]) {
    tabStates[key] = {
      enabled: false,
      intervalMs: 60000,
      autoStart: true,
      pauseWhenInactive: true,
      badgeCountdown: true,
      paused: false,
      remainingMs: null,
      nextReloadAt: null
    };
  }
  return tabStates[key];
}

async function startTab(tabId, intervalMs, options = {}) {
  const st = ensureState(tabId);
  st.enabled = true;
  st.intervalMs = intervalMs;
  st.autoStart = options.autoStart ?? true;
  st.pauseWhenInactive = options.pauseWhenInactive ?? true;
  st.badgeCountdown = options.badgeCountdown ?? true;
  st.paused = false;
  st.remainingMs = null;
  st.nextReloadAt = Date.now() + intervalMs;

  await clearReloadAlarm(tabId);
  await scheduleReload(tabId, intervalMs);
  await saveStates();

  safeSend(tabId, { type: "CONFIGURE", enabled: true, badgeCountdown: st.badgeCountdown, nextReloadAt: st.nextReloadAt });

  // Update badge immediately if it's the active tab
  const active = await getActiveTabId();
  if (active === tabId && st.badgeCountdown) setBadge(formatMMSS(intervalMs));
}

async function stopTab(tabId) {
  const key = String(tabId);
  if (!tabStates[key]) return;
  tabStates[key].enabled = false;
  tabStates[key].paused = false;
  tabStates[key].remainingMs = null;
  tabStates[key].nextReloadAt = null;

  await clearReloadAlarm(tabId);
  await saveStates();
  safeSend(tabId, { type: "DISABLE" });

  const active = await getActiveTabId();
  if (active === tabId) setBadge("");
}

async function pauseTab(tabId) {
  const st = ensureState(tabId);
  if (!st.enabled || st.paused || !st.pauseWhenInactive) return;

  const now = Date.now();
  const remaining = st.nextReloadAt ? Math.max(0, st.nextReloadAt - now) : st.intervalMs;
  st.paused = true;
  st.remainingMs = remaining;
  st.nextReloadAt = null;

  await clearReloadAlarm(tabId);
  await saveStates();
  safeSend(tabId, { type: "PAUSE", enabled: true });

  const active = await getActiveTabId();
  if (active === tabId) setBadge(""); // if it somehow stays active, clear
}

async function resumeTab(tabId) {
  const st = ensureState(tabId);
  if (!st.enabled || !st.paused) return;

  st.paused = false;
  const delay = st.remainingMs ?? st.intervalMs;
  st.remainingMs = null;
  st.nextReloadAt = Date.now() + delay;

  await clearReloadAlarm(tabId);
  await scheduleReload(tabId, delay);
  await saveStates();

  safeSend(tabId, { type: "CONFIGURE", enabled: true, badgeCountdown: st.badgeCountdown, nextReloadAt: st.nextReloadAt });
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#444" });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadStates();
});

// Boot
loadStates().catch(() => {});

// Alarm -> reload (per tab)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("reload_")) return;
  const tabId = Number(alarm.name.replace("reload_", ""));
  const st = ensureState(tabId);
  if (!st.enabled || st.paused) return;

  try {
    await chrome.tabs.reload(tabId, { bypassCache: false });
  } catch (_) {
    // If tab no longer exists or can't reload (chrome://), stop it.
    await stopTab(tabId);
    return;
  }

  // Schedule next
  st.nextReloadAt = Date.now() + st.intervalMs;
  await saveStates();
  await scheduleReload(tabId, st.intervalMs);

  safeSend(tabId, { type: "CONFIGURE", enabled: true, badgeCountdown: st.badgeCountdown, nextReloadAt: st.nextReloadAt });
});

// Auto-start on page load (keeps running across navigation)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const st = ensureState(tabId);
  if (!st.enabled || !st.autoStart) return;

  // If we don't have a future schedule (e.g., service worker restarted), rebuild it.
  if (!st.paused && (!st.nextReloadAt || st.nextReloadAt <= Date.now())) {
    st.nextReloadAt = Date.now() + st.intervalMs;
    await saveStates();
    await clearReloadAlarm(tabId);
    await scheduleReload(tabId, st.intervalMs);
    safeSend(tabId, { type: "CONFIGURE", enabled: true, badgeCountdown: st.badgeCountdown, nextReloadAt: st.nextReloadAt });
  }
});

// Pause/resume when tab becomes inactive/active
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  // Clear badge by default; content script ticks will set it if enabled
  setBadge("");

  // Resume this tab if needed
  const st = ensureState(tabId);
  if (st.enabled && st.pauseWhenInactive) await resumeTab(tabId);

  // Pause other tabs in the same window that are enabled + pauseWhenInactive
  const tabs = await chrome.tabs.query({ currentWindow: true });
  for (const t of tabs) {
    if (!t.id || t.id === tabId) continue;
    const s = ensureState(t.id);
    if (s.enabled && s.pauseWhenInactive) await pauseTab(t.id);
  }
});

// Window focus changes: if user leaves Chrome, pause active tab (if configured)
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) return;
  const active = await getActiveTabId();
  if (active == null) return;
  const st = ensureState(active);
  if (st.enabled && st.pauseWhenInactive) await pauseTab(active);
  setBadge("");
});

// Cleanup when a tab closes
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const key = String(tabId);
  if (tabStates[key]) {
    delete tabStates[key];
    await saveStates();
  }
  await clearReloadAlarm(tabId);
});

// Messages from popup & content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "START_TAB") {
      await startTab(msg.tabId, msg.intervalMs, msg.options);
      sendResponse({ ok: true, message: "Started for this tab." });
      return;
    }

    if (msg?.type === "STOP_TAB") {
      await stopTab(msg.tabId);
      sendResponse({ ok: true, message: "Stopped for this tab." });
      return;
    }

    if (msg?.type === "GET_STATE") {
      const st = ensureState(msg.tabId);
      sendResponse({ ok: true, state: st });
      return;
    }

    // Content script ticks -> update badge only for active tab and only if enabled
    if (msg?.type === "TICK") {
      const tabId = sender?.tab?.id;
      if (!tabId) return;

      const st = ensureState(tabId);
      if (!st.enabled || st.paused || !st.badgeCountdown) return;

      const active = await getActiveTabId();
      if (active !== tabId) return;

      setBadge(formatMMSS(msg.remainingMs));
      return;
    }

    // Content script can notify visibility, but we already handle activation/focus.
    if (msg?.type === "CS_READY") {
      const tabId = sender?.tab?.id;
      if (!tabId) return;
      const st = ensureState(tabId);
      if (st.enabled && !st.paused && st.nextReloadAt) {
        safeSend(tabId, { type: "CONFIGURE", enabled: true, badgeCountdown: st.badgeCountdown, nextReloadAt: st.nextReloadAt });
      } else {
        safeSend(tabId, { type: "DISABLE" });
      }
      return;
    }
  })().catch(() => {});
  return true; // keep the message channel open for async sendResponse
});
