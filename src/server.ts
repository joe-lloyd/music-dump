// Read-only web UI over the taste DB. Zero deps: node:http + node:sqlite.
// The DB is opened per request (read-only) so the exporter writing in the
// same volume never fights a long-lived reader snapshot.
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(import.meta.dirname, '..');
const DB_FILE = process.env.SPOTIFY_DB ?? path.join(ROOT, 'data', 'spotify.db');
const PORT = Number(process.env.PORT ?? 8080);
const INDEX = path.join(ROOT, 'public', 'index.html');

function query(sql: string, ...args: (string | number)[]): unknown[] {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

const api: Record<string, (params: URLSearchParams) => unknown> = {
  '/api/stats': () => {
    const one = (sql: string) => (query(sql)[0] as Record<string, unknown>) ?? {};
    return {
      counts: {
        liked: one('SELECT COUNT(*) n FROM liked_tracks WHERE removed_at IS NULL').n,
        artists: one('SELECT COUNT(*) n FROM artists').n,
        followed: one('SELECT COUNT(*) n FROM artists WHERE is_followed = 1').n,
        albums: one('SELECT COUNT(*) n FROM albums WHERE is_saved = 1').n,
        playlists: one('SELECT COUNT(*) n FROM playlists WHERE removed_at IS NULL').n,
        plays: one('SELECT COUNT(*) n FROM plays').n,
      },
      lastSync: one('SELECT MAX(finished_at) t FROM sync_runs').t,
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
    return {
      album: query(`SELECT * FROM albums WHERE id = ?`, id)[0] ?? null,
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

  '/api/albums': () => query(`
    SELECT al.id, al.name, al.album_type, al.release_date, al.label, al.popularity,
           al.image_url, al.saved_at, al.total_tracks, al.is_saved, al.unsaved_at, al.removed_at,
           (SELECT group_concat(a.name, ', ' ORDER BY aa.position)
              FROM album_artists aa JOIN artists a ON a.id = aa.artist_id
             WHERE aa.album_id = al.id) AS artists
    FROM albums al WHERE al.is_saved = 1 OR al.unsaved_at IS NOT NULL
    ORDER BY al.saved_at DESC`),

  // Everything the discography crawl knows that isn't in the saved section.
  // Server-side paging + search — this grows to thousands of rows.
  '/api/albums-all': (params) => {
    const q = `%${params.get('q') ?? ''}%`;
    const limit = Math.min(Number(params.get('limit') ?? 120), 500);
    const offset = Number(params.get('offset') ?? 0);
    return query(`
      SELECT al.id, al.name, al.album_type, al.release_date, al.image_url,
             al.total_tracks, al.is_saved, al.unsaved_at, al.removed_at,
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
        WHERE p.played_at > COALESCE((SELECT MAX(ts) FROM history_plays), '')
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

  '/api/plays': () => query(`
    SELECT p.played_at, p.context_type, t.id, t.name, al.image_url, al.id AS album_id,
           (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
              FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
             WHERE ta.track_id = t.id) AS artists
    FROM plays p JOIN tracks t ON t.id = p.track_id
    LEFT JOIN albums al ON al.id = t.album_id
    ORDER BY p.played_at DESC LIMIT 300`),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const handler = api[url.pathname];
    if (handler) {
      // Serialize BEFORE writeHead — a handler that throws mid-write would
      // otherwise crash the process with ERR_HTTP_HEADERS_SENT.
      const body = JSON.stringify(handler(url.searchParams));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(INDEX));
      return;
    }
    // Locally archived cover art (survives content being pulled from Spotify).
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

server.listen(PORT, () => console.log(`taste-db ui on :${PORT}, db: ${DB_FILE}`));
