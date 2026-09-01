// Where each file in the library came from, and how good it actually is.
//
// The library is fed by five different pipelines (Lidarr over usenet, Lidarr
// over torrents, the YouTube intake, Soulseek upgrades, and CD rips) and until
// now a track on the Songs page looked identical whichever one produced it.
// This store keeps one row per audio file recording both, so the UI can badge
// a song with its quality tier and its origin.
//
// It is *derived* data: a scanner on eliot walks the library, reads the audio
// headers, joins Lidarr's grab history for the origin, and posts batches here.
// Nothing else writes it, and dropping the file loses nothing but a rescan.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { normalizeMusicText } from './jellyfin.ts';

export const PROVENANCE_FILE = process.env.PROVENANCE_DB
  ?? path.join(import.meta.dirname, '..', 'data', 'provenance.db');

// Ordered worst to best. The UI renders the tier name, so keep these stable.
export const QUALITY_TIERS = ['low', 'standard', 'high', 'lossless', 'hires'] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

export const SOURCES = ['youtube', 'cd', 'usenet', 'torrent', 'soulseek', 'unknown'] as const;
export type Source = (typeof SOURCES)[number];

const LOSSLESS_CODECS = new Set(['flac', 'alac', 'wav', 'ape', 'wavpack', 'wv', 'aiff', 'tta']);

export interface AudioInfo {
  codec: string | null;
  bitrate: number | null;      // kbps
  sampleRate: number | null;   // Hz
  bitDepth: number | null;     // bits per sample; only meaningful for lossless
}

/**
 * Bucket a file into the tier its badge shows.
 *
 * Lossless is decided by codec alone - a FLAC's nominal bitrate says something
 * about the music, not the fidelity, so feeding it into the lossy thresholds
 * would be nonsense. Only inside lossless does the bit depth / sample rate
 * split hi-res out.
 *
 * Lossy files fall on bitrate, with the boundaries chosen from what actually
 * feeds this library:
 *
 *   >= 256  MP3-320 and AAC-256, which is what the usenet releases are.
 *   >=  96  YouTube's best Opus stream (itag 251), which measures anywhere
 *           from 110 to 160 kbps depending on the material. The floor sits at
 *           96 rather than 128 so a quiet track and a loud one off the same
 *           download do not land in different tiers - they are the same
 *           source at the same settings, and the badge should say so.
 *    <  96  YouTube's fallback streams (itags 249/250) and old low-bitrate
 *           MP3s: the files genuinely worth replacing.
 *
 * The exact figure is always shown next to the tier, so nothing here hides
 * the difference between a 100 kbps file and a 250 kbps one.
 */
export function qualityTier(info: AudioInfo): QualityTier {
  const codec = String(info.codec ?? '').trim().toLowerCase();
  if (LOSSLESS_CODECS.has(codec)) {
    const depth = Number(info.bitDepth ?? 0);
    const rate = Number(info.sampleRate ?? 0);
    return depth >= 24 || rate > 48_000 ? 'hires' : 'lossless';
  }
  const bitrate = Number(info.bitrate ?? 0);
  if (bitrate >= 256) return 'high';
  if (bitrate >= 96) return 'standard';
  return 'low';
}

/** Short label for the badge, e.g. "FLAC 24" / "320". */
export function qualityLabel(tier: QualityTier, info: AudioInfo): string {
  switch (tier) {
    case 'hires': {
      const depth = Number(info.bitDepth ?? 0);
      const khz = info.sampleRate ? Math.round(Number(info.sampleRate) / 100) / 10 : null;
      return depth >= 24 ? `${depth}/${khz ?? '?'}` : `${khz ?? '?'} kHz`;
    }
    case 'lossless':
      return String(info.codec ?? 'lossless').toUpperCase();
    default:
      return info.bitrate ? `${Math.round(Number(info.bitrate))}k` : String(info.codec ?? '').toUpperCase();
  }
}

export function isSource(value: unknown): value is Source {
  return (SOURCES as readonly string[]).includes(String(value));
}

export function isTier(value: unknown): value is QualityTier {
  return (QUALITY_TIERS as readonly string[]).includes(String(value));
}

/**
 * Lookup key shared with the taste DB.
 *
 * Provenance is recorded per file path, but the Songs page renders Spotify
 * track rows that have no path - resolving those through Jellyfin would mean a
 * fuzzy match per row on every render. Instead each scanned file also stores a
 * normalized artist+title key, computed with the same normalizer the Jellyfin
 * matcher uses, so any track row can look its badge up directly.
 *
 * Only the first credited artist is used: the taste DB stores "A, B" where the
 * file is often tagged "A" alone, and the leading credit is the part both
 * agree on.
 */
export function provenanceKey(artist: string | null | undefined, title: string | null | undefined): string {
  const lead = String(artist ?? '').split(/,| & | feat\.? | ft\.? /i)[0] ?? '';
  const a = normalizeMusicText(lead);
  const t = normalizeMusicText(title);
  return a && t ? `${a}|${t}` : '';
}

/**
 * Lookup key for a whole release.
 *
 * The same record is named two different ways in this system: Lidarr's folders
 * are "Seasons in the Abyss (1990) [Album]" while the tags inside say
 * "Seasons in the Abyss". Everything from the first bracket on is dropped so
 * both land on one key.
 */
export function albumMatchKey(artist: string | null | undefined, album: string | null | undefined): string {
  const bare = String(album ?? '').replace(/\s*[([].*$/, '').trim();
  return provenanceKey(artist, bare);
}

export const LIB_ALBUM_PREFIX = 'libalbum-';
export const LIB_TRACK_PREFIX = 'libtrack-';

/**
 * Stable ids for music the taste DB has never heard of.
 *
 * The library is fed by five pipelines and Spotify knows about maybe half of
 * it, so binding navigation to Spotify ids left most of the collection with
 * no album page at all. These ids are derived from what the library itself
 * knows, so every album is reachable regardless of who supplied it.
 *
 * Both are restricted to the characters the client router accepts
 * ([A-Za-z0-9-]), because an id that cannot appear in a URL is not an id.
 */

/** The album folder a file sits in, as a library-relative path. */
export function albumFolderOf(filePath: string): string {
  const normalized = String(filePath ?? '').replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return cut > 0 ? normalized.slice(0, cut) : normalized;
}

/**
 * Identity is the FOLDER, not the artist and title.
 *
 * Grouping on the tagged artist tore releases in half: an album whose tracks
 * carry different feature credits ("Serj Tankian" on one track, "Serj Tankian
 * feat. Bic Runga" on the next) became two albums out of one record. The
 * folder is what the release physically is, and it is also what the cover art
 * and the download pipelines already agree on.
 *
 * Hashed because a path contains characters a URL route cannot, and because
 * two different artists can own identically named folders.
 */
export function libAlbumId(filePath: string | null | undefined): string {
  return libAlbumIdForFolder(albumFolderOf(String(filePath ?? '')));
}

/**
 * The same id from the folder itself, for callers that already have the
 * directory rather than a file inside it. Latest is one: an album row names a
 * directory, but a single names the audio file, and passing a directory to
 * libAlbumId would silently take its parent — every album in an artist's
 * folder collapsing onto one id.
 */
export function libAlbumIdForFolder(folder: string | null | undefined): string {
  const clean = String(folder ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!clean) return '';
  return LIB_ALBUM_PREFIX + createHash('sha1').update(clean).digest('hex').slice(0, 16);
}

/**
 * Hashed rather than slugged: a path is the only thing guaranteed unique per
 * file, and two tracks in one album can share a title (a reprise, or the same
 * song on two discs). A slug would collide; a digest cannot.
 */
export function libTrackId(filePath: string): string {
  return LIB_TRACK_PREFIX + createHash('sha1').update(String(filePath)).digest('hex').slice(0, 16);
}

export interface ProvenanceRow {
  path: string;
  artist: string;
  title: string;
  album: string | null;
  source: Source;
  detail: string | null;       // indexer, release group, or discogs release id
  codec: string | null;
  bitrate: number | null;
  sample_rate: number | null;
  bit_depth: number | null;
  size_bytes: number | null;
  mtime: number | null;
  scanned_at: string;
  duration_ms: number | null;
  track_number: number | null;
  disc_number: number | null;
  folder: string | null;
  album_id: string | null;
  track_id: string | null;
}

export interface Badge {
  tier: QualityTier;
  quality: string;
  source: Source;
  detail: string | null;
}

export function badgeOf(row: ProvenanceRow): Badge {
  const info: AudioInfo = {
    codec: row.codec,
    bitrate: row.bitrate,
    sampleRate: row.sample_rate,
    bitDepth: row.bit_depth,
  };
  const tier = qualityTier(info);
  return { tier, quality: qualityLabel(tier, info), source: row.source, detail: row.detail };
}

/** Better of two badges, so an album with one stray MP3 still shows honestly. */
function betterBadge(a: ProvenanceRow, b: ProvenanceRow): ProvenanceRow {
  const rank = (row: ProvenanceRow) => QUALITY_TIERS.indexOf(badgeOf(row).tier);
  return rank(b) > rank(a) ? b : a;
}

export interface ScanInput {
  path: string;
  artist?: string | null;
  title?: string | null;
  album?: string | null;
  source?: string | null;
  detail?: string | null;
  codec?: string | null;
  bitrate?: number | null;
  sample_rate?: number | null;
  bit_depth?: number | null;
  size_bytes?: number | null;
  mtime?: number | null;
  duration_ms?: number | null;
  track_number?: number | null;
  disc_number?: number | null;
}

export class ProvenanceStore {
  private db: DatabaseSync | null = null;
  private readonly dbFile: string;
  private readonly now: () => number;
  private cache: { at: number; map: Map<string, Badge> } | null = null;
  private albumCache: { at: number; map: Map<string, Badge> } | null = null;

  constructor(dbFile?: string, now: () => number = Date.now) {
    this.dbFile = dbFile ?? PROVENANCE_FILE;
    this.now = now;
  }

  private handle(): DatabaseSync {
    if (!this.db) {
      mkdirSync(path.dirname(this.dbFile), { recursive: true });
      this.db = new DatabaseSync(this.dbFile);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS track_provenance (
          path TEXT PRIMARY KEY,
          match_key TEXT NOT NULL,
          artist TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          album TEXT,
          source TEXT NOT NULL DEFAULT 'unknown',
          detail TEXT,
          codec TEXT,
          bitrate INTEGER,
          sample_rate INTEGER,
          bit_depth INTEGER,
          size_bytes INTEGER,
          mtime INTEGER,
          scanned_at TEXT NOT NULL,
          duration_ms INTEGER,
          track_number INTEGER,
          disc_number INTEGER,
          folder TEXT,
          album_id TEXT,
          track_id TEXT
        );
        CREATE INDEX IF NOT EXISTS provenance_key ON track_provenance(match_key);
        CREATE INDEX IF NOT EXISTS provenance_source ON track_provenance(source);
        CREATE INDEX IF NOT EXISTS provenance_album ON track_provenance(artist, album);
      `);
      // Additive migration: deployed databases predate the album-page columns
      // and must gain them in place rather than being rebuilt.
      const columns = new Set((this.db.prepare('PRAGMA table_info(track_provenance)')
        .all() as { name: string }[]).map((column) => column.name));
      for (const [name, type] of [
        ['duration_ms', 'INTEGER'], ['track_number', 'INTEGER'], ['disc_number', 'INTEGER'],
        ['folder', 'TEXT'], ['album_id', 'TEXT'], ['track_id', 'TEXT'],
      ]) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE track_provenance ADD COLUMN ${name} ${type}`);
      }
      // Indexes on the migrated columns go up only AFTER the ALTERs. Putting
      // them in the CREATE TABLE batch above breaks every existing database:
      // the index references a column the old table has not grown yet, the
      // whole exec throws, and the migration that would have added it never
      // runs. Deployed with that mistake once; it took the API down with
      // "no such column: folder".
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS provenance_folder ON track_provenance(folder);
        CREATE INDEX IF NOT EXISTS provenance_album_id ON track_provenance(album_id);
        CREATE INDEX IF NOT EXISTS provenance_track_id ON track_provenance(track_id);
      `);
      // Backfill the derived ids for rows written before they existed, so an
      // upgrade does not need a full rescan to make album pages work.
      const stale = this.db.prepare('SELECT path FROM track_provenance WHERE album_id IS NULL').all() as { path: string }[];
      if (stale.length) {
        const fill = this.db.prepare('UPDATE track_provenance SET folder = ?, album_id = ?, track_id = ? WHERE path = ?');
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const row of stale) {
            fill.run(albumFolderOf(row.path), libAlbumId(row.path), libTrackId(row.path), row.path);
          }
          this.db.exec('COMMIT');
        } catch {
          this.db.exec('ROLLBACK');
        }
      }
    }
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.cache = null;
    this.albumCache = null;
  }

  /**
   * Record a batch of scanned files. Idempotent per path, so the scanner can
   * re-send anything it is unsure about without duplicating rows.
   */
  upsert(rows: ScanInput[]): number {
    const db = this.handle();
    const at = new Date(this.now()).toISOString();
    const stmt = db.prepare(`
      INSERT INTO track_provenance
        (path, match_key, artist, title, album, source, detail,
         codec, bitrate, sample_rate, bit_depth, size_bytes, mtime, scanned_at,
         duration_ms, track_number, disc_number, folder, album_id, track_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        match_key = excluded.match_key, artist = excluded.artist, title = excluded.title,
        album = excluded.album, source = excluded.source, detail = excluded.detail,
        codec = excluded.codec, bitrate = excluded.bitrate,
        sample_rate = excluded.sample_rate, bit_depth = excluded.bit_depth,
        size_bytes = excluded.size_bytes, mtime = excluded.mtime,
        scanned_at = excluded.scanned_at, duration_ms = excluded.duration_ms,
        track_number = excluded.track_number, disc_number = excluded.disc_number,
        folder = excluded.folder, album_id = excluded.album_id, track_id = excluded.track_id
    `);
    let written = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const file = String(row.path ?? '').trim();
        if (!file) continue;
        const artist = String(row.artist ?? '');
        const title = String(row.title ?? '');
        stmt.run(
          file,
          provenanceKey(artist, title),
          artist,
          title,
          row.album ?? null,
          isSource(row.source) ? row.source : 'unknown',
          row.detail ?? null,
          row.codec ?? null,
          row.bitrate == null ? null : Math.round(Number(row.bitrate)),
          row.sample_rate == null ? null : Math.round(Number(row.sample_rate)),
          row.bit_depth == null ? null : Math.round(Number(row.bit_depth)),
          row.size_bytes == null ? null : Math.round(Number(row.size_bytes)),
          row.mtime == null ? null : Math.round(Number(row.mtime)),
          at,
          row.duration_ms == null ? null : Math.round(Number(row.duration_ms)),
          row.track_number == null ? null : Math.round(Number(row.track_number)),
          row.disc_number == null ? null : Math.round(Number(row.disc_number)),
          albumFolderOf(file),
          libAlbumId(file),
          libTrackId(file),
        );
        written += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.cache = null;
    this.albumCache = null;
    return written;
  }

  /** Drop rows the scanner no longer sees, so deletions do not linger. */
  prune(keepPaths: string[]): number {
    const db = this.handle();
    const keep = new Set(keepPaths);
    const existing = (db.prepare('SELECT path FROM track_provenance').all() as { path: string }[])
      .map((row) => row.path);
    const gone = existing.filter((file) => !keep.has(file));
    if (!gone.length) return 0;
    const stmt = db.prepare('DELETE FROM track_provenance WHERE path = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const file of gone) stmt.run(file);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.cache = null;
    this.albumCache = null;
    return gone.length;
  }

  row(file: string): ProvenanceRow | null {
    const found = this.handle()
      .prepare('SELECT * FROM track_provenance WHERE path = ?')
      .get(file);
    return (found as ProvenanceRow | undefined) ?? null;
  }

  /**
   * artist+title -> badge, for decorating track lists. Cached briefly because
   * every list endpoint wants it and the scan only changes hourly.
   */
  badges(ttlMs = 60_000): Map<string, Badge> {
    if (this.cache && this.now() - this.cache.at < ttlMs) return this.cache.map;
    const map = new Map<string, Badge>();
    const best = new Map<string, ProvenanceRow>();
    for (const row of this.handle()
      .prepare("SELECT * FROM track_provenance WHERE match_key <> ''")
      .all() as ProvenanceRow[]) {
      const seen = best.get(row.match_key);
      best.set(row.match_key, seen ? betterBadge(seen, row) : row);
    }
    for (const [key, row] of best) map.set(key, badgeOf(row));
    this.cache = { at: this.now(), map };
    return map;
  }

  /** Counts per source and per tier, for the Overview page. */
  summary(): { sources: Record<string, number>; tiers: Record<string, number>; total: number; scannedAt: string | null } {
    const db = this.handle();
    const sources: Record<string, number> = {};
    for (const row of db.prepare(
      'SELECT source, COUNT(*) n FROM track_provenance GROUP BY source',
    ).all() as { source: string; n: number }[]) {
      sources[row.source] = Number(row.n);
    }
    const tiers: Record<string, number> = {};
    for (const row of db.prepare('SELECT * FROM track_provenance').all() as ProvenanceRow[]) {
      const tier = badgeOf(row).tier;
      tiers[tier] = (tiers[tier] ?? 0) + 1;
    }
    const total = Object.values(sources).reduce((sum, n) => sum + n, 0);
    const latest = db.prepare('SELECT MAX(scanned_at) at FROM track_provenance').get() as { at: string | null };
    return { sources, tiers, total, scannedAt: latest?.at ?? null };
  }

  /**
   * artist+album -> badge, for the Albums grid and Latest downloads.
   *
   * The tier shown is the *modal* one across the album's files, not the best
   * and not the worst: one bonus track in a different format should not
   * relabel a whole record in either direction. Source is picked the same way.
   */
  albumBadges(ttlMs = 60_000): Map<string, Badge> {
    if (this.albumCache && this.now() - this.albumCache.at < ttlMs) return this.albumCache.map;
    const groups = new Map<string, { tiers: Map<QualityTier, number>; sources: Map<Source, number>; sample: ProvenanceRow }>();
    for (const row of this.handle()
      .prepare("SELECT * FROM track_provenance WHERE album IS NOT NULL AND album <> ''")
      .all() as ProvenanceRow[]) {
      const key = albumMatchKey(row.artist, row.album);
      if (!key) continue;
      let group = groups.get(key);
      if (!group) {
        group = { tiers: new Map(), sources: new Map(), sample: row };
        groups.set(key, group);
      }
      const tier = badgeOf(row).tier;
      group.tiers.set(tier, (group.tiers.get(tier) ?? 0) + 1);
      group.sources.set(row.source, (group.sources.get(row.source) ?? 0) + 1);
    }
    const top = <T,>(counts: Map<T, number>): T => [...counts.entries()]
      .sort((a, b) => b[1] - a[1])[0][0];
    const map = new Map<string, Badge>();
    for (const [key, group] of groups) {
      const tier = top(group.tiers);
      map.set(key, {
        tier,
        quality: qualityLabel(tier, {
          codec: group.sample.codec,
          bitrate: group.sample.bitrate,
          sampleRate: group.sample.sample_rate,
          bitDepth: group.sample.bit_depth,
        }),
        source: top(group.sources),
        detail: group.sample.detail,
      });
    }
    this.albumCache = { at: this.now(), map };
    return map;
  }

  /**
   * Distinct (artist, album) pairs on disk. The CD shelf uses this to decide
   * whether a disc has already been ripped, which is a question about files
   * rather than about anything Spotify knows.
   */
  rowsForAlbums(): { artist: string; album: string | null }[] {
    return this.handle().prepare(
      "SELECT artist, album FROM track_provenance WHERE album IS NOT NULL AND album <> '' GROUP BY artist, album",
    ).all() as { artist: string; album: string | null }[];
  }

  /**
   * Every album the library physically holds, newest first.
   *
   * This is the catalogue the UI navigates: it owes nothing to Spotify, so an
   * album that arrived by usenet, torrent, Soulseek, YouTube or a CD rip is
   * as reachable as one Spotify happens to know.
   */
  albums(): { id: string; name: string; artists: string; total_tracks: number; added_at: string; source: Source; rel: string }[] {
    const folders = new Map<string, ProvenanceRow[]>();
    // One pass, grouped on the stored folder. Only the columns the listing
    // needs, so a thousand albums do not drag every column of 9,000 rows.
    for (const row of this.handle().prepare(
      'SELECT path, folder, album, artist, source, mtime FROM track_provenance WHERE folder IS NOT NULL',
    ).all() as ProvenanceRow[]) {
      const folder = row.folder!;
      (folders.get(folder) ?? folders.set(folder, []).get(folder)!).push(row);
    }
    // Undefined for an empty list rather than throwing: a folder of untagged
    // files has no album name and no artist, and it still deserves a page.
    const modal = <T,>(values: T[]): T | undefined => {
      const counts = new Map<T, number>();
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    return [...folders.entries()].map(([folder, rows]) => {
      const name = modal(rows.map((row) => row.album).filter(Boolean) as string[])
        // A folder of loose singles has no album tag; its own name is the
        // best label available.
        ?? folder.slice(folder.lastIndexOf('/') + 1);
      return {
        id: libAlbumId(rows[0].path),
        name: String(name),
        // Album artist, not track artist: the credit shared by most tracks,
        // so a featured guest on two songs does not rename the record.
        artists: modal(rows.map((row) => row.artist).filter(Boolean)) ?? '',
        total_tracks: rows.length,
        added_at: new Date(Math.max(...rows.map((row) => Number(row.mtime ?? 0))) * 1000).toISOString(),
        source: modal(rows.map((row) => row.source)) ?? 'unknown',
        rel: rows[0].path,
      };
    }).sort((a, b) => b.added_at.localeCompare(a.added_at));
  }

  /** The tracks of one library album, in disc/track order. */
  albumTracks(id: string): ProvenanceRow[] {
    return (this.handle().prepare(
      'SELECT * FROM track_provenance WHERE album_id = ?',
    ).all(id) as ProvenanceRow[])
      .sort((a, b) => (a.disc_number ?? 1) - (b.disc_number ?? 1)
        || (a.track_number ?? 0) - (b.track_number ?? 0)
        || a.path.localeCompare(b.path));
  }

  /** One scanned file by its derived id, for playback. */
  trackById(id: string): ProvenanceRow | null {
    if (!id.startsWith(LIB_TRACK_PREFIX)) return null;
    return (this.handle().prepare(
      'SELECT * FROM track_provenance WHERE track_id = ?',
    ).get(id) as ProvenanceRow | undefined) ?? null;
  }

  /**
   * Any scanned file matching an artist+title, best copy first.
   *
   * Radio resolves what it can through MusicBrainz ids, but the singles the
   * app pulled from YouTube were never in Lidarr and so have no recording id
   * at all. Name matching is the only handle on those, and `match_key` is
   * already indexed for exactly this shape of question.
   */
  byMatchKey(key: string): ProvenanceRow | null {
    return (this.handle().prepare(`
      SELECT * FROM track_provenance WHERE match_key = ?
      ORDER BY size_bytes DESC LIMIT 1
    `).get(key) as ProvenanceRow | undefined) ?? null;
  }

  /** Paths already scanned, with mtime+size, so the scanner can skip them. */
  fingerprints(): Map<string, string> {
    return new Map((this.handle()
      .prepare('SELECT path, mtime, size_bytes FROM track_provenance')
      .all() as { path: string; mtime: number | null; size_bytes: number | null }[])
      .map((row) => [row.path, `${row.mtime ?? 0}:${row.size_bytes ?? 0}`]));
  }
}
