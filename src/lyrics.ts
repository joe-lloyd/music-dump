// Lyrics for the player, local-first: a matched Jellyfin item is asked for
// its lyrics live (covers .lrc sidecars beside the files and embedded tags,
// and self-heals when a sidecar appears later), then LRCLIB fills the gaps.
// Only LRCLIB responses are cached on disk — hits forever, misses retried
// weekly — so the third party is asked about each track at most once.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface LyricLine { time: number; text: string; }

export interface LyricsResult {
  available: boolean;
  synced: LyricLine[] | null;
  plain: string | null;
  instrumental: boolean;
  source: 'jellyfin' | 'lrclib' | null;
}

export interface LyricsTrack {
  id: string;
  name: string;
  album: string | null;
  artists: string | null;
  duration_ms: number | null;
}

interface LyricsBridge {
  match(track: never): Promise<{ itemId: string } | null>;
  lyrics(itemId: string): Promise<{ synced: LyricLine[] | null; plain: string | null } | null>;
}

const MISS_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const USER_AGENT = 'music-taste/1.0 (https://github.com/joe-lloyd/music-dump)';

const NONE: LyricsResult = { available: false, synced: null, plain: null, instrumental: false, source: null };

// [mm:ss.xx] timestamps, several per line allowed; [ar:], [ti:], … are metadata.
export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const content = raw.slice((tags.at(-1)?.index ?? 0) + tags.at(-1)![0].length).trim();
    for (const [, min, sec, frac] of tags) {
      const fraction = frac ? Number(frac) / 10 ** frac.length : 0;
      lines.push({ time: Number(min) * 60 + Number(sec) + fraction, text: content });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export class LyricsService {
  private db: DatabaseSync | null = null;
  private readonly dbFile: string;
  private readonly fetchImpl: typeof fetch;

  constructor(dbFile?: string, fetchImpl?: typeof fetch) {
    this.dbFile = dbFile ?? process.env.LYRICS_DB ?? path.join(import.meta.dirname, '..', 'data', 'lyrics.db');
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private cache(): DatabaseSync {
    if (!this.db) {
      this.db = new DatabaseSync(this.dbFile);
      this.db.exec(`CREATE TABLE IF NOT EXISTS lrclib_cache (
        track_id TEXT PRIMARY KEY,
        found INTEGER NOT NULL,
        synced TEXT,
        plain TEXT,
        instrumental INTEGER NOT NULL DEFAULT 0,
        fetched_at INTEGER NOT NULL
      )`);
    }
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  async for(track: LyricsTrack, bridge: LyricsBridge): Promise<LyricsResult> {
    try {
      const match = await bridge.match(track as never);
      if (match) {
        const local = await bridge.lyrics(match.itemId);
        if (local) return { available: true, ...local, instrumental: false, source: 'jellyfin' };
      }
    } catch { /* an unreachable Jellyfin only forfeits the local source */ }
    return this.fromLrclib(track);
  }

  private async fromLrclib(track: LyricsTrack): Promise<LyricsResult> {
    const cached = this.cache()
      .prepare('SELECT found, synced, plain, instrumental, fetched_at FROM lrclib_cache WHERE track_id = ?')
      .get(track.id) as { found: number; synced: string | null; plain: string | null; instrumental: number; fetched_at: number } | undefined;
    if (cached && (cached.found || Date.now() - cached.fetched_at < MISS_RETRY_MS)) {
      if (!cached.found) return NONE;
      return {
        available: true,
        synced: cached.synced ? JSON.parse(cached.synced) : null,
        plain: cached.plain,
        instrumental: Boolean(cached.instrumental),
        source: 'lrclib',
      };
    }

    const params = new URLSearchParams({
      track_name: track.name,
      artist_name: (track.artists ?? '').split(',')[0].trim(),
    });
    if (track.album) params.set('album_name', track.album);
    if (track.duration_ms) params.set('duration', String(Math.round(track.duration_ms / 1000)));

    let found: { synced: LyricLine[] | null; plain: string | null; instrumental: boolean } | null = null;
    try {
      const response = await this.fetchImpl(`https://lrclib.net/api/get?${params}`, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404) {
        found = null;
      } else if (!response.ok) {
        return NONE; // 429/5xx: do not cache, retry on the next request
      } else {
        const data = await response.json() as { syncedLyrics?: string | null; plainLyrics?: string | null; instrumental?: boolean };
        const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : [];
        found = {
          synced: synced.length > 1 ? synced : null,
          plain: data.plainLyrics?.trim() || null,
          instrumental: Boolean(data.instrumental),
        };
        if (!found.synced && !found.plain && !found.instrumental) found = null;
      }
    } catch {
      return NONE; // network failure: not cached either
    }

    this.cache().prepare(`INSERT OR REPLACE INTO lrclib_cache
      (track_id, found, synced, plain, instrumental, fetched_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(track.id, found ? 1 : 0, found?.synced ? JSON.stringify(found.synced) : null,
        found?.plain ?? null, found?.instrumental ? 1 : 0, Date.now());
    if (!found) return NONE;
    return { available: true, ...found, source: 'lrclib' };
  }
}
