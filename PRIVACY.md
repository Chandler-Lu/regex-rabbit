# Privacy Policy

**Regex Rabbit Chrome Extension**
Effective date: May 8, 2026

---

## Overview

Regex Rabbit is a Chrome extension that lets you search the current page using regular expressions. This policy explains what data the extension touches, how it is used, and who can access it.

**The short answer: all data stays on your device and is never sent anywhere.**

---

## What data the extension accesses

| Data type | How it is used | Where it stays |
|---|---|---|
| User preferences *(max matches, highlight color, UI scale, case sensitivity)* | Saved so your settings persist across browser sessions | Local only (`chrome.storage.sync`) |
| Current page DOM content | Read in-memory to execute the regex search and highlight matches | Never leaves the tab |
| Search patterns entered by the user | Used solely to perform the search on the active tab | Never stored |

---

## Data sharing

No user data is shared with any third party — ever. The extension makes no network requests. It has no analytics, no telemetry, no crash reporting, and no remote configuration. There is no server.

---

## How the `storage` permission is used

The `storage` permission is used exclusively to save your extension preferences (highlight color, max match count, UI scale, and case-sensitivity toggle) via `chrome.storage.sync`. This data is scoped to your own Chrome profile. It is never read by, transmitted to, or accessible by anyone other than the extension running locally in your browser.

---

## What we do not do

Regex Rabbit does not:

- Collect or log search patterns, page content, or browsing history
- Send any data to external servers or third parties
- Use analytics or tracking of any kind
- Monetize user data
- Share data with advertisers, data brokers, or any other parties

---

## Contact

Questions about this policy can be raised via the project's GitHub repository:
[github.com/Chandler-Lu/regex-rabbit](https://github.com/Chandler-Lu/regex-rabbit)
