# spotify-taste-db

Exports your Spotify library **metadata** (no audio) into a local SQLite database:
liked songs, saved albums (with full track listings), followed artists, playlists,
top artists/tracks per time range, and recently played. Artists are hydrated with
genres and follower counts; albums with label and popularity.

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

## Known limits

- **No audio features** (tempo/energy/danceability): Spotify removed that endpoint
  for apps created after Nov 2024. The `tracks.isrc` column is there so you can
  cross-reference MusicBrainz/AcousticBrainz instead.
- **No full listening history** via the API — request your "Extended streaming
  history" at <https://www.spotify.com/account/privacy/> for that (JSON export,
  takes days to arrive).
- Playlist items that are podcast episodes or local files are skipped (counted in
  the run summary).
