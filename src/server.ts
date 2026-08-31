// Web UI over the read-only taste DB plus small, separate mutable stores for
// player history and the lossless-upgrade queue. Zero runtime dependencies.
import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { JellyfinBridge, LOCAL_LIBRARY_PREFIX, type TasteTrack } from './jellyfin.ts';
import { LyricsService } from './lyrics.ts';
import { APP_PLAYS_FILE, PlaysStore } from './plays.ts';
import {
  UpgradeStore, localAlbumId, type BatchTrack, type LocalTrack, type SourceMode,
  type UpgradeJob, validWorkerToken,
} from './upgrades.ts';

const ROOT = path.join(import.meta.dirname, '..');
const DB_FILE = process.env.SPOTIFY_DB ?? path.join(ROOT, 'data', 'spotify.db');
const PORT = Number(process.env.PORT ?? 8080);
const INDEX = path.join(ROOT, 'public', 'index.html');
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/app.css': { file: path.join(ROOT, 'public', 'app.css'), type: 'text/css; charset=utf-8' },
  '/player.js': { file: path.join(ROOT, 'public', 'player.js'), type: 'text/javascript; charset=utf-8' },
  '/sw.js': { file: path.join(ROOT, 'public', 'sw.js'), type: 'text/javascript; charset=utf-8' },
  '/manifest.webmanifest': { file: path.join(ROOT, 'public', 'manifest.webmanifest'), type: 'application/manifest+json' },
  '/icon.svg': { file: path.join(ROOT, 'public', 'icon.svg'), type: 'image/svg+xml' },
};
// Where this container sees the music library that the worker writes to.
// Empty disables file-based cover lookup and leaves only the Jellyfin path.
const APP_LIBRARY_PREFIX = process.env.APP_LIBRARY_PREFIX ?? '/music';
const jellyfin = new JellyfinBridge();
const lyrics = new LyricsService();
const appPlays = new PlaysStore();
const upgrades = new UpgradeStore();
const UPGRADE_WORKER_TOKEN = process.env.UPGRADE_WORKER_TOKEN ?? '';
const SOURCE_HOSTS = new Set([
  'open.spotify.com', 'spotify.link',
  'youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be',
]);

// Followed, or with at least one still-liked track — the artists that are
// actually part of the taste. The raw `artists` table also holds every
// feature credit and discography-crawl hydration (5000+ and growing
// nightly), which made the old tile count meaningless.
const TASTE_ARTISTS_SQL = `SELECT COUNT(DISTINCT a.id) n FROM artists a
  WHERE a.is_followed = 1 OR EXISTS (
    SELECT 1 FROM track_artists ta JOIN liked_tracks lt
      ON lt.track_id = ta.track_id AND lt.removed_at IS NULL
    WHERE ta.artist_id = a.id)`;

function query(sql: string, ...args: (string | number)[]): unknown[] {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    // Read-only connection, so the attachment is read-only too. Lets any
    // query fold `app.app_plays` (plays made in this player) into its joins.
    if (existsSync(APP_PLAYS_FILE)) {
      try {
        db.exec(`ATTACH DATABASE '${APP_PLAYS_FILE.replaceAll("'", "''")}' AS app`);
      } catch { /* a query that doesn't touch app.app_plays still works */ }
    }
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

const LOCAL_TRACK_PREFIX = 'localtrack-';
const LOCAL_ALBUM_PREFIX = 'localalbum-';

// Music that came in through the app itself (YouTube / Spotify-link intake)
// has no Spotify identity, so it lives in the upgrade store rather than the
// taste DB. It is still just music: these helpers give it the same shape as
// a Spotify track so every existing surface - albums, player, lyrics, plays
// - can carry it without a parallel code path.
function localAsTasteTrack(track: LocalTrack): TasteTrack {
  return {
    id: track.id,
    name: track.name,
    album_id: track.album_id,
    album: track.album,
    artists: track.artists,
    duration_ms: track.duration_ms,
    disc_number: null,
    track_number: track.track_number,
    image_url: null,
  };
}

function localTrack(id: string): LocalTrack | null {
  if (!id.startsWith(LOCAL_TRACK_PREFIX)) return null;
  return upgrades.localTracks().find((track) => track.id === id) ?? null;
}

// Local files resolve by the exact path the worker installed them to, never
// by title matching: Jellyfin may not have probed their tags yet, and an
// exact path can never resolve to the wrong recording.
async function resolveMatch(track: TasteTrack) {
  const local = localTrack(track.id);
  if (local) return jellyfin.matchPath(local.path);
  return jellyfin.match(track);
}

function localAlbums(): { id: string; name: string; artists: string; total_tracks: number; added_at: string }[] {
  const albums = new Map<string, { id: string; name: string; artists: string; total_tracks: number; added_at: string }>();
  for (const track of upgrades.localTracks()) {
    const existing = albums.get(track.album_id);
    if (existing) {
      existing.total_tracks += 1;
      if (track.added_at < existing.added_at) existing.added_at = track.added_at;
    } else {
      albums.set(track.album_id, {
        id: track.album_id,
        name: track.album,
        artists: track.artists,
        total_tracks: 1,
        added_at: track.added_at,
      });
    }
  }
  return [...albums.values()].sort((a, b) => b.added_at.localeCompare(a.added_at));
}

function tasteTrack(id: string): TasteTrack | null {
  const local = localTrack(id);
  if (local) return localAsTasteTrack(local);
  return (query(`
    SELECT t.id, t.name, t.album_id, t.duration_ms, t.disc_number, t.track_number,
           al.name AS album, al.image_url,
           (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
              FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
             WHERE ta.track_id = t.id) AS artists
    FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
    WHERE t.id = ?`, id)[0] as TasteTrack | undefined) ?? null;
}

function publicUpgrade(job: UpgradeJob): Omit<UpgradeJob, 'claim_token' | 'current_path'> {
  const { claim_token: _claimToken, current_path: _currentPath, ...safe } = job;
  return safe;
}

function validSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SOURCE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isYouTubeUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ['youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host);
  } catch {
    return false;
  }
}

async function readJson(req: http.IncomingMessage, maxBytes = 32_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error('request body is too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new Error('request body must be a JSON object');
  }
}

function workerAuthorized(req: http.IncomingMessage): boolean {
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const supplied = bearer || String(req.headers['x-upgrade-token'] ?? '');
  return validWorkerToken(UPGRADE_WORKER_TOKEN, supplied);
}

function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

// The Lidarr download-state tables are written by an external poller
// (HomeLab repo: pi-server/lidarr-library-sync) that pulls what Lidarr has
// actually downloaded. Ensure they exist so the read queries below never
// throw on a fresh DB before that poller's first run; the poller then keeps
// them populated. Additive only — never touches the exporter's tables.
function ensureLidarrTables(): void {
  try {
    const db = new DatabaseSync(DB_FILE);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lidarr_sync (
          id INTEGER PRIMARY KEY CHECK (id = 1), synced_at TEXT,
          downloaded_album_count INTEGER, artists_in_lidarr INTEGER,
          artists_matched INTEGER, tastedb_albums_checked INTEGER,
          tastedb_albums_downloaded INTEGER);
        CREATE TABLE IF NOT EXISTS album_download_status (
          album_id TEXT PRIMARY KEY, downloaded INTEGER, lidarr_title TEXT,
          match_score REAL, synced_at TEXT);`);
    } finally {
      db.close();
    }
  } catch (err) {
    console.error('ensureLidarrTables:', (err as Error).message);
  }
}

const api: Record<string, (params: URLSearchParams) => unknown | Promise<unknown>> = {
  '/api/player/status': (params) => jellyfin.status(params.get('refresh') === '1'),

  '/api/player/lyrics': async (params) => {
    const track = tasteTrack(params.get('id') ?? '');
    if (!track) return { available: false, synced: null, plain: null, instrumental: false, source: null };
    return lyrics.for(track, jellyfin);
  },

  '/api/player/resolve': async (params) => {
    const track = tasteTrack(params.get('id') ?? '');
    if (!track) return { available: false, reason: 'unknown-track', detail: 'This track is not in the taste database' };
    const status = await jellyfin.status();
    if (status.state !== 'ready') {
      return { available: false, reason: status.state, detail: status.detail, wakeAvailable: status.wakeAvailable };
    }
    const match = await resolveMatch(track);
    if (!match) {
      return {
        available: false,
        reason: 'not-matched',
        detail: 'No local file for this track — its album may not be downloaded yet',
        track,
      };
    }
    return {
      available: true,
      streamUrl: `/api/player/stream?id=${encodeURIComponent(track.id)}`,
      confidence: match.score,
      track,
    };
  },

  // Everything the overview needs, with Spotify plays (main DB) and this
  // app's plays (own DB) merged in JS — cross-database joins aren't worth
  // an ATTACH on a read-only handle.
  '/api/overview': () => {
    const one = (sql: string, ...a: (string | number)[]) => (query(sql, ...a)[0] as Record<string, unknown>) ?? {};
    const toMap = (rows: unknown[], key = 'k') =>
      Object.fromEntries((rows as { [k: string]: unknown; n: number }[]).map((r) => [String(r[key]), r.n]));

    const spotifyDaily = toMap(query(`SELECT date(played_at, 'localtime') k, COUNT(*) n FROM plays
      WHERE date(played_at, 'localtime') >= date('now', 'localtime', '-34 days') GROUP BY k`));
    const appDaily = toMap(appPlays.all(`SELECT date(played_at, 'localtime') k, COUNT(*) n FROM app_plays
      WHERE date(played_at, 'localtime') >= date('now', 'localtime', '-34 days') GROUP BY k`));
    const daily = [];
    for (let i = 34; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86_400_000).toLocaleDateString('sv');
      daily.push({ d, spotify: Number(spotifyDaily[d] ?? 0), app: Number(appDaily[d] ?? 0) });
    }

    const mergeBuckets = (a: Record<string, unknown>, b: Record<string, unknown>, keys: string[]) =>
      keys.map((k) => ({ k, n: Number(a[k] ?? 0) + Number(b[k] ?? 0) }));
    const hourKeys = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
    const hours = mergeBuckets(
      toMap(query(`SELECT strftime('%H', played_at, 'localtime') k, COUNT(*) n FROM plays GROUP BY k`)),
      toMap(appPlays.all(`SELECT strftime('%H', played_at, 'localtime') k, COUNT(*) n FROM app_plays GROUP BY k`)),
      hourKeys);
    const weekdays = mergeBuckets(
      toMap(query(`SELECT strftime('%w', played_at, 'localtime') k, COUNT(*) n FROM plays GROUP BY k`)),
      toMap(appPlays.all(`SELECT strftime('%w', played_at, 'localtime') k, COUNT(*) n FROM app_plays GROUP BY k`)),
      ['1', '2', '3', '4', '5', '6', '0']); // Monday-first

    const artistCounts = new Map<string, { id: string; name: string; n: number }>();
    for (const row of query(`SELECT a.id id, a.name name, COUNT(*) n FROM plays p
        JOIN track_artists ta ON ta.track_id = p.track_id JOIN artists a ON a.id = ta.artist_id
        WHERE p.played_at >= datetime('now', '-30 days') GROUP BY a.id`) as { id: string; name: string; n: number }[]) {
      artistCounts.set(row.id, { ...row });
    }
    const appTracks = appPlays.all<{ track_id: string; n: number }>(
      `SELECT track_id, COUNT(*) n FROM app_plays WHERE played_at >= datetime('now', '-30 days') GROUP BY track_id`);
    if (appTracks.length) {
      const marks = appTracks.map(() => '?').join(',');
      const byTrack = new Map(appTracks.map((t) => [t.track_id, t.n]));
      for (const row of query(`SELECT ta.track_id tid, a.id id, a.name name FROM track_artists ta
          JOIN artists a ON a.id = ta.artist_id WHERE ta.track_id IN (${marks})`,
          ...appTracks.map((t) => t.track_id)) as { tid: string; id: string; name: string }[]) {
        const bump = byTrack.get(row.tid) ?? 0;
        const entry = artistCounts.get(row.id) ?? { id: row.id, name: row.name, n: 0 };
        entry.n += bump;
        artistCounts.set(row.id, entry);
      }
    }
    const topArtists = [...artistCounts.values()].sort((a, b) => b.n - a.n).slice(0, 10);

    const window30 = (offsetDays: number) => Number(one(`SELECT COUNT(*) n FROM plays
        WHERE played_at >= datetime('now', ?) AND played_at < datetime('now', ?)`,
        `-${offsetDays + 30} days`, `-${offsetDays} days`).n ?? 0)
      + Number(appPlays.all<{ n: number }>(`SELECT COUNT(*) n FROM app_plays
        WHERE played_at >= datetime('now', ?) AND played_at < datetime('now', ?)`,
        `-${offsetDays + 30} days`, `-${offsetDays} days`)[0]?.n ?? 0);

    const listenedMs30 = Number(one(`SELECT COALESCE(SUM(t.duration_ms), 0) ms FROM plays p
        JOIN tracks t ON t.id = p.track_id WHERE p.played_at >= datetime('now', '-30 days')`).ms ?? 0)
      + Number(appPlays.all<{ ms: number }>(`SELECT COALESCE(SUM(ms_played), 0) ms FROM app_plays
        WHERE played_at >= datetime('now', '-30 days')`)[0]?.ms ?? 0);

    const history = one('SELECT COUNT(*) n, COALESCE(SUM(ms_played), 0) ms, MIN(ts) a, MAX(ts) b FROM history_plays');
    let lifetimeMonthly = null;
    if (Number(history.n) > 0) {
      const historyMonths = query(`SELECT substr(ts, 1, 7) k, COUNT(*) n FROM history_plays GROUP BY k`) as { k: string; n: number }[];
      const lastHistoryMonth = historyMonths.at(-1)?.k ?? '';
      const laterSpotify = query(`SELECT substr(played_at, 1, 7) k, COUNT(*) n FROM plays
        WHERE substr(played_at, 1, 7) > ? GROUP BY k`, lastHistoryMonth) as { k: string; n: number }[];
      const appMonths = toMap(appPlays.all(`SELECT substr(played_at, 1, 7) k, COUNT(*) n FROM app_plays GROUP BY k`));
      const merged = new Map<string, { m: string; spotify: number; app: number }>();
      for (const r of [...historyMonths, ...laterSpotify]) merged.set(r.k, { m: r.k, spotify: r.n, app: 0 });
      for (const [m, n] of Object.entries(appMonths)) {
        const entry = merged.get(m) ?? { m, spotify: 0, app: 0 };
        entry.app += Number(n);
        merged.set(m, entry);
      }
      lifetimeMonthly = [...merged.values()].sort((a, b) => a.m.localeCompare(b.m));
    }

    return {
      counts: {
        tasteArtists: one(TASTE_ARTISTS_SQL).n,
        liked: one('SELECT COUNT(*) n FROM liked_tracks WHERE removed_at IS NULL').n,
        albums: one('SELECT COUNT(*) n FROM albums WHERE is_saved = 1').n,
        playlists: one('SELECT COUNT(*) n FROM playlists WHERE removed_at IS NULL').n,
        downloaded: one('SELECT downloaded_album_count n FROM lidarr_sync WHERE id = 1').n ?? 0,
        totalPlays: Number(one('SELECT COUNT(*) n FROM plays').n ?? 0)
          + Number(appPlays.all<{ n: number }>('SELECT COUNT(*) n FROM app_plays')[0]?.n ?? 0)
          + Number(history.n ?? 0),
        appPlays: Number(appPlays.all<{ n: number }>('SELECT COUNT(*) n FROM app_plays')[0]?.n ?? 0),
      },
      plays30: window30(0),
      playsPrev30: window30(30),
      hours30: Math.round(listenedMs30 / 360_000) / 10,
      daily,
      hours,
      weekdays,
      topArtists,
      history: { rows: Number(history.n ?? 0), hours: Math.round(Number(history.ms ?? 0) / 3.6e6), from: history.a ?? null, to: history.b ?? null },
      lifetimeMonthly,
      likedPerMonth: query(`SELECT substr(added_at, 1, 7) AS month, COUNT(*) AS n FROM liked_tracks GROUP BY month ORDER BY month`),
      genres: query(`
        SELECT je.value AS genre, COUNT(DISTINCT lt.track_id) AS n
        FROM liked_tracks lt
        JOIN track_artists ta ON ta.track_id = lt.track_id
        JOIN artists a ON a.id = ta.artist_id, json_each(a.genres) je
        WHERE lt.removed_at IS NULL
        GROUP BY je.value ORDER BY n DESC LIMIT 14`),
      downloadsSyncedAt: one('SELECT synced_at t FROM lidarr_sync WHERE id = 1').t ?? null,
      lastSync: one('SELECT MAX(finished_at) t FROM sync_runs').t,
    };
  },

  '/api/stats': () => {
    const one = (sql: string) => (query(sql)[0] as Record<string, unknown>) ?? {};
    return {
      counts: {
        liked: one('SELECT COUNT(*) n FROM liked_tracks WHERE removed_at IS NULL').n,
        artists: one(TASTE_ARTISTS_SQL).n,
        followed: one('SELECT COUNT(*) n FROM artists WHERE is_followed = 1').n,
        albums: one('SELECT COUNT(*) n FROM albums WHERE is_saved = 1').n,
        playlists: one('SELECT COUNT(*) n FROM playlists WHERE removed_at IS NULL').n,
        plays: one('SELECT COUNT(*) n FROM plays').n,
        // Albums Lidarr has actually downloaded (>=1 file) — the ⤓ headline.
        downloaded: one('SELECT downloaded_album_count n FROM lidarr_sync WHERE id = 1').n ?? 0,
      },
      lastSync: one('SELECT MAX(finished_at) t FROM sync_runs').t,
      downloadsSyncedAt: one('SELECT synced_at t FROM lidarr_sync WHERE id = 1').t ?? null,
      genres: query(`
        SELECT je.value AS genre, COUNT(DISTINCT lt.track_id) AS n
        FROM liked_tracks lt
        JOIN track_artists ta ON ta.track_id = lt.track_id
        JOIN artists a ON a.id = ta.artist_id, json_each(a.genres) je
        WHERE lt.removed_at IS NULL
        GROUP BY je.value ORDER BY n DESC LIMIT 20`),
      likedPerMonth: query(`
        SELECT substr(added_at, 1, 7) AS month, COUNT(*) AS n
        FROM liked_tracks GROUP BY month ORDER BY month`),
      releases: query(`
        SELECT al.id, al.name, al.album_type AS album_group, al.release_date, al.image_url,
               al.is_saved, al.unsaved_at, al.removed_at,
               (SELECT downloaded FROM album_download_status ds WHERE ds.album_id = al.id) AS downloaded,
               (SELECT group_concat(a.name, ', ' ORDER BY aa.position)
                  FROM album_artists aa JOIN artists a ON a.id = aa.artist_id
                 WHERE aa.album_id = al.id) AS artists
        FROM albums al
        WHERE al.release_date >= date('now', '-90 days')
          AND (EXISTS (SELECT 1 FROM artist_albums x JOIN artists a ON a.id = x.artist_id
                        WHERE x.album_id = al.id AND a.is_followed = 1)
            OR EXISTS (SELECT 1 FROM album_artists x JOIN artists a ON a.id = x.artist_id
                        WHERE x.album_id = al.id AND a.is_followed = 1))
        ORDER BY al.release_date DESC LIMIT 36`),
      history: (query('SELECT COUNT(*) n, SUM(ms_played) ms FROM history_plays')[0] as { n: number; ms: number }).n
        ? {
            ...query('SELECT COUNT(*) n, SUM(ms_played) ms, MIN(ts) first, MAX(ts) last FROM history_plays')[0] as object,
            perMonth: query(`
              SELECT substr(ts, 1, 7) AS month, COUNT(*) AS n
              FROM history_plays GROUP BY month ORDER BY month`),
          }
        : null,
    };
  },

  '/api/artists': () => query(`
    SELECT a.id, a.name, a.genres, a.popularity, a.followers, a.image_url, a.is_followed,
           a.unfollowed_at, a.removed_at,
           (SELECT COUNT(*) FROM track_artists ta JOIN liked_tracks lt ON lt.track_id = ta.track_id
             WHERE ta.artist_id = a.id AND lt.removed_at IS NULL) AS liked_count,
           (SELECT MIN(rank) FROM top_artists t WHERE t.artist_id = a.id AND t.time_range = 'medium_term') AS top_rank
    FROM artists a
    WHERE a.is_followed = 1 OR liked_count > 0 OR top_rank IS NOT NULL OR a.unfollowed_at IS NOT NULL
    ORDER BY liked_count DESC, a.followers DESC`),

  '/api/artist': (params) => {
    const id = params.get('id') ?? '';
    return {
      artist: query(`SELECT * FROM artists WHERE id = ?`, id)[0] ?? null,
      albums: query(`
        SELECT DISTINCT al.id, al.name, al.album_type, al.release_date, al.image_url,
               al.total_tracks, al.is_saved, al.unsaved_at, al.removed_at, al.label,
               (SELECT downloaded FROM album_download_status ds WHERE ds.album_id = al.id) AS downloaded,
               COALESCE(aa.album_group, al.album_type) AS album_group
        FROM albums al
        LEFT JOIN artist_albums aa ON aa.album_id = al.id AND aa.artist_id = ?1
        WHERE aa.artist_id = ?1
           OR al.id IN (SELECT album_id FROM album_artists WHERE artist_id = ?1)
        ORDER BY al.release_date DESC`, id),
      liked: query(`
        SELECT t.id, t.name, t.duration_ms, lt.added_at, lt.removed_at,
               al.name AS album, al.id AS album_id, al.image_url
        FROM track_artists ta
        JOIN tracks t ON t.id = ta.track_id
        JOIN liked_tracks lt ON lt.track_id = t.id
        LEFT JOIN albums al ON al.id = t.album_id
        WHERE ta.artist_id = ? ORDER BY lt.added_at DESC`, id),
      topRanks: query(`
        SELECT time_range, MIN(rank) AS rank FROM top_artists
        WHERE artist_id = ? GROUP BY time_range`, id),
      events: query(`
        SELECT * FROM events WHERE artist_id = ? AND datetime >= date('now')
        ORDER BY datetime`, id),
    };
  },

  '/api/album': (params) => {
    const id = params.get('id') ?? '';
    if (id.startsWith(LOCAL_ALBUM_PREFIX)) {
      const tracks = upgrades.localTracks().filter((track) => track.album_id === id);
      if (!tracks.length) return { album: null, artists: [], tracks: [] };
      const first = tracks[0];
      return {
        album: {
          id,
          name: first.album,
          album_type: 'local',
          release_date: (first.added_at || '').slice(0, 10),
          image_url: null,
          total_tracks: tracks.length,
          is_saved: 1,
          downloaded: 1,
          local: 1,
        },
        // No Spotify artist id to link to, so the name carries it.
        artists: [{ id: null, name: first.artists }],
        tracks: tracks.map((track) => ({
          id: track.id,
          name: track.name,
          disc_number: 1,
          track_number: track.track_number,
          duration_ms: track.duration_ms,
          explicit: 0,
          artists: track.artists,
          liked: 0,
          local: 1,
        })),
      };
    }
    return {
      album: query(`SELECT al.*,
               (SELECT downloaded FROM album_download_status ds WHERE ds.album_id = al.id) AS downloaded
        FROM albums al WHERE al.id = ?`, id)[0] ?? null,
      artists: query(`
        SELECT a.id, a.name FROM album_artists aa JOIN artists a ON a.id = aa.artist_id
        WHERE aa.album_id = ? ORDER BY aa.position`, id),
      tracks: query(`
        SELECT t.id, t.name, t.disc_number, t.track_number, t.duration_ms, t.explicit,
               (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
                  FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                 WHERE ta.track_id = t.id) AS artists,
               (lt.track_id IS NOT NULL AND lt.removed_at IS NULL) AS liked
        FROM tracks t LEFT JOIN liked_tracks lt ON lt.track_id = t.id
        WHERE t.album_id = ? ORDER BY t.disc_number, t.track_number`, id),
    };
  },

  '/api/tracks': () => query(`
    SELECT t.id, t.name, t.duration_ms, t.popularity, lt.added_at, lt.removed_at,
           al.name AS album, al.id AS album_id, al.image_url, al.release_date,
           (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
              FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
             WHERE ta.track_id = t.id) AS artists
    FROM liked_tracks lt JOIN tracks t ON t.id = lt.track_id
    LEFT JOIN albums al ON al.id = t.album_id
    ORDER BY lt.added_at DESC`),

  '/api/albums': () => [
    // Locally imported albums are real music in the library, so they belong
    // in the same grid as saved Spotify albums - flagged downloaded, because
    // by definition the file is already on disk.
    ...localAlbums().map((album) => ({
      id: album.id,
      name: album.name,
      artists: album.artists,
      album_type: 'local',
      release_date: (album.added_at || '').slice(0, 10),
      image_url: null,
      saved_at: album.added_at,
      total_tracks: album.total_tracks,
      is_saved: 1,
      unsaved_at: null,
      removed_at: null,
      downloaded: 1,
      local: 1,
    })),
    ...query(`
    SELECT al.id, al.name, al.album_type, al.release_date, al.label, al.popularity,
           al.image_url, al.saved_at, al.total_tracks, al.is_saved, al.unsaved_at, al.removed_at,
           (SELECT downloaded FROM album_download_status ds WHERE ds.album_id = al.id) AS downloaded,
           (SELECT group_concat(a.name, ', ' ORDER BY aa.position)
              FROM album_artists aa JOIN artists a ON a.id = aa.artist_id
             WHERE aa.album_id = al.id) AS artists
    FROM albums al WHERE al.is_saved = 1 OR al.unsaved_at IS NOT NULL
    ORDER BY al.saved_at DESC`) as Record<string, unknown>[],
  ],

  // Everything the discography crawl knows that isn't in the saved section.
  // Server-side paging + search — this grows to thousands of rows.
  '/api/albums-all': (params) => {
    const q = `%${params.get('q') ?? ''}%`;
    const limit = Math.min(Number(params.get('limit') ?? 120), 500);
    const offset = Number(params.get('offset') ?? 0);
    return query(`
      SELECT al.id, al.name, al.album_type, al.release_date, al.image_url,
             al.total_tracks, al.is_saved, al.unsaved_at, al.removed_at,
             (SELECT downloaded FROM album_download_status ds WHERE ds.album_id = al.id) AS downloaded,
             (SELECT group_concat(a.name, ', ' ORDER BY aa.position)
                FROM album_artists aa JOIN artists a ON a.id = aa.artist_id
               WHERE aa.album_id = al.id) AS artists
      FROM albums al
      WHERE al.is_saved = 0 AND al.unsaved_at IS NULL
        AND (al.name LIKE ?1 OR artists LIKE ?1)
      ORDER BY al.release_date DESC
      LIMIT ?2 OFFSET ?3`, q, limit, offset);
  },

  // Whole track library grouped by album: a page of albums, each with its
  // tracks nested. Search matches album, artist, or track names.
  '/api/songs': (params) => {
    const q = `%${params.get('q') ?? ''}%`;
    const limit = Math.min(Number(params.get('limit') ?? 40), 200);
    const offset = Number(params.get('offset') ?? 0);
    const albums = query(`
      SELECT al.id, al.name, al.image_url, al.release_date, al.removed_at,
             (SELECT group_concat(a.name, ', ' ORDER BY aa.position)
                FROM album_artists aa JOIN artists a ON a.id = aa.artist_id
               WHERE aa.album_id = al.id) AS artists
      FROM albums al
      WHERE EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)
        AND (al.name LIKE ?1 OR artists LIKE ?1
             OR EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND t.name LIKE ?1))
      ORDER BY al.release_date DESC
      LIMIT ?2 OFFSET ?3`, q, limit, offset) as { id: string }[];
    if (!albums.length) return [];
    const marks = albums.map(() => '?').join(',');
    const tracks = query(`
      SELECT t.album_id, t.id, t.name, t.disc_number, t.track_number, t.duration_ms,
             (lt.track_id IS NOT NULL AND lt.removed_at IS NULL) AS liked
      FROM tracks t LEFT JOIN liked_tracks lt ON lt.track_id = t.id
      WHERE t.album_id IN (${marks})
      ORDER BY t.album_id, t.disc_number, t.track_number`, ...albums.map((a) => a.id)) as { album_id: string }[];
    return albums.map((al) => ({ ...al, tracks: tracks.filter((t) => t.album_id === al.id) }));
  },

  '/api/playlists': () => query(`
    SELECT p.id, p.name, p.description, p.owner_name, p.total_tracks, p.removed_at,
           (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id AND pt.removed_at IS NULL) AS synced_tracks
    FROM playlists p ORDER BY p.removed_at IS NOT NULL, p.name`),

  '/api/playlist-tracks': (params) => query(`
    SELECT pt.position, pt.added_at, pt.removed_at, t.id, t.name, t.duration_ms,
           al.name AS album, al.id AS album_id, al.image_url,
           (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
              FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
             WHERE ta.track_id = t.id) AS artists
    FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
    LEFT JOIN albums al ON al.id = t.album_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.removed_at IS NOT NULL, pt.position`, params.get('id') ?? ''),

  '/api/top-artists': (params) => query(`
    SELECT ta.rank, a.id, a.name, a.genres, a.image_url, a.is_followed
    FROM top_artists ta JOIN artists a ON a.id = ta.artist_id
    WHERE ta.time_range = ? ORDER BY ta.rank`, params.get('range') ?? 'medium_term'),

  '/api/top-tracks': (params) => query(`
    SELECT tt.rank, t.id, t.name, al.name AS album, al.image_url,
           (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
              FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
             WHERE ta.track_id = t.id) AS artists
    FROM top_tracks tt JOIN tracks t ON t.id = tt.track_id
    LEFT JOIN albums al ON al.id = t.album_id
    WHERE tt.time_range = ? ORDER BY tt.rank`, params.get('range') ?? 'medium_term'),

  // Wrapped-style play stats for any date range. Unifies the GDPR lifetime
  // history with the API's rolling capture (API rows only after the history
  // ends, so the overlap window isn't double-counted). History rows under
  // 30s are skips and don't count — same threshold Spotify uses.
  '/api/wrapped': (params) => {
    const from = params.get('from') ?? '0000';
    const to = (params.get('to') ?? '9999') + '~'; // '~' sorts after any ISO char
    // Plays made in this app live in their own database; ATTACH it read-only
    // (the connection is read-only, so the attachment is too) and fold them
    // into the unified stream. They can never overlap the Spotify sources.
    const hasAppPlays = existsSync(APP_PLAYS_FILE);
    const appBranch = hasAppPlays ? `
        UNION ALL
        SELECT ap.played_at, ap.track_id, t.name,
               (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
                  FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                 WHERE ta.track_id = ap.track_id),
               (SELECT al.name FROM albums al WHERE al.id = t.album_id),
               ap.ms_played
        FROM app.app_plays ap LEFT JOIN tracks t ON t.id = ap.track_id` : '';
    const cte = `
      WITH unified AS (
        SELECT ts, track_id, track_name, artist_name, album_name, ms_played
        FROM history_plays WHERE ms_played >= 30000
        UNION ALL
        SELECT p.played_at, p.track_id, t.name,
               (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
                  FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
                 WHERE ta.track_id = p.track_id),
               (SELECT al.name FROM albums al WHERE al.id = t.album_id),
               COALESCE(t.duration_ms, 210000)
        FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
        WHERE p.played_at > COALESCE((SELECT MAX(ts) FROM history_plays), '')${appBranch}
      ),
      ranged AS (SELECT * FROM unified WHERE ts >= ?1 AND ts <= ?2)
    `;
    return {
      totals: query(`${cte}
        SELECT COUNT(*) plays, SUM(ms_played) ms,
               COUNT(DISTINCT COALESCE(track_id, track_name)) tracks,
               COUNT(DISTINCT artist_name) artists
        FROM ranged`, from, to)[0],
      topTracks: query(`${cte}
        SELECT MAX(track_id) id, track_name, artist_name, COUNT(*) plays, SUM(ms_played) ms
        FROM ranged GROUP BY COALESCE(track_id, track_name || '~' || COALESCE(artist_name, ''))
        ORDER BY plays DESC LIMIT 100`, from, to),
      topArtists: query(`${cte}
        SELECT r.artist_name, COUNT(*) plays, SUM(r.ms_played) ms,
               MAX(a.id) artist_id, MAX(a.image_url) image_url
        FROM ranged r LEFT JOIN artists a ON a.name = r.artist_name
        WHERE r.artist_name IS NOT NULL
        GROUP BY r.artist_name ORDER BY plays DESC LIMIT 100`, from, to),
      topAlbums: query(`${cte}
        SELECT r.album_name, r.artist_name, COUNT(*) plays,
               MAX(al.id) album_id, MAX(al.image_url) image_url
        FROM ranged r LEFT JOIN albums al ON al.name = r.album_name
        WHERE r.album_name IS NOT NULL
        GROUP BY r.album_name, r.artist_name ORDER BY plays DESC LIMIT 50`, from, to),
      perMonth: query(`${cte}
        SELECT substr(ts, 1, 7) AS month, COUNT(*) AS n
        FROM ranged GROUP BY month ORDER BY month`, from, to),
      years: (query(`SELECT DISTINCT substr(ts, 1, 4) y FROM history_plays
                     UNION SELECT DISTINCT substr(played_at, 1, 4) FROM plays ORDER BY y`) as { y: string }[])
        .map((r) => r.y),
    };
  },

  '/api/events': () => {
    const near = (process.env.EVENT_COUNTRIES ?? 'NL').split(',').map((c) => c.trim().toUpperCase());
    const rows = query(`
      SELECT e.*, a.name AS artist_name, a.image_url
      FROM events e LEFT JOIN artists a ON a.id = e.artist_id
      WHERE e.datetime >= date('now')
      ORDER BY e.datetime`) as { country: string }[];
    return {
      countries: near,
      near: rows.filter((r) => near.includes(r.country)),
      elsewhere: rows.filter((r) => !near.includes(r.country)),
    };
  },

  // Lidarr "Custom List" feed: [{MusicBrainzId, ArtistName}]. MBIDs come from
  // the artist_mbid cache (src/musicbrainz.ts); eligibility mirrors that
  // stage's rule (followed, or ≥ LIDARR_MIN_LIKED liked tracks) so an artist
  // unfollowed later drops out of the feed even though the cache row stays.
  '/api/lidarr-list': () => query(`
    SELECT am.mbid AS MusicBrainzId, a.name AS ArtistName
    FROM artist_mbid am JOIN artists a ON a.id = am.artist_id
    WHERE am.mbid <> '' AND a.removed_at IS NULL
      AND (a.is_followed = 1
        OR (SELECT COUNT(*) FROM track_artists ta JOIN liked_tracks lt ON lt.track_id = ta.track_id
             WHERE ta.artist_id = a.id AND lt.removed_at IS NULL) >= ?)
    ORDER BY a.name`, Number(process.env.LIDARR_MIN_LIKED ?? 3)),

  '/api/plays': () => query(`
    SELECT p.played_at, p.context_type, t.id, t.name, al.image_url, al.id AS album_id,
           (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
              FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
             WHERE ta.track_id = t.id) AS artists
    FROM plays p JOIN tracks t ON t.id = p.track_id
    LEFT JOIN albums al ON al.id = t.album_id
    ORDER BY p.played_at DESC LIMIT 300`),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api/upgrades') {
      if (req.method === 'GET') {
        const result = upgrades.list(Number(url.searchParams.get('limit') ?? 250));
        json(res, 200, { ...result, jobs: result.jobs.map(publicUpgrade) });
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' });
        return;
      }
      try {
        const body = await readJson(req);
        const suppliedUrl = String(body.sourceUrl ?? '').trim();
        const sourceMode = String(body.sourceMode ?? 'single') as SourceMode;
        if (!['single', 'playlist', 'chapters'].includes(sourceMode)) {
          throw new Error('sourceMode must be single, playlist, or chapters');
        }
        const isBatch = sourceMode !== 'single';
        const explicitTrackId = String(body.trackId ?? '').trim();
        if (isBatch && explicitTrackId) throw new Error('album intake cannot target one Spotify track');
        let trackId = explicitTrackId;
        if (!isBatch && !trackId && suppliedUrl) {
          try {
            const source = new URL(suppliedUrl);
            const spotifyTrack = source.hostname === 'open.spotify.com'
              ? source.pathname.match(/^\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]+)/i)
              : null;
            if (spotifyTrack) trackId = spotifyTrack[1];
          } catch { /* validSourceUrl below returns the useful error */ }
        }
        let track = trackId ? tasteTrack(trackId) : null;
        if (explicitTrackId && !track) {
          json(res, 404, { error: 'track is not in the taste database' });
          return;
        }
        // A pasted Spotify URL can identify a known taste-db track without
        // asking for metadata. For a genuinely new Spotify track, fall back
        // to the manual artist/title fields instead of rejecting the URL.
        if (!explicitTrackId && trackId && !track) trackId = '';
        const sourceUrl = suppliedUrl || (trackId ? `https://open.spotify.com/track/${trackId}` : '');
        if (!validSourceUrl(sourceUrl)) {
          json(res, 422, { error: 'sourceUrl must be an https Spotify or YouTube URL' });
          return;
        }
        if (isBatch && !isYouTubeUrl(sourceUrl)) {
          json(res, 422, { error: 'playlist and chapter intake require a YouTube URL' });
          return;
        }
        const downloader = String(body.downloader ?? 'auto');
        if (!['auto', 'yt-dlp', 'spotdl'].includes(downloader)) {
          json(res, 422, { error: 'downloader must be auto, yt-dlp, or spotdl' });
          return;
        }

        // If Jellyfin already has the track, skip the lossy intake download
        // and search for a lossless replacement directly. A cold/offline
        // archive simply falls back to the source-download phase.
        let match = null;
        if (track) {
          try { match = await resolveMatch(track); } catch { /* archive asleep or unconfigured */ }
        }
        const artist = track?.artists ?? String(body.artist ?? '');
        const album = track?.album ?? String(body.album ?? '');
        const title = track?.name ?? String(body.title ?? '');
        if (isBatch && (!artist.trim() || !album.trim())) {
          throw new Error('artist and album are required for playlist or chapter intake');
        }
        const created = upgrades.create({
          trackId: track?.id ?? null,
          sourceUrl,
          downloader: isBatch ? 'yt-dlp' : downloader as 'auto' | 'yt-dlp' | 'spotdl',
          sourceMode,
          artist,
          title: isBatch ? album : title,
          album,
          durationMs: track?.duration_ms ?? (Number(body.durationMs ?? 0) || null),
          currentPath: match?.path ?? null,
          currentCodec: match?.container ?? null,
          maxAttempts: Number(body.maxAttempts ?? 6),
        });
        json(res, 201, { job: publicUpgrade(created) });
      } catch (err) {
        const message = (err as Error).message;
        json(res, /already in the active/.test(message) ? 409 : 422, { error: message });
      }
      return;
    }
    if (url.pathname === '/api/upgrades/retry' || url.pathname === '/api/upgrades/cancel') {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
        return;
      }
      try {
        const body = await readJson(req);
        const id = Number(body.id);
        if (!Number.isInteger(id) || id < 1) throw new Error('a valid job id is required');
        const job = url.pathname.endsWith('/retry') ? upgrades.retry(id) : upgrades.cancel(id);
        json(res, 200, { job: publicUpgrade(job) });
      } catch (err) {
        json(res, 409, { error: (err as Error).message });
      }
      return;
    }
    if (url.pathname === '/api/upgrades/claim' || url.pathname === '/api/upgrades/complete') {
      if (!UPGRADE_WORKER_TOKEN) {
        json(res, 503, { error: 'upgrade worker token is not configured' });
        return;
      }
      if (!workerAuthorized(req)) {
        json(res, 401, { error: 'invalid worker token' });
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
        return;
      }
      try {
        const body = await readJson(req, 512_000);
        if (url.pathname.endsWith('/claim')) {
          const job = upgrades.claim(String(body.workerId ?? ''), Number(body.leaseSeconds ?? 7_200));
          json(res, 200, { job });
          return;
        }
        const outcome = String(body.outcome ?? '');
        if (!['source_ready', 'batch_ready', 'upgraded', 'already_lossless', 'failed'].includes(outcome)) {
          throw new Error('invalid completion outcome');
        }
        if (outcome === 'batch_ready') {
          if (!Array.isArray(body.tracks)) throw new Error('batch_ready requires tracks');
          const result = upgrades.finishBatch({
            id: Number(body.id),
            claimToken: String(body.claimToken ?? ''),
            resultPath: String(body.resultPath ?? ''),
            tracks: body.tracks.map((raw) => {
              if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('invalid batch track');
              const track = raw as Record<string, unknown>;
              return {
                sourceUrl: track.sourceUrl == null ? null : String(track.sourceUrl),
                artist: String(track.artist ?? ''),
                title: String(track.title ?? ''),
                album: String(track.album ?? ''),
                durationMs: Number(track.durationMs ?? 0),
                currentPath: String(track.currentPath ?? ''),
                currentCodec: String(track.currentCodec ?? ''),
                trackNumber: Number(track.trackNumber ?? 0),
              } satisfies BatchTrack;
            }),
          });
          void jellyfin.refreshLibrary().catch((err) => console.error('Jellyfin refresh:', (err as Error).message));
          json(res, 200, {
            job: publicUpgrade(result.job),
            children: result.children.map(publicUpgrade),
          });
          return;
        }
        const job = upgrades.finish({
          id: Number(body.id),
          claimToken: String(body.claimToken ?? ''),
          outcome: outcome as 'source_ready' | 'upgraded' | 'already_lossless' | 'failed',
          error: body.error == null ? null : String(body.error),
          candidate: body.candidate == null ? null : String(body.candidate),
          currentPath: body.currentPath == null ? null : String(body.currentPath),
          currentCodec: body.currentCodec == null ? null : String(body.currentCodec),
          resultPath: body.resultPath == null ? null : String(body.resultPath),
        });
        if (outcome === 'source_ready' || outcome === 'upgraded') {
          void jellyfin.refreshLibrary().catch((err) => console.error('Jellyfin refresh:', (err as Error).message));
        }
        json(res, 200, { job: publicUpgrade(job) });
      } catch (err) {
        json(res, 409, { error: (err as Error).message });
      }
      return;
    }
    if (url.pathname === '/api/player/wake') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      await jellyfin.wake();
      res.writeHead(202, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ accepted: true }));
      return;
    }
    if (url.pathname === '/api/player/played') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 10_000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { id?: string; msPlayed?: number; completed?: boolean };
        const track = tasteTrack(String(body.id ?? ''));
        const ms = Number(body.msPlayed);
        // Server-enforced Spotify-style threshold: under 20s is a skim, not a play.
        if (!track || !Number.isFinite(ms) || ms < 20_000) {
          res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ recorded: false }));
          return;
        }
        appPlays.record(track.id, ms, Boolean(body.completed));
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
      return;
    }
    if (url.pathname === '/api/player/stream') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end();
        return;
      }
      const track = tasteTrack(url.searchParams.get('id') ?? '');
      if (!track) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('unknown track');
        return;
      }
      const online = await jellyfin.sourceOnline();
      if (online === false) {
        res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '15' }).end('music archive is offline');
        return;
      }
      const match = await resolveMatch(track);
      if (!match) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('track not matched in Jellyfin');
        return;
      }
      // Tie the upstream fetch to the browser connection: pause/disconnect
      // cancels the Jellyfin read instead of leaking it until file end.
      const clientGone = new AbortController();
      res.on('close', () => clientGone.abort());
      const upstream = await jellyfin.stream(match.itemId, req.headers.range, clientGone.signal);
      const headers: Record<string, string> = { 'cache-control': 'private, no-store' };
      for (const name of ['accept-ranges', 'content-length', 'content-range', 'content-type', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      res.writeHead(upstream.status, headers);
      if (req.method === 'HEAD' || !upstream.body) {
        res.end();
        return;
      }
      const body = Readable.fromWeb(upstream.body as never);
      // A mid-stream upstream failure (NFS hiccup, our own abort) must drop
      // the response, not crash the process via an unhandled 'error'.
      body.on('error', () => res.destroy());
      body.pipe(res);
      return;
    }
    const handler = api[url.pathname];
    if (handler) {
      // Serialize BEFORE writeHead — a handler that throws mid-write would
      // otherwise crash the process with ERR_HTTP_HEADERS_SENT.
      const body = JSON.stringify(await handler(url.searchParams));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(INDEX));
      return;
    }
    const staticFile = STATIC_FILES[url.pathname];
    if (staticFile) {
      res.writeHead(200, { 'content-type': staticFile.type, 'cache-control': 'no-cache' });
      res.end(readFileSync(staticFile.file));
      return;
    }
    // Locally archived cover art (survives content being pulled from Spotify).
    // Locally imported albums have no Spotify artwork. Prefer the cover file
    // sitting beside the audio (the intake writes one); fall back to asking
    // Jellyfin, which extracts embedded art. Jellyfin has proved unreliable
    // at ingesting folder art over the NFS mount, so the file comes first.
    const localImage = url.pathname.match(/^\/img\/local\/([A-Za-z0-9-]+)\.jpg$/);
    if (localImage) {
      const track = upgrades.localTracks().find((row) => row.album_id === localImage[1]);
      if (track) {
        // The worker records its own mount path; this container sees the
        // same tree under APP_LIBRARY_PREFIX.
        const dir = path.dirname(track.path.replace(/\\/g, '/'));
        if (dir.startsWith(LOCAL_LIBRARY_PREFIX)) {
          const local = path.join(APP_LIBRARY_PREFIX, dir.slice(LOCAL_LIBRARY_PREFIX.length));
          for (const name of ['cover.jpg', 'folder.jpg', 'cover.png', 'folder.png']) {
            try {
              const body = readFileSync(path.join(local, name));
              res.writeHead(200, {
                'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg',
                'cache-control': 'public, max-age=86400',
              });
              res.end(body);
              return;
            } catch { /* try the next filename */ }
          }
        }
        try {
          const match = await jellyfin.matchPath(track.path);
          if (match) {
            // Folder/embedded art attaches to Jellyfin's album entity, not
            // to each audio item, so prefer the album and fall back to the track.
            let upstream: Response | null = null;
            for (const candidate of [match.albumId, match.itemId]) {
              if (!candidate) continue;
              try {
                upstream = await jellyfin.image(candidate);
                break;
              } catch { /* try the next one */ }
            }
            if (!upstream) throw new Error('no artwork');
            const body = Buffer.from(await upstream.arrayBuffer());
            res.writeHead(200, {
              'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
              'cache-control': 'public, max-age=3600',
            });
            res.end(body);
            return;
          }
        } catch { /* fall through to 404 - the UI shows its letter placeholder */ }
      }
      res.writeHead(404).end();
      return;
    }
    const image = url.pathname.match(/^\/img\/(albums|artists)\/([A-Za-z0-9]+)\.jpg$/);
    if (image) {
      try {
        const body = readFileSync(path.join(path.dirname(DB_FILE), 'images', image[1], `${image[2]}.jpg`));
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    const gone = /unable to open/i.test((err as Error).message ?? '');
    res.writeHead(gone ? 503 : 500, { 'content-type': 'text/plain' });
    res.end(gone ? 'database not created yet — wait for the first export run' : `error: ${(err as Error).message}`);
    if (!gone) console.error(err);
  }
});

ensureLidarrTables();
server.listen(PORT, () => console.log(`taste-db ui on :${PORT}, db: ${DB_FILE}`));
