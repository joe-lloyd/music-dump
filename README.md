# spotify-taste-db

Exports your Spotify library **metadata** (no audio) into a local SQLite database:
liked songs, saved albums (with full track listings), followed artists, playlists,
top artists/tracks per time range, and recently played. Artists are hydrated with
genres and follower counts; albums with label, popularity and track listings.

**Nothing is ever deleted.** Un-liking, un-following, un-saving, removing from a
playlist, or Spotify pulling content entirely only *tags* the row
(`removed_at` / `unfollowed_at` / `unsaved_at`) — the history stays queryable
and visible in the UI as badges.

It also archives, so the data survives content being pulled from Spotify:

- **Full discographies** — every album/single/compilation per known artist
  (`artist_albums`), followed artists first, resumable across quota-limited runs.
- **Cover art binaries** — album covers and artist images downloaded to
  `data/images/{albums,artists}/<id>.jpg` (CDN fetches, not counted against the
  API quota).

Zero runtime dependencies — uses Node's built-in `fetch` and `node:sqlite`.
Requires **Node >= 23.6** (runs TypeScript natively).

## Setup (one time)

1. Go to <https://developer.spotify.com/dashboard> and create an app.
   - **Redirect URI:** `http://127.0.0.1:8888/callback` (must match exactly)
   - **API used:** Web API
2. Copy the app's **Client ID** (the Client Secret is not needed — this uses the
   PKCE flow).
3. Optional, for editor type support only:

   ```sh
   pnpm install --ignore-scripts
   ```

## Run

```sh
SPOTIFY_CLIENT_ID=<your client id> pnpm export
```

The first run opens a browser tab to authorize; tokens are cached in `tokens.json`
(gitignored, `chmod 600`) so later runs need no interaction. The database is
written to `data/spotify.db` (override with `SPOTIFY_DB=/path/to.db`).

Re-running is idempotent: everything is upserted, and liked/saved/followed flags
are rebuilt from scratch each run so removals are reflected. The `plays` table
only ever grows — Spotify exposes just the last 50 plays, so run the export
regularly (cron/launchd) to accumulate listening history.

## Schema

| Table | Contents |
|---|---|
| `artists` | id, name, genres (JSON), popularity, followers, image, `is_followed` |
| `albums` | id, name, type, release date, label, popularity, image, `is_saved`, `saved_at` |
| `tracks` | id, name, album, disc/track number, duration, explicit, popularity, ISRC |
| `track_artists`, `album_artists` | many-to-many with position |
| `liked_tracks` | track id + `added_at` |
| `playlists`, `playlist_tracks` | playlist metadata + ordered tracks with `added_at`/`added_by` |
| `top_artists`, `top_tracks` | rank per `time_range` (`short_term`/`medium_term`/`long_term`) |
| `plays` | recently-played log, appended across runs |
| `sync_runs` | timestamps + JSON summary per export run |

Example queries:

```sql
-- Genres by number of liked tracks
SELECT value AS genre, COUNT(*) AS n
FROM liked_tracks
JOIN track_artists USING (track_id)
JOIN artists a ON a.id = artist_id, json_each(a.genres)
GROUP BY value ORDER BY n DESC LIMIT 25;

-- Liked tracks added per month
SELECT substr(added_at, 1, 7) AS month, COUNT(*) FROM liked_tracks GROUP BY month;
```

## Web UI

`src/server.ts` + `public/index.html`: a read-only browser over the DB —
overview stats (genres, liked-per-month), artist grid with search, liked
songs, saved albums, playlists, top artists/tracks per time range, recent
plays. Navigation is internal: artist → discography → album detail with
track list; Spotify appears only as explicit "Open in Spotify ↗" links.
Cover art is served from the local archive first (`/img/...`), falling back
to the CDN — removed content keeps its artwork. Zero deps, same as the
exporter. Locally: `node src/server.ts` → <http://localhost:8080>. On the
homelab: **<https://music.home.arpa>** (Caddy → `spotify-taste-db-web:8080`
over `homelab-net`).

The UI is dark-first (neon-magenta identity) and includes a persistent bottom
player with gapless queue transitions (the next track pre-buffers ~20s early),
seeking, volume, and Media Session controls. Plays made in the app are recorded
server-side into `data/app-plays.db` (20s minimum, Spotify-style) and the
Overview merges them with Spotify plays: daily stacked listening, listening
clock, day rhythm, heavy rotation, and a lifetime chart once the GDPR history
import lands. Playback controls resolve against the local
Jellyfin library; an item that is merely known to Spotify is never presented as
successfully playable.

Lyrics are local-first: a matched track asks Jellyfin for its lyrics (which
covers `.lrc` sidecar files beside the audio and embedded lyric tags), and
LRCLIB fills the gaps — identified client, 10 s timeout, hits cached forever
and misses for a week in `data/lyrics.db`, so the third party is asked about
each track at most once. Synced lyrics follow the current line, click any line
to seek, and a per-track ±0.5 s nudge (persisted in the browser) corrects
drifting timing. Plain lyrics render without fake timing; instrumentals and
no-matches stay quiet.

## MP3 intake and automatic FLAC upgrades

The **FLAC queue** tab closes the gap between "I want this song now" and "a
verified lossless copy exists somewhere":

1. Queue any Spotify-backed track with its small `FLAC up` control, or paste a
   Spotify/YouTube URL in the FLAC queue. Known Spotify tracks supply their own
   artist/title/album metadata; new links require artist + title.
2. The app writes the request to `data/upgrades.db`, separate from the
   exporter-owned `spotify.db`. Queue claims use leases, so a worker crash does
   not strand an item in `working` forever.
3. The scheduled worker on `eliot` downloads an initial MP3 with spotDL (Spotify)
   or yt-dlp (YouTube) if Jellyfin does not already have a local file. It then
   searches Soulseek through slskd for FLAC candidates.
4. A replacement is accepted only when ffprobe confirms the codec is actually
   FLAC and duration + artist + title match. The FLAC is copied and verified on
   the library filesystem before the old lossy file is moved to the recoverable
   `music-upgrade/replaced/` area. The app then asks Jellyfin to rescan.

Upgrade failures retry with exponential backoff (six hours up to seven days),
+/-25% jitter, and a random pick among due failures. `maxAttempts` defaults to 6
and is capped at 20. Attempted Soulseek files are remembered so a bad candidate
is not selected repeatedly. Exhausted items stay visible and **Retry now** grants
another attempt. Source downloads have their own three-attempt budget.

Worker mutation endpoints (`/api/upgrades/claim` and `/api/upgrades/complete`)
require a shared random `UPGRADE_WORKER_TOKEN` of at least 16 characters. Queue
creation never exposes that token to the browser. Source URLs are restricted to
HTTPS Spotify and YouTube hosts and all downloader commands use argument arrays,
not a shell. See the HomeLab repository's `eliot/acquisition/music-upgrader/`
for the worker, slskd container, systemd timer, and deployment checklist.

## Local playback through Jellyfin

The browser never receives the Jellyfin API key. `src/jellyfin.ts` indexes
Jellyfin audio server-side, matches a Spotify track on normalized title plus a
scored combination of artist, album, duration, disc, and track number, and
proxies range-aware audio through `/api/player/stream`. Low-confidence and tied
matches are rejected rather than playing the wrong recording.

Playback remains visibly unconfigured until the R0 Jellyfin music-library
handoff exists and an API key is supplied. On the Pi:

1. Create a Jellyfin API key named `music-taste` in the Jellyfin dashboard.
2. Add it to the deployed checkout's gitignored `.env`:

   ```sh
   printf 'JELLYFIN_API_KEY=%s\n' 'paste-key-here' >> .env
   chmod 600 .env
   ```

3. Recreate only the web container: `docker compose up -d --force-recreate web`.

The compose defaults expect Jellyfin at `http://jellyfin:8096`, the music source
at `192.168.2.34:2049`, and the existing wake endpoint at
`http://192.168.2.23:7777/wake`. Override `JELLYFIN_URL`,
`JELLYFIN_USER_ID`, `MUSIC_SOURCE_HOST`, `MUSIC_SOURCE_PORT`, or
`ELIOT_WAKE_URL` when needed. `JELLYFIN_API_KEY_FILE` is also supported when a
mounted secret file is preferable to an environment variable.

For the FLAC worker, add the same random token used on eliot to this checkout's
gitignored `.env`:

```sh
UPGRADE_WORKER_TOKEN=<at-least-16-random-characters>
```

For local UI work without a Spotify account or production database:

```sh
npm run fixture
SPOTIFY_DB=./data/dev-fixture.db node src/server.ts
```

## Deployment (pi-server)

Runs on `pi-server` (192.168.2.23) as two containers from one compose file —
`spotify-taste-db` (exporter, internal 6h sync loop) and `spotify-taste-db-web`
(UI) — both plain `node:24-alpine` with this repo bind-mounted (system Node on
the Pi is v18). The deployed copy at `pi:~/spotify-taste-db` is a checkout of
<https://github.com/joe-lloyd/music-dump>; update with:

```sh
ssh pi 'cd spotify-taste-db && git pull && docker compose up -d --force-recreate'
```

Logs via `docker logs spotify-taste-db` / `docker logs spotify-taste-db-web`;
the DB lives at `data/spotify.db` on the Pi. Grab a copy for local querying
with:

```sh
scp pi:spotify-taste-db/data/spotify.db /tmp/spotify.db
```

**Do not run the export from two machines**: Spotify rotates refresh tokens,
so a second machine invalidates the first's `tokens.json`. The Pi is the
runner; re-authorize (delete `tokens.json`, run once interactively) if the
token ever breaks.

## Concerts (Shows tab + ntfy alerts)

Needs a free Ticketmaster Discovery API key: create one at
<https://developer.ticketmaster.com> (instant, 5k requests/day) and add
`TICKETMASTER_API_KEY=<key>` to the `.env` on the Pi. The daily run then
checks every followed artist's upcoming events, fills the **Shows** tab
(split by `EVENT_COUNTRIES`, default `NL,BE,DE`), lists them on artist pages,
and pings ntfy (with a tap-through ticket link) whenever a new nearby show
appears. Without the key the stage just skips.

## Lidarr import list

The daily run resolves each interesting artist (followed, or ≥3 liked tracks —
`LIDARR_MIN_LIKED`) to a MusicBrainz artist id, ISRC lookup first and exact
name search as fallback (`src/musicbrainz.ts`, cached in `artist_mbid`, capped
at `LIDARR_MB_LIMIT`=500 lookups/run at MusicBrainz's 1 req/s). The web UI then
serves **`/api/lidarr-list`** — `[{"MusicBrainzId": …, "ArtistName": …}, …]` —
which Lidarr consumes as a *Custom List* import list
(`http://spotify-taste-db-web:8080/api/lidarr-list` over `homelab-net`).
No-match artists are recorded as `''` and retried monthly; only exact
normalized name matches are accepted, so a miss beats monitoring a stranger's
discography.

## Importing your lifetime listening history

Request "Extended streaming history" at <https://www.spotify.com/account/privacy/>
(takes days to arrive). Unzip it, then load it into `history_plays`:

```sh
# locally (Node >= 23.6)
node src/import-history.ts ~/Downloads/my_spotify_data/

# on the Pi (host Node is too old — use the container)
scp -r ~/Downloads/my_spotify_data pi:history-export
ssh pi 'docker run --rm -v /home/pi-admin/spotify-taste-db:/app -v /home/pi-admin/history-export:/export -w /app node:24-alpine node src/import-history.ts /export'
```

Handles both the extended format (`Streaming_History_Audio_*.json`,
`endsong_*.json`) and the basic account-data format (`StreamingHistory*.json`);
podcast episodes are skipped and re-imports dedupe. The Overview page picks it
up automatically (lifetime plays, hours listened, per-month chart).

## Known limits

- **Daily API quota** (dev-mode apps, 2026): a long `retry-after` makes the run
  exit cleanly; the next scheduled run resumes hydration from its NULL markers.
- **Batch/catalog restrictions** (dev-mode apps, 2026): batch `?ids=` endpoints
  and `/playlists/{id}/tracks` return 403 — playlist tracks come from the
  embedded page on the playlist detail endpoint, hydration goes one item at a
  time. Playlists longer than one embedded page (~100 tracks) may be truncated
  if the pagination link is also blocked.
- `/me/top/*` now pages the full affinity ranking (thousands of items) — capped
  at 500 per time range via `SPOTIFY_TOP_LIMIT` (0 = unlimited).

- **No audio features** (tempo/energy/danceability): Spotify removed that endpoint
  for apps created after Nov 2024. The `tracks.isrc` column is there so you can
  cross-reference MusicBrainz/AcousticBrainz instead.
- **No full listening history** via the API — request your "Extended streaming
  history" at <https://www.spotify.com/account/privacy/> for that (JSON export,
  takes days to arrive).
- Playlist items that are podcast episodes or local files are skipped (counted in
  the run summary).
