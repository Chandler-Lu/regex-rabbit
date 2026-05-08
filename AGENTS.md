# AGENTS.md

## Commands

```sh
npm install              # Install jsdom (test dependency)
npm run lint             # Syntax check on all 9 source files
npm test                 # 80 unit tests (domain + auto-search logic)
npm run test:integration # 32 integration tests (jsdom + worker_threads)
```

## Architecture

Chrome Manifest V3 extension. MVC pattern with domain/infra separation.

### File structure

```
background.js         Service Worker: inject scripts, handle toggle/shortcut
content_script.js     Page entry: SearchBar UI + SearchController orchestrator
style.css             Search bar + highlight CSS + auto-search button
manifest.json         MV3 manifest
search_worker.js      Web Worker: regex matching off main thread
options.html/js/css   Options page (scale, max matches, colors, auto-search, case sensitivity)
icons/                Extension icons

domain/               Pure logic — no browser APIs, testable in Node
  error_registry.js     Error code table (4xx user-fixable, 5xx system)
  pattern_analyzer.js   Regex safety analysis (syntax + 6 ReDoS detection rules)
  display_formatter.js  SearchState → UI display strings

infra/                Runtime — need browser APIs, tested via jsdom/worker_threads
  text_collector.js     TreeWalker DOM text node collection
  highlight_engine.js   Mark creation/removal with layout guards + batch rendering
  worker_manager.js     Worker lifecycle + start→chunks→finish protocol

tests/unit/           Domain + pure-logic tests (node:test)
tests/integration/    Infra tests (jsdom for engine/collector/observer, worker_threads for protocol)
```

## Architecture

Chrome Manifest V3 extension. MVC pattern with domain/infra separation.

### File structure

```
background.js         Service Worker: inject scripts, handle toggle/shortcut
content_script.js     Page entry: SearchBar UI + SearchController orchestrator
style.css             Search bar + highlight CSS
manifest.json         MV3 manifest
search_worker.js      Web Worker: regex matching off main thread
options.html/js/css   Options page (scale, max matches, colors, case sensitivity)
icons/                Extension icons

domain/               Pure logic — no browser APIs, testable in Node
  error_registry.js     Error code table (4xx user-fixable, 5xx system)
  pattern_analyzer.js   Regex safety analysis (syntax + 6 ReDoS detection rules)
  display_formatter.js  SearchState → UI display strings

infra/                Runtime — need browser APIs, tested via jsdom/worker_threads
  text_collector.js     TreeWalker DOM text node collection
  highlight_engine.js   Mark creation/removal with layout guards + batch rendering
  worker_manager.js     Worker lifecycle + start→chunks→finish protocol

tests/unit/           Domain + pure-logic tests (node:test)
tests/integration/    Infra tests (jsdom for engine/collector, worker_threads for protocol)
```

### Dependency order (background.js injection)

```
style.css →
domain/error_registry.js → domain/pattern_analyzer.js → domain/display_formatter.js →
infra/text_collector.js → infra/highlight_engine.js → infra/worker_manager.js →
content_script.js
```

### content_script.js search pipeline

```
performSearch(pattern)
  → RRPatternAnalyzer.analyze(pattern, flags)   // safety gate
  → RRTextCollector.collect()                    // text node collection
  → matchChunked() [time-sliced, 50 nodes/chunk] // RegExp matching (collects match objects)
  → RRHighlightEngine.renderMatches()            // batch DOM rendering
  → formatCount() / navigate()                  // UI updates

Cleanup:  RRHighlightEngine.removeHighlights(handles) // restores original text nodes
Cancel:   searchGen counter — chunked processing aborts on mismatch
```

### Key contracts

- `RRPatternAnalyzer.analyze(pattern, flags)` → `{ok, status, reasons, errorCode}`
- `RRPatternAnalyzer.addRule({id, pattern:RegExp, reason})` → `boolean` — validated
- `RRDisplayFormatter.format(state)` → `{count, status, detail, code, isError}`
- `RRHighlightEngine.renderMatches(indexedNodes, matches)` — **nodes FIRST**, matches SECOND
- `RRHighlightEngine.removeHighlights(handles)` → void
- `RRWorkerManager.search(taskId, pattern, flags, nodes, policy)` → Promise
- `RRTextCollector.collect()` → `[{id, node:Text, text}]`

### Auto-search pipeline

```
toggleAutoSearch() → MutationObserver on document.body
  → onMutation(mutations) → filter self-mutations → scheduleAutoSearch()
    → debounce (cfg.autoSearchDebounce ms, default 1500) → performSearch()

Cancel:  manual input → clearTimeout(autoSearchTimer)
Dispose: hide() → stopAutoSearch() → observer.disconnect()
Reconnect: show() → if enabled, startAutoSearch()
SPA guard: watchContainer() → stopAutoSearch() on container removal
Self-guard: mutations from #regex-search-container skipped
```

### Message protocol

- Background → Content: `{ action: "toggleSearch" }`
- Worker inbound: `start`, `chunks`, `finish`, `cancel`, `search`
- Worker outbound: `complete`, `error`

### Pitfalls

- **DO NOT** swap renderMatches param order — correct is `(indexedNodes, matches)`
- **DO NOT** add browser APIs to domain/ modules
- **DO NOT** skip lint before committing
- Worker source uses `self.onmessage` (Chrome Web Worker) — integration tests use worker_threads shim
- `sanitizeColor()` must validate colors before CSS interpolation (CSS injection prevention)
- `searchGen` counter must be checked at each `matchChunked` iteration for cancellation
- `watchContainer()` must call `removeHighlights()` before nullifying state (SPA mark leak)
- `highlight_engine.js` class name is `regex-search-highlight` (matches style.css)
- `worker_manager.js` `updateConfig()` validates value types before assignment
- `pattern_analyzer.js` `addRule()` validates id/pattern/reason before pushing
- `scheduleAutoSearch()` must clear `autoSearchTimer` on manual `onInput()` — prevents stale re-search
- `onMutation()` must skip mutations whose `target` is inside `#regex-search-container` — prevents self-triggering infinite loops
- `stopAutoSearch()` must be called on `hide()`, `watchContainer()`, and `toggleAutoSearch(false)` — prevents observer leaks
- `autoSearchEnabled` is session-only (not persisted to chrome.storage) — resets to OFF on page reload
- `autoSearchDebounce` is persisted to chrome.storage.sync, default 1500ms, range 500-5000
