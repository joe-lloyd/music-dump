import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LyricsService, parseLrc, type LyricsTrack } from './lyrics.ts';

const track: LyricsTrack = {
  id: 'spotify-track',
  name: 'Signal in the Static',
  album: 'Night Drive',
  artists: 'Local Signals, Guest Act',
  duration_ms: 252_000,
};

const noBridge = {
  match: async () => null,
  lyrics: async () => null,
};

test('parses enhanced-LRC word tags into word timings, and never invents them', () => {
  const [line] = parseLrc('[00:10.00]<00:10.00>find <00:10.40>the <00:11.00>signal');
  assert.equal(line.text, 'find the signal');
  assert.deepEqual(line.words, [
    { time: 10, text: 'find' },
    { time: 10.4, text: 'the' },
    { time: 11, text: 'signal' },
  ]);
  const [plainLine] = parseLrc('[00:10.00]no word timing here');
  assert.equal(plainLine.words, undefined);
});

test('parses LRC timestamps, repeated tags, and skips metadata lines', () => {
  const lines = parseLrc('[ar:Local Signals]\n[00:12.50]find the signal\n[00:20][01:05.5]in the static\n\n[00:03.250]\n');
  assert.deepEqual(lines, [
    { time: 3.25, text: '' },
    { time: 12.5, text: 'find the signal' },
    { time: 20, text: 'in the static' },
    { time: 65.5, text: 'in the static' },
  ]);
});

test('prefers Jellyfin lyrics for a matched track and skips LRCLIB', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lyrics-'));
  const service = new LyricsService(path.join(dir, 'lyrics.db'), async () => {
    throw new Error('LRCLIB must not be called when Jellyfin has lyrics');
  });
  try {
    const result = await service.for(track, {
      match: async () => ({ itemId: 'right' }),
      lyrics: async (itemId) => {
        assert.equal(itemId, 'right');
        return { synced: [{ time: 1, text: 'from the sidecar' }], plain: null };
      },
    });
    assert.equal(result.source, 'jellyfin');
    assert.deepEqual(result.synced, [{ time: 1, text: 'from the sidecar' }]);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to LRCLIB, sends an identifying user agent, and caches the hit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lyrics-'));
  let calls = 0;
  const service = new LyricsService(path.join(dir, 'lyrics.db'), async (input, init) => {
    calls += 1;
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('artist_name'), 'Local Signals');
    assert.equal(url.searchParams.get('duration'), '252');
    assert.match(String((init?.headers as Record<string, string>)['user-agent']), /music-taste/);
    return Response.json({ syncedLyrics: '[00:01.00]one\n[00:02.00]two', plainLyrics: 'one\ntwo', instrumental: false });
  });
  try {
    const first = await service.for(track, noBridge);
    assert.equal(first.source, 'lrclib');
    assert.equal(first.synced?.length, 2);
    const second = await service.for(track, noBridge);
    assert.equal(second.synced?.length, 2);
    assert.equal(calls, 1);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('caches an LRCLIB 404 as a miss but does not cache errors', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lyrics-'));
  let status = 500;
  let calls = 0;
  const service = new LyricsService(path.join(dir, 'lyrics.db'), async () => {
    calls += 1;
    return new Response(null, { status });
  });
  try {
    assert.equal((await service.for(track, noBridge)).available, false); // 500: retryable
    status = 404;
    assert.equal((await service.for(track, noBridge)).available, false); // 404: cached miss
    assert.equal((await service.for(track, noBridge)).available, false);
    assert.equal(calls, 2);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
