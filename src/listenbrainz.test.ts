import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ListenBrainz, capPerArtist, mbidFromIdentifier, parseJspf, spaceArtists,
} from './listenbrainz.ts';

const MBID = '7543b047-68a2-4c65-b034-520b8aa5927c';

// The exact shape LB Radio answers with, trimmed to one track.
const jspf = (tracks: unknown[]) => ({ payload: { jspf: { playlist: { track: tracks } } } });

function store(): { lb: ListenBrainz; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'lb-'));
  return { dir, lb: new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', user: 'joe' }) };
}

test('a recording id is pulled out of a JSPF identifier URL', () => {
  assert.equal(
    mbidFromIdentifier([`https://musicbrainz.org/recording/${MBID}`]),
    MBID,
  );
  assert.equal(mbidFromIdentifier('https://example.com/nothing'), null);
  assert.equal(mbidFromIdentifier(undefined), null);
});

test('JSPF becomes radio tracks, and entries without an MBID are dropped', () => {
  const tracks = parseJspf(jspf([
    {
      album: 'All Hail',
      creator: 'Norma Jean',
      duration: 239992,
      title: '/with_errors',
      identifier: [`https://musicbrainz.org/recording/${MBID}`],
      extension: {
        'https://musicbrainz.org/doc/jspf#track': {
          artist_identifiers: ['a02b1a45-271c-4bc3-9d82-68bb896cb5fd'],
          release_identifier: 'https://musicbrainz.org/release/650cfbc3-b272-4cfa-8508-7e8be2c6b756',
        },
      },
    },
    { creator: 'No Id', title: 'Skipped', identifier: [] },
  ]));
  assert.equal(tracks.length, 1);
  assert.deepEqual(tracks[0], {
    recordingMbid: MBID,
    title: '/with_errors',
    artist: 'Norma Jean',
    artistMbids: ['a02b1a45-271c-4bc3-9d82-68bb896cb5fd'],
    album: 'All Hail',
    releaseMbid: '650cfbc3-b272-4cfa-8508-7e8be2c6b756',
    durationMs: 239992,
  });
});

// The bug this guards is real: seeding raw similarity with a Converge track
// returned 87 recordings that were, every one of them, Tool.
test('one artist cannot take over a station', () => {
  const tracks = [
    { artist: 'Tool', title: 'a' }, { artist: 'Tool', title: 'b' },
    { artist: 'Tool', title: 'c' }, { artist: 'Boris', title: 'd' },
  ];
  const capped = capPerArtist(tracks, 2);
  assert.deepEqual(capped.map((t) => t.title), ['a', 'b', 'd']);
});

test('the same artist never lands twice in a row while another is waiting', () => {
  const spaced = spaceArtists([
    { artist: 'Tool', title: 'a' }, { artist: 'Tool', title: 'b' },
    { artist: 'Boris', title: 'c' },
  ]);
  assert.deepEqual(spaced.map((t) => t.artist), ['Tool', 'Boris', 'Tool']);
});

test('spacing still emits everything when only one artist is left', () => {
  const spaced = spaceArtists([
    { artist: 'Tool', title: 'a' }, { artist: 'Tool', title: 'b' },
  ]);
  assert.deepEqual(spaced.map((t) => t.title), ['a', 'b']);
});

test('a radio result is cached, so the same prompt is fetched once', async () => {
  const { lb, dir } = store();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify(jspf([{
      creator: 'Boris', title: 'Dear', identifier: [`https://musicbrainz.org/recording/${MBID}`],
    }])), { status: 200 });
  }) as unknown as typeof fetch;
  const cached = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl });
  try {
    assert.equal((await cached.radio('artist:(Boris)')).length, 1);
    assert.equal((await cached.radio('artist:(Boris)')).length, 1);
    assert.equal(calls, 1, 'second call should have come from cache');
  } finally {
    cached.close();
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a token the token-only endpoints stay quiet instead of erroring', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lb-'));
  const lb = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: '' });
  try {
    assert.equal(lb.enabled, false);
    assert.deepEqual(await lb.radio('artist:(Boris)'), []);
    assert.equal(await lb.lookup('Boris', 'Dear'), null);
    assert.equal(await lb.flush(), 0);
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queued listens submit once and are not re-sent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lb-'));
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    return new Response('{"status":"ok"}', { status: 200 });
  }) as unknown as typeof fetch;
  const lb = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl });
  try {
    lb.enqueue({ listenedAt: 1_700_000_000, artist: 'Converge', title: 'Jane Doe', album: 'Jane Doe' });
    lb.enqueue({ listenedAt: 1_700_000_300, artist: 'Boris', title: 'Dear' });
    assert.equal(lb.pending(), 2);

    assert.equal(await lb.flush(), 2);
    assert.equal(lb.pending(), 0);
    assert.equal(await lb.flush(), 0, 'a submitted listen must not be sent twice');

    const sent = JSON.parse(bodies[0]);
    assert.equal(sent.listen_type, 'import');
    assert.equal(sent.payload[0].listened_at, 1_700_000_000);
    assert.equal(sent.payload[0].track_metadata.artist_name, 'Converge');
    assert.deepEqual(lb.stats(), { pending: 0, submitted: 2, failed: 0 });
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-queueing the same listen is ignored, so an import can be re-run', () => {
  const { lb, dir } = store();
  try {
    lb.enqueue({ listenedAt: 1_700_000_000, artist: 'Converge', title: 'Jane Doe' });
    lb.enqueue({ listenedAt: 1_700_000_000, artist: 'Converge', title: 'Jane Doe' });
    assert.equal(lb.pending(), 1);
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The account's email was unverified when this first ran, and ListenBrainz
// refused every submission with a 401. Counting those against the retry budget
// would have discarded the listens half an hour later - destroying exactly what
// the queue exists to protect, for a problem a single click fixes.
test('an auth failure never uses up the retry budget for a listen', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lb-'));
  const fetchImpl = (async () => new Response(
    '{"error":"account does not have a verified email address"}', { status: 401 },
  )) as unknown as typeof fetch;
  const lb = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl });
  try {
    lb.enqueue({ listenedAt: 1_700_000_000, artist: 'Converge', title: 'Jane Doe' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await assert.rejects(() => lb.flush());
    }
    assert.equal(lb.pending(), 1, 'the listen must still be waiting to go');
    assert.equal(lb.stats().failed, 0);
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a busy server does not use up retries either', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lb-'));
  const fetchImpl = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
  const lb = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl });
  try {
    lb.enqueue({ listenedAt: 1_700_000_000, artist: 'Boris', title: 'Dear' });
    for (let attempt = 0; attempt < 8; attempt += 1) await assert.rejects(() => lb.flush());
    assert.equal(lb.pending(), 1);
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A genuinely malformed row must still stop blocking everything behind it.
test('a rejected payload is retried, then given up on', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lb-'));
  const fetchImpl = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
  const lb = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl });
  try {
    lb.enqueue({ listenedAt: 1_700_000_000, artist: 'Converge', title: 'Jane Doe' });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await assert.rejects(() => lb.flush());
    }
    assert.equal(lb.pending(), 0, 'exhausted rows must stop being retried');
    assert.deepEqual(lb.stats(), { pending: 0, submitted: 0, failed: 1 });
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
