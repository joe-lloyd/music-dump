import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TasteTrack } from './jellyfin.ts';

export const voyage35 = ['Even Less', 'Waiting (Phase One)', 'And the Swallows Dance Above the Sun', 'Signify', 'Up the Downstair', 'Dark Matter', 'The Nostalgia Factory', 'Hatesong', 'The Sky Moves Sideways (Phase One)', 'Fadeaway', 'Shesmovedon', 'Voyage 34', 'Radioactive Toy'];
export class PlaylistStore {
  db: DatabaseSync;
  constructor(file = process.env.PLAYLISTS_DB ?? path.join(import.meta.dirname, '..', 'data', 'playlists.db')) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS local_playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, tracks TEXT NOT NULL, removed_at TEXT);
      CREATE TABLE IF NOT EXISTS playlist_seeds (id TEXT PRIMARY KEY);`);
    if (!this.db.prepare('SELECT id FROM playlist_seeds WHERE id = ?').get('voyage35')) {
      this.db.exec('BEGIN');
      try {
        this.save(null, 'Voyage 35', 'Porcupine Tree setlist. Encore: Radioactive Toy.', voyage35.map((name) => ({
          id: `setlist:${randomUUID()}`, name, artists: 'Porcupine Tree', album: null, album_id: null,
          duration_ms: null, disc_number: null, track_number: null, image_url: null,
        })));
        this.db.prepare('INSERT INTO playlist_seeds VALUES (?)').run('voyage35');
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }
  list() {
    return this.db.prepare('SELECT * FROM local_playlists WHERE removed_at IS NULL ORDER BY name').all().map(row => ({
      id: String(row.id), name: String(row.name), description: String(row.description), source: 'local',
      owner_name: 'You', synced_tracks: JSON.parse(String(row.tracks)).length, images: [],
    }));
  }
  tracks(id: string): TasteTrack[] {
    const row = this.db.prepare('SELECT tracks FROM local_playlists WHERE id = ? AND removed_at IS NULL').get(id);
    if (!row) throw new Error('local playlist not found');
    return JSON.parse(String(row.tracks));
  }
  track(id: string): TasteTrack | null {
    for (const playlist of this.list()) {
      const track = this.tracks(playlist.id).find(t => t.id === id);
      if (track) return track;
    }
    return null;
  }
  save(id: string | null, name: string, description: string, tracks: TasteTrack[]) {
    const key = id ?? `local-playlist:${randomUUID()}`;
    if (id) this.tracks(id);
    this.db.prepare(`INSERT INTO local_playlists VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, tracks=excluded.tracks`).run(key, name, description, JSON.stringify(tracks));
    return key;
  }
  remove(id: string) {
    this.tracks(id);
    this.db.prepare('UPDATE local_playlists SET removed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }
  close() { this.db.close(); }
}
