const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'https://chrome.google.com/webstore/',
  'edge://'
];

// Helper function to check if a URL is restricted
function isRestrictedUrl(url) {
  if (!url) {
    return true; // Treat missing URL as potentially restricted
  }
  return RESTRICTED_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

// Helper function to inject content script and CSS
async function injectSearch(tab) {
  // <<< Step 1: Check URL Before Attempting Injection >>>
  if (isRestrictedUrl(tab.url)) {
    console.log(`Regex Search: Skipping injection on restricted page (${tab.url ? tab.url.substring(0, 30) + '...' : 'N/A'}).`);
    return; // Exit early, do not attempt injection
  }

  const tabId = tab.id; // Get tabId for use in catch block too

  try {
    // Inject CSS and Script
    await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ['style.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content_script.js'] });

    // Send toggle message
    chrome.tabs.sendMessage(tabId, { action: "toggleSearchUI" }, (response) => {
        if (chrome.runtime.lastError) {
            // Suppress "Receiving end does not exist" errors if content script isn't ready/tab closed
            if (!chrome.runtime.lastError.message?.includes("Receiving end does not exist")) {
               // console.warn("Could not send message to content script:", chrome.runtime.lastError.message);
            }
        }
    });

  } catch (err) {
    // <<< Step 2: Refine Error Handling in Catch Block >>>
    const errorMessage = err.toString(); // Use toString() for better matching sometimes

    if (errorMessage.includes('Cannot access') || // Catches various "Cannot access..." errors
        errorMessage.includes('chrome.google.com/webstore') ||
        errorMessage.includes('Missing host permission') || // Might occur in edge cases
        errorMessage.includes('operation is insecure') ||
        errorMessage.includes('No tab with id') || // Tab might have closed between trigger and injection
        errorMessage.includes('cannot be scripted')) // Another way some errors are phrased
    {
        // Log specific known/expected errors calmly, not as console.error
        console.log(`Regex Search: Injection skipped or failed due to restrictions/tab state on ${tab.url ? tab.url.substring(0, 30) + '...' : tabId}. Error: ${errorMessage}`);
    } else {
        // Log other unexpected errors as actual errors
        console.error(`Regex Search: Unexpected injection failed for tab ${tabId}:`, err);
    }
  }
}

// Listener for the extension icon click
chrome.action.onClicked.addListener((tab) => {
  // The 'tab' object here usually has 'id' and sometimes 'url' if permitted
  if (tab?.id) {
    injectSearch(tab); // Pass the whole tab object
  } else {
     console.error("Regex Search: Clicked action on a tab without a valid ID.");
  }
});

// Listener for the command (keyboard shortcut)
chrome.commands.onCommand.addListener((command, tab) => {
  // The 'tab' object here usually includes the 'url'
  if (command === "_execute_action" && tab?.id) {
    injectSearch(tab); // Pass the whole tab object
  }
});