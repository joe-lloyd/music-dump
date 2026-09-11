# Search

## Sub-features

Songs, artists, albums, playlists, empty results, request failure, changing query.

## How to get to it (user POV)

Type into Search music from any panel.

## Driving it with Playwright

Run npm run verify:search. Assert grouped results and navigate an artist or playlist link.

## Gotchas

Two-character minimum. Search covers synced metadata and local files, not the live Spotify catalog.
