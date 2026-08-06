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
  added_at TEXT NOT NULL
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
  PRIMARY KEY (playlist_id, position)
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

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_track_artists_artist ON track_artists(artist_id);
CREATE INDEX IF NOT EXISTS idx_plays_track ON plays(track_id);
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
  release_date?: string;
  release_date_precision?: string;
  total_tracks?: number;
  label?: string;
  popularity?: number;
  images?: { url: string }[];
  artists?: ApiArtist[];
}

export interface ApiTrack {
  id: string | null;
  name: string;
  type?: string;
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
