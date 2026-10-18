# Privacy Policy

**Regex Rabbit Chrome Extension**
Effective date: October 18, 2026

## Overview

Regex Rabbit searches text on the active page in the browser. The extension does not send page content or search patterns to a Regex Rabbit server. Appearance and search preferences are stored with Chrome's storage APIs; Chrome may synchronize `chrome.storage.sync` preferences across devices when Chrome Sync is enabled for the user.

## Data the extension accesses

| Data | Use | Storage |
|---|---|---|
| Text and visible control values on the active page | Read in memory to collect search text, find matches, and display highlights | Not persisted by the extension; not sent to Regex Rabbit or another remote service |
| Search patterns | Run the requested page search | Not persisted by the extension |
| Search and appearance preferences, including limits, colors, scale, language, and toolbar-position setting | Restore the user's chosen behavior and appearance | `chrome.storage.sync`; Chrome may synchronize these settings according to the user's Chrome Sync configuration |
| Toolbar coordinates | Restore the toolbar position when permanent position memory is enabled | `chrome.storage.local` in the browser profile; disabling the option removes the saved coordinates |

During a search, page text and patterns are passed between the tab and an extension offscreen document so an isolated Web Worker can perform matching. They remain in browser memory for that search and are released when the task completes, is canceled, or fails.

## Data sharing

Regex Rabbit has no analytics, telemetry, crash reporting, remote configuration, or Regex Rabbit server. The extension does not transmit page content or search patterns to third parties. Chrome's built-in synchronization of `chrome.storage.sync` preferences is governed by the user's Chrome account and Sync settings.

## Extension permissions

- `activeTab` and `scripting` let the extension access and add its search interface to the active tab after the user invokes it.
- `offscreen` lets the extension host its local matching Worker outside the page's content security policy.
- `storage` saves preferences and, when enabled, toolbar coordinates as described above.

## Contact

Questions about this policy can be raised through the project's GitHub repository: [github.com/GuangDai/regex-rabbit](https://github.com/GuangDai/regex-rabbit).
