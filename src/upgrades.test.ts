import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UpgradeStore, isLosslessCodec, validWorkerToken } from './upgrades.ts';

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
