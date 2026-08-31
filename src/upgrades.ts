import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const UPGRADES_FILE = process.env.UPGRADES_DB
  ?? path.join(import.meta.dirname, '..', 'data', 'upgrades.db');

export type UpgradePhase = 'source' | 'upgrade';
export type SourceMode = 'single' | 'playlist' | 'chapters';
export type UpgradeStatus =
  | 'pending_source'
  | 'queued'
  | 'working'
  | 'retry_wait'
  | 'upgraded'
  | 'already_lossless'
  | 'exhausted'
  | 'cancelled';

export interface UpgradeJob {
  id: number;
  track_id: string | null;
  source_url: string | null;
  downloader: 'auto' | 'yt-dlp' | 'spotdl';
  source_mode: SourceMode;
  parent_id: number | null;
  track_number: number | null;
  batch_size: number | null;
  artist: string;
  title: string;
  album: string | null;
  duration_ms: number | null;
  current_path: string | null;
  current_codec: string | null;
  phase: UpgradePhase;
  status: UpgradeStatus;
  source_attempts: number;
  upgrade_attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  result_path: string | null;
  created_at: string;
  updated_at: string;
  claimed_by: string | null;
  claim_token: string | null;
  claim_expires_at: string | null;
}

export interface CreateUpgrade {
  trackId?: string | null;
  sourceUrl?: string | null;
  downloader?: 'auto' | 'yt-dlp' | 'spotdl';
  sourceMode?: SourceMode;
  parentId?: number | null;
  trackNumber?: number | null;
  artist: string;
  title: string;
  album?: string | null;
  durationMs?: number | null;
  currentPath?: string | null;
  currentCodec?: string | null;
  maxAttempts?: number;
}

export interface FinishUpgrade {
  id: number;
  claimToken: string;
  outcome: 'source_ready' | 'upgraded' | 'already_lossless' | 'failed' | 'parked';
  error?: string | null;
  candidate?: string | null;
  currentPath?: string | null;
  currentCodec?: string | null;
  resultPath?: string | null;
}

export interface BatchTrack {
  sourceUrl?: string | null;
  artist: string;
  title: string;
  album: string;
  durationMs: number;
  currentPath: string;
  currentCodec: string;
  trackNumber: number;
}

export interface FinishBatch {
  id: number;
  claimToken: string;
  resultPath: string;
  tracks: BatchTrack[];
}

const LOSSLESS = new Set(['flac', 'alac', 'ape', 'wavpack', 'wv']);
const TERMINAL = new Set<UpgradeStatus>(['upgraded', 'already_lossless', 'exhausted', 'cancelled']);
const SOURCE_MAX_ATTEMPTS = 3;

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function asJob(row: unknown): UpgradeJob {
  return row as UpgradeJob;
}

export function isLosslessCodec(codec: string | null | undefined): boolean {
  return LOSSLESS.has(String(codec ?? '').trim().toLowerCase());
}

export function validWorkerToken(configured: string, supplied: string): boolean {
  const expected = Buffer.from(configured);
  const actual = Buffer.from(supplied);
  return expected.length >= 16 && expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Durable queue shared by the UI and the eliot worker. It deliberately lives
 * outside spotify.db: the exporter owns that database, while this is mutable
 * application state with a different backup/retention lifecycle.
 */
// Lossy containers the intake can hand back; kept in step with the worker's
// INTAKE_CODECS. Lossless never appears here - that is what an upgrade produces.
export const INTAKE_CODECS = new Set(['mp3', 'opus', 'aac', 'vorbis']);

export interface LocalTrack {
  id: string;            // "localtrack-<queue id>"
  album_id: string;      // "localalbum-<slug>"
  name: string;
  album: string;
  artists: string;
  duration_ms: number | null;
  track_number: number | null;
  codec: string | null;
  standalone: boolean;
  path: string;          // worker-side path, e.g. /data/library/music/...
  added_at: string;
}

// Stable per (artist, album) so an album keeps one id across imports.
export function localAlbumId(artist: string, album: string): string {
  const slug = `${artist}-${album}`
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `localalbum-${slug}`;
}

export class UpgradeStore {
  readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    file = UPGRADES_FILE,
    now: () => number = Date.now,
    random: () => number = Math.random,
  ) {
    this.now = now;
    this.random = random;
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS upgrade_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT,
        source_url TEXT,
        downloader TEXT NOT NULL DEFAULT 'auto'
          CHECK (downloader IN ('auto', 'yt-dlp', 'spotdl')),
        source_mode TEXT NOT NULL DEFAULT 'single'
          CHECK (source_mode IN ('single', 'playlist', 'chapters')),
        parent_id INTEGER REFERENCES upgrade_queue(id),
        track_number INTEGER,
        batch_size INTEGER,
        artist TEXT NOT NULL,
        title TEXT NOT NULL,
        album TEXT,
        duration_ms INTEGER,
        current_path TEXT,
        current_codec TEXT,
        phase TEXT NOT NULL CHECK (phase IN ('source', 'upgrade')),
        status TEXT NOT NULL CHECK (status IN (
          'pending_source', 'queued', 'working', 'retry_wait',
          'upgraded', 'already_lossless', 'exhausted', 'cancelled'
        )),
        source_attempts INTEGER NOT NULL DEFAULT 0,
        upgrade_attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 6,
        next_attempt_at TEXT,
        last_error TEXT,
        result_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_by TEXT,
        claim_token TEXT,
        claim_expires_at TEXT
      );

      -- Artists that entered the library through an import. Lidarr's custom
      -- list only speaks MusicBrainz ids, so each name is resolved once and
      -- cached here; '' records a miss so it is not retried every poll.
      CREATE TABLE IF NOT EXISTS imported_artists (
        name TEXT PRIMARY KEY,
        mbid TEXT,
        checked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS upgrade_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id INTEGER NOT NULL REFERENCES upgrade_queue(id) ON DELETE CASCADE,
        phase TEXT NOT NULL CHECK (phase IN ('source', 'upgrade')),
        attempt_no INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT,
        error TEXT,
        candidate TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_upgrade_due
        ON upgrade_queue(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_upgrade_attempts_job
        ON upgrade_attempts(queue_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_upgrade_active_track
        ON upgrade_queue(track_id)
        WHERE track_id IS NOT NULL
          AND status NOT IN ('upgraded', 'already_lossless', 'exhausted', 'cancelled');
    `);

    // Existing deployments already have upgrade_queue. Keep migrations
    // additive so a web-container restart upgrades the durable queue in place.
    const columns = new Set((this.db.prepare('PRAGMA table_info(upgrade_queue)').all() as { name: string }[])
      .map((column) => column.name));
    if (!columns.has('source_mode')) {
      this.db.exec("ALTER TABLE upgrade_queue ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'single' CHECK (source_mode IN ('single', 'playlist', 'chapters'))");
    }
    if (!columns.has('parent_id')) {
      this.db.exec('ALTER TABLE upgrade_queue ADD COLUMN parent_id INTEGER REFERENCES upgrade_queue(id)');
    }
    if (!columns.has('track_number')) {
      this.db.exec('ALTER TABLE upgrade_queue ADD COLUMN track_number INTEGER');
    }
    if (!columns.has('batch_size')) {
      this.db.exec('ALTER TABLE upgrade_queue ADD COLUMN batch_size INTEGER');
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_upgrade_parent_track
        ON upgrade_queue(parent_id, track_number)
        WHERE parent_id IS NOT NULL;
    `);
  }

  close(): void {
    this.db.close();
  }

  create(input: CreateUpgrade): UpgradeJob {
    const artist = input.artist.trim();
    const title = input.title.trim();
    if (!artist || !title) throw new Error('artist and title are required');
    if (!input.sourceUrl && !input.currentPath) throw new Error('a source URL or existing local file is required');
    const sourceMode = input.sourceMode ?? 'single';
    if (!['single', 'playlist', 'chapters'].includes(sourceMode)) throw new Error('invalid source mode');
    const parentId = input.parentId == null ? null : Math.trunc(input.parentId);
    const trackNumber = input.trackNumber == null ? null : Math.trunc(input.trackNumber);
    if (parentId != null && parentId < 1) throw new Error('parentId must be positive');
    if (trackNumber != null && trackNumber < 1) throw new Error('trackNumber must be positive');

    const maxAttempts = Math.max(1, Math.min(20, Math.trunc(input.maxAttempts ?? 6)));
    const currentCodec = input.currentCodec?.trim().toLowerCase() || null;
    const alreadyLossless = Boolean(input.currentPath && isLosslessCodec(currentCodec));
    const hasLocal = Boolean(input.currentPath);
    const phase: UpgradePhase = hasLocal ? 'upgrade' : 'source';
    const status: UpgradeStatus = alreadyLossless ? 'already_lossless' : hasLocal ? 'queued' : 'pending_source';
    const at = nowIso(this.now);

    try {
      const result = this.db.prepare(`
        INSERT INTO upgrade_queue (
          track_id, source_url, downloader, source_mode, parent_id, track_number,
          artist, title, album, duration_ms,
          current_path, current_codec, phase, status, max_attempts,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.trackId?.trim() || null,
        input.sourceUrl?.trim() || null,
        input.downloader ?? 'auto',
        sourceMode,
        parentId,
        trackNumber,
        artist,
        title,
        input.album?.trim() || null,
        input.durationMs == null ? null : Math.max(0, Math.trunc(input.durationMs)),
        input.currentPath?.trim() || null,
        currentCodec,
        phase,
        status,
        maxAttempts,
        alreadyLossless ? null : at,
        at,
        at,
      );
      return this.get(Number(result.lastInsertRowid))!;
    } catch (err) {
      if (/UNIQUE constraint failed: upgrade_queue\.track_id/i.test((err as Error).message)) {
        throw new Error('this track is already in the active upgrade queue');
      }
      if (/UNIQUE constraint failed: upgrade_queue\.parent_id, upgrade_queue\.track_number/i.test((err as Error).message)) {
        throw new Error('this batch track is already in the upgrade queue');
      }
      throw err;
    }
  }

  // Every row that installed a file is part of the local library, whatever
  // became of its lossless upgrade afterwards. A cancelled or exhausted
  // upgrade still leaves a perfectly good MP3 on disk, so membership keys
  // off current_path, never off status.
  localTracks(): LocalTrack[] {
    return this.db.prepare(`
      SELECT id, artist, title, album, duration_ms, track_number, current_path, current_codec,
             created_at, parent_id, source_mode
      FROM upgrade_queue
      WHERE current_path IS NOT NULL AND current_path <> ''
      ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, track_number, id
    `).all().map((row) => {
      const r = row as Record<string, unknown>;
      const artist = String(r.artist ?? '');
      const album = String(r.album ?? '') || String(r.title ?? '');
      return {
        id: `localtrack-${r.id}`,
        album_id: localAlbumId(artist, album),
        name: String(r.title ?? ''),
        album,
        artists: artist,
        duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
        track_number: r.track_number == null ? null : Number(r.track_number),
        codec: (r.current_codec as string) ?? null,
        // A one-off download rather than a track of an imported album.
        standalone: r.parent_id == null && r.source_mode === 'single',
        path: String(r.current_path ?? ''),
        added_at: String(r.created_at ?? ''),
      };
    });
  }

  // Distinct artists whose music actually landed on disk.
  importedArtists(): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT artist FROM upgrade_queue
      WHERE current_path IS NOT NULL AND current_path <> '' AND TRIM(artist) <> ''
    `).all() as { artist: string }[]).map((row) => row.artist);
  }

  // name -> mbid for imported artists resolved so far ('' means no match).
  importedArtistMbids(): Map<string, string> {
    return new Map((this.db.prepare(
      'SELECT name, mbid FROM imported_artists WHERE mbid IS NOT NULL',
    ).all() as { name: string; mbid: string }[]).map((row) => [row.name, row.mbid]));
  }

  rememberArtistMbid(name: string, mbid: string | null): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO imported_artists (name, mbid, checked_at) VALUES (?, ?, ?)',
    ).run(name, mbid ?? '', nowIso(this.now));
  }

  // Never looked up, or a miss older than the retry window.
  unresolvedImportedArtists(retryDays = 30): string[] {
    const known = new Map((this.db.prepare(
      'SELECT name, mbid, checked_at FROM imported_artists',
    ).all() as { name: string; mbid: string; checked_at: string }[]).map((r) => [r.name, r]));
    const stale = Date.now() - retryDays * 86_400_000;
    return this.importedArtists().filter((name) => {
      const row = known.get(name);
      if (!row) return true;
      if (row.mbid) return false;
      return new Date(row.checked_at || 0).getTime() <= stale;
    });
  }

  get(id: number): UpgradeJob | null {
    const row = this.db.prepare('SELECT * FROM upgrade_queue WHERE id = ?').get(id);
    return row ? asJob(row) : null;
  }

  list(limit = 250): { jobs: UpgradeJob[]; counts: Record<string, number> } {
    const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const jobs = this.db.prepare(`
      SELECT * FROM upgrade_queue
      ORDER BY CASE WHEN status IN ('working', 'queued', 'pending_source', 'retry_wait') THEN 0 ELSE 1 END,
               updated_at DESC, id DESC
      LIMIT ?
    `).all(safeLimit).map(asJob);
    const counts = Object.fromEntries((this.db.prepare(
      'SELECT status, COUNT(*) AS n FROM upgrade_queue GROUP BY status',
    ).all() as { status: string; n: number }[]).map((row) => [row.status, row.n]));
    return { jobs, counts };
  }

  private expireLeases(at: string): void {
    const expired = this.db.prepare(`
      SELECT id, phase, source_attempts, upgrade_attempts, max_attempts
      FROM upgrade_queue
      WHERE status = 'working' AND claim_expires_at <= ?
    `).all(at) as Pick<UpgradeJob, 'id' | 'phase' | 'source_attempts' | 'upgrade_attempts' | 'max_attempts'>[];

    for (const job of expired) {
      const attempts = job.phase === 'source' ? job.source_attempts : job.upgrade_attempts;
      const cap = job.phase === 'source' ? SOURCE_MAX_ATTEMPTS : job.max_attempts;
      const exhausted = attempts >= cap;
      this.db.prepare(`
        UPDATE upgrade_queue
        SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?,
            claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL
        WHERE id = ?
      `).run(exhausted ? 'exhausted' : 'retry_wait', exhausted ? null : at, 'worker lease expired', at, job.id);
      this.db.prepare(`
        UPDATE upgrade_attempts
        SET finished_at = ?, outcome = 'failed', error = 'worker lease expired'
        WHERE id = (SELECT id FROM upgrade_attempts WHERE queue_id = ? AND finished_at IS NULL ORDER BY id DESC LIMIT 1)
      `).run(at, job.id);
    }
  }

  claim(workerId: string, leaseSeconds = 7_200): (UpgradeJob & { attemptedCandidates: string[] }) | null {
    const worker = workerId.trim().slice(0, 120);
    if (!worker) throw new Error('workerId is required');
    const at = nowIso(this.now);
    const expires = new Date(this.now() + Math.max(300, leaseSeconds) * 1000).toISOString();
    const token = randomBytes(24).toString('hex');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.expireLeases(at);
      // Fresh intake is FIFO. Retry-wait rows deliberately use random() so a
      // permanently awkward title cannot monopolize every scheduled sweep.
      const row = this.db.prepare(`
        SELECT * FROM upgrade_queue
        WHERE status IN ('pending_source', 'queued', 'retry_wait')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY
          CASE status WHEN 'pending_source' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
          CASE WHEN status = 'retry_wait' THEN random() ELSE id END
        LIMIT 1
      `).get(at);
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      const job = asJob(row);
      const attemptNo = job.phase === 'source' ? job.source_attempts + 1 : job.upgrade_attempts + 1;
      const counter = job.phase === 'source' ? 'source_attempts' : 'upgrade_attempts';
      this.db.prepare(`
        UPDATE upgrade_queue
        SET status = 'working', ${counter} = ${counter} + 1,
            claimed_by = ?, claim_token = ?, claim_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(worker, token, expires, at, job.id);
      this.db.prepare(`
        INSERT INTO upgrade_attempts (queue_id, phase, attempt_no, started_at)
        VALUES (?, ?, ?, ?)
      `).run(job.id, job.phase, attemptNo, at);
      this.db.exec('COMMIT');

      const claimed = this.get(job.id)!;
      const attemptedCandidates = (this.db.prepare(`
        SELECT candidate FROM upgrade_attempts
        WHERE queue_id = ? AND phase = 'upgrade' AND candidate IS NOT NULL
        ORDER BY id
      `).all(job.id) as { candidate: string }[]).map((item) => item.candidate);
      return { ...claimed, attemptedCandidates };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  finish(input: FinishUpgrade): UpgradeJob {
    const at = nowIso(this.now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.get(input.id);
      if (!job || job.status !== 'working' || !job.claim_token || job.claim_token !== input.claimToken) {
        throw new Error('job is not owned by this worker lease');
      }

      let status: UpgradeStatus;
      let refundAttempt = false;
      let phase = job.phase;
      let nextAttempt: string | null = null;
      let error = input.error?.trim().slice(0, 2_000) || null;

      if (input.outcome === 'source_ready') {
        if (!input.currentPath) throw new Error('source_ready requires currentPath');
        status = isLosslessCodec(input.currentCodec) ? 'already_lossless' : 'queued';
        phase = 'upgrade';
        nextAttempt = status === 'queued' ? at : null;
        error = null;
      } else if (input.outcome === 'upgraded') {
        if (!input.resultPath) throw new Error('upgraded requires resultPath');
        status = 'upgraded';
        error = null;
      } else if (input.outcome === 'already_lossless') {
        status = 'already_lossless';
        error = null;
      } else if (input.outcome === 'parked') {
        // The worker declined the job by policy (e.g. Soulseek disabled).
        // The counter is incremented at CLAIM time, so refund it here -
        // otherwise merely being offered to a worker that declines silently
        // eats the retry budget, and six sweeps would exhaust a job that was
        // never actually tried.
        status = 'cancelled';
        refundAttempt = true;
      } else {
        if (!error) error = 'worker reported an unspecified failure';
        const attempts = job.phase === 'source' ? job.source_attempts : job.upgrade_attempts;
        const cap = job.phase === 'source' ? SOURCE_MAX_ATTEMPTS : job.max_attempts;
        status = attempts >= cap ? 'exhausted' : 'retry_wait';
        if (status === 'retry_wait') {
          // Six hours, then exponential backoff capped at seven days, with
          // +/-25% jitter so failed searches do not synchronize.
          const baseSeconds = Math.min(7 * 86_400, 6 * 3_600 * (2 ** Math.max(0, attempts - 1)));
          const jittered = Math.round(baseSeconds * (0.75 + this.random() * 0.5));
          nextAttempt = new Date(this.now() + jittered * 1000).toISOString();
        }
      }

      this.db.prepare(`
        UPDATE upgrade_queue
        SET phase = ?, status = ?, next_attempt_at = ?, last_error = ?,
            current_path = COALESCE(?, current_path),
            current_codec = COALESCE(?, current_codec),
            result_path = COALESCE(?, result_path), updated_at = ?,
            claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL
        WHERE id = ?
      `).run(
        phase,
        status,
        nextAttempt,
        error,
        input.currentPath?.trim() || null,
        input.currentCodec?.trim().toLowerCase() || null,
        input.resultPath?.trim() || null,
        at,
        job.id,
      );
      if (refundAttempt) {
        const counter = job.phase === 'source' ? 'source_attempts' : 'upgrade_attempts';
        this.db.prepare(
          `UPDATE upgrade_queue SET ${counter} = MAX(0, ${counter} - 1) WHERE id = ?`,
        ).run(job.id);
      }
      this.db.prepare(`
        UPDATE upgrade_attempts
        SET finished_at = ?, outcome = ?, error = ?, candidate = ?
        WHERE id = (SELECT id FROM upgrade_attempts WHERE queue_id = ? AND finished_at IS NULL ORDER BY id DESC LIMIT 1)
      `).run(at, input.outcome, error, input.candidate?.trim() || null, job.id);
      this.db.exec('COMMIT');
      return this.get(job.id)!;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  finishBatch(input: FinishBatch): { job: UpgradeJob; children: UpgradeJob[] } {
    if (!Array.isArray(input.tracks) || input.tracks.length < 2 || input.tracks.length > 500) {
      throw new Error('a batch must contain between 2 and 500 tracks');
    }
    const resultPath = input.resultPath.trim();
    if (!resultPath) throw new Error('batch completion requires resultPath');
    const numbers = input.tracks.map((track) => Math.trunc(track.trackNumber));
    if (numbers.some((number) => !Number.isInteger(number) || number < 1)
        || new Set(numbers).size !== numbers.length) {
      throw new Error('batch track numbers must be unique positive integers');
    }
    if (input.tracks.some((track) => !track.artist.trim() || !track.title.trim() || !track.album.trim())) {
      throw new Error('every batch track requires artist, title, and album');
    }
    if (input.tracks.some((track) => !Number.isFinite(track.durationMs) || track.durationMs <= 0)) {
      throw new Error('every batch track requires a positive duration');
    }
    // Intake keeps the source codec rather than re-encoding to MP3, so accept
    // any lossy container the worker can produce. Lossless is rejected here
    // because a batch track is by definition still awaiting its upgrade.
    if (input.tracks.some((track) => !track.currentPath.trim() || !INTAKE_CODECS.has(track.currentCodec.trim().toLowerCase()))) {
      throw new Error(`every batch track must reference an imported file (${[...INTAKE_CODECS].sort().join(', ')})`);
    }

    const at = nowIso(this.now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const parent = this.get(input.id);
      if (!parent || parent.status !== 'working' || !parent.claim_token || parent.claim_token !== input.claimToken) {
        throw new Error('job is not owned by this worker lease');
      }
      if (parent.phase !== 'source' || parent.source_mode === 'single') {
        throw new Error('only a playlist or chapter source can complete as a batch');
      }

      const children = input.tracks.map((track) => this.create({
        sourceUrl: track.sourceUrl ?? parent.source_url,
        downloader: 'yt-dlp',
        sourceMode: 'single',
        parentId: parent.id,
        trackNumber: track.trackNumber,
        artist: track.artist,
        title: track.title,
        album: track.album,
        durationMs: track.durationMs,
        currentPath: track.currentPath,
        currentCodec: track.currentCodec,
        maxAttempts: parent.max_attempts,
      }));

      this.db.prepare(`
        UPDATE upgrade_queue
        SET status = 'upgraded', next_attempt_at = NULL, last_error = NULL,
            result_path = ?, batch_size = ?, updated_at = ?,
            claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL
        WHERE id = ?
      `).run(resultPath, children.length, at, parent.id);
      this.db.prepare(`
        UPDATE upgrade_attempts
        SET finished_at = ?, outcome = 'batch_ready', error = NULL
        WHERE id = (SELECT id FROM upgrade_attempts WHERE queue_id = ? AND finished_at IS NULL ORDER BY id DESC LIMIT 1)
      `).run(at, parent.id);
      this.db.exec('COMMIT');
      return { job: this.get(parent.id)!, children };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  retry(id: number): UpgradeJob {
    const job = this.get(id);
    if (!job) throw new Error('upgrade job not found');
    if (job.status === 'working') throw new Error('an active worker owns this job');
    // 'cancelled' IS retryable: that is what parking means. A job the worker
    // declined by policy (Soulseek disabled) or that you cancelled by hand
    // must be resumable, otherwise cancelling is silently destructive and the
    // Retry button on those rows can never work.
    if (job.status === 'upgraded' || job.status === 'already_lossless') {
      throw new Error(`cannot retry a ${job.status} job`);
    }
    const at = nowIso(this.now);
    const phase = job.current_path ? 'upgrade' : 'source';
    const maxAttempts = phase === 'upgrade' ? Math.max(job.max_attempts, job.upgrade_attempts + 1) : job.max_attempts;
    this.db.prepare(`
      UPDATE upgrade_queue SET phase = ?, status = ?, max_attempts = ?,
        source_attempts = CASE WHEN ? = 'source' THEN 0 ELSE source_attempts END,
        next_attempt_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(phase, phase === 'source' ? 'pending_source' : 'queued', maxAttempts, phase, at, at, id);
    return this.get(id)!;
  }

  // Forget an import entirely: the queue row and, for a batch parent, every
  // track it generated. Returns the installed paths so the caller can clean
  // the files up - this store never touches the filesystem itself.
  remove(id: number): { removed: number; paths: string[] } {
    const job = this.get(id);
    if (!job) throw new Error('upgrade job not found');
    const family = [job, ...(this.db.prepare(
      'SELECT * FROM upgrade_queue WHERE parent_id = ?',
    ).all(id) as Record<string, unknown>[]).map(asJob)];
    if (family.some((row) => row.status === 'working')) {
      throw new Error('an active worker owns this job');
    }
    const paths = family.map((row) => row.current_path).filter((value): value is string => Boolean(value));
    const remove = this.db.prepare('DELETE FROM upgrade_queue WHERE id = ? OR parent_id = ?');
    const run = this.db.prepare('BEGIN');
    run.run();
    try {
      remove.run(id, id);
      this.db.prepare('COMMIT').run();
    } catch (err) {
      this.db.prepare('ROLLBACK').run();
      throw err;
    }
    return { removed: family.length, paths };
  }

  cancel(id: number): UpgradeJob {
    const job = this.get(id);
    if (!job) throw new Error('upgrade job not found');
    if (TERMINAL.has(job.status)) return job;
    if (job.status === 'working') throw new Error('an active worker owns this job');
    const at = nowIso(this.now);
    this.db.prepare(`
      UPDATE upgrade_queue SET status = 'cancelled', next_attempt_at = NULL,
        updated_at = ?, claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL
      WHERE id = ?
    `).run(at, id);
    return this.get(id)!;
  }
}
