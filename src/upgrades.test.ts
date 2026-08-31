import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { UpgradeStore, isLosslessCodec, localAlbumId, validWorkerToken } from './upgrades.ts';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'upgrades-'));
  let now = Date.parse('2026-08-31T10:00:00.000Z');
  const store = new UpgradeStore(path.join(dir, 'queue.db'), () => now, () => 0.5);
  return {
    store,
    advance(ms: number) { now += ms; },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('recognizes real lossless codecs, not a filename extension', () => {
  assert.equal(isLosslessCodec('FLAC'), true);
  assert.equal(isLosslessCodec('alac'), true);
  assert.equal(isLosslessCodec('mp3'), false);
  assert.equal(isLosslessCodec(null), false);
});

test('migrates the deployed single-track queue schema additively', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'upgrades-legacy-'));
  const file = path.join(dir, 'queue.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE upgrade_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT, source_url TEXT,
      downloader TEXT NOT NULL DEFAULT 'auto',
      artist TEXT NOT NULL, title TEXT NOT NULL, album TEXT, duration_ms INTEGER,
      current_path TEXT, current_codec TEXT, phase TEXT NOT NULL, status TEXT NOT NULL,
      source_attempts INTEGER NOT NULL DEFAULT 0,
      upgrade_attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 6,
      next_attempt_at TEXT, last_error TEXT, result_path TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      claimed_by TEXT, claim_token TEXT, claim_expires_at TEXT
    );
  `);
  legacy.close();

  const store = new UpgradeStore(file);
  try {
    const columns = new Set((store.db.prepare('PRAGMA table_info(upgrade_queue)').all() as { name: string }[])
      .map((column) => column.name));
    assert.equal(columns.has('source_mode'), true);
    assert.equal(columns.has('parent_id'), true);
    assert.equal(columns.has('track_number'), true);
    assert.equal(columns.has('batch_size'), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queues source acquisition only when no local file exists', () => {
  const f = fixture();
  try {
    const source = f.store.create({
      trackId: 'spotify-1', sourceUrl: 'https://open.spotify.com/track/spotify-1',
      artist: 'Local Signals', title: 'Signal in the Static', maxAttempts: 4,
    });
    assert.equal(source.phase, 'source');
    assert.equal(source.status, 'pending_source');

    const local = f.store.create({
      trackId: 'spotify-2', sourceUrl: 'https://open.spotify.com/track/spotify-2',
      artist: 'Local Signals', title: 'Already Here', currentPath: '/music/already.mp3', currentCodec: 'mp3',
    });
    assert.equal(local.phase, 'upgrade');
    assert.equal(local.status, 'queued');

    const flac = f.store.create({
      trackId: 'spotify-3', sourceUrl: 'https://open.spotify.com/track/spotify-3',
      artist: 'Local Signals', title: 'Lossless', currentPath: '/music/lossless.flac', currentCodec: 'flac',
    });
    assert.equal(flac.status, 'already_lossless');
  } finally {
    f.close();
  }
});

test('claims source, promotes it to the upgrade queue, and completes atomically', () => {
  const f = fixture();
  try {
    const created = f.store.create({
      sourceUrl: 'https://youtu.be/example', downloader: 'yt-dlp',
      artist: 'Local Signals', title: 'Signal in the Static', durationMs: 252_000,
    });
    const source = f.store.claim('eliot');
    assert.equal(source?.id, created.id);
    assert.equal(source?.phase, 'source');
    assert.equal(source?.source_attempts, 1);

    const queued = f.store.finish({
      id: created.id, claimToken: source!.claim_token!, outcome: 'source_ready',
      currentPath: '/data/library/music/_Singles/Local Signals/Signal in the Static.mp3',
      currentCodec: 'mp3',
    });
    assert.equal(queued.status, 'queued');
    assert.equal(queued.phase, 'upgrade');

    const upgrade = f.store.claim('eliot');
    assert.equal(upgrade?.upgrade_attempts, 1);
    const done = f.store.finish({
      id: created.id, claimToken: upgrade!.claim_token!, outcome: 'upgraded',
      candidate: 'peer\\album\\track.flac', resultPath: '/data/library/music/_Singles/Local Signals/Signal in the Static.flac',
      currentCodec: 'flac',
    });
    assert.equal(done.status, 'upgraded');
    assert.equal(f.store.claim('eliot'), null);
  } finally {
    f.close();
  }
});

test('expands a YouTube album into linked per-track FLAC jobs atomically', () => {
  const f = fixture();
  try {
    const parent = f.store.create({
      sourceUrl: 'https://www.youtube.com/playlist?list=album', downloader: 'yt-dlp',
      sourceMode: 'playlist', artist: 'Local Signals', title: 'Night Drive', album: 'Night Drive',
      maxAttempts: 4,
    });
    const claimed = f.store.claim('eliot')!;
    assert.equal(claimed.id, parent.id);
    assert.equal(claimed.source_mode, 'playlist');

    const expanded = f.store.finishBatch({
      id: parent.id,
      claimToken: claimed.claim_token!,
      resultPath: '/data/library/music/_YouTube/Local Signals/Night Drive',
      tracks: [
        {
          sourceUrl: 'https://youtu.be/one', artist: 'Local Signals', title: 'Streetlight Frequency',
          album: 'Night Drive', durationMs: 201_000,
          currentPath: '/data/library/music/_YouTube/Local Signals/Night Drive/01 - Streetlight Frequency.mp3',
          currentCodec: 'mp3', trackNumber: 1,
        },
        {
          sourceUrl: 'https://youtu.be/two', artist: 'Local Signals', title: 'Half Awake',
          album: 'Night Drive', durationMs: 218_000,
          currentPath: '/data/library/music/_YouTube/Local Signals/Night Drive/02 - Half Awake.mp3',
          currentCodec: 'mp3', trackNumber: 2,
        },
      ],
    });

    assert.equal(expanded.job.status, 'upgraded');
    assert.equal(expanded.job.batch_size, 2);
    assert.deepEqual(expanded.children.map((job) => [job.parent_id, job.track_number, job.status]), [
      [parent.id, 1, 'queued'], [parent.id, 2, 'queued'],
    ]);
    assert.equal(f.store.claim('eliot')?.id, expanded.children[0].id);
  } finally {
    f.close();
  }
});

test('rejects an invalid album expansion without inserting partial children', () => {
  const f = fixture();
  try {
    const parent = f.store.create({
      sourceUrl: 'https://youtu.be/album', sourceMode: 'chapters', downloader: 'yt-dlp',
      artist: 'Local Signals', title: 'Night Drive', album: 'Night Drive',
    });
    const claimed = f.store.claim('eliot')!;
    assert.throws(() => f.store.finishBatch({
      id: parent.id, claimToken: claimed.claim_token!, resultPath: '/music/album', tracks: [
        {
          artist: 'Local Signals', title: 'One', album: 'Night Drive', durationMs: 100_000,
          currentPath: '/music/01.mp3', currentCodec: 'mp3', trackNumber: 1,
        },
        {
          artist: 'Local Signals', title: 'Two', album: 'Night Drive', durationMs: 100_000,
          currentPath: '/music/02.mp3', currentCodec: 'mp3', trackNumber: 1,
        },
      ],
    }), /track numbers/);
    assert.equal(f.store.list().jobs.length, 1);
    assert.equal(f.store.get(parent.id)?.status, 'working');
  } finally {
    f.close();
  }
});

test('jittered failures become due later and exhaust at the configured cap', () => {
  const f = fixture();
  try {
    const job = f.store.create({
      artist: 'Local Signals', title: 'Hard to Find', currentPath: '/music/hard.mp3', maxAttempts: 2,
    });
    const first = f.store.claim('eliot')!;
    const waiting = f.store.finish({
      id: job.id, claimToken: first.claim_token!, outcome: 'failed',
      error: 'no FLAC result', candidate: 'peer-a\\hard.flac',
    });
    assert.equal(waiting.status, 'retry_wait');
    assert.equal(waiting.next_attempt_at, '2026-08-31T16:00:00.000Z');
    assert.equal(f.store.claim('eliot'), null);

    f.advance(6 * 3_600_000);
    const second = f.store.claim('eliot')!;
    assert.deepEqual(second.attemptedCandidates, ['peer-a\\hard.flac']);
    const exhausted = f.store.finish({
      id: job.id, claimToken: second.claim_token!, outcome: 'failed', error: 'peer timed out',
    });
    assert.equal(exhausted.status, 'exhausted');

    const retried = f.store.retry(job.id);
    assert.equal(retried.status, 'queued');
    assert.equal(retried.max_attempts, 3);
  } finally {
    f.close();
  }
});

test('expired worker leases are recovered and count toward the cap', () => {
  const f = fixture();
  try {
    const job = f.store.create({ artist: 'A', title: 'B', currentPath: '/music/b.mp3', maxAttempts: 1 });
    f.store.claim('crashed-worker', 300);
    f.advance(301_000);
    assert.equal(f.store.claim('replacement'), null);
    assert.equal(f.store.get(job.id)?.status, 'exhausted');
    assert.equal(f.store.get(job.id)?.last_error, 'worker lease expired');
  } finally {
    f.close();
  }
});

test('deduplicates active tracks and compares configured worker tokens safely', () => {
  const f = fixture();
  try {
    f.store.create({ trackId: 'same', artist: 'A', title: 'B', currentPath: '/music/b.mp3' });
    assert.throws(
      () => f.store.create({ trackId: 'same', artist: 'A', title: 'B', currentPath: '/music/b2.mp3' }),
      /already in the active upgrade queue/,
    );
    assert.equal(validWorkerToken('1234567890abcdef', '1234567890abcdef'), true);
    assert.equal(validWorkerToken('1234567890abcdef', 'wrong'), false);
    assert.equal(validWorkerToken('short', 'short'), false);
  } finally {
    f.close();
  }
});

test('installed files become local library tracks and albums, whatever the upgrade did', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'local-'));
  const store = new UpgradeStore(path.join(dir, 'upgrades.db'));
  try {
    const parent = store.create({
      sourceUrl: 'https://youtu.be/abc123', downloader: 'yt-dlp', sourceMode: 'chapters',
      artist: 'Igorrr and Ruby My Dear', title: 'Maigre', album: 'Maigre',
    });
    const claimed = store.claim('eliot')!;
    const { children } = store.finishBatch({
      id: parent.id, claimToken: claimed.claim_token!,
      resultPath: '/data/library/music/_YouTube/Igorrr and Ruby My Dear/Maigre',
      tracks: [
        { artist: 'Igorrr and Ruby My Dear', title: 'Barbecue', album: 'Maigre', trackNumber: 1,
          currentPath: '/data/library/music/_YouTube/Igorrr and Ruby My Dear/Maigre/01 - Barbecue.mp3',
          currentCodec: 'mp3', durationMs: 180_000 },
        { artist: 'Igorrr and Ruby My Dear', title: 'Cuisse', album: 'Maigre', trackNumber: 2,
          currentPath: '/data/library/music/_YouTube/Igorrr and Ruby My Dear/Maigre/02 - Cuisse.mp3',
          currentCodec: 'mp3', durationMs: 200_000 },
      ],
    });
    assert.equal(children.length, 2);

    // A cancelled upgrade must NOT remove the file from the library: the MP3
    // is still on disk and still playable.
    store.cancel(children[0].id);

    const local = store.localTracks();
    assert.equal(local.length, 2, 'both installed tracks remain local library members');
    assert.equal(local[0].name, 'Barbecue');
    assert.equal(local[0].album, 'Maigre');
    assert.equal(local[0].track_number, 1);
    assert.match(local[0].id, /^localtrack-\d+$/);
    assert.equal(local[0].album_id, local[1].album_id, 'same album shares one id');
    assert.equal(local[0].album_id, localAlbumId('Igorrr and Ruby My Dear', 'Maigre'));
    assert.ok(local[0].path.endsWith('01 - Barbecue.mp3'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
