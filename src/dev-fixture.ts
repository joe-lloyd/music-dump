// A small fictional library for local UI work. Never reads tokens or calls Spotify.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { TasteDb } from './db.ts';

const file = path.join(import.meta.dirname, '..', 'data', 'dev-fixture.db');
rmSync(file, { force: true });
const taste = new TasteDb(file);

const artists = [
  { id: 'ar01', name: 'Local Signals', genres: ['indietronica', 'dream pop'], popularity: 72, followers: { total: 183420 }, images: [] },
  { id: 'ar02', name: 'Mira Vale', genres: ['art pop', 'ambient pop'], popularity: 68, followers: { total: 88420 }, images: [] },
  { id: 'ar03', name: 'Glass Harbour', genres: ['post-rock', 'shoegaze'], popularity: 64, followers: { total: 149210 }, images: [] },
  { id: 'ar04', name: 'Low Orbit Club', genres: ['nu jazz', 'downtempo'], popularity: 57, followers: { total: 47650 }, images: [] },
  { id: 'ar05', name: 'Soft Focus', genres: ['indie soul', 'neo-psychedelic'], popularity: 61, followers: { total: 71290 }, images: [] },
  { id: 'ar06', name: 'Hana North', genres: ['singer-songwriter', 'folk pop'], popularity: 55, followers: { total: 34120 }, images: [] },
];

for (const artist of artists) {
  taste.upsertArtist(artist, { followed: artist.id !== 'ar06' });
  taste.run('UPDATE artists SET discog_synced_at = ? WHERE id = ?', '2026-08-31T04:13:00Z', artist.id);
  taste.run('INSERT INTO artist_mbid (artist_id, mbid, method, resolved_at) VALUES (?, ?, ?, ?)', artist.id, `00000000-0000-0000-0000-0000000000${artist.id.slice(-2)}`, 'name', '2026-08-30T04:00:00Z');
}

const albums = [
  { id: 'al01', name: 'Night Drive', artist: 'ar01', type: 'album', release: '2026-08-14', label: 'Static Bloom', saved: true, downloaded: 1, tracks: ['Streetlight Frequency', 'Half Awake', 'Signal in the Static', 'The Long Way Home'] },
  { id: 'al02', name: 'Afterimage', artist: 'ar02', type: 'album', release: '2026-07-04', label: 'Violet Hours', saved: true, downloaded: 1, tracks: ['Blue Room', 'Paper Moons', 'Afterimage', 'Still Life'] },
  { id: 'al03', name: 'Weather Systems', artist: 'ar03', type: 'album', release: '2025-11-21', label: 'Northline', saved: false, downloaded: 1, tracks: ['Pressure Drop', 'White Horizon', 'Rain Language', 'Clearing'] },
  { id: 'al04', name: 'Rooms Without Clocks', artist: 'ar04', type: 'album', release: '2024-05-17', label: 'Late Checkout', saved: true, downloaded: 1, tracks: ['Lobby at Midnight', 'Keycard', 'No Wake-Up Call', 'Checkout'] },
  { id: 'al05', name: 'Velvet Static', artist: 'ar05', type: 'album', release: '2023-09-08', label: 'Kindred', saved: true, downloaded: 0, tracks: ['Colour Theory', 'Slow Cinema', 'Velvet Static', 'Golden Hour'] },
  { id: 'al06', name: 'Small Constellations', artist: 'ar06', type: 'album', release: '2022-03-25', label: 'Field Notes', saved: false, downloaded: 0, tracks: ['Northbound', 'Names for the Stars', 'Kitchen Light', 'Morning Train'] },
  { id: 'al07', name: 'Nocturne / Rework', artist: 'ar01', type: 'single', release: '2026-08-28', label: 'Static Bloom', saved: false, downloaded: 1, tracks: ['Nocturne', 'Nocturne (Low Orbit Rework)'] },
  { id: 'al08', name: 'Live at the Glasshouse', artist: 'ar03', type: 'album', release: '2026-08-21', label: 'Northline', saved: false, downloaded: 0, tracks: ['White Horizon (Live)', 'Clearing (Live)', 'Weather Systems (Live)'] },
];

let likedIndex = 0;
for (const album of albums) {
  const artist = artists.find((candidate) => candidate.id === album.artist)!;
  taste.upsertAlbum({
    id: album.id,
    name: album.name,
    album_type: album.type,
    release_date: album.release,
    release_date_precision: 'day',
    total_tracks: album.tracks.length,
    label: album.label,
    popularity: 48 + album.tracks.length * 3,
    artists: [artist],
    images: [],
  }, album.saved ? { savedAt: `${album.release}T12:00:00Z` } : {});
  taste.run('UPDATE albums SET tracks_synced = 1 WHERE id = ?', album.id);
  taste.run('INSERT INTO artist_albums (artist_id, album_id, album_group) VALUES (?, ?, ?)', album.artist, album.id, album.type === 'single' ? 'single' : 'album');

  album.tracks.forEach((name, index) => {
    const id = `${album.id}t${index + 1}`;
    taste.upsertTrack({
      id,
      name,
      album: { id: album.id, name: album.name },
      artists: [artist],
      disc_number: 1,
      track_number: index + 1,
      duration_ms: 188_000 + index * 21_000 + Number(album.id.slice(-2)) * 1_700,
      explicit: false,
      popularity: 50 + index * 4,
    });
    if ((index + Number(album.id.slice(-2))) % 3 !== 0) {
      const month = String(((likedIndex * 2) % 12) + 1).padStart(2, '0');
      taste.run('INSERT INTO liked_tracks (track_id, added_at) VALUES (?, ?)', id, `2026-${month}-${String((likedIndex % 26) + 1).padStart(2, '0')}T20:00:00Z`);
      likedIndex += 1;
    }
  });
}

taste.db.exec(`
  CREATE TABLE lidarr_sync (
    id INTEGER PRIMARY KEY CHECK (id = 1), synced_at TEXT,
    downloaded_album_count INTEGER, artists_in_lidarr INTEGER,
    artists_matched INTEGER, tastedb_albums_checked INTEGER,
    tastedb_albums_downloaded INTEGER
  );
  CREATE TABLE album_download_status (
    album_id TEXT PRIMARY KEY, downloaded INTEGER, lidarr_title TEXT,
    match_score REAL, synced_at TEXT
  );
`);
taste.run('INSERT INTO lidarr_sync VALUES (1, ?, ?, ?, ?, ?, ?)', '2026-08-31T08:42:00Z', 146, 314, 309, albums.length, albums.filter((album) => album.downloaded).length);
for (const album of albums) {
  taste.run('INSERT INTO album_download_status VALUES (?, ?, ?, ?, ?)', album.id, album.downloaded, album.name, 1, '2026-08-31T08:42:00Z');
}

taste.run('INSERT INTO playlists (id, name, description, owner_name, total_tracks) VALUES (?, ?, ?, ?, ?)', 'pl01', 'Night bus', 'Songs for the last ride home', 'Joe', 8);
const playlistTracks = ['al01t1', 'al01t3', 'al02t2', 'al03t4', 'al04t1', 'al05t2', 'al06t3', 'al07t2'];
playlistTracks.forEach((id, index) => taste.run('INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)', 'pl01', id, index + 1, `2026-08-${String(index + 10).padStart(2, '0')}T21:00:00Z`));

artists.slice(0, 5).forEach((artist, index) => taste.run('INSERT INTO top_artists (time_range, rank, artist_id) VALUES (?, ?, ?)', 'medium_term', index + 1, artist.id));
playlistTracks.slice(0, 5).forEach((id, index) => taste.run('INSERT INTO top_tracks (time_range, rank, track_id) VALUES (?, ?, ?)', 'medium_term', index + 1, id));

for (let month = 1; month <= 12; month += 1) {
  for (let play = 0; play < 18 + month * 3; play += 1) {
    const id = playlistTracks[(month + play) % playlistTracks.length];
    const album = albums.find((candidate) => id.startsWith(candidate.id))!;
    const artist = artists.find((candidate) => candidate.id === album.artist)!;
    const trackName = album.tracks[Number(id.slice(-1)) - 1];
    taste.run(`INSERT INTO history_plays
      (ts, track_name, ms_played, track_id, artist_name, album_name, platform, country, skipped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `2025-${String(month).padStart(2, '0')}-${String((play % 26) + 1).padStart(2, '0')}T${String(play % 23).padStart(2, '0')}:12:00Z`,
    trackName, 190_000 + play * 500, id, artist.name, album.name, 'android', 'NL', 0);
  }
}

playlistTracks.slice(0, 6).forEach((id, index) => taste.run('INSERT INTO plays (played_at, track_id, context_type) VALUES (?, ?, ?)', `2026-08-31T0${index + 2}:15:00Z`, id, 'playlist'));
taste.run('INSERT INTO events (id, artist_id, name, datetime, venue, city, country, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'ev01', 'ar02', 'Mira Vale — Afterimage Tour', '2026-11-14T19:30:00Z', 'Paradiso', 'Amsterdam', 'NL', 'https://example.com/tickets', '2026-08-30T04:00:00Z', '2026-08-31T04:00:00Z');
taste.run('INSERT INTO sync_runs (started_at, finished_at, summary) VALUES (?, ?, ?)', '2026-08-31T04:00:00Z', '2026-08-31T04:13:00Z', '{}');

taste.db.close();
console.log(`fixture ready: ${file}`);

