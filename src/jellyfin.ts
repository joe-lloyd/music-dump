import net from 'node:net';
import { readFileSync } from 'node:fs';
import { splitWordTags } from './lyrics.ts';

export interface TasteTrack {
  id: string;
  name: string;
  album_id: string | null;
  album: string | null;
  artists: string | null;
  duration_ms: number | null;
  disc_number: number | null;
  track_number: number | null;
  image_url: string | null;
}

interface JellyfinAudioItem {
  Id: string;
  Name: string;
  Album?: string;
  AlbumId?: string;
  Artists?: string[];
  // Unlike Artists, Jellyfin serializes AlbumArtists as {Id, Name} pairs.
  AlbumArtists?: { Name?: string }[];
  RunTimeTicks?: number;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  Container?: string;
  Path?: string;
}

interface JellyfinItemsResponse {
  Items?: JellyfinAudioItem[];
  TotalRecordCount?: number;
}

export interface PlayerMatch {
  itemId: string;
  albumId: string | null;
  container: string | null;
  path: string | null;
  score: number;
}

export interface PlayerStatus {
  configured: boolean;
  state: 'unconfigured' | 'ready' | 'archive-offline' | 'jellyfin-offline';
  sourceOnline: boolean | null;
  wakeAvailable: boolean;
  audioItems: number;
  indexedAt: string | null;
  detail: string;
}

const INDEX_TTL_MS = 5 * 60 * 1000;
// The upgrade worker writes paths as it sees them (/data/library/music/...);
// Jellyfin serves the same files from its own bind (/eliot-media/music/...).
export const LOCAL_LIBRARY_PREFIX = process.env.LOCAL_LIBRARY_PREFIX ?? '/data/library/music';
const JELLYFIN_LIBRARY_PREFIX = process.env.JELLYFIN_LIBRARY_PREFIX ?? '/eliot-media/music';

export function normalizeMusicText(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(feat|featuring|ft)\.?\s+.*$/i, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function names(value: string | null | undefined): string[] {
  return (value ?? '').split(/,| & | feat\.? | ft\.? /i).map(normalizeMusicText).filter(Boolean);
}

// Until Jellyfin's tag probe reaches a file (hours, on a big scan over NFS)
// the item's Name is just the Lidarr filename — "Artist - Album - NN - Title"
// — with no artist or album fields. Parse those out so a freshly scanned
// library is matchable immediately. A mis-parse fails safe: the score
// threshold still demands exact agreement with the Spotify record, so a
// wrongly split name can only miss, never play the wrong song. Real tags
// win as soon as they exist.
export function deriveFromFilename(item: JellyfinAudioItem): JellyfinAudioItem {
  if (item.Artists?.length || item.AlbumArtists?.length || item.Album) return item;
  const parts = (item.Name ?? '').split(' - ');
  if (parts.length < 4) return item;
  let numberIndex = -1;
  for (let i = parts.length - 2; i >= 2; i -= 1) {
    if (/^\d{1,3}$/.test(parts[i].trim())) {
      numberIndex = i;
      break;
    }
  }
  if (numberIndex < 0) return item;
  const number = Number(parts[numberIndex]);
  return {
    ...item,
    Name: parts.slice(numberIndex + 1).join(' - '),
    Album: parts.slice(1, numberIndex).join(' - '),
    Artists: [parts[0]],
    // Lidarr writes multi-disc tracks as DNN (e.g. 204 = disc 2 track 4).
    IndexNumber: item.IndexNumber ?? (number > 99 ? number % 100 : number),
    ParentIndexNumber: item.ParentIndexNumber ?? (number > 99 ? Math.floor(number / 100) : undefined),
  };
}

export function scoreJellyfinMatch(track: TasteTrack, item: JellyfinAudioItem): number {
  if (normalizeMusicText(track.name) !== normalizeMusicText(item.Name)) return -1;

  let score = 4;
  const tasteArtists = names(track.artists);
  const jellyfinArtists = [
    ...(item.Artists ?? []),
    ...(item.AlbumArtists ?? []).map((artist) => artist?.Name ?? ''),
  ].map((name) => normalizeMusicText(name));
  if (tasteArtists.some((artist) => jellyfinArtists.includes(artist))) score += 3;
  if (normalizeMusicText(track.album) && normalizeMusicText(track.album) === normalizeMusicText(item.Album)) score += 3;

  if (track.duration_ms && item.RunTimeTicks) {
    const delta = Math.abs(track.duration_ms - item.RunTimeTicks / 10_000);
    if (delta <= 3_000) score += 2;
    else if (delta <= 8_000) score += 1;
  }
  if (track.track_number && track.track_number === item.IndexNumber) score += 1;
  if (track.disc_number && track.disc_number === item.ParentIndexNumber) score += 1;
  return score;
}

function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (online: boolean) => {
      socket.destroy();
      resolve(online);
    };
    socket.setTimeout(1_500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export class JellyfinBridge {
  private readonly baseUrl = (process.env.JELLYFIN_URL ?? '').replace(/\/$/, '');
  private readonly keyFile = process.env.JELLYFIN_API_KEY_FILE ?? '';
  private readonly inlineKey = process.env.JELLYFIN_API_KEY ?? '';
  private readonly userId = process.env.JELLYFIN_USER_ID ?? '';
  private readonly sourceHost = process.env.MUSIC_SOURCE_HOST ?? '';
  private readonly sourcePort = Number(process.env.MUSIC_SOURCE_PORT ?? 2049);
  private readonly wakeUrl = process.env.ELIOT_WAKE_URL ?? '';
  private byName = new Map<string, JellyfinAudioItem[]>();
  private byPath = new Map<string, JellyfinAudioItem>();
  private relPaths: Set<string> | null = null;
  private relPathsAt = 0;
  private itemCount = 0;
  private indexedAt = 0;
  // Set when a Jellyfin scan is asked for, so the next lookup rebuilds in the
  // background instead of throwing away an index it can still answer from.
  private stale = false;
  private refreshPromise: Promise<void> | null = null;

  private token(): string {
    if (this.inlineKey) return this.inlineKey.trim();
    if (!this.keyFile) return '';
    try {
      return readFileSync(this.keyFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  configured(): boolean {
    return Boolean(this.baseUrl && this.token());
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    const token = this.token();
    if (!this.baseUrl || !token) throw new Error('Jellyfin playback is not configured');
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(12_000),
      headers: { 'X-Emby-Token': token, ...init.headers },
    });
    if (!response.ok) throw new Error(`Jellyfin returned ${response.status}`);
    return response;
  }

  async sourceOnline(): Promise<boolean | null> {
    if (!this.sourceHost) return null;
    return probe(this.sourceHost, this.sourcePort);
  }

  /**
   * Bring the index up to date - without ever making playback wait for it.
   *
   * Rebuilding means asking Jellyfin for all ~9,500 audio items with their
   * metadata, and on the Pi that takes about SEVENTEEN SECONDS. This used to
   * sit directly in front of playback: match() and matchPath() await it, and
   * it rebuilds once the index passes five minutes old, so the first track
   * played after any five-minute gap stalled for seventeen seconds before a
   * byte of audio moved. Picking a random song or a new album - exactly when
   * you have not played anything for a while - hit it almost every time.
   *
   * A stale index is still a good index: the library gains a track now and
   * then, it does not reshuffle. So the rebuild now runs behind whatever we
   * already hold, and only a caller with nothing at all to answer from waits.
   */
  async refresh(force = false): Promise<void> {
    if (!this.configured()) throw new Error('Jellyfin playback is not configured');
    const usable = this.indexedAt && !this.stale && Date.now() - this.indexedAt < INDEX_TTL_MS;
    if (!force && usable) return;
    if (!this.refreshPromise) {
      this.refreshPromise = this.rebuild().finally(() => { this.refreshPromise = null; });
    }
    // Cold, or the caller insists on current data: this one has to wait.
    if (force || !this.indexedAt) return this.refreshPromise;
    // Otherwise answer from what we have. The catch marks the promise handled
    // so a background failure cannot take the process down; the index we are
    // still serving is the fallback.
    this.refreshPromise.catch(() => { /* keep serving the index we have */ });
  }

  private async rebuild(): Promise<void> {
    const params = new URLSearchParams({
      recursive: 'true',
      includeItemTypes: 'Audio',
      fields: 'Album,AlbumArtists,AlbumId,Artists,RunTimeTicks,IndexNumber,ParentIndexNumber,Container,Path',
      enableTotalRecordCount: 'true',
      limit: '100000',
    });
    if (this.userId) params.set('userId', this.userId);
    // The full audio dump takes well over the default 12 s while a
    // library scan has the Pi busy; a cold container must still manage
    // to build its first index.
    const response = await this.request(`/Items?${params}`, { signal: AbortSignal.timeout(90_000) });
    const data = await response.json() as JellyfinItemsResponse;
    const next = new Map<string, JellyfinAudioItem[]>();
    const nextPaths = new Map<string, JellyfinAudioItem>();
    for (const raw of data.Items ?? []) {
      if (!raw.Id || !raw.Name) continue;
      if (raw.Path) nextPaths.set(raw.Path.replace(/\\/g, '/'), raw);
      const item = deriveFromFilename(raw);
      const key = normalizeMusicText(item.Name);
      const bucket = next.get(key) ?? [];
      bucket.push(item);
      next.set(key, bucket);
    }
    this.byName = next;
    this.byPath = nextPaths;
    this.itemCount = data.TotalRecordCount ?? data.Items?.length ?? 0;
    this.indexedAt = Date.now();
    this.stale = false;
  }

  /**
   * Everything the index can actually play, as paths relative to the library
   * root: each audio file, and every directory above it.
   *
   * This exists so the Latest feed can tell "on disk" apart from "playable".
   * The provenance scanner reads the disk directly and badges a file within
   * minutes of it landing; Jellyfin only serves what its own library scan has
   * ingested. Between those two moments a card looks finished but play fails,
   * which is the lie this lookup lets the UI stop telling.
   *
   * Returns null while no index is loaded - "unknown" must not be presented
   * as "not playable".
   */
  indexedRelPaths(): Set<string> | null {
    if (!this.indexedAt) return null;
    if (this.relPathsAt === this.indexedAt && this.relPaths) return this.relPaths;
    const rels = new Set<string>();
    for (const full of this.byPath.keys()) {
      for (const prefix of [JELLYFIN_LIBRARY_PREFIX, LOCAL_LIBRARY_PREFIX]) {
        if (!full.startsWith(prefix + '/')) continue;
        let rel = full.slice(prefix.length + 1);
        rels.add(rel);
        // Every ancestor directory too, so an album folder answers directly.
        while (rel.includes('/')) {
          rel = rel.slice(0, rel.lastIndexOf('/'));
          rels.add(rel);
        }
      }
    }
    this.relPaths = rels;
    this.relPathsAt = this.indexedAt;
    return rels;
  }

  matchLoaded(track: TasteTrack): PlayerMatch | null {
    const candidates = this.byName.get(normalizeMusicText(track.name)) ?? [];
    const ranked = candidates
      .map((item) => ({ item, score: scoreJellyfinMatch(track, item) }))
      .filter((candidate) => candidate.score >= 8)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    if (ranked[1] && ranked[0].score === ranked[1].score && ranked[0].score < 10) return null;
    return {
      itemId: ranked[0].item.Id,
      albumId: ranked[0].item.AlbumId ?? null,
      container: ranked[0].item.Container ?? null,
      path: ranked[0].item.Path ?? null,
      score: ranked[0].score,
    };
  }

  // Locally imported files (YouTube intake) have no Spotify identity, and
  // Jellyfin may not have probed their tags yet, so title/artist matching is
  // useless for them. We know exactly where the worker installed each one,
  // so resolve by path: exact, and it can never pick the wrong recording.
  matchPathLoaded(workerPath: string): PlayerMatch | null {
    const normalized = String(workerPath ?? '').replace(/\\/g, '/');
    if (!normalized) return null;
    const candidates = [normalized];
    if (normalized.startsWith(LOCAL_LIBRARY_PREFIX)) {
      candidates.push(JELLYFIN_LIBRARY_PREFIX + normalized.slice(LOCAL_LIBRARY_PREFIX.length));
    }
    for (const candidate of candidates) {
      const item = this.byPath.get(candidate);
      if (item) return { itemId: item.Id, albumId: item.AlbumId ?? null, container: item.Container ?? null, path: item.Path ?? null, score: 100 };
    }
    return null;
  }

  /**
   * A hit against a stale index is a hit; a MISS might only mean the file
   * landed after that index was built. So a miss - and only a miss - waits
   * for the rebuild already running rather than calling a track we do have
   * missing. Playing something the library holds never pays for this.
   */
  private async settled<T>(found: T | null, again: () => T | null): Promise<T | null> {
    if (found || !this.refreshPromise) return found;
    try {
      await this.refreshPromise;
    } catch {
      return null;                   // the rebuild failed; the miss stands
    }
    return again();
  }

  async matchPath(workerPath: string): Promise<PlayerMatch | null> {
    try {
      await this.refresh();
    } catch (err) {
      if (!this.indexedAt) throw err;
    }
    return this.settled(this.matchPathLoaded(workerPath), () => this.matchPathLoaded(workerPath));
  }

  async match(track: TasteTrack): Promise<PlayerMatch | null> {
    try {
      await this.refresh();
    } catch (err) {
      if (!this.indexedAt) throw err;
    }
    return this.settled(this.matchLoaded(track), () => this.matchLoaded(track));
  }

  async status(force = false): Promise<PlayerStatus> {
    if (!this.configured()) {
      return {
        configured: false,
        state: 'unconfigured',
        sourceOnline: null,
        wakeAvailable: Boolean(this.wakeUrl),
        audioItems: 0,
        indexedAt: null,
        detail: 'Connect Jellyfin to enable local playback',
      };
    }

    const sourceOnline = await this.sourceOnline();
    if (sourceOnline === false) {
      return {
        configured: true,
        state: 'archive-offline',
        sourceOnline,
        wakeAvailable: Boolean(this.wakeUrl),
        audioItems: this.itemCount,
        indexedAt: this.indexedAt ? new Date(this.indexedAt).toISOString() : null,
        detail: 'The music archive is asleep',
      };
    }

    try {
      await this.refresh(force);
      return {
        configured: true,
        state: 'ready',
        sourceOnline,
        wakeAvailable: Boolean(this.wakeUrl),
        audioItems: this.itemCount,
        indexedAt: new Date(this.indexedAt).toISOString(),
        detail: `${this.itemCount.toLocaleString()} local tracks ready`,
      };
    } catch (err) {
      return {
        configured: true,
        state: 'jellyfin-offline',
        sourceOnline,
        wakeAvailable: Boolean(this.wakeUrl),
        audioItems: this.itemCount,
        indexedAt: this.indexedAt ? new Date(this.indexedAt).toISOString() : null,
        detail: (err as Error).message,
      };
    }
  }

  // Jellyfin merges .lrc sidecars and embedded lyric tags behind one
  // endpoint; Start is in 100ns ticks and absent on unsynchronized lines.
  async lyrics(itemId: string): Promise<{ synced: { time: number; text: string }[] | null; plain: string | null } | null> {
    let response: Response;
    try {
      response = await this.request(`/Audio/${encodeURIComponent(itemId)}/Lyrics`);
    } catch {
      return null;
    }
    const data = await response.json() as { Lyrics?: { Text?: string; Start?: number }[] };
    const lines = data.Lyrics ?? [];
    const timed = lines.filter((line) => typeof line.Start === 'number');
    if (timed.length > 1) {
      return {
        synced: timed.map((line) => {
          const { text, words } = splitWordTags((line.Text ?? '').trim());
          return { time: (line.Start as number) / 10_000_000, text, ...(words ? { words } : {}) };
        }),
        plain: null,
      };
    }
    const plain = lines.map((line) => line.Text ?? '').join('\n').trim();
    return plain ? { synced: null, plain } : null;
  }

  // Album art for locally imported music: Jellyfin extracts embedded art
  // (or a cover.jpg beside the files), so it is the one place that already
  // has an image for a track with no Spotify identity.
  async image(itemId: string): Promise<Response> {
    return this.request(`/Items/${encodeURIComponent(itemId)}/Images/Primary?maxWidth=600`);
  }

  async stream(itemId: string, range?: string, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {};
    if (range) headers.Range = range;
    // Time-limit only the wait for response headers. A plain
    // AbortSignal.timeout also cancels the response BODY, which cut every
    // stream dead 30 seconds in while the browser was still pulling audio.
    // After headers arrive the body streams for as long as the caller's
    // signal (the browser connection) stays open.
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(new Error('Jellyfin took too long to start the stream')), 15_000);
    signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      return await this.request(`/Audio/${encodeURIComponent(itemId)}/stream?static=true`, { headers, signal: controller.signal });
    } finally {
      clearTimeout(connectTimer);
    }
  }

  async refreshLibrary(): Promise<void> {
    await this.request('/Library/Refresh', { method: 'POST' });
    // Mark it, do not throw it away. Clearing indexedAt here meant the next
    // play rebuilt from cold - seventeen seconds - and it did that while the
    // scan we just asked for had Jellyfin at its busiest. Everything the old
    // index knew about is still exactly where it was.
    this.stale = true;
  }

  async wake(): Promise<void> {
    if (!this.wakeUrl) throw new Error('Wake-on-play is not configured');
    const response = await fetch(this.wakeUrl, { method: 'POST', signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Wake service returned ${response.status}`);
  }
}
