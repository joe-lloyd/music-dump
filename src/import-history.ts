// Import Spotify's GDPR "Extended streaming history" export into history_plays.
//
//   node src/import-history.ts ~/Downloads/my_spotify_data/
//
// Point it at the extracted folder (unzip first). Handles both formats:
//   - Extended history: Streaming_History_Audio_*.json / endsong_*.json
//     ({ts, ms_played, spotify_track_uri, master_metadata_track_name, ...})
//   - Basic account data: StreamingHistory*.json
//     ({endTime, artistName, trackName, msPlayed})
// Re-importing overlapping exports is safe — rows dedupe on (ts, track, ms).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { TasteDb } from './db.ts';

const DB_FILE = process.env.SPOTIFY_DB ?? path.join(import.meta.dirname, '..', 'data', 'spotify.db');

interface ExtendedEntry {
  ts?: string;
  ms_played?: number;
  spotify_track_uri?: string | null;
  master_metadata_track_name?: string | null;
  master_metadata_album_artist_name?: string | null;
  master_metadata_album_album_name?: string | null;
  episode_name?: string | null;
  platform?: string;
  conn_country?: string;
  reason_start?: string;
  reason_end?: string;
  shuffle?: boolean;
  skipped?: boolean;
  // basic account-data format
  endTime?: string;
  artistName?: string;
  trackName?: string;
  msPlayed?: number;
}

const dir = process.argv[2];
if (!dir || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('Usage: node src/import-history.ts <extracted-export-folder>');
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((f) => /^(Streaming_History.*|StreamingHistory.*|endsong.*)\.json$/i.test(f))
  .sort();
if (!files.length) {
  console.error(`No streaming history JSON files found in ${dir}`);
  console.error('Expected Streaming_History_Audio_*.json, endsong_*.json, or StreamingHistory*.json');
  process.exit(1);
}

const db = new TasteDb(DB_FILE);
let inserted = 0;
let duplicate = 0;
let episodes = 0;

for (const file of files) {
  const entries = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as ExtendedEntry[];
  db.transaction(() => {
    for (const e of entries) {
      if (e.episode_name || (e.spotify_track_uri && !e.spotify_track_uri.startsWith('spotify:track:'))) {
        episodes++;
        continue;
      }
      // Basic format has local time "YYYY-MM-DD HH:MM"; normalize to ISO-ish.
      const ts = e.ts ?? (e.endTime ? e.endTime.replace(' ', 'T') + ':00Z' : null);
      const name = e.master_metadata_track_name ?? e.trackName;
      if (!ts || !name) continue;
      const res = db.run(
        `INSERT OR IGNORE INTO history_plays
           (ts, track_name, ms_played, track_id, artist_name, album_name,
            platform, country, reason_start, reason_end, shuffle, skipped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ts,
        name,
        e.ms_played ?? e.msPlayed ?? 0,
        e.spotify_track_uri?.replace('spotify:track:', ''),
        e.master_metadata_album_artist_name ?? e.artistName,
        e.master_metadata_album_album_name,
        e.platform,
        e.conn_country,
        e.reason_start,
        e.reason_end,
        e.shuffle,
        e.skipped,
      );
      if (Number(res.changes) > 0) inserted++;
      else duplicate++;
    }
  });
  console.log(`${file}: done`);
}

const span = db.db.prepare('SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n, SUM(ms_played) ms FROM history_plays').get() as
  { a: string; b: string; n: number; ms: number };
console.log(`\nImported ${inserted} plays (${duplicate} duplicates skipped, ${episodes} podcast episodes ignored)`);
console.log(`History now: ${span.n} plays, ${Math.round(span.ms / 3_600_000)} hours listened, ${span.a?.slice(0, 10)} → ${span.b?.slice(0, 10)}`);
