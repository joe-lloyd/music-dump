import path from 'node:path';
import { initAuth } from './auth.ts';

try {
  process.loadEnvFile(path.join(import.meta.dirname, '..', '.env'));
} catch {
  // no .env — rely on the environment
}
import { get, paginate, type Page } from './api.ts';
import { TasteDb, type ApiAlbum, type ApiArtist, type ApiTrack } from './db.ts';

const DB_FILE = process.env.SPOTIFY_DB ?? path.join(import.meta.dirname, '..', 'data', 'spotify.db');
const TIME_RANGES = ['short_term', 'medium_term', 'long_term'] as const;

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
  track: ApiTrack | null;
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
      let position = 0;
      for await (const trackPage of paginate<PlaylistTrackItem>(`/playlists/${pl.id}/tracks`)) {
        db.transaction(() => {
          for (const item of trackPage.items) {
            position++;
            const track = item.track;
            if (!track?.id || track.type === 'episode' || track.is_local) {
              skipped++;
              continue;
            }
            db.upsertTrack(track);
            db.run(
              `INSERT OR REPLACE INTO playlist_tracks (playlist_id, track_id, position, added_at, added_by)
               VALUES (?, ?, ?, ?, ?)`,
              pl.id, track.id, position, item.added_at, item.added_by?.id,
            );
            tracks++;
          }
        });
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
// and label — fetch the full objects in batches to fill those in.
async function hydrate(db: TasteDb): Promise<void> {
  const artistIds = (db.db.prepare('SELECT id FROM artists WHERE genres IS NULL').all() as { id: string }[]).map((r) => r.id);
  console.log(`Hydrating ${artistIds.length} artists (genres, followers)...`);
  for (let i = 0; i < artistIds.length; i += 50) {
    const batch = artistIds.slice(i, i + 50);
    const body = await get<{ artists: (ApiArtist | null)[] }>('/artists', { ids: batch.join(',') });
    db.transaction(() => {
      for (const artist of body.artists) {
        if (!artist?.id) continue;
        db.upsertArtist({ ...artist, genres: artist.genres ?? [] });
      }
    });
    console.log(`  ${Math.min(i + 50, artistIds.length)}/${artistIds.length}`);
  }

  const albumIds = (db.db.prepare('SELECT id FROM albums WHERE label IS NULL').all() as { id: string }[]).map((r) => r.id);
  console.log(`Hydrating ${albumIds.length} albums (label, popularity)...`);
  for (let i = 0; i < albumIds.length; i += 20) {
    const batch = albumIds.slice(i, i + 20);
    const body = await get<{ albums: (ApiAlbum | null)[] }>('/albums', { ids: batch.join(',') });
    db.transaction(() => {
      for (const album of body.albums) {
        if (!album?.id) continue;
        // '' instead of NULL for label-less albums, so they aren't refetched every run.
        db.upsertAlbum({ ...album, label: album.label ?? '' });
      }
    });
    console.log(`  ${Math.min(i + 20, albumIds.length)}/${albumIds.length}`);
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
