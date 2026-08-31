import net from 'node:net';
import { readFileSync } from 'node:fs';

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
}

interface JellyfinItemsResponse {
  Items?: JellyfinAudioItem[];
  TotalRecordCount?: number;
}

export interface PlayerMatch {
  itemId: string;
  container: string | null;
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
  private itemCount = 0;
  private indexedAt = 0;
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

  async refresh(force = false): Promise<void> {
    if (!this.configured()) throw new Error('Jellyfin playback is not configured');
    if (!force && this.indexedAt && Date.now() - this.indexedAt < INDEX_TTL_MS) return;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      const params = new URLSearchParams({
        recursive: 'true',
        includeItemTypes: 'Audio',
        fields: 'Album,AlbumArtists,Artists,RunTimeTicks,IndexNumber,ParentIndexNumber,Container',
        enableTotalRecordCount: 'true',
        limit: '100000',
      });
      if (this.userId) params.set('userId', this.userId);
      const response = await this.request(`/Items?${params}`);
      const data = await response.json() as JellyfinItemsResponse;
      const next = new Map<string, JellyfinAudioItem[]>();
      for (const item of data.Items ?? []) {
        if (!item.Id || !item.Name) continue;
        const key = normalizeMusicText(item.Name);
        const bucket = next.get(key) ?? [];
        bucket.push(item);
        next.set(key, bucket);
      }
      this.byName = next;
      this.itemCount = data.TotalRecordCount ?? data.Items?.length ?? 0;
      this.indexedAt = Date.now();
    })().finally(() => { this.refreshPromise = null; });

    return this.refreshPromise;
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
      container: ranked[0].item.Container ?? null,
      score: ranked[0].score,
    };
  }

  async match(track: TasteTrack): Promise<PlayerMatch | null> {
    try {
      await this.refresh();
    } catch (err) {
      if (!this.indexedAt) throw err;
    }
    return this.matchLoaded(track);
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
      return { synced: timed.map((line) => ({ time: (line.Start as number) / 10_000_000, text: (line.Text ?? '').trim() })), plain: null };
    }
    const plain = lines.map((line) => line.Text ?? '').join('\n').trim();
    return plain ? { synced: null, plain } : null;
  }

  async stream(itemId: string, range?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (range) headers.Range = range;
    return this.request(`/Audio/${encodeURIComponent(itemId)}/stream?static=true`, { headers, signal: AbortSignal.timeout(30_000) });
  }

  async wake(): Promise<void> {
    if (!this.wakeUrl) throw new Error('Wake-on-play is not configured');
    const response = await fetch(this.wakeUrl, { method: 'POST', signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Wake service returned ${response.status}`);
  }
}
