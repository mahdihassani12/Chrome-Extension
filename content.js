// Soft Auto Reload - content script
// Runs on all pages, but only active when enabled for that tab.
// Sends a per-second countdown tick to background for badge updates.

let enabled = false;
let badgeCountdown = true;
let nextReloadAt = null;
let tickTimer = null;

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
    if (!enabled) {
      stopTicking();
      return;
    }
    startTicking();
  }
  if (msg?.type === "PAUSE") {
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