// One-shot: push the play history already in the taste DB to ListenBrainz.
//
// The "stats:(user)" and "recs:(user)" radio stations are computed from
// submitted listens, so a fresh account has neither. Waiting months for them
// to fill in from live scrobbling would be silly when the same plays are
// already sitting in spotify.db — this hands them over in one go, and the
// personalised stations light up immediately.
//
// Safe to re-run: the queue's UNIQUE (listened_at, artist, title) drops
// anything already submitted, so a second pass adds only what is new.
//
//   docker compose exec web node --disable-warning=ExperimentalWarning \
//     src/backfill-listens.ts [--dry-run]
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ListenBrainz } from './listenbrainz.ts';

const DB_FILE = process.env.SPOTIFY_DB
  ?? path.join(import.meta.dirname, '..', 'data', 'spotify.db');

interface Row {
  played_at: string;
  title: string;
  artist: string | null;
  album: string | null;
}

function main(): number {
  const dryRun = process.argv.includes('--dry-run');
  const lb = new ListenBrainz();
  if (!lb.enabled) {
    console.error('LISTENBRAINZ_TOKEN is not set — nothing to submit to');
    return 2;
  }

  // ListenBrainz acknowledges a submission before it has durably ingested it,
  // so "submitted" is not proof the listens arrived. --resubmit unmarks
  // everything and sends it again; duplicates are harmless, since a listen is
  // identified by its timestamp on their side too.
  if (process.argv.includes('--resubmit')) {
    console.log(`re-queued ${lb.resubmitAll()} previously submitted listen(s)`);
  }

  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  // Spotify's recorded plays. This app's own plays are scrobbled live as they
  // happen, so they are deliberately not re-read here.
  const rows = db.prepare(`
    SELECT p.played_at,
           t.name AS title,
           (SELECT group_concat(a.name, ', ' ORDER BY ta.position)
              FROM track_artists ta JOIN artists a ON a.id = ta.artist_id
             WHERE ta.track_id = t.id) AS artist,
           al.name AS album
    FROM plays p
    JOIN tracks t ON t.id = p.track_id
    LEFT JOIN albums al ON al.id = t.album_id
    ORDER BY p.played_at
  `).all() as unknown as Row[];
  db.close();

  let queued = 0;
  let skipped = 0;
  for (const row of rows) {
    const artist = (row.artist ?? '').split(',')[0].trim();
    const at = Math.floor(Date.parse(row.played_at) / 1000);
    if (!artist || !row.title || !Number.isFinite(at)) {
      skipped += 1;
      continue;
    }
    if (!dryRun) lb.enqueue({ listenedAt: at, artist, title: row.title, album: row.album });
    queued += 1;
  }

  console.log(`${rows.length} play(s) in the taste DB — ${queued} queued, ${skipped} unusable`);
  if (dryRun) {
    console.log('dry run: nothing was queued');
    lb.close();
    return 0;
  }
  console.log(`${lb.pending()} listen(s) waiting to go`);
  lb.close();
  return 0;
}

// Queue first, submit second: enqueueing is synchronous and safe, while the
// drain talks to the network and is allowed to fail without losing anything.
const code = main();
if (code === 0) {
  const lb = new ListenBrainz();
  const drain = async () => {
    let total = 0;
    for (;;) {
      const sent = await lb.flush();
      if (!sent) break;
      total += sent;
      console.log(`  submitted ${total}…`);
    }
    console.log(`done: ${total} listen(s) submitted, ${lb.pending()} still queued`);
    lb.close();
  };
  await drain().catch((err) => {
    console.error(`submission stopped: ${(err as Error).message}`);
    console.error('Nothing was lost — the queue keeps them and the server retries every 5 minutes.');
    lb.close();
  });
} else {
  process.exitCode = code;
}
