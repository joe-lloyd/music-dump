import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type LikeKind = 'track' | 'album' | 'artist';
export const LIKE_KINDS: readonly LikeKind[] = ['track', 'album', 'artist'];
export type LikeChoice = { id: string; liked: number; added_at: string };

/** Local choices override the Spotify snapshot without changing its sync history. */
export class LikesStore {
  readonly db: DatabaseSync;
  constructor(file = process.env.LIKES_DB ?? path.join(import.meta.dirname, '..', 'data', 'likes.db')) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Tracks came first and keep their table; albums and artists share one
    // keyed by kind, so a third kind is a row value rather than a migration.
    this.db.exec('CREATE TABLE IF NOT EXISTS app_likes (track_id TEXT PRIMARY KEY, liked INTEGER NOT NULL, added_at TEXT NOT NULL)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS app_entity_likes (
      kind TEXT NOT NULL, id TEXT NOT NULL, liked INTEGER NOT NULL, added_at TEXT NOT NULL,
      PRIMARY KEY (kind, id))`);
  }
  set(id: string, liked: boolean, kind: LikeKind = 'track') {
    const now = new Date().toISOString();
    if (kind === 'track') {
      this.db.prepare(`INSERT INTO app_likes VALUES (?, ?, ?) ON CONFLICT(track_id)
        DO UPDATE SET liked = excluded.liked, added_at = excluded.added_at`).run(id, Number(liked), now);
      return;
    }
    this.db.prepare(`INSERT INTO app_entity_likes VALUES (?, ?, ?, ?) ON CONFLICT(kind, id)
      DO UPDATE SET liked = excluded.liked, added_at = excluded.added_at`).run(kind, id, Number(liked), now);
  }
  choices(kind: LikeKind = 'track'): LikeChoice[] {
    if (kind === 'track') {
      return this.db.prepare('SELECT track_id AS id, liked, added_at FROM app_likes').all() as LikeChoice[];
    }
    return this.db.prepare('SELECT id, liked, added_at FROM app_entity_likes WHERE kind = ?').all(kind) as LikeChoice[];
  }
  /** Everything favourited in the app, the set the grab sweep walks. */
  liked(kind: LikeKind): LikeChoice[] {
    return this.choices(kind).filter((choice) => choice.liked);
  }
}
