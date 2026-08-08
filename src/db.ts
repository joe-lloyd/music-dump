import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  genres TEXT,                 -- JSON array; NULL until hydrated via /artists
  popularity INTEGER,
  followers INTEGER,
  image_url TEXT,
  is_followed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  album_type TEXT,
  release_date TEXT,
  release_date_precision TEXT,
  total_tracks INTEGER,
  label TEXT,                  -- NULL until hydrated via /albums
  popularity INTEGER,
  image_url TEXT,
  is_saved INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT
);

CREATE TABLE IF NOT EXISTS album_artists (
  album_id TEXT NOT NULL REFERENCES albums(id),
  artist_id TEXT NOT NULL REFERENCES artists(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (album_id, artist_id)
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  album_id TEXT REFERENCES albums(id),
  disc_number INTEGER,
  track_number INTEGER,
  duration_ms INTEGER,
  explicit INTEGER,
  popularity INTEGER,
  isrc TEXT
);

CREATE TABLE IF NOT EXISTS track_artists (
  track_id TEXT NOT NULL REFERENCES tracks(id),
  artist_id TEXT NOT NULL REFERENCES artists(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (track_id, artist_id)
);

CREATE TABLE IF NOT EXISTS liked_tracks (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id),
  added_at TEXT NOT NULL,
  removed_at TEXT              -- set when un-liked; row is never deleted
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  owner_id TEXT,
  owner_name TEXT,
  is_public INTEGER,
  is_collaborative INTEGER,
  snapshot_id TEXT,
  total_tracks INTEGER
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id),
  track_id TEXT NOT NULL REFERENCES tracks(id),
  position INTEGER NOT NULL,
  added_at TEXT,
  added_by TEXT,
  removed_at TEXT,             -- set when gone from the playlist; never deleted
  PRIMARY KEY (playlist_id, track_id, position)
);

CREATE TABLE IF NOT EXISTS top_artists (
  time_range TEXT NOT NULL,    -- short_term | medium_term | long_term
  rank INTEGER NOT NULL,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  PRIMARY KEY (time_range, rank)
);

CREATE TABLE IF NOT EXISTS top_tracks (
  time_range TEXT NOT NULL,
  rank INTEGER NOT NULL,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  PRIMARY KEY (time_range, rank)
);

-- Recently played; appends across runs (the API only exposes the last 50,
-- so run the export regularly to accumulate history).
CREATE TABLE IF NOT EXISTS plays (
  played_at TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  context_type TEXT,
  context_uri TEXT
);

-- Full discographies (albums/singles/compilations per artist), crawled so the
-- library survives content being pulled from Spotify.
CREATE TABLE IF NOT EXISTS artist_albums (
  artist_id TEXT NOT NULL REFERENCES artists(id),
  album_id TEXT NOT NULL REFERENCES albums(id),
  album_group TEXT,            -- album | single | compilation
  PRIMARY KEY (artist_id, album_id)
);

-- Lifetime listening history from Spotify's GDPR "Extended streaming history"
-- export, loaded by src/import-history.ts. Kept separate from the plays table
-- (the rolling API capture): different fidelity, different source. The PK
-- dedupes re-imports of overlapping exports.
CREATE TABLE IF NOT EXISTS history_plays (
  ts TEXT NOT NULL,
  track_name TEXT NOT NULL DEFAULT '',
  ms_played INTEGER NOT NULL DEFAULT 0,
  track_id TEXT,               -- parsed from spotify_track_uri when present
  artist_name TEXT,
  album_name TEXT,
  platform TEXT,
  country TEXT,
  reason_start TEXT,
  reason_end TEXT,
  shuffle INTEGER,
  skipped INTEGER,
  PRIMARY KEY (ts, track_name, ms_played)
);

-- Upcoming concerts for followed artists, from the Ticketmaster Discovery
-- API. Never deleted: last_seen_at goes stale when an event vanishes
-- (cancelled or past), first_seen_at drives new-show notifications.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  artist_id TEXT REFERENCES artists(id),
  name TEXT,
  datetime TEXT,
  venue TEXT,
  city TEXT,
  country TEXT,               -- ISO code, e.g. NL
  url TEXT,                   -- ticket page
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Spotify artist → MusicBrainz id cache, filled by src/musicbrainz.ts and
-- served to Lidarr via /api/lidarr-list. '' = looked up, no confident match
-- (retried monthly); a real MBID is permanent.
CREATE TABLE IF NOT EXISTS artist_mbid (
  artist_id TEXT PRIMARY KEY REFERENCES artists(id),
  mbid TEXT NOT NULL DEFAULT '',
  method TEXT,                 -- isrc | name
  resolved_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_track_artists_artist ON track_artists(artist_id);
CREATE INDEX IF NOT EXISTS idx_plays_track ON plays(track_id);
CREATE INDEX IF NOT EXISTS idx_history_track ON history_plays(track_id);
CREATE INDEX IF NOT EXISTS idx_history_month ON history_plays(substr(ts, 1, 7));
`;

// node:sqlite rejects undefined and booleans as bind values.
type Bindable = string | number | null;
function v(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as Bindable;
}

// Loose shapes of the Spotify API objects we consume.
export interface ApiArtist {
  id: string;
  name: string;
  genres?: string[];
  popularity?: number;
  followers?: { total: number };
  images?: { url: string }[];
}

export interface ApiAlbum {
  id: string;
  name: string;
  album_type?: string;
  album_group?: string; // present on /artists/{id}/albums items
  release_date?: string;
  release_date_precision?: string;
  total_tracks?: number;
  label?: string;
  popularity?: number;
  images?: { url: string }[];
  artists?: ApiArtist[];
  tracks?: { items?: ApiTrack[]; next?: string | null };
}

export interface ApiTrack {
  id: string | null;
  name: string;
  type?: string;
  episode?: boolean; // dev-mode playlist shape flags episodes with a boolean
  is_local?: boolean;
  album?: ApiAlbum;
  artists?: ApiArtist[];
  disc_number?: number;
  track_number?: number;
  duration_ms?: number;
  explicit?: boolean;
  popularity?: number;
  external_ids?: { isrc?: string };
}

export class TasteDb {
  readonly db: DatabaseSync;
  private stmts = new Map<string, StatementSync>();

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    // Migrations for columns added after the first release.
    for (const ddl of [
      `ALTER TABLE artists ADD COLUMN discog_synced_at TEXT`,
      `ALTER TABLE albums ADD COLUMN tracks_synced INTEGER NOT NULL DEFAULT 0`,
      // Tombstones: nothing is ever deleted, only tagged with when it went away.
      `ALTER TABLE artists ADD COLUMN unfollowed_at TEXT`,
      `ALTER TABLE artists ADD COLUMN removed_at TEXT`,
      `ALTER TABLE albums ADD COLUMN unsaved_at TEXT`,
      `ALTER TABLE albums ADD COLUMN removed_at TEXT`,
      `ALTER TABLE liked_tracks ADD COLUMN removed_at TEXT`,
      `ALTER TABLE playlists ADD COLUMN removed_at TEXT`,
      `ALTER TABLE playlist_tracks ADD COLUMN removed_at TEXT`,
      // Concert sync markers: when events were last checked, and the artist's
      // Ticketmaster attraction id ('' = looked up, no match).
      `ALTER TABLE artists ADD COLUMN events_synced_at TEXT`,
      `ALTER TABLE artists ADD COLUMN tm_attraction_id TEXT`,
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // column already exists
      }
    }
    // playlist_tracks PK widened from (playlist_id, position) to
    // (playlist_id, track_id, position) so a track shifting position leaves
    // its tombstone row intact. SQLite can't alter a PK — rebuild once.
    const pk = this.db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('playlist_tracks') WHERE pk > 0`).get() as { n: number };
    if (pk.n === 2) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE playlist_tracks_new (
          playlist_id TEXT NOT NULL REFERENCES playlists(id),
          track_id TEXT NOT NULL REFERENCES tracks(id),
          position INTEGER NOT NULL,
          added_at TEXT,
          added_by TEXT,
          removed_at TEXT,
          PRIMARY KEY (playlist_id, track_id, position)
        );
        INSERT OR IGNORE INTO playlist_tracks_new SELECT playlist_id, track_id, position, added_at, added_by, removed_at FROM playlist_tracks;
        DROP TABLE playlist_tracks;
        ALTER TABLE playlist_tracks_new RENAME TO playlist_tracks;
        COMMIT;
      `);
    }
  }

  // Tombstone helper for full-set syncs: rows in `table` whose `keyCol` is
  // not in `presentIds` get `col` stamped; present rows get it cleared (an
  // item re-liked/re-followed/re-saved comes back to life, keeping history
  // simple: the current state plus when it last went away).
  markMissing(table: string, keyCol: string, col: string, presentIds: string[], extraWhere = '1=1'): number {
    this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS present_ids (id TEXT PRIMARY KEY)`);
    this.db.exec(`DELETE FROM present_ids`);
    const ins = this.db.prepare(`INSERT OR IGNORE INTO present_ids (id) VALUES (?)`);
    for (const id of presentIds) ins.run(id);
    const res = this.db.prepare(`
      UPDATE ${table} SET ${col} = ?
      WHERE ${col} IS NULL AND ${extraWhere} AND ${keyCol} NOT IN (SELECT id FROM present_ids)`
    ).run(new Date().toISOString());
    this.db.prepare(`UPDATE ${table} SET ${col} = NULL WHERE ${keyCol} IN (SELECT id FROM present_ids)`).run();
    return Number(res.changes);
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string, ...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.prepare(sql).run(...args.map(v));
  }

  count(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // COALESCE keeps hydrated fields (genres, followers, ...) when a later
  // upsert only carries the simplified artist object.
  upsertArtist(artist: ApiArtist, opts: { followed?: boolean } = {}): void {
    this.run(
      `INSERT INTO artists (id, name, genres, popularity, followers, image_url, is_followed)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         genres = COALESCE(excluded.genres, genres),
         popularity = COALESCE(excluded.popularity, popularity),
         followers = COALESCE(excluded.followers, followers),
         image_url = COALESCE(excluded.image_url, image_url),
         is_followed = MAX(is_followed, excluded.is_followed)`,
      artist.id,
      artist.name,
      artist.genres ? JSON.stringify(artist.genres) : null,
      artist.popularity,
      artist.followers?.total,
      artist.images?.[0]?.url,
      opts.followed ?? false,
    );
  }

  upsertAlbum(album: ApiAlbum, opts: { savedAt?: string } = {}): void {
    this.run(
      `INSERT INTO albums (id, name, album_type, release_date, release_date_precision,
                           total_tracks, label, popularity, image_url, is_saved, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         album_type = COALESCE(excluded.album_type, album_type),
         release_date = COALESCE(excluded.release_date, release_date),
         release_date_precision = COALESCE(excluded.release_date_precision, release_date_precision),
         total_tracks = COALESCE(excluded.total_tracks, total_tracks),
         label = COALESCE(excluded.label, label),
         popularity = COALESCE(excluded.popularity, popularity),
         image_url = COALESCE(excluded.image_url, image_url),
         is_saved = MAX(is_saved, excluded.is_saved),
         saved_at = COALESCE(excluded.saved_at, saved_at)`,
      album.id,
      album.name,
      album.album_type,
      album.release_date,
      album.release_date_precision,
      album.total_tracks,
      album.label,
      album.popularity,
      album.images?.[0]?.url,
      opts.savedAt !== undefined,
      opts.savedAt,
    );
    for (const [i, artist] of (album.artists ?? []).entries()) {
      if (!artist.id) continue;
      this.upsertArtist(artist);
      this.run(
        `INSERT OR REPLACE INTO album_artists (album_id, artist_id, position) VALUES (?, ?, ?)`,
        album.id,
        artist.id,
        i,
      );
    }
  }

  // Handles both full track objects (liked/playlist/top) and the simplified
  // ones embedded in album track listings (pass albumId for those).
  upsertTrack(track: ApiTrack, albumId?: string): void {
    if (!track.id) return;
    if (track.album?.id) this.upsertAlbum(track.album);
    this.run(
      `INSERT INTO tracks (id, name, album_id, disc_number, track_number,
                           duration_ms, explicit, popularity, isrc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         album_id = COALESCE(excluded.album_id, album_id),
         disc_number = COALESCE(excluded.disc_number, disc_number),
         track_number = COALESCE(excluded.track_number, track_number),
         duration_ms = COALESCE(excluded.duration_ms, duration_ms),
         explicit = COALESCE(excluded.explicit, explicit),
         popularity = COALESCE(excluded.popularity, popularity),
         isrc = COALESCE(excluded.isrc, isrc)`,
      track.id,
      track.name,
      track.album?.id ?? albumId,
      track.disc_number,
      track.track_number,
      track.duration_ms,
      track.explicit,
      track.popularity,
      track.external_ids?.isrc,
    );
    for (const [i, artist] of (track.artists ?? []).entries()) {
      if (!artist.id) continue;
      this.upsertArtist(artist);
      this.run(
        `INSERT OR REPLACE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)`,
        track.id,
        artist.id,
        i,
      );
    }
  }
}
