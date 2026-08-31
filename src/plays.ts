// Plays made in this app's player, recorded server-side into a database the
// web container owns (the exporter writes spotify.db; keeping local plays
// separate means no write contention and no schema coupling). Combined
// listening stats merge these with the Spotify plays at query time.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_MS = 60 * 60 * 1000; // one hour: longer than any sane single play

// Resolved once so read-only consumers (the wrapped/Top queries ATTACH this
// file) agree with the store about where the plays live.
export const APP_PLAYS_FILE = process.env.APP_PLAYS_DB
  ?? path.join(import.meta.dirname, '..', 'data', 'app-plays.db');

export class PlaysStore {
  private db: DatabaseSync | null = null;
  private readonly dbFile: string;

  constructor(dbFile?: string) {
    this.dbFile = dbFile ?? APP_PLAYS_FILE;
  }

  private handle(): DatabaseSync {
    if (!this.db) {
      this.db = new DatabaseSync(this.dbFile);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_plays (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          track_id TEXT NOT NULL,
          played_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          ms_played INTEGER NOT NULL DEFAULT 0,
          completed INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS app_plays_time ON app_plays(played_at);
        CREATE INDEX IF NOT EXISTS app_plays_track ON app_plays(track_id);
      `);
    }
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  record(trackId: string, msPlayed: number, completed: boolean): void {
    this.handle()
      .prepare('INSERT INTO app_plays (track_id, ms_played, completed) VALUES (?, ?, ?)')
      .run(trackId, Math.max(0, Math.min(Math.round(msPlayed), MAX_MS)), completed ? 1 : 0);
  }

  all<T>(sql: string, ...args: (string | number)[]): T[] {
    return this.handle().prepare(sql).all(...args) as T[];
  }
}
