import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { initAuth } from './auth.ts';

try {
  process.loadEnvFile(path.join(import.meta.dirname, '..', '.env'));
} catch {
  // no .env — rely on the environment
}
import { ApiError, get, paginate, type Page } from './api.ts';
import { TasteDb, type ApiAlbum, type ApiArtist, type ApiTrack } from './db.ts';

const DB_FILE = process.env.SPOTIFY_DB ?? path.join(import.meta.dirname, '..', 'data', 'spotify.db');
const TIME_RANGES = ['short_term', 'medium_term', 'long_term'] as const;
// Spotify pages the top-items ranking thousands deep; past a few hundred it is
// noise and crawl time. 0 = unlimited.
const TOP_LIMIT = Number(process.env.SPOTIFY_TOP_LIMIT ?? 500);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const IMG_DIR = path.join(path.dirname(DB_FILE), 'images');

interface SavedTrackItem { added_at: string; track: ApiTrack }
interface SavedAlbumItem { added_at: string; album: ApiAlbum }
interface PlaylistItem {
  id: string;
  name: string;
  description?: string;
  owner?: { id?: string; display_name?: string };
  public?: boolean;
  collaborative?: boolean;
  snapshot_id?: string;
  tracks?: { total?: number };
}
interface PlaylistTrackItem {
  added_at?: string;
  added_by?: { id?: string };
  is_local?: boolean;
  track?: ApiTrack | null; // legacy shape
  item?: ApiTrack | null; // dev-mode shape since 2026
}
interface PlayItem {
  played_at: string;
  track: ApiTrack;
  context?: { type?: string; uri?: string } | null;
}

async function syncLikedTracks(db: TasteDb): Promise<number> {
  console.log('Liked songs...');
  db.run('DELETE FROM liked_tracks');
  let count = 0;
  for await (const page of paginate<SavedTrackItem>('/me/tracks')) {
    db.transaction(() => {
      for (const item of page.items) {
        if (!item.track?.id) continue;
        db.upsertTrack(item.track);
        db.run('INSERT OR REPLACE INTO liked_tracks (track_id, added_at) VALUES (?, ?)', item.track.id, item.added_at);
        count++;
      }
    });
    console.log(`  ${count}/${page.total ?? '?'}`);
  }
  return count;
}

async function syncSavedAlbums(db: TasteDb): Promise<number> {
  console.log('Saved albums...');
  db.run('UPDATE albums SET is_saved = 0, saved_at = NULL');
  let count = 0;
  for await (const page of paginate<SavedAlbumItem>('/me/albums')) {
    for (const item of page.items) {
      if (!item.album?.id) continue;
      db.transaction(() => db.upsertAlbum(item.album, { savedAt: item.added_at }));
      // Album track listings are embedded (first 50) and paginate beyond that.
      let trackPage: { items?: ApiTrack[]; next?: string | null } | undefined = item.album.tracks;
      while (trackPage) {
        const tracks = trackPage.items ?? [];
        db.transaction(() => {
          for (const track of tracks) db.upsertTrack(track, item.album.id);
        });
        trackPage = trackPage.next ? await get<Page<ApiTrack>>(trackPage.next) : undefined;
      }
      db.run('UPDATE albums SET tracks_synced = 1 WHERE id = ?', item.album.id);
      count++;
    }
    console.log(`  ${count}/${page.total ?? '?'}`);
  }
  return count;
}

async function syncFollowedArtists(db: TasteDb): Promise<number> {
  console.log('Followed artists...');
  db.run('UPDATE artists SET is_followed = 0');
  let count = 0;
  const unwrap = (body: unknown) => (body as { artists: Page<ApiArtist> }).artists;
  for await (const page of paginate<ApiArtist>('/me/following', { type: 'artist' }, unwrap)) {
    db.transaction(() => {
      for (const artist of page.items) {
        if (!artist.id) continue;
        db.upsertArtist(artist, { followed: true });
        count++;
      }
    });
    console.log(`  ${count}/${page.total ?? '?'}`);
  }
  return count;
}

async function syncPlaylists(db: TasteDb): Promise<{ playlists: number; tracks: number; skipped: number }> {
  console.log('Playlists...');
  let playlists = 0;
  let tracks = 0;
  let skipped = 0; // episodes, local files, removed tracks
  for await (const page of paginate<PlaylistItem>('/me/playlists')) {
    for (const pl of page.items) {
      if (!pl?.id) continue;
      db.run(
        `INSERT OR REPLACE INTO playlists
           (id, name, description, owner_id, owner_name, is_public, is_collaborative, snapshot_id, total_tracks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        pl.id, pl.name, pl.description, pl.owner?.id, pl.owner?.display_name,
        pl.public, pl.collaborative, pl.snapshot_id, pl.tracks?.total,
      );
      db.run('DELETE FROM playlist_tracks WHERE playlist_id = ?', pl.id);
      // Dev-mode apps get 403 on /playlists/{id}/tracks, but the playlist
      // detail endpoint embeds the track pages: under `items` (new shape,
      // entries carry `item`) or `tracks` (legacy shape, entries carry `track`).
      const detail = await get<{ items?: Page<PlaylistTrackItem>; tracks?: Page<PlaylistTrackItem> }>(`/playlists/${pl.id}`);
      let trackPage: Page<PlaylistTrackItem> | undefined = detail.items ?? detail.tracks;
      db.run('UPDATE playlists SET total_tracks = ? WHERE id = ?', trackPage?.total ?? null, pl.id);
      let position = 0;
      while (trackPage) {
        const entries = trackPage.items ?? [];
        db.transaction(() => {
          for (const entry of entries) {
            position++;
            const track = entry.item ?? entry.track;
            if (!track?.id || track.type === 'episode' || track.episode || track.is_local || entry.is_local) {
              skipped++;
              continue;
            }
            db.upsertTrack(track);
            db.run(
              `INSERT OR REPLACE INTO playlist_tracks (playlist_id, track_id, position, added_at, added_by)
               VALUES (?, ?, ?, ?, ?)`,
              pl.id, track.id, position, entry.added_at, entry.added_by?.id,
            );
            tracks++;
          }
        });
        if (!trackPage.next) break;
        try {
          trackPage = await get<Page<PlaylistTrackItem>>(trackPage.next);
        } catch (err) {
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            console.log(`  "${pl.name}": pagination blocked (${err.status}), truncated at ${position} of ${detail.items?.total ?? '?'} items`);
            break;
          }
          throw err;
        }
      }
      playlists++;
      console.log(`  ${playlists}/${page.total ?? '?'}: ${pl.name} (${position} items)`);
    }
  }
  return { playlists, tracks, skipped };
}

async function syncTops(db: TasteDb): Promise<void> {
  for (const range of TIME_RANGES) {
    console.log(`Top artists/tracks (${range})...`);
    db.run('DELETE FROM top_artists WHERE time_range = ?', range);
    let rank = 0;
    for await (const page of paginate<ApiArtist>('/me/top/artists', { time_range: range })) {
      db.transaction(() => {
        for (const artist of page.items) {
          if (!artist.id) continue;
          db.upsertArtist(artist);
          db.run('INSERT OR REPLACE INTO top_artists (time_range, rank, artist_id) VALUES (?, ?, ?)', range, ++rank, artist.id);
        }
      });
      if (TOP_LIMIT && rank >= TOP_LIMIT) break;
    }
    db.run('DELETE FROM top_tracks WHERE time_range = ?', range);
    rank = 0;
    for await (const page of paginate<ApiTrack>('/me/top/tracks', { time_range: range })) {
      db.transaction(() => {
        for (const track of page.items) {
          if (!track.id) continue;
          db.upsertTrack(track);
          db.run('INSERT OR REPLACE INTO top_tracks (time_range, rank, track_id) VALUES (?, ?, ?)', range, ++rank, track.id);
        }
      });
      if (TOP_LIMIT && rank >= TOP_LIMIT) break;
    }
  }
}

async function syncRecentlyPlayed(db: TasteDb): Promise<number> {
  console.log('Recently played...');
  const body = await get<{ items: PlayItem[] }>('/me/player/recently-played', { limit: '50' });
  let added = 0;
  db.transaction(() => {
    for (const item of body.items ?? []) {
      if (!item.track?.id) continue;
      db.upsertTrack(item.track);
      const res = db.run(
        'INSERT OR IGNORE INTO plays (played_at, track_id, context_type, context_uri) VALUES (?, ?, ?, ?)',
        item.played_at, item.track.id, item.context?.type, item.context?.uri,
      );
      if (Number(res.changes) > 0) added++;
    }
  });
  console.log(`  ${added} new plays recorded`);
  return added;
}

// Simplified artist/album objects embedded in tracks lack genres, followers
// and label. Batch ?ids= endpoints return 403 for dev-mode apps, so fetch the
// full objects one at a time, throttled. NULL markers make this resumable —
// an interrupted run picks up where it left off.
async function hydrate(db: TasteDb): Promise<void> {
  const artistIds = (db.db.prepare('SELECT id FROM artists WHERE genres IS NULL').all() as { id: string }[]).map((r) => r.id);
  console.log(`Hydrating ${artistIds.length} artists (genres, followers)...`);
  for (const [i, id] of artistIds.entries()) {
    try {
      const artist = await get<ApiArtist>(`/artists/${id}`);
      db.upsertArtist({ ...artist, genres: artist.genres ?? [] });
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 403 || err.status === 404))) throw err;
      db.run(`UPDATE artists SET genres = '[]' WHERE id = ?`, id); // unreachable — don't refetch
    }
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${artistIds.length}`);
    await sleep(250);
  }

  // Saved and liked albums first; discography stubs fill the tail of the queue.
  const albumIds = (db.db.prepare(`
    SELECT id FROM albums WHERE label IS NULL OR tracks_synced = 0
    ORDER BY is_saved DESC, (SELECT COUNT(*) FROM tracks t JOIN liked_tracks lt ON lt.track_id = t.id
                              WHERE t.album_id = albums.id) DESC`).all() as { id: string }[]).map((r) => r.id);
  console.log(`Hydrating ${albumIds.length} albums (label, popularity, track listings)...`);
  for (const [i, id] of albumIds.entries()) {
    try {
      const album = await get<ApiAlbum>(`/albums/${id}`);
      db.transaction(() => {
        // '' instead of NULL for label-less albums, so they aren't refetched every run.
        db.upsertAlbum({ ...album, label: album.label ?? '' });
        for (const track of album.tracks?.items ?? []) db.upsertTrack(track, id);
      });
      let next = album.tracks?.next ?? null;
      while (next) {
        try {
          const page = await get<Page<ApiTrack>>(next);
          db.transaction(() => {
            for (const track of page.items ?? []) db.upsertTrack(track, id);
          });
          next = page.next;
        } catch (err) {
          if (!(err instanceof ApiError && (err.status === 403 || err.status === 404))) throw err;
          console.log(`  album ${id}: track pagination blocked (${err.status}), first page only`);
          break;
        }
      }
      db.run('UPDATE albums SET tracks_synced = 1 WHERE id = ?', id);
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 403 || err.status === 404))) throw err;
      db.run(`UPDATE albums SET label = '', tracks_synced = 1 WHERE id = ?`, id); // unreachable — don't refetch
    }
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${albumIds.length}`);
    await sleep(250);
  }
}

// Crawl each artist's full discography (albums, singles, compilations — not
// appears_on, which balloons into other people's compilations). Followed and
// popular artists first; the per-artist marker makes this resumable across
// quota-limited runs. Newly discovered albums enter the hydration queue,
// which fills in their track listings on this or later runs.
async function syncDiscographies(db: TasteDb): Promise<number> {
  const pending = db.db.prepare(`
    SELECT id, name FROM artists WHERE discog_synced_at IS NULL
    ORDER BY is_followed DESC, followers DESC`).all() as { id: string; name: string }[];
  console.log(`Discographies: ${pending.length} artists to crawl...`);
  let done = 0;
  for (const artist of pending) {
    try {
      for await (const page of paginate<ApiAlbum>(`/artists/${artist.id}/albums`, { include_groups: 'album,single,compilation' })) {
        db.transaction(() => {
          for (const album of page.items) {
            if (!album?.id) continue;
            db.upsertAlbum(album);
            db.run(
              'INSERT OR REPLACE INTO artist_albums (artist_id, album_id, album_group) VALUES (?, ?, ?)',
              artist.id, album.id, album.album_group,
            );
          }
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // ghost artist — mark done so it isn't retried forever
        db.run('UPDATE artists SET discog_synced_at = ? WHERE id = ?', new Date().toISOString(), artist.id);
        continue;
      }
      if (err instanceof ApiError && err.status === 403) {
        console.log(`  /artists/{id}/albums is blocked for this app (403) — skipping discography crawl`);
        return done;
      }
      throw err;
    }
    db.run('UPDATE artists SET discog_synced_at = ? WHERE id = ?', new Date().toISOString(), artist.id);
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${pending.length}`);
    await sleep(200);
  }
  return done;
}

// Cover art archival: image URLs die when content is pulled from Spotify, so
// keep the binaries. These come from the CDN, not the API host, and don't
// count against the daily quota — this stage runs even after a quota abort.
async function archiveImages(db: TasteDb): Promise<number> {
  const jobs = [
    ...(db.db.prepare('SELECT id, image_url FROM albums WHERE image_url IS NOT NULL').all() as { id: string; image_url: string }[])
      .map((r) => ({ url: r.image_url, file: path.join(IMG_DIR, 'albums', `${r.id}.jpg`) })),
    ...(db.db.prepare('SELECT id, image_url FROM artists WHERE image_url IS NOT NULL').all() as { id: string; image_url: string }[])
      .map((r) => ({ url: r.image_url, file: path.join(IMG_DIR, 'artists', `${r.id}.jpg`) })),
  ];
  mkdirSync(path.join(IMG_DIR, 'albums'), { recursive: true });
  mkdirSync(path.join(IMG_DIR, 'artists'), { recursive: true });
  let downloaded = 0;
  let failed = 0;
  for (const job of jobs) {
    if (existsSync(job.file)) continue;
    try {
      const res = await fetch(job.url);
      if (!res.ok) {
        failed++;
        continue;
      }
      writeFileSync(job.file, Buffer.from(await res.arrayBuffer()));
      downloaded++;
    } catch {
      failed++;
    }
    if (downloaded > 0 && downloaded % 200 === 0) console.log(`  ${downloaded} images...`);
    await sleep(60);
  }
  console.log(`  ${downloaded} new images archived${failed ? `, ${failed} failed` : ''} (${jobs.length} total known)`);
  return downloaded;
}

async function main(): Promise<void> {
  await initAuth();
  const db = new TasteDb(DB_FILE);
  const startedAt = new Date().toISOString();
  const runId = db.run('INSERT INTO sync_runs (started_at) VALUES (?)', startedAt).lastInsertRowid;

  const summary: Record<string, number | string> = {};
  try {
    const me = await get<{ id: string; display_name?: string }>('/me');
    console.log(`Exporting library of ${me.display_name ?? me.id} → ${DB_FILE}\n`);
    summary.liked_tracks = await syncLikedTracks(db);
    summary.saved_albums = await syncSavedAlbums(db);
    summary.followed_artists = await syncFollowedArtists(db);
    const pl = await syncPlaylists(db);
    summary.playlists = pl.playlists;
    summary.playlist_tracks = pl.tracks;
    summary.playlist_items_skipped = pl.skipped;
    await syncTops(db);
    summary.new_plays = await syncRecentlyPlayed(db);
    await hydrate(db);
    summary.discographies_crawled = await syncDiscographies(db);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 429)) throw err;
    // Daily quota gone — everything synced so far is committed and every
    // crawl stage resumes from its own markers on the next run.
    console.log(`\n${err.message} — API stages stopped for this run.`);
    summary.quota_exhausted = 1;
  }

  console.log('Archiving cover art (CDN, not quota-limited)...');
  summary.images_archived = await archiveImages(db);

  summary.total_tracks = db.count('tracks');
  summary.total_artists = db.count('artists');
  summary.total_albums = db.count('albums');
  db.run(
    'UPDATE sync_runs SET finished_at = ?, summary = ? WHERE id = ?',
    new Date().toISOString(), JSON.stringify(summary), runId,
  );

  console.log('\nDone.');
  for (const [key, value] of Object.entries(summary)) {
    console.log(`  ${key}: ${value}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
