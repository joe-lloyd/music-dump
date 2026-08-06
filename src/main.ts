import path from 'node:path';
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

interface SavedTrackItem { added_at: string; track: ApiTrack }
interface SavedAlbumItem { added_at: string; album: ApiAlbum & { tracks?: Page<ApiTrack> } }
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
      let trackPage: Page<ApiTrack> | undefined = item.album.tracks;
      while (trackPage) {
        const tracks = trackPage.items ?? [];
        db.transaction(() => {
          for (const track of tracks) db.upsertTrack(track, item.album.id);
        });
        trackPage = trackPage.next ? await get<Page<ApiTrack>>(trackPage.next) : undefined;
      }
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

  const albumIds = (db.db.prepare('SELECT id FROM albums WHERE label IS NULL').all() as { id: string }[]).map((r) => r.id);
  console.log(`Hydrating ${albumIds.length} albums (label, popularity)...`);
  for (const [i, id] of albumIds.entries()) {
    try {
      const album = await get<ApiAlbum>(`/albums/${id}`);
      // '' instead of NULL for label-less albums, so they aren't refetched every run.
      db.upsertAlbum({ ...album, label: album.label ?? '' });
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 403 || err.status === 404))) throw err;
      db.run(`UPDATE albums SET label = '' WHERE id = ?`, id); // unreachable — don't refetch
    }
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${albumIds.length}`);
    await sleep(250);
  }
}

async function main(): Promise<void> {
  await initAuth();
  const db = new TasteDb(DB_FILE);
  const startedAt = new Date().toISOString();
  const runId = db.run('INSERT INTO sync_runs (started_at) VALUES (?)', startedAt).lastInsertRowid;

  const me = await get<{ id: string; display_name?: string }>('/me');
  console.log(`Exporting library of ${me.display_name ?? me.id} → ${DB_FILE}\n`);

  const liked = await syncLikedTracks(db);
  const albums = await syncSavedAlbums(db);
  const followed = await syncFollowedArtists(db);
  const pl = await syncPlaylists(db);
  await syncTops(db);
  const plays = await syncRecentlyPlayed(db);
  await hydrate(db);

  const summary = {
    liked_tracks: liked,
    saved_albums: albums,
    followed_artists: followed,
    playlists: pl.playlists,
    playlist_tracks: pl.tracks,
    playlist_items_skipped: pl.skipped,
    new_plays: plays,
    total_tracks: db.count('tracks'),
    total_artists: db.count('artists'),
    total_albums: db.count('albums'),
  };
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
