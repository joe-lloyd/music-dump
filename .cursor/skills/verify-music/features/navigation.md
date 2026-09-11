# Navigation

## Sub-features

Artists, Liked songs, playlists, album detail and legacy album list URL.

## How to get to it (user POV)

Use the sidebar or mobile menu; album search results open album details.

## Driving it with Playwright

Run npm run verify:search. Check the Albums tab is absent and result navigation dismisses search.

## Gotchas

Desktop embeds the shared UI and needs a new package to ship. Mobile browser widths do not reproduce a physical keyboard.
