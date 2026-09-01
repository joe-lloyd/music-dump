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
}

export class ProvenanceStore {
  private db: DatabaseSync | null = null;
  private readonly dbFile: string;
  private readonly now: () => number;
  private cache: { at: number; map: Map<string, Badge> } | null = null;

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
          scanned_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS provenance_key ON track_provenance(match_key);
        CREATE INDEX IF NOT EXISTS provenance_source ON track_provenance(source);
      `);
    }
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.cache = null;
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
         codec, bitrate, sample_rate, bit_depth, size_bytes, mtime, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        match_key = excluded.match_key, artist = excluded.artist, title = excluded.title,
        album = excluded.album, source = excluded.source, detail = excluded.detail,
        codec = excluded.codec, bitrate = excluded.bitrate,
        sample_rate = excluded.sample_rate, bit_depth = excluded.bit_depth,
        size_bytes = excluded.size_bytes, mtime = excluded.mtime,
        scanned_at = excluded.scanned_at
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
        );
        written += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.cache = null;
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
   * Distinct (artist, album) pairs on disk. The CD shelf uses this to decide
   * whether a disc has already been ripped, which is a question about files
   * rather than about anything Spotify knows.
   */
  rowsForAlbums(): { artist: string; album: string | null }[] {
    return this.handle().prepare(
      "SELECT artist, album FROM track_provenance WHERE album IS NOT NULL AND album <> '' GROUP BY artist, album",
    ).all() as { artist: string; album: string | null }[];
  }

  /** Paths already scanned, with mtime+size, so the scanner can skip them. */
  fingerprints(): Map<string, string> {
    return new Map((this.handle()
      .prepare('SELECT path, mtime, size_bytes FROM track_provenance')
      .all() as { path: string; mtime: number | null; size_bytes: number | null }[])
      .map((row) => [row.path, `${row.mtime ?? 0}:${row.size_bytes ?? 0}`]));
  }
}
