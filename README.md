# Regex Rabbit

Chrome Manifest V3 extension for searching the current page with regular expressions.

## Features

- Regex search via toolbar icon or `Ctrl+Shift+F` / `Command+Shift+F`
- ReDoS safety analysis (4xx/5xx error codes)
- Configurable max matches, highlight colors, UI scale, case sensitivity
- SPA-aware — detects DOM mutations and recreates UI
- Time-sliced search with cancellation on new input
- Dark mode support

## Development

```sh
npm install              # Install jsdom (test dependency)
npm run lint             # Syntax check on all source files
npm test                 # Unit tests (domain layer)
npm run test:integration # Integration tests (jsdom + worker_threads)
npm run build            # Build dist/ with all runtime files
```

## Architecture

See [AGENTS.md](AGENTS.md) for module contracts, injection order, and testing structure.
