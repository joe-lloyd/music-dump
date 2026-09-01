// The physical shelf: CDs owned on disc, pulled from a Discogs collection so
// the app knows what still needs ripping.
//
// Discogs is the catalogue of record for physical media - it has the pressing,
// the catalogue number and the year, which is exactly what tells two editions
// of the same album apart. The collection is synced in, stored locally, and
// then cross-checked against the library so each disc shows as ripped or not.
// Ripping itself happens elsewhere; this only tracks it.
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { normalizeMusicText } from './jellyfin.ts';

export const DISCOGS_FILE = process.env.DISCOGS_DB
  ?? path.join(import.meta.dirname, '..', 'data', 'discogs.db');

const API = 'https://api.discogs.com';
// Discogs rejects requests without a descriptive agent, and asks that it
// identify the application rather than impersonate a browser.
const AGENT = process.env.DISCOGS_USER_AGENT ?? 'HomelabMusicTaste/1.0 (+https://music.home.arpa)';

export type ShelfStatus = 'shelf' | 'ripping' | 'ripped' | 'skip';
export const SHELF_STATUSES: ShelfStatus[] = ['shelf', 'ripping', 'ripped', 'skip'];

export interface ShelfItem {
  release_id: number;
  artist: string;
  title: string;
  year: number | null;
  format: string | null;
  label: string | null;
  catno: string | null;
  thumb_url: string | null;
  cover_url: string | null;
  genres: string | null;      // JSON array
  status: ShelfStatus;
  rip_path: string | null;
  notes: string | null;
  added_at: string;
  updated_at: string;
}

export class DiscogsError extends Error {
  readonly status: number;

  // Written out rather than declared as a constructor parameter property:
  // Node's type stripping runs without a full compiler and rejects those.
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface CollectionRelease {
  id: number;
  basic_information?: {
    id?: number;
    title?: string;
    year?: number;
    thumb?: string;
    cover_image?: string;
    artists?: { name?: string }[];
    labels?: { name?: string; catno?: string }[];
    formats?: { name?: string; qty?: string; descriptions?: string[] }[];
    genres?: string[];
  };
}

/** "Joe Bloggs (2)" is how Discogs disambiguates same-named artists. */
function cleanArtist(name: string): string {
  return name.replace(/\s*\(\d+\)$/, '').trim();
}

function formatOf(release: CollectionRelease['basic_information']): string | null {
  const first = release?.formats?.[0];
  if (!first) return null;
  const extra = (first.descriptions ?? []).filter((d) => d && d !== first.name);
  return [first.name, ...extra].filter(Boolean).join(', ') || null;
}

export function toShelfItem(release: CollectionRelease): Omit<ShelfItem, 'status' | 'rip_path' | 'notes' | 'added_at' | 'updated_at'> {
  const info = release.basic_information ?? {};
  const artists = (info.artists ?? []).map((a) => cleanArtist(String(a.name ?? ''))).filter(Boolean);
  const label = info.labels?.[0];
  return {
    release_id: Number(info.id ?? release.id),
    artist: artists.join(', ') || 'Unknown Artist',
    title: String(info.title ?? '').trim() || 'Untitled',
    year: info.year ? Number(info.year) : null,
    format: formatOf(info),
    label: label?.name ? String(label.name) : null,
    catno: label?.catno ? String(label.catno) : null,
    thumb_url: info.thumb || null,
    cover_url: info.cover_image || info.thumb || null,
    genres: info.genres?.length ? JSON.stringify(info.genres) : null,
  };
}

/**
 * Discogs has two credential shapes and they are NOT interchangeable.
 *
 *  - A **consumer key + secret** identifies an *application*. It authenticates
 *    requests to public endpoints (catalogue search, release lookup) at the
 *    full rate limit, and that is all. It cannot read anyone's collection,
 *    because it does not identify a person.
 *  - A **personal access token** identifies *you*. It is what unlocks
 *    /oauth/identity and the collection endpoints.
 *
 * The alternative to a personal token is the full OAuth 1.0a dance
 * (request token -> browser authorize -> verifier -> access token), which for
 * a single-user homelab app buys nothing over the token you can generate with
 * one click on the same settings page.
 *
 * Both are supported here: whichever is configured is used, with the personal
 * token preferred when both are present.
 */
export type DiscogsScope = 'none' | 'catalogue' | 'account';

export class DiscogsClient {
  private readonly token: string;
  private readonly key: string;
  private readonly secret: string;

  constructor(
    token = process.env.DISCOGS_TOKEN ?? '',
    key = process.env.DISCOGS_CONSUMER_KEY ?? '',
    secret = process.env.DISCOGS_CONSUMER_SECRET ?? '',
  ) {
    this.token = token.trim();
    this.key = key.trim();
    this.secret = secret.trim();
  }

  /** What the configured credentials can actually reach. */
  get scope(): DiscogsScope {
    if (this.token) return 'account';
    if (this.key && this.secret) return 'catalogue';
    return 'none';
  }

  get configured(): boolean {
    return this.scope !== 'none';
  }

  /** Collection sync needs a personal token; search does not. */
  get canReadCollection(): boolean {
    return this.scope === 'account';
  }

  private authorization(): string {
    return this.token
      ? `Discogs token=${this.token}`
      : `Discogs key=${this.key}, secret=${this.secret}`;
  }

  private async request<T>(pathname: string, params: Record<string, string> = {}): Promise<T> {
    if (!this.configured) throw new DiscogsError('No Discogs credentials are configured', 503);
    const url = new URL(API + pathname);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    // 60 requests/minute authenticated. A collection sync is a handful of
    // pages, so one polite wait-and-retry is enough to ride out a 429 rather
    // than failing a sync the user asked for.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await fetch(url, {
        headers: { authorization: this.authorization(), 'user-agent': AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(30, Number(res.headers.get('retry-after') ?? 5) || 5);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        continue;
      }
      if (!res.ok) {
        // 401 on a consumer key/secret is not a bad credential, it is the
        // wrong *kind* of credential; say which so it is actionable.
        const detail = res.status !== 401
          ? `Discogs returned ${res.status}`
          : this.canReadCollection
            ? 'Discogs rejected the personal access token'
            : 'This endpoint needs a personal access token, not a consumer key and secret';
        throw new DiscogsError(detail, res.status);
      }
      return await res.json() as T;
    }
    throw new DiscogsError('Discogs rate limit exceeded', 429);
  }

  /** The token's own account - saves asking for a username separately. */
  identity(): Promise<{ username: string; id: number }> {
    if (!this.canReadCollection) {
      throw new DiscogsError(
        'Collection sync needs a personal access token. Generate one at '
        + 'discogs.com/settings/developers and set DISCOGS_TOKEN; a consumer '
        + 'key and secret can only search the catalogue.',
        403,
      );
    }
    return this.request('/oauth/identity');
  }

  /**
   * Every release in the collection. Folder 0 is Discogs' "All" folder, so
   * this covers every custom folder without enumerating them.
   */
  async collection(username: string, onPage?: (page: number, pages: number) => void): Promise<CollectionRelease[]> {
    const all: CollectionRelease[] = [];
    let page = 1;
    let pages = 1;
    do {
      const body = await this.request<{
        pagination?: { pages?: number };
        releases?: CollectionRelease[];
      }>(`/users/${encodeURIComponent(username)}/collection/folders/0/releases`, {
        page: String(page),
        per_page: '100',
        sort: 'artist',
      });
      pages = Number(body.pagination?.pages ?? 1);
      all.push(...(body.releases ?? []));
      onPage?.(page, pages);
      page += 1;
    } while (page <= pages && page <= 50); // 5000 discs is well past any shelf
    return all;
  }

  /** Free-text catalogue search, for adding a disc the collection is missing. */
  async search(term: string): Promise<CollectionRelease[]> {
    const body = await this.request<{ results?: Record<string, unknown>[] }>('/database/search', {
      q: term,
      type: 'release',
      format: 'CD',
      per_page: '25',
    });
    // Search results are shaped differently from collection entries; fold them
    // into the same shape so one renderer handles both.
    return (body.results ?? []).map((result) => {
      const title = String(result.title ?? '');
      const dash = title.indexOf(' - ');
      return {
        id: Number(result.id ?? 0),
        basic_information: {
          id: Number(result.id ?? 0),
          title: dash > 0 ? title.slice(dash + 3) : title,
          year: result.year ? Number(result.year) : undefined,
          thumb: String(result.thumb ?? ''),
          cover_image: String(result.cover_image ?? result.thumb ?? ''),
          artists: dash > 0 ? [{ name: title.slice(0, dash) }] : [],
          labels: Array.isArray(result.label)
            ? [{ name: String(result.label[0] ?? ''), catno: String(result.catno ?? '') }]
            : [],
          formats: Array.isArray(result.format) ? [{ name: String(result.format[0] ?? 'CD') }] : [],
          genres: Array.isArray(result.genre) ? result.genre.map(String) : [],
        },
      };
    });
  }
}

/** Match key for "do I already have this album ripped?". */
export function albumKey(artist: string, title: string): string {
  const lead = String(artist ?? '').split(/,| & | feat\.? | ft\.? /i)[0] ?? '';
  // Discogs titles carry edition noise the library folder never has.
  const bare = String(title ?? '')
    .replace(/\s*[([][^)\]]*(edition|remaster|reissue|deluxe|disc|cd\s*\d)[^)\]]*[)\]]/gi, '')
    .trim();
  const a = normalizeMusicText(lead);
  const t = normalizeMusicText(bare);
  return a && t ? `${a} ${t}` : '';
}

export class ShelfStore {
  private db: DatabaseSync | null = null;
  private readonly dbFile: string;
  private readonly now: () => number;

  constructor(dbFile?: string, now: () => number = Date.now) {
    this.dbFile = dbFile ?? DISCOGS_FILE;
    this.now = now;
  }

  private handle(): DatabaseSync {
    if (!this.db) {
      mkdirSync(path.dirname(this.dbFile), { recursive: true });
      this.db = new DatabaseSync(this.dbFile);
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS cd_shelf (
          release_id INTEGER PRIMARY KEY,
          artist TEXT NOT NULL,
          title TEXT NOT NULL,
          year INTEGER,
          format TEXT,
          label TEXT,
          catno TEXT,
          thumb_url TEXT,
          cover_url TEXT,
          genres TEXT,
          status TEXT NOT NULL DEFAULT 'shelf'
            CHECK (status IN ('shelf', 'ripping', 'ripped', 'skip')),
          rip_path TEXT,
          notes TEXT,
          added_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS shelf_status ON cd_shelf(status);

        CREATE TABLE IF NOT EXISTS shelf_sync (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          username TEXT,
          synced_at TEXT,
          released INTEGER
        );
      `);
    }
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * Merge a synced collection in. Catalogue fields are refreshed every sync,
   * but status/notes/rip_path are the user's and are never overwritten.
   */
  sync(releases: CollectionRelease[], username: string): { added: number; updated: number; removed: number } {
    const db = this.handle();
    const at = new Date(this.now()).toISOString();
    const existing = new Set((db.prepare('SELECT release_id FROM cd_shelf').all() as { release_id: number }[])
      .map((row) => row.release_id));
    const insert = db.prepare(`
      INSERT INTO cd_shelf
        (release_id, artist, title, year, format, label, catno, thumb_url, cover_url,
         genres, status, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shelf', ?, ?)
      ON CONFLICT(release_id) DO UPDATE SET
        artist = excluded.artist, title = excluded.title, year = excluded.year,
        format = excluded.format, label = excluded.label, catno = excluded.catno,
        thumb_url = excluded.thumb_url, cover_url = excluded.cover_url,
        genres = excluded.genres, updated_at = excluded.updated_at
    `);
    let added = 0;
    let updated = 0;
    const seen = new Set<number>();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const release of releases) {
        const item = toShelfItem(release);
        if (!item.release_id) continue;
        seen.add(item.release_id);
        if (existing.has(item.release_id)) updated += 1; else added += 1;
        insert.run(
          item.release_id, item.artist, item.title, item.year, item.format,
          item.label, item.catno, item.thumb_url, item.cover_url, item.genres, at, at,
        );
      }
      // A disc sold or removed on Discogs should leave the shelf too, unless
      // it has already been ripped - then the library still has it and the
      // record is worth keeping.
      let removed = 0;
      const drop = db.prepare("DELETE FROM cd_shelf WHERE release_id = ? AND status IN ('shelf', 'skip')");
      for (const id of existing) {
        if (!seen.has(id)) removed += drop.run(id).changes ? 1 : 0;
      }
      db.prepare(`
        INSERT INTO shelf_sync (id, username, synced_at, released) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username,
          synced_at = excluded.synced_at, released = excluded.released
      `).run(username, at, seen.size);
      db.exec('COMMIT');
      return { added, updated, removed };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Add a single release found through search rather than the collection. */
  add(release: CollectionRelease): ShelfItem | null {
    const item = toShelfItem(release);
    if (!item.release_id) return null;
    const at = new Date(this.now()).toISOString();
    this.handle().prepare(`
      INSERT INTO cd_shelf
        (release_id, artist, title, year, format, label, catno, thumb_url, cover_url,
         genres, status, added_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shelf', ?, ?)
      ON CONFLICT(release_id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(
      item.release_id, item.artist, item.title, item.year, item.format,
      item.label, item.catno, item.thumb_url, item.cover_url, item.genres, at, at,
    );
    return this.get(item.release_id);
  }

  get(releaseId: number): ShelfItem | null {
    return (this.handle().prepare('SELECT * FROM cd_shelf WHERE release_id = ?')
      .get(releaseId) as ShelfItem | undefined) ?? null;
  }

  list(): ShelfItem[] {
    return this.handle().prepare(
      'SELECT * FROM cd_shelf ORDER BY artist COLLATE NOCASE, year, title COLLATE NOCASE',
    ).all() as ShelfItem[];
  }

  setStatus(releaseId: number, status: ShelfStatus, ripPath?: string | null): ShelfItem | null {
    if (!SHELF_STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
    const at = new Date(this.now()).toISOString();
    this.handle().prepare(
      'UPDATE cd_shelf SET status = ?, rip_path = COALESCE(?, rip_path), updated_at = ? WHERE release_id = ?',
    ).run(status, ripPath ?? null, at, releaseId);
    return this.get(releaseId);
  }

  remove(releaseId: number): boolean {
    return this.handle().prepare('DELETE FROM cd_shelf WHERE release_id = ?').run(releaseId).changes > 0;
  }

  lastSync(): { username: string | null; synced_at: string | null; released: number | null } {
    const row = this.handle().prepare('SELECT username, synced_at, released FROM shelf_sync WHERE id = 1').get();
    return (row as { username: string | null; synced_at: string | null; released: number | null })
      ?? { username: null, synced_at: null, released: null };
  }

  /**
   * Flip shelf discs to ripped when the library grows a matching album.
   * Only moves 'shelf' -> 'ripped'; a manual 'skip' or an in-progress
   * 'ripping' is the user's state and is left alone.
   */
  reconcile(libraryKeys: Set<string>): number {
    const db = this.handle();
    const at = new Date(this.now()).toISOString();
    const stmt = db.prepare("UPDATE cd_shelf SET status = 'ripped', updated_at = ? WHERE release_id = ?");
    let flipped = 0;
    for (const item of this.list()) {
      if (item.status !== 'shelf') continue;
      if (!libraryKeys.has(albumKey(item.artist, item.title))) continue;
      stmt.run(at, item.release_id);
      flipped += 1;
    }
    return flipped;
  }
}
