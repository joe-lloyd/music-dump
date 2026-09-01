import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { JellyfinBridge, deriveFromFilename, normalizeMusicText, scoreJellyfinMatch, type TasteTrack } from './jellyfin.ts';

const track: TasteTrack = {
  id: 'spotify-track',
  name: 'Signal in the Static',
  album_id: 'spotify-album',
  album: 'Night Drive',
  artists: 'Local Signals',
  duration_ms: 252_000,
  disc_number: 1,
  track_number: 3,
  image_url: null,
};

test('normalizes punctuation, accents, ampersands, and featured artists', () => {
  assert.equal(normalizeMusicText('Beyonc\u00e9 & JAY-Z (Live)'), 'beyonce and jay z live');
  assert.equal(normalizeMusicText('Local Signals feat. Guest'), 'local signals');
});

test('requires an exact normalized track title', () => {
  assert.equal(scoreJellyfinMatch(track, { Id: '1', Name: 'A Different Song' } as never), -1);
});

test('strongly scores album, artist, duration, and track-number agreement', () => {
  const score = scoreJellyfinMatch(track, {
    Id: '1',
    Name: 'Signal in the Static',
    Album: 'Night Drive',
    Artists: ['Local Signals'],
    RunTimeTicks: 2_520_000_000,
    ParentIndexNumber: 1,
    IndexNumber: 3,
  } as never);
  assert.equal(score, 14);
});

test('derives artist, album, and track number from an unprobed Lidarr filename', () => {
  const derived = deriveFromFilename({ Id: '1', Name: 'Local Signals - Night Drive - 03 - Signal in the Static' } as never);
  assert.equal(derived.Name, 'Signal in the Static');
  assert.equal(derived.Album, 'Night Drive');
  assert.deepEqual(derived.Artists, ['Local Signals']);
  assert.equal(derived.IndexNumber, 3);
  assert.equal(scoreJellyfinMatch(track, derived), 11);
});

test('derivation keeps dashes in the title, reads DNN disc numbers, and skips odd shapes', () => {
  const dashed = deriveFromFilename({ Id: '1', Name: 'Band - Album - 204 - Title - The Reprise' } as never);
  assert.equal(dashed.Name, 'Title - The Reprise');
  assert.equal(dashed.ParentIndexNumber, 2);
  assert.equal(dashed.IndexNumber, 4);
  const odd = deriveFromFilename({ Id: '1', Name: 'Just a Regular - Song Title' } as never);
  assert.equal(odd.Name, 'Just a Regular - Song Title');
  assert.equal(odd.Album, undefined);
});

test('derivation never overrides real tag metadata', () => {
  const tagged = deriveFromFilename({ Id: '1', Name: 'A - B - 01 - C', Artists: ['Real Artist'] } as never);
  assert.equal(tagged.Name, 'A - B - 01 - C');
  assert.equal(tagged.Album, undefined);
});

test('reads artist credit from AlbumArtists {Id, Name} pairs, as Jellyfin serializes them', () => {
  const score = scoreJellyfinMatch(track, {
    Id: '1',
    Name: 'Signal in the Static',
    Album: 'Night Drive',
    AlbumArtists: [{ Id: 'abc', Name: 'Local Signals' }],
  } as never);
  assert.equal(score, 10);
});

test('does not over-score a same-title track by another artist and album', () => {
  const score = scoreJellyfinMatch(track, {
    Id: '2',
    Name: 'Signal in the Static',
    Album: 'Elsewhere',
    Artists: ['Someone Else'],
    RunTimeTicks: 1_800_000_000,
  } as never);
  assert.equal(score, 4);
});

test('indexes Jellyfin audio, matches safely, and forwards range requests', async () => {
  let seenRange = '';
  const mock = http.createServer((req, res) => {
    assert.equal(req.headers['x-emby-token'], 'fixture-key');
    if (req.url?.startsWith('/Items?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        TotalRecordCount: 2,
        Items: [
          { Id: 'wrong', Name: track.name, Album: 'Elsewhere', Artists: ['Someone Else'], RunTimeTicks: 1_800_000_000 },
          { Id: 'right', Name: track.name, Album: track.album, Artists: [track.artists], RunTimeTicks: 2_520_000_000, IndexNumber: 3, ParentIndexNumber: 1, Container: 'flac', Path: '/eliot-media/music/Local Signals/track.flac' },
        ],
      }));
      return;
    }
    if (req.url?.startsWith('/Audio/right/stream')) {
      seenRange = req.headers.range ?? '';
      res.writeHead(206, { 'content-type': 'audio/flac', 'content-range': 'bytes 0-3/4' });
      res.end('data');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address();
  assert(address && typeof address === 'object');
  process.env.JELLYFIN_URL = `http://127.0.0.1:${address.port}`;
  process.env.JELLYFIN_API_KEY = 'fixture-key';

  try {
    const bridge = new JellyfinBridge();
    const status = await bridge.status();
    assert.equal(status.state, 'ready');
    assert.equal(status.audioItems, 2);
    const match = await bridge.match(track);
    assert.equal(match?.itemId, 'right');
    assert.equal(match?.container, 'flac');
    assert.equal(match?.path, '/eliot-media/music/Local Signals/track.flac');
    const response = await bridge.stream(match!.itemId, 'bytes=0-3');
    assert.equal(response.status, 206);
    assert.equal(seenRange, 'bytes=0-3');
    assert.equal(await response.text(), 'data');
  } finally {
    delete process.env.JELLYFIN_URL;
    delete process.env.JELLYFIN_API_KEY;
    await new Promise<void>((resolve, reject) => mock.close((err) => err ? reject(err) : resolve()));
  }
});

// Rebuilding the index means asking Jellyfin for every audio item it holds,
// which on the Pi takes about seventeen seconds. It used to sit directly in
// front of playback, so the first track played after any five-minute gap
// stalled for that long. These pin the behaviour that fixed it.
//
// Deterministic rather than timed: the second /Items request HANGS until the
// test releases it, so "did not wait for the rebuild" is the difference
// between passing and hanging, not a stopwatch reading.
async function withSlowIndex(
  items: (round: number) => unknown[],
  body: (bridge: JellyfinBridge, release: () => void) => Promise<void>,
): Promise<void> {
  let round = 0;
  // The gate exists before the server does, so releasing it early is safe -
  // awaiting an already-open gate just continues.
  let open = () => { /* replaced below */ };
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const mock = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/Items?')) {
      round += 1;
      if (round > 1) await gate;      // every rebuild waits to be let go
      const payload = items(round);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ TotalRecordCount: payload.length, Items: payload }));
      return;
    }
    if (req.url?.startsWith('/Library/Refresh')) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address();
  assert(address && typeof address === 'object');
  process.env.JELLYFIN_URL = `http://127.0.0.1:${address.port}`;
  process.env.JELLYFIN_API_KEY = 'fixture-key';
  try {
    await body(new JellyfinBridge(), open);
  } finally {
    open();                            // never leave a request hanging
    delete process.env.JELLYFIN_URL;
    delete process.env.JELLYFIN_API_KEY;
    await new Promise<void>((resolve, reject) => mock.close((err) => err ? reject(err) : resolve()));
  }
}

const indexed = (id: string, name: string) => ({
  Id: id, Name: name, Album: track.album, Artists: [track.artists],
  RunTimeTicks: 2_520_000_000, IndexNumber: 3, ParentIndexNumber: 1,
  Container: 'flac', Path: `/eliot-media/music/Local Signals/${id}.flac`,
});

test('a stale index answers immediately while it rebuilds behind you', { timeout: 5_000 }, async () => {
  await withSlowIndex(() => [indexed('right', track.name)], async (bridge, release) => {
    assert.equal((await bridge.status()).state, 'ready');
    // A Jellyfin scan used to throw the index away; now it only marks it.
    await bridge.refreshLibrary();
    // This must NOT wait for the rebuild - which is hanging - to answer.
    const match = await bridge.match(track);
    assert.equal(match?.itemId, 'right', 'a known track must resolve from the index we already hold');
    release();
  });
});

test('a miss waits for the rebuild rather than calling a track missing', { timeout: 5_000 }, async () => {
  const fresh: TasteTrack = { ...track, name: 'Arrived After The Index' };
  await withSlowIndex(
    (round) => round === 1
      ? [indexed('right', track.name)]
      : [indexed('right', track.name), indexed('newcomer', fresh.name)],
    async (bridge, release) => {
      assert.equal((await bridge.status()).state, 'ready');
      await bridge.refreshLibrary();
      const pending = bridge.match(fresh);      // misses the stale index
      release();                                 // let the rebuild land
      assert.equal((await pending)?.itemId, 'newcomer',
        'a file that landed after the index was built must still resolve');
    },
  );
});

// Jellyfin cannot watch the NFS mount, so it has to be told when audio lands.
// Telling it used to mean scanning all seven libraries on this server -
// movies and series on the CIFS NAS included - to notice one new single.
test('a scan is asked of the music library alone, never the whole server', async () => {
  const asked: string[] = [];
  const mock = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url?.split('?')[0]}`);
    if (req.url?.startsWith('/Library/VirtualFolders')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        { ItemId: 'movies-id', CollectionType: 'movies', Locations: ['/movies'] },
        { ItemId: 'music-id', CollectionType: 'music', Locations: ['/eliot-media/music'] },
      ]));
      return;
    }
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address();
  assert(address && typeof address === 'object');
  process.env.JELLYFIN_URL = `http://127.0.0.1:${address.port}`;
  process.env.JELLYFIN_API_KEY = 'fixture-key';
  try {
    const bridge = new JellyfinBridge();
    await bridge.refreshLibrary();
    assert.ok(asked.includes('POST /Items/music-id/Refresh'), `asked: ${asked.join(', ')}`);
    assert.ok(!asked.includes('POST /Library/Refresh'), 'must not scan every library');
    await bridge.refreshLibrary();
    assert.equal(asked.filter((at) => at.includes('VirtualFolders')).length, 1, 'id is looked up once');
  } finally {
    delete process.env.JELLYFIN_URL;
    delete process.env.JELLYFIN_API_KEY;
    await new Promise<void>((resolve, reject) => mock.close((err) => err ? reject(err) : resolve()));
  }
});

test('changed paths are reported as Jellyfin spells them, folders deduped', async () => {
  let posted: { Updates: { Path: string }[] } | null = null;
  const mock = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/Library/Media/Updated')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      posted = JSON.parse(Buffer.concat(chunks).toString());
    }
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address();
  assert(address && typeof address === 'object');
  process.env.JELLYFIN_URL = `http://127.0.0.1:${address.port}`;
  process.env.JELLYFIN_API_KEY = 'fixture-key';
  try {
    await new JellyfinBridge().mediaChanged([
      '/data/library/music/Clark/Cave Dog',          // the worker's spelling
      '/data/library/music/Clark/Cave Dog',          // said twice, sent once
      '/eliot-media/music/_Singles/Yppah',           // already Jellyfin's
      '/somewhere/else/entirely',                    // not ours: dropped
    ]);
    assert.deepEqual(posted?.Updates.map((u) => u.Path), [
      '/eliot-media/music/Clark/Cave Dog',
      '/eliot-media/music/_Singles/Yppah',
    ]);
  } finally {
    delete process.env.JELLYFIN_URL;
    delete process.env.JELLYFIN_API_KEY;
    await new Promise<void>((resolve, reject) => mock.close((err) => err ? reject(err) : resolve()));
  }
});
