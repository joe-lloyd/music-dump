---
name: verify-music
description: Drive Music Dump library search and liked songs in a real browser after navigation, API, or responsive UI changes.
---

## Launch

Use Node 24 or newer. Run `pnpm install`, `npm run fixture`, and `npm run build --prefix ui` from the repository root.
Run `npm run verify:search`. The script starts its own server on port 18081 with separate mutable SQLite stores in `data/search-verification/run-*`.
It copies the fictional `data/dev-fixture.db` into each run directory. Never replace that path with the live Spotify database.

## Doctor

The script polls `GET http://127.0.0.1:18081/api/tracks` and fails if the server cannot start.
Before running, confirm port 18081 is free. The helper owns and terminates only its child server.

## Drive

`scripts/verify-search.mjs` uses Playwright Chromium with the built shared UI. Install Chromium with `pnpm exec playwright install chromium` if missing.
It drives the Search music searchbox, heart buttons, Close search, Escape, result links, and reload at 1440, 390, and 320 pixels.
The script also calls the real API to prove local likes survive changes to the Spotify fixture.

## Evidence

Keep `data/search-verification/results.json`, `server.log`, and `search-*.png`.
Inspect the screenshots after each visual change. A passing width assertion does not prove the layout looks correct.
Search failure checks intercept only the API boundary. Normal searches and likes use the real fixture server.
These checks do not prove audible playback, packaged native clients, phone keyboard behavior, or production library performance.

## Cleanup

The helper closes Chromium and terminates its own server in a finally block. It changes only its copied Spotify fixture.
Scratch databases and evidence remain in the ignored data directory for inspection. Do not delete evidence when cleaning up a failed run.

## Helpers

`npm run verify:search` runs the complete scripted flow. Read `features/README.md` for the feature map.
