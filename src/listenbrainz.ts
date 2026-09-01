// ListenBrainz: the replacement for Spotify's taste graph.
//
// Two jobs, and they feed each other:
//
//  1. RADIO. LB Radio turns a prompt ("artist:(Converge)", "tag:(doom metal)")
//     into a playlist of MusicBrainz recording ids. Recording ids are the join
//     key the open music ecosystem speaks, and Lidarr stamps one on every
//     track it imports — so "do we already own this?" is an exact lookup, not
//     a fuzzy title match. See lidarr_recording in the taste DB.
//
//  2. SCROBBLING. Every play is submitted back. That is what makes the
//     "stats:(user)" and "recs:(user)" prompts work, and it rebuilds the
//     listening history OUTSIDE Spotify — the thing that actually makes
//     cancelling the subscription survivable.
//
// Submissions go through a durable queue rather than straight out over the
// wire: a play must never be lost because the pi was offline for an hour, and
// the player must never wait on a third party to finish a track.
//
// The similarity endpoints on labs.* need no credentials; everything on the
// main API now does ("bad actors and AI scrapers", per their own 401 body),
// so `enabled` gates the token-only paths and the rest still works without it.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface RadioTrack {
  recordingMbid: string;
  title: string;
  artist: string;
  artistMbids: string[];
  album: string | null;
  releaseMbid: string | null;
  durationMs: number | null;
}

export interface Listen {
  listenedAt: number;      // unix seconds
  artist: string;
  title: string;
  album?: string | null;
  recordingMbid?: string | null;
}

/** How far the radio is allowed to stray from the seed. */
export type RadioMode = 'easy' | 'medium' | 'hard';

const API = 'https://api.listenbrainz.org/1';
const LABS = 'https://labs.api.listenbrainz.org';
const USER_AGENT = 'music-taste/1.0 (https://github.com/joe-lloyd/music-dump)';

// A radio prompt is deterministic enough that re-asking within the hour just
// burns someone else's quota, and short enough that a stale playlist is never
// interesting. Name lookups are the opposite: a hit is permanent, a miss is
// worth retrying once the MusicBrainz database has had time to grow.
const RADIO_TTL_MS = 60 * 60 * 1000;
const SIMILAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOOKUP_MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ListenBrainz accepts 1000 listens per import request; stay well under so a
// single oversized body can't fail a whole backfill.
const SUBMIT_BATCH = 250;
// Recording metadata is fetched in bulk; keep the URL a sane length.
const METADATA_BATCH = 50;
const MAX_SUBMIT_TRIES = 6;

// Session-based co-occurrence, the algorithm LB's own explore page defaults to.
const SIMILAR_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30';

/**
 * Recording MBID out of a JSPF `identifier`, which is a URL (or a list of
 * them) rather than a bare id.
 */
export function mbidFromIdentifier(identifier: unknown): string | null {
  const list = Array.isArray(identifier) ? identifier : [identifier];
  for (const entry of list) {
    const found = /recording\/([0-9a-f-]{36})/i.exec(String(entry ?? ''));
    if (found) return found[1].toLowerCase();
  }
  return null;
}

/** JSPF track -> our shape. Tolerant: a track missing an MBID is dropped. */
export function parseJspf(body: unknown): RadioTrack[] {
  const payload = (body as { payload?: { jspf?: { playlist?: { track?: unknown[] } } } })?.payload;
  const tracks = payload?.jspf?.playlist?.track ?? [];
  const out: RadioTrack[] = [];
  for (const raw of tracks) {
    const track = raw as Record<string, unknown>;
    const recordingMbid = mbidFromIdentifier(track.identifier);
    if (!recordingMbid) continue;
    const extension = Object.values((track.extension ?? {}) as Record<string, unknown>)[0] as
      { artist_identifiers?: unknown[]; release_identifier?: unknown } | undefined;
    const releaseMbid = mbidFromIdentifier(extension?.release_identifier)
      ?? (/release\/([0-9a-f-]{36})/i.exec(String(extension?.release_identifier ?? ''))?.[1] ?? null);
    out.push({
      recordingMbid,
      title: String(track.title ?? '').trim(),
      artist: String(track.creator ?? '').trim(),
      artistMbids: (extension?.artist_identifiers ?? [])
        .map((entry) => {
          const text = String(entry ?? '');
          return (/([0-9a-f-]{36})/i.exec(text)?.[1] ?? '').toLowerCase();
        })
        .filter(Boolean),
      album: track.album ? String(track.album) : null,
      releaseMbid: releaseMbid ? releaseMbid.toLowerCase() : null,
      durationMs: Number.isFinite(track.duration) ? Number(track.duration) : null,
    });
  }
  return out;
}

/**
 * Cap how many tracks any one artist may contribute, keeping the original
 * order otherwise.
 *
 * Raw similarity is brutally clustered — seeding it with a Converge track
 * returned 87 recordings that were, without exception, Tool. A radio station
 * that plays one artist is not a radio station, so the cap is a correctness
 * requirement rather than a nicety. LB Radio already diversifies internally;
 * this protects the labs-similarity fallback, which does not.
 */
export function capPerArtist<T extends { artist: string }>(tracks: T[], limit: number): T[] {
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const track of tracks) {
    const key = track.artist.toLowerCase();
    const count = seen.get(key) ?? 0;
    if (count >= limit) continue;
    seen.set(key, count + 1);
    out.push(track);
  }
  return out;
}

/**
 * Deal tracks out so the same artist never lands twice in a row, without
 * disturbing more of the order than it has to. A straight sort by score puts
 * an artist's whole catalogue back-to-back even after the cap.
 */
export function spaceArtists<T extends { artist: string }>(tracks: T[]): T[] {
  const remaining = [...tracks];
  const out: T[] = [];
  let previous = '';
  while (remaining.length) {
    let index = remaining.findIndex((track) => track.artist.toLowerCase() !== previous);
    if (index < 0) index = 0;          // only one artist left — play it anyway
    const [picked] = remaining.splice(index, 1);
    previous = picked.artist.toLowerCase();
    out.push(picked);
  }
  return out;
}

/**
 * A failed submission, carrying whether waiting could ever help.
 *
 * 401/403 mean the account needs attention (an unverified email, a revoked
 * token); 429 and 5xx mean ListenBrainz is busy. None of those are the
 * listen's fault, so none of them should count against its retry budget.
 */
class SubmitError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }

  get permanent(): boolean {
    return !(this.status === 401 || this.status === 403 || this.status === 429 || this.status >= 500);
  }
}

export class ListenBrainz {
  private db: DatabaseSync | null = null;
  private readonly dbFile: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;
  readonly user: string;

  constructor(options?: { dbFile?: string; token?: string; user?: string; fetchImpl?: typeof fetch }) {
    this.dbFile = options?.dbFile
      ?? process.env.LISTENBRAINZ_DB
      ?? path.join(import.meta.dirname, '..', 'data', 'listenbrainz.db');
    this.token = options?.token ?? process.env.LISTENBRAINZ_TOKEN ?? '';
    this.user = options?.user ?? process.env.LISTENBRAINZ_USER ?? '';
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  /** Token-only endpoints (radio, lookup, scrobbling) are available. */
  get enabled(): boolean {
    return Boolean(this.token);
  }

  private handle(): DatabaseSync {
    if (!this.db) {
      this.db = new DatabaseSync(this.dbFile);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lb_cache (
          key TEXT PRIMARY KEY,
          fetched_at INTEGER NOT NULL,
          payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lb_listens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          listened_at INTEGER NOT NULL,
          artist TEXT NOT NULL,
          title TEXT NOT NULL,
          album TEXT,
          recording_mbid TEXT,
          tries INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          submitted_at TEXT,
          UNIQUE (listened_at, artist, title)
        );
        CREATE INDEX IF NOT EXISTS lb_listens_pending
          ON lb_listens(submitted_at, tries);
      `);
    }
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private cached<T>(key: string, ttlMs: number): T | null {
    const row = this.handle()
      .prepare('SELECT fetched_at, payload FROM lb_cache WHERE key = ?')
      .get(key) as { fetched_at: number; payload: string } | undefined;
    if (!row) return null;
    if (Date.now() - row.fetched_at > ttlMs) return null;
    try {
      return JSON.parse(row.payload) as T;
    } catch {
      return null;
    }
  }

  private store(key: string, value: unknown): void {
    this.handle()
      .prepare('INSERT OR REPLACE INTO lb_cache (key, fetched_at, payload) VALUES (?, ?, ?)')
      .run(key, Date.now(), JSON.stringify(value));
  }

  private async get(url: string, withToken: boolean): Promise<unknown> {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT };
    if (withToken) headers.authorization = `Token ${this.token}`;
    const response = await this.fetchImpl(url, { headers });
    if (response.status === 429 || response.status === 503) {
      throw new Error(`listenbrainz is rate limiting (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`listenbrainz ${new URL(url).pathname} failed (${response.status})`);
    }
    return response.json();
  }

  /**
   * LB Radio. The prompt language is theirs: `artist:(name or mbid)`,
   * `tag:(a,b)`, `stats:(user)`, `recs:(user)`. Mode widens the net.
   */
  async radio(prompt: string, mode: RadioMode = 'medium'): Promise<RadioTrack[]> {
    if (!this.enabled) return [];
    const key = `radio:${mode}:${prompt}`;
    const hit = this.cached<RadioTrack[]>(key, RADIO_TTL_MS);
    if (hit) return hit;
    const url = `${API}/explore/lb-radio?prompt=${encodeURIComponent(prompt)}&mode=${mode}`;
    const tracks = parseJspf(await this.get(url, true));
    if (tracks.length) this.store(key, tracks);
    return tracks;
  }

  /**
   * Recordings that co-occur with this one in real listening sessions. No
   * token needed, and it keeps working if the main API tightens further — but
   * it clusters hard by artist, so callers must diversify (capPerArtist).
   */
  async similar(recordingMbid: string): Promise<RadioTrack[]> {
    const key = `similar:${recordingMbid}`;
    const hit = this.cached<RadioTrack[]>(key, SIMILAR_TTL_MS);
    if (hit) return hit;
    const url = `${LABS}/similar-recordings/json?recording_mbids=${encodeURIComponent(recordingMbid)}`
      + `&algorithm=${SIMILAR_ALGORITHM}`;
    const body = await this.get(url, false);
    // The labs endpoints answer either a flat list or a list-of-lists.
    const rows = (Array.isArray(body) && Array.isArray(body[0]) ? body[0] : body) as
      Record<string, unknown>[];
    const tracks: RadioTrack[] = (Array.isArray(rows) ? rows : [])
      .filter((row) => row && row.recording_mbid)
      .map((row) => ({
        recordingMbid: String(row.recording_mbid).toLowerCase(),
        title: String(row.recording_name ?? '').trim(),
        artist: String(row.artist_credit_name ?? '').trim(),
        artistMbids: (row.artist_credit_mbids as string[] | undefined) ?? [],
        album: row.release_name ? String(row.release_name) : null,
        releaseMbid: row.release_mbid ? String(row.release_mbid).toLowerCase() : null,
        durationMs: null,
      }));
    if (tracks.length) this.store(key, tracks);
    return tracks;
  }

  /**
   * Recording lengths, in bulk.
   *
   * The similarity endpoint returns no duration, and duration is what lets the
   * fetch-ahead pick the right YouTube result instead of a live take or an
   * hour-long mix. One call covers a whole station.
   */
  async recordingLengths(mbids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.enabled) return out;
    const wanted = [...new Set(mbids.filter(Boolean))];
    for (let at = 0; at < wanted.length; at += METADATA_BATCH) {
      const batch = wanted.slice(at, at + METADATA_BATCH);
      const key = `lengths:${batch.join(',')}`;
      const hit = this.cached<Record<string, number>>(key, SIMILAR_TTL_MS);
      if (hit) {
        for (const [mbid, length] of Object.entries(hit)) out.set(mbid, length);
        continue;
      }
      let body: Record<string, { recording?: { length?: number } }>;
      try {
        body = await this.get(
          `${API}/metadata/recording?recording_mbids=${batch.join(',')}`, true,
        ) as typeof body;
      } catch {
        continue;         // a station without durations still plays
      }
      const found: Record<string, number> = {};
      for (const [mbid, entry] of Object.entries(body ?? {})) {
        const length = entry?.recording?.length;
        if (Number.isFinite(length) && Number(length) > 0) {
          found[mbid.toLowerCase()] = Number(length);
          out.set(mbid.toLowerCase(), Number(length));
        }
      }
      this.store(key, found);
    }
    return out;
  }

  /** Artist name or title -> MBIDs. The only route for tracks Lidarr never saw. */
  async lookup(artist: string, title: string): Promise<
    { recordingMbid: string; artistMbids: string[]; releaseMbid: string | null } | null
  > {
    if (!this.enabled || !artist || !title) return null;
    const key = `lookup:${artist.toLowerCase()}|${title.toLowerCase()}`;
    const hit = this.cached<{ found: boolean; value: never }>(key, LOOKUP_MISS_TTL_MS);
    if (hit) return hit.found ? hit.value : null;
    const query = new URLSearchParams({ artist_name: artist, recording_name: title });
    const body = await this.get(`${API}/metadata/lookup?${query}`, true) as Record<string, unknown>;
    const recordingMbid = body?.recording_mbid ? String(body.recording_mbid) : '';
    if (!recordingMbid) {
      this.store(key, { found: false });
      return null;
    }
    const value = {
      recordingMbid: recordingMbid.toLowerCase(),
      artistMbids: (body.artist_mbids as string[] | undefined) ?? [],
      releaseMbid: body.release_mbid ? String(body.release_mbid).toLowerCase() : null,
    };
    this.store(key, { found: true, value });
    return value;
  }

  // --- scrobbling ---------------------------------------------------------

  /**
   * Queue a play for submission. Never throws and never blocks on the network:
   * the caller is a player finishing a track.
   *
   * The UNIQUE (listened_at, artist, title) is what makes re-importing a
   * history file safe — a listen already queued is silently ignored rather
   * than being submitted twice.
   */
  enqueue(listen: Listen): void {
    this.handle().prepare(`
      INSERT OR IGNORE INTO lb_listens (listened_at, artist, title, album, recording_mbid)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      Math.floor(listen.listenedAt),
      listen.artist,
      listen.title,
      listen.album ?? null,
      listen.recordingMbid ?? null,
    );
  }

  /**
   * Put already-submitted listens back in the queue.
   *
   * ListenBrainz answers a submission with {"status":"ok"} before the listens
   * are durably ingested, so a 200 is an acknowledgement rather than a
   * guarantee. If they never show up, this is how they go again - the rows
   * were never deleted, only marked.
   */
  resubmitAll(): number {
    const result = this.handle()
      .prepare('UPDATE lb_listens SET submitted_at = NULL, tries = 0, last_error = NULL')
      .run();
    return Number(result.changes ?? 0);
  }

  pending(): number {
    return (this.handle()
      .prepare(`SELECT COUNT(*) n FROM lb_listens WHERE submitted_at IS NULL AND tries < ?`)
      .get(MAX_SUBMIT_TRIES) as { n: number }).n;
  }

  stats(): { pending: number; submitted: number; failed: number } {
    const row = this.handle().prepare(`
      SELECT SUM(submitted_at IS NULL AND tries < ?) pending,
             SUM(submitted_at IS NOT NULL) submitted,
             SUM(submitted_at IS NULL AND tries >= ?) failed
      FROM lb_listens
    `).get(MAX_SUBMIT_TRIES, MAX_SUBMIT_TRIES) as Record<string, number | null>;
    return {
      pending: row.pending ?? 0,
      submitted: row.submitted ?? 0,
      failed: row.failed ?? 0,
    };
  }

  private async post(payload: unknown): Promise<void> {
    const response = await this.fetchImpl(`${API}/submit-listens`, {
      method: 'POST',
      headers: {
        'authorization': `Token ${this.token}`,
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new SubmitError(response.status, `submit-listens failed (${response.status}) ${detail.slice(0, 200)}`);
    }
  }

  /** "Playing now" is ephemeral and best-effort — never queued, never retried. */
  async nowPlaying(listen: Omit<Listen, 'listenedAt'>): Promise<void> {
    if (!this.enabled) return;
    await this.post({
      listen_type: 'playing_now',
      payload: [{
        track_metadata: {
          artist_name: listen.artist,
          track_name: listen.title,
          release_name: listen.album ?? undefined,
          additional_info: {
            recording_mbid: listen.recordingMbid ?? undefined,
            media_player: 'music.home.arpa',
            submission_client: 'music-taste',
          },
        },
      }],
    });
  }

  /**
   * Drain the queue. Returns how many listens were accepted. Failures raise
   * the per-row try count rather than aborting the drain, so one poisoned row
   * (a title ListenBrainz rejects) can never wedge the backlog behind it.
   */
  async flush(limit = SUBMIT_BATCH): Promise<number> {
    if (!this.enabled) return 0;
    const rows = this.handle().prepare(`
      SELECT id, listened_at, artist, title, album, recording_mbid
      FROM lb_listens WHERE submitted_at IS NULL AND tries < ?
      ORDER BY listened_at LIMIT ?
    `).all(MAX_SUBMIT_TRIES, limit) as {
      id: number; listened_at: number; artist: string; title: string;
      album: string | null; recording_mbid: string | null;
    }[];
    if (!rows.length) return 0;

    const payload = {
      // "import" is the listen_type for anything historical; "single" is only
      // correct for a track that just finished, and the queue may hold both by
      // the time it drains.
      listen_type: 'import',
      payload: rows.map((row) => ({
        listened_at: row.listened_at,
        track_metadata: {
          artist_name: row.artist,
          track_name: row.title,
          release_name: row.album ?? undefined,
          additional_info: {
            recording_mbid: row.recording_mbid ?? undefined,
            media_player: 'music.home.arpa',
            submission_client: 'music-taste',
          },
        },
      })),
    };

    const ids = rows.map((row) => row.id);
    const marks = ids.map(() => '?').join(',');
    try {
      await this.post(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A rejection we cannot fix by waiting counts against the row's budget;
      // one we can does not. The distinction is not academic: ListenBrainz
      // refuses every submission until the account's email is verified, and
      // counting those would burn six retries in half an hour and discard the
      // listens - the exact data this queue exists to protect.
      const permanent = err instanceof SubmitError ? err.permanent : true;
      this.handle().prepare(
        `UPDATE lb_listens SET tries = tries + ?, last_error = ? WHERE id IN (${marks})`,
      ).run(permanent ? 1 : 0, message.slice(0, 300), ...ids);
      throw err;
    }
    this.handle()
      .prepare(`UPDATE lb_listens SET submitted_at = ?, last_error = NULL WHERE id IN (${marks})`)
      .run(new Date().toISOString(), ...ids);
    return rows.length;
  }
}
