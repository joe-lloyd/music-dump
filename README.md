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

The front end is **not in this repo**. It lives in
[`music-ui`](https://github.com/joe-lloyd/music-ui) and is vendored here as the
`ui/` submodule, because a second consumer — the
[`homelab-music`](https://github.com/joe-lloyd/homelab-music) desktop tray app —
serves the identical files. One copy, pinned by commit on each side, so a fix to
the lyric scroll cannot land in one and be forgotten in the other.

`ui/routes.json` is the single source of truth for what serves at which URL and
under which content type; `src/server.ts` reads it rather than restating it.
To change the UI, commit in `music-ui`, then bump the submodule pointer here.

`src/server.ts` + `ui/public/index.html`: a read-only browser over the DB —
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

### Continuous play across albums

An ordinary queue no longer stops at the last visible song. Tracks first play
in the order shown on the page; during the final track's normal 20-second
prefetch window, the player appends another **whole local album**:

1. the next unplayed album by the same artist, in newest-to-oldest discography
   order (wrapping once if the session began in the middle);
2. when that artist's local albums are exhausted, the newest album by another
   artist with overlapping cached genres / the same broad vibe (so ambient,
   chillwave and downtempo can keep a quiet run together);
3. when there is no genre evidence, the alphabetically next artist's newest
   album, which is deterministic and works for library-only artists too.

Genre similarity and personal-affinity tie-breaking use metadata already in
`spotify.db`; album/track availability comes only from `provenance.db`. The
existing MusicBrainz ids remain the durable identity used by Lidarr and radio,
but no MusicBrainz or ListenBrainz request is made at an album boundary:
MusicBrainz is not an audio-energy database, and putting a public request there
would add both latency and a new failure mode to playback. The visited-album
history is persisted and bounded, completed queue rows are trimmed after 500
tracks, and a session that genuinely traverses the shelf starts another lap.
Radio stations keep their separate discovery/fetch-ahead behavior and do not
switch into album autoplay while station tracks are still landing.

Lyrics are local-first: a matched track asks Jellyfin for its lyrics (which
covers `.lrc` sidecar files beside the audio and embedded lyric tags), and
LRCLIB fills the gaps — identified client, 10 s timeout, hits cached forever
and misses for a week in `data/lyrics.db`, so the third party is asked about
each track at most once. Synced lyrics follow the current line, click any line
to seek, and a per-track ±0.5 s nudge (persisted in the browser) corrects
drifting timing. Plain lyrics render without fake timing; instrumentals and
no-matches stay quiet.

## Quality and source badges

Every track row carries two badges: what fidelity the file actually is, and
which pipeline produced it. `src/provenance.ts` holds the model, a scanner on
eliot (`HomeLab: eliot/acquisition/music-upgrader/library_scan.py`) fills it,
and `data/provenance.db` stores one row per audio file.

**Quality tiers.** Lossless is decided by codec alone — a FLAC's nominal
bitrate describes the music, not the fidelity, so it never reaches the lossy
thresholds. Only inside lossless does bit depth / sample rate split `hires`
out. Lossy files fall on bitrate:

| Tier | Rule | What it is here |
|---|---|---|
| `hires` | lossless, ≥24-bit or >48 kHz | 1,869 files, mostly modern WEB-FLAC |
| `lossless` | FLAC / ALAC / WAV / APE | the bulk of the library |
| `high` | ≥256 kbps | MP3-320 and AAC-256 from usenet |
| `standard` | ≥96 kbps | YouTube's best Opus stream (itag 251) |
| `low` | <96 kbps | YouTube fallback streams, old MP3s |

The 96 kbps floor is deliberate. YouTube's itag 251 measures anywhere from 110
to 160 kbps depending on the material, so a quiet track and a loud one from the
*same download* would otherwise land in different tiers. The exact figure is
always printed next to the badge, so nothing is hidden by the bucketing.

The badge encodes the tier three ways at once — filled bars, colour, and the
literal figure — so it stays readable at 9 px and does not depend on telling
magenta from gold.

**Sources.** `youtube`, `cd`, `usenet`, `torrent`, `soulseek`, `unknown`. The
usenet/torrent split is an exact join through Lidarr's history rather than a
guess; the indexer name rides along in the tooltip.

**How rows get badged.** Provenance is recorded per *file path*, but the Songs
page renders Spotify track rows that have no path. Resolving those through
Jellyfin would mean a fuzzy match per row on every render, so each scanned file
also stores a normalized `artist|title` key built with the same normalizer the
Jellyfin matcher uses. `decorateBadges()` then attaches the badge to any
track-shaped row on the way out of the API — one rule for the whole surface, so
Songs, search, album tracklists, Latest and Plays all agree. A song with no
scanned file simply comes back unbadged.

`GET /api/provenance` returns the counts behind it all.

> **Note on NULs.** The key separator is `|`. It was briefly a NUL byte, which
> SQLite's C API silently truncates a bound string at — every key stored as
> just the artist, and every lookup missed. `syntax.test.ts` now fails on a NUL
> byte anywhere in `src/`.

## Navigation is not bound to Spotify

Every album the library physically holds has a page, plays, and is reachable —
whether Spotify has ever heard of it or not. Before this, an album's id came
only from the taste DB, so roughly a third of the newest downloads had no
cover, no link, and nowhere to go: usenet and Soulseek grabs of records Spotify
does not carry were invisible to the app that downloaded them.

The library's own catalogue comes from the provenance scanner:

| | |
|---|---|
| `GET /api/library-albums` | every album on disk, newest first |
| `GET /api/album?id=libalbum-…` | its page, from the scanner's record |
| `libtrack-…` | a playable track id, resolved by exact path |

**An album is a folder.** Identity is the directory hash, not artist+title.
Grouping on the tagged artist tore releases in half — "Serj Tankian" and "Serj
Tankian feat. Bic Runga" became two albums out of one record, and 1,007
"albums" collapsed to the correct 869 once folders became the unit. The folder
is also what cover art and every download pipeline already agree on.

**A track is a path.** `libtrack-` ids are a digest of the file path, because
a path is the only thing unique per file — two tracks on one album can share a
title (a reprise, the same song on two discs) and a slug would collide.
Playback resolves through `matchPath`, so it is exact and can never pick the
wrong recording, the same guarantee the intake files already had.

Library tracks are shaped like taste tracks (`libAsTasteTrack`), so the player,
queue, lyrics and play-recording carry them with no parallel code path. The
album page hides the Spotify button and does not link a nonexistent artist
page, but keeps everything else: real durations, disc/track order, per-track
quality and source badges, and Play album.


### Artwork and volume in the player

Album art follows a track everywhere it goes. The play button carries the
album id and cover url as data attributes, so whatever the player builds from
a queue — the queue list, the bar, and the OS media panel via Media Session —
shows the same cover as the page the track was started from. One rule decides
the url in both the pages and `player.js`: `localalbum-`/`libalbum-` ids are
served by this app at `/img/local/`, everything else goes to `/img/albums/`.
Hardcoding the Spotify route is what left local music with no art on the lock
screen.

The volume slider is **squared**, not linear. Loudness is perceived roughly
logarithmically, so a linear control spends most of its travel in a range that
already sounds loud and makes the first few percent lurch. `gain = position²`
gives a slider where a small move near the bottom is a small change in what
you hear:

```
slider 0.05 → gain 0.003      slider 0.50 → gain 0.250
slider 0.10 → gain 0.010      slider 0.72 → gain 0.518
slider 0.25 → gain 0.063      slider 1.00 → gain 1.000
```

Squared rather than a true dB curve because the saved value is the *gain* and
the slider needs its exact inverse to restore position — `x²`/`√x` round-trips
exactly, and a dB mapping with a floor does not.


## CDs tab — the physical shelf

Discs owned on CD, synced from a Discogs collection, tracked through to ripped.
Discogs is the catalogue of record for physical media: it has the pressing, the
catalogue number and the year, which is what tells two editions of one album
apart.

- **Sync** pulls the whole collection (folder `0` = Discogs' "All", so custom
  folders need no enumeration). Catalogue fields refresh on every sync;
  `status`, `notes` and `rip_path` are yours and are never overwritten.
- **Statuses** cycle `To rip → Ripping → Ripped`, with `Skip` as the escape
  hatch. A disc that leaves your Discogs collection is dropped from the shelf
  *unless* it has been ripped — the library still has that music.
- **Reconciliation** runs on every page load: any `shelf` disc whose album now
  exists in the library flips to `ripped` on its own. Matching strips the
  edition noise Discogs titles carry (`(Remastered)`, `[Deluxe Edition]`) that
  a library folder never has.

Ripping happens with whatever tool you like (EAC, whipper, abcde) into a `_CD/`
folder; the app detects the files and flips the status. It does not drive a
drive.

Needs a personal access token from
<https://www.discogs.com/settings/developers> in `DISCOGS_TOKEN`. Without one
the tab renders setup instructions instead of failing. The token's own account
is resolved via `/oauth/identity`, so there is no username to configure.

## The standard album card

Everything album-shaped renders through one card (`albumCell` /
`.al-card`): art, name, artist, year (plus type when it isn't a plain album),
then the quality and source badges, with an optional pill overlaid on the art
for context like Latest's download time or the CD shelf's TO RIP state. The
Albums grid, an artist's discography, Latest downloads, the Overview's new
releases, playlists and the CD shelf all wear it, so the library reads the
same wherever an album appears. The CD shelf *extends* the base card with its
state pill and action row rather than owning a lookalike — if the card
changes, everything changes together.

Related unification notes:

- The CD shelf uses Discogs' `cover_image`, not `thumb` — the thumb is ~150px
  and reads blurry the moment the card is wider than that.
- Playlists are a shelf of cards, each wearing a collage of up to four covers
  from inside it (`/api/playlists` returns `images`), with the songs on a
  `#playlist/<id>` detail page.
- The FLAC queue renders as multi-column cards with the attempt budget as
  dots, a spinner on working jobs, and a 12-second live refresh while the tab
  is open — the worker changes the queue on its own schedule, so a page-load
  snapshot was always stale.
- The Top page's rabbit hole is a one-line strip with a small curve rather
  than a card the height of a whole track list.

## MP3/album intake and automatic FLAC upgrades

The **FLAC queue** tab closes the gap between "I want this song now" and "a
verified lossless copy exists somewhere":

1. Queue any Spotify-backed track with its small `FLAC up` control, or paste a
   Spotify/YouTube URL in the FLAC queue. Known Spotify tracks supply their own
   artist/title/album metadata; new single-track links require artist + title.
   For a YouTube album, choose **YouTube playlist** or **Chaptered video** and
   supply the album artist + album title.
2. The app writes the request to `data/upgrades.db`, separate from the
   exporter-owned `spotify.db`. Queue claims use leases, so a worker crash does
   not strand an item in `working` forever.
3. The scheduled worker on `eliot` downloads an initial MP3 with spotDL (Spotify)
   or yt-dlp (YouTube) if Jellyfin does not already have a local file. YouTube
   playlists are imported in playlist order; long videos use yt-dlp's internal
   chapters. Each generated track becomes its own durable FLAC job. The worker
   then searches Soulseek through slskd for FLAC candidates.
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

Album expansion is atomic in the queue: the parent is only marked imported once
all generated MP3s have been validated and every child upgrade row can be
inserted. A playlist with an unavailable entry, a video without at least two
valid chapters, or a split whose file count differs from the chapter count fails
intake instead of silently importing a partial album. Album files live under
`_YouTube/<Artist>/<Album>/<track> - <title>.mp3` with canonical tags.

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

## Song radio, and life after Spotify (ListenBrainz)

Two things Spotify was still doing for this library got replaced on
2026-09-01: telling us what our artists are releasing, and suggesting music we
do not own. Neither answer comes from Spotify any more.

### New & upcoming comes from Lidarr

The overview's release grid used to be a Spotify query — albums whose artist
carried Spotify's `is_followed` flag, discovered by crawling Spotify
discographies. Lidarr's calendar answers the same question better:

- it is the artists **actually being tracked** (284, all monitored), not
  whoever Spotify thinks you follow;
- it reaches into the **future**, so an announced-but-unreleased record shows
  up with its date. Spotify only lists a record once it is out;
- it knows whether the **files landed**, so a release either links to a real
  album page or wears a release date and no link.

Spotify still fills gaps for artists Lidarr has never been told about, and the
counts say how many came from each (`fromLidarr` / `fromSpotify` on
`/api/releases`). When that second number reaches zero the Spotify half can be
deleted outright.

### Radio

`/api/radio?kind=artist&value=Converge` builds a station. Behind it:

- **LB Radio** (`explore/lb-radio`) turns a prompt into recordings. Its prompt
  language takes artists and tags, not recording ids, so a "play radio from
  this track" seed is resolved back to its artist first.
- **Recording MBIDs are the join key.** Lidarr stamps one on every track it
  imports, and `lidarr_recording` in the taste DB caches it against the file
  path — so "do we own this?" is an index lookup. 9072 of 9077 recordings
  resolved to a real file when that map was first built. Tracks Lidarr never
  saw (the YouTube singles) fall back to artist+title.
- **A station is a mix.** Owned tracks and unowned ones interleave, leading
  with an owned one so audio starts instantly. A station made only of music we
  lack cannot play until a download finishes, which reads as "radio is broken".

### Song radio vs artist radio

They answer different questions and take different routes:

| | seed | route | answers |
|---|---|---|---|
| **Song radio** | one recording | `similar-recordings` (labs) | songs played *alongside* this song |
| **Artist radio** | an artist | LB Radio `artist:(…)` | songs by and around this band |

The radio glyph on any library track row — and on the player bar while
something plays — starts a song station. LB Radio's prompt language has no
recording element, so asking it for a song would silently widen straight back
out to the artist; only recording similarity answers the question asked. A
Converge track returns Botch, Dillinger Escape Plan and Nails.

Two things it has to survive:

- **An obscure song has no neighbours.** Below 12 tracks the station widens to
  the artist and says so on the page (`similar+artist`), rather than handing
  back four tracks and calling it a station.
- **File tags carry credits, not artists.** LB Radio resolves artists by exact
  name and answers `artist:(Bonobo & Arooj Aftab)` with a flat *400 — could not
  be looked up*, so a 2026 collaboration had no station at all. Fixed twice
  over: Lidarr's own `artist_name`/`artist_mbid` is preferred (canonical, and
  an MBID gives a wider net than a name — 34 distinct artists vs 28), and if
  only a tag is available the full credit is tried **first**, reducing to the
  lead artist only when ListenBrainz rejects it. That ordering is what keeps
  "Simon & Garfunkel" and "AC/DC" intact — they resolve, so they are never cut.

Similarity carries no duration, which the fetch-ahead needs to pick the right
YouTube result, so one bulk `metadata/recording` call fills them in.

**Diversity is a correctness requirement, not a nicety.** The raw similarity
endpoint, seeded with a Converge track, returned 87 recordings that were —
every single one — Tool. LB Radio diversifies internally (a Converge seed gives
18 distinct artists across 44 tracks); the similarity fallback does not, so it
is capped at two per artist and spaced so the same artist never lands twice in
a row.

### Fetch-ahead

Unowned tracks are fetched while the owned ones play by queueing a
`ytsearch5:` job for eliot's music-upgrader. It is a **lead of 5, not a rate**:
the client keeps five fetches in flight and starts another only as one lands.

That distinction was a bug first. The original version asked for three more on
every 12-second poll regardless of how many were already running, so a
40-track station queued all forty within about three minutes — a listener who
skipped away after two songs left 38 downloads behind them. A track nobody can
find stops counting against the lead, so the window slides past it rather than
stalling on it.

### Discovered vs wanted

A track radio merely *played* is not a track you asked to own, and the two get
different treatment:

| | lands as | lossless hunt |
|---|---|---|
| radio fetch-ahead | YouTube single, parked | no |
| pressed play on it | YouTube single | yes |
| FLAC↑ on a radio track | (already on disk) | yes |

Every imported single used to enter the Soulseek FLAC queue automatically. One
evening of stations put **100 tracks** into it — passive listening had become a
download campaign for music nobody chose. Now a discovered track lands
playable and stops there, as a *parked* job: file on disk, nothing hunting for
it. `auto_upgrade` on the queue row is the switch, and parking reuses the
existing reversible park state rather than inventing a terminal one.

`POST /api/tracks/want` is the single escalation point, and it is idempotent
across all three states it can meet: nothing queued (fetch it, hunt enabled),
parked by radio (promote it — the file is already there), or on disk but never
queued (hunt from the file, no download). Both the FLAC↑ control and pressing
play on a track we lack send exactly this — **pressing play IS the request**,
since nobody plays a song they do not want. The player then watches for the
file and starts playback itself when it lands.

That last part is aimed squarely at the Spotify liked-songs list: press play on
anything in it and the track is fetched, played, and queued for a real copy.

**This path does not go through Lidarr.** It is deliberately the short one —
app queue → worker → yt-dlp → `_Singles/<Artist>/<Title>.opus` — because radio
needs a file within a song's length, and the Lidarr route (indexer search →
qBittorrent or SABnzbd → import) takes minutes to hours and works in whole
releases rather than single tracks. The cost is that radio discoveries land as
standard-quality YouTube singles, tagged `source=youtube`, not proper releases.
Promoting one you liked into a real lossless copy means adding the artist or
album to Lidarr, which is not yet wired up. Fetching the whole
station up front would pull 38 albums for a station abandoned after two songs.

The known recording length is used to **choose** among search results rather
than to reject whichever one came back: YouTube's top hit is regularly a live
take, an hour-long mix, or a lyric video with a long intro. yt-dlp's
`--match-filter` takes the first result inside a ±25% window. (A pasted link
keeps the strict 3% check — there, a mismatch means the wrong video.)

Because radio needs its fetches within a song's length, they run on their own
two-minute `radio-fetch.timer` on eliot, restricted to `--phase source`. The
FLAC upgrade jobs in the same queue talk to Soulseek and must **not** run that
often; the phase filter is what keeps the two cadences apart.

### Scrobbling

Every play over 20s is submitted to ListenBrainz. This is the part that makes
cancelling Spotify survivable: the listening history is rebuilt somewhere open
and exportable, and it is what the `stats:` and `recs:` stations are computed
from. `src/backfill-listens.ts` hands over the play history already in the
taste DB so those stations do not have to wait months.

Submissions go through a durable queue (`data/listenbrainz.db`), drained every
five minutes:

- a play is never lost to a network blip, and the player never waits on a
  third party to finish a track;
- **an auth or server failure does not consume the retry budget.** The account's
  email was unverified on the first run and ListenBrainz refused every
  submission with a 401 — counting those would have discarded the listens half
  an hour later, destroying exactly what the queue exists to protect. Only a
  genuinely rejected payload counts;
- `--resubmit` unmarks everything and sends it again, because ListenBrainz
  answers `{"status":"ok"}` before it has durably ingested anything, so a 200 is
  an acknowledgement rather than a guarantee.

### Configuration

`LISTENBRAINZ_TOKEN` and `LISTENBRAINZ_USER` in the Pi's gitignored `.env`. A
free account's user token. Without it the Radio tab says so and nothing else
changes — the similarity endpoints it falls back to need no credentials.

```sh
docker compose exec web node --disable-warning=ExperimentalWarning   src/backfill-listens.ts --dry-run     # then without the flag
```

## Deployment (pi-server)

Runs on `pi-server` (192.168.2.23) as two containers from one compose file —
`spotify-taste-db` (exporter, internal 6h sync loop) and `spotify-taste-db-web`
(UI) — both plain `node:24-alpine` with this repo bind-mounted (system Node on
the Pi is v18). The deployed copy at `pi:~/spotify-taste-db` is a checkout of
<https://github.com/joe-lloyd/music-dump>; update with:

```sh
ssh pi 'cd spotify-taste-db && git pull --recurse-submodules && docker compose up -d --force-recreate'
```

> **`--recurse-submodules` is not optional.** The front end is the `ui/`
> submodule. A plain `git pull` leaves it at the old commit — or, on a checkout
> that predates it, empty — and `src/server.ts` imports from it at startup, so
> the web container crash-loops on `ERR_MODULE_NOT_FOUND` rather than serving a
> stale page. On a checkout that has never seen the submodule, initialise it
> once first:
>
> ```sh
> ssh pi 'cd spotify-taste-db && git submodule update --init'
> ```
>
> `music-ui` is public, so this needs no credentials on the Pi — which is
> exactly why it is public.

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
