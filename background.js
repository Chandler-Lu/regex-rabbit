/**
 * @fileoverview Service Worker for Regex Rabbit (Manifest V3).
 *
 * Injects content scripts and stylesheet in dependency order,
 * handles toolbar click and keyboard shortcut (Ctrl+Shift+F).
 */
const BLOCKED = [
  "chrome://", "chrome-extension://",
  "https://chrome.google.com/webstore", "https://chromewebstore.google.com",
  "edge://", "about:"
];

function isInjectable(url) {
  if (!url || typeof url !== "string") return false;
  for (const p of BLOCKED) { if (url.startsWith(p)) return false; }
  return true;
}

async function injectScripts(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["style.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: [
      "domain/error_registry.js",
      "domain/pattern_analyzer.js",
      "domain/display_formatter.js",
      "infra/text_collector.js",
      "infra/highlight_engine.js",
      "infra/worker_manager.js",
      "content_script.js"
    ]});
    return true;
  } catch (e) {
    console.warn("[RegexRabbit] Injection failed:", tabId, e.message);
    return false;
  }
}

async function sendToggle(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { action: "toggleSearch" }); }
  catch (e) {
    if ((e.message || "").indexOf("Receiving end does not exist") !== -1) return;
    throw e;
  }
}

async function toggle() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !isInjectable(tab.url)) return;
    if (!await injectScripts(tab.id)) return;
    await sendToggle(tab.id);
  } catch (e) { console.warn("[RegexRabbit] Toggle failed:", e.message); }
}

chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener(c => { if (c === "_execute_action") toggle(); });
