import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** Local choices override the Spotify snapshot without changing its sync history. */
export class LikesStore {
  readonly db: DatabaseSync;
  constructor(file = process.env.LIKES_DB ?? path.join(import.meta.dirname, '..', 'data', 'likes.db')) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS app_likes (track_id TEXT PRIMARY KEY, liked INTEGER NOT NULL, added_at TEXT NOT NULL)');
  }
  set(id: string, liked: boolean) {
    this.db.prepare(`INSERT INTO app_likes VALUES (?, ?, ?) ON CONFLICT(track_id)
      DO UPDATE SET liked = excluded.liked, added_at = excluded.added_at`).run(id, Number(liked), new Date().toISOString());
  }
  choices() {
    return this.db.prepare('SELECT track_id, liked, added_at FROM app_likes').all() as { track_id: string; liked: number; added_at: string }[];
  }
}
