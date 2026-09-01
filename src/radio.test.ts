import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ListenBrainz, type RadioTrack } from './listenbrainz.ts';
import { ProvenanceStore, libTrackId } from './provenance.ts';
import { RadioEngine, interleave, promptFor, type RadioEntry } from './radio.ts';

const OWNED_PATH = '/data/library/music/Converge/Jane Doe (2001) [Album]/01 - Concubine.flac';
const SINGLE_PATH = '/data/library/music/_Singles/Noisia/Could This Be.opus';
const REC_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const REC_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const REC_C = 'cccccccc-0000-4000-8000-000000000003';

function track(over: Partial<RadioTrack> = {}): RadioTrack {
  return {
    recordingMbid: REC_A,
    title: 'Concubine',
    artist: 'Converge',
    artistMbids: [],
    album: 'Jane Doe',
    releaseMbid: null,
    durationMs: 140_000,
    ...over,
  };
}

function withEngine(
  owned: Record<string, string>,
  run: (engine: RadioEngine, provenance: ProvenanceStore) => void | Promise<void>,
  lb?: ListenBrainz,
): Promise<void> | void {
  const dir = mkdtempSync(path.join(tmpdir(), 'radio-'));
  const provenance = new ProvenanceStore(path.join(dir, 'prov.db'));
  provenance.upsert([
    {
      path: OWNED_PATH, artist: 'Converge', title: 'Concubine', album: 'Jane Doe',
      source: 'usenet', codec: 'flac', bit_depth: 16, sample_rate: 44_100,
      duration_ms: 140_000, track_number: 1, disc_number: 1, size_bytes: 30_000_000,
    },
    {
      path: SINGLE_PATH, artist: 'Noisia', title: 'Could This Be', album: null,
      source: 'youtube', codec: 'opus', bitrate: 128, size_bytes: 3_000_000,
    },
  ]);
  const listenbrainz = lb ?? new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: '' });
  const engine = new RadioEngine(
    listenbrainz,
    provenance,
    (mbids) => new Map(mbids.filter((m) => owned[m]).map((m) => [m, owned[m]])),
  );
  const done = run(engine, provenance);
  const cleanup = () => {
    provenance.close();
    listenbrainz.close();
    rmSync(dir, { recursive: true, force: true });
  };
  if (done instanceof Promise) return done.finally(cleanup);
  cleanup();
  return undefined;
}

test('a prompt is built from the seed, and a track seeds on its artist', () => {
  // LB Radio's prompt language takes artists and tags, never a recording id.
  assert.equal(promptFor({ kind: 'artist', value: 'Converge' }), 'artist:(Converge)');
  assert.equal(promptFor({ kind: 'track', value: 'Converge' }), 'artist:(Converge)');
  assert.equal(promptFor({ kind: 'tag', value: 'post-hardcore' }), 'tag:(post-hardcore)');
  assert.equal(promptFor({ kind: 'stats', value: 'joe' }), 'stats:(joe)');
  assert.equal(promptFor({ kind: 'recs', value: 'joe' }), 'recs:(joe)');
});

test('a recording we hold resolves to a playable track id', () => {
  withEngine({ [REC_A]: OWNED_PATH }, (engine) => {
    const [entry] = engine.resolve([track()]);
    assert.equal(entry.owned, true);
    assert.equal(entry.trackId, libTrackId(OWNED_PATH));
    assert.equal(entry.row?.source, 'usenet');
  });
});

// The singles pulled from YouTube were never in Lidarr, so they have no
// recording id at all — without the name fallback, radio would offer to
// download music already sitting on the disk.
test('a track Lidarr never saw still resolves by artist and title', () => {
  withEngine({}, (engine) => {
    const [entry] = engine.resolve([
      track({ recordingMbid: REC_B, artist: 'Noisia', title: 'Could This Be', album: null }),
    ]);
    assert.equal(entry.owned, true);
    assert.equal(entry.trackId, libTrackId(SINGLE_PATH));
  });
});

test('a recording we do not hold comes back marked for fetching', () => {
  withEngine({}, (engine) => {
    const [entry] = engine.resolve([
      track({ recordingMbid: REC_C, artist: 'Boris', title: 'Dear', album: 'Pink' }),
    ]);
    assert.equal(entry.owned, false);
    assert.equal(entry.trackId, null);
    assert.equal(entry.path, null);
  });
});

// A station that opens with an unowned track cannot start until a download
// finishes, which reads to a listener as "radio is broken".
test('a station leads with something owned, then alternates', () => {
  const owned = [{ artist: 'A' }, { artist: 'B' }] as unknown as RadioEntry[];
  const fresh = [{ artist: 'C' }, { artist: 'D' }, { artist: 'E' }] as unknown as RadioEntry[];
  assert.deepEqual(
    interleave(owned, fresh).map((entry) => entry.artist),
    ['A', 'C', 'B', 'D', 'E'],
  );
});

test('interleaving copes with either side being empty', () => {
  const fresh = [{ artist: 'C' }, { artist: 'D' }] as unknown as RadioEntry[];
  assert.deepEqual(interleave([], fresh).map((e) => e.artist), ['C', 'D']);
  assert.deepEqual(interleave(fresh, []).map((e) => e.artist), ['C', 'D']);
  assert.deepEqual(interleave([], []), []);
});

test('a station dedupes recordings LB returns more than once', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radio-lb-'));
  const body = {
    payload: {
      jspf: {
        playlist: {
          track: [
            { creator: 'Converge', title: 'Concubine', identifier: [`https://musicbrainz.org/recording/${REC_A}`] },
            { creator: 'Converge', title: 'Concubine', identifier: [`https://musicbrainz.org/recording/${REC_A}`] },
            { creator: 'Boris', title: 'Dear', identifier: [`https://musicbrainz.org/recording/${REC_C}`] },
          ],
        },
      },
    },
  };
  const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const lb = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl });
  try {
    await withEngine({ [REC_A]: OWNED_PATH }, async (engine) => {
      const station = await engine.station({ kind: 'artist', value: 'Converge' });
      assert.equal(station.source, 'lb-radio');
      assert.equal(station.entries.length, 2);
      assert.equal(station.entries[0].owned, true, 'owned track leads');
      assert.equal(station.entries[1].owned, false);
    }, lb);
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('when LB Radio has nothing, similarity fills in and is diversified', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radio-sim-'));
  const similar = [
    { recording_mbid: REC_B, recording_name: 'a', artist_credit_name: 'Tool' },
    { recording_mbid: REC_C, recording_name: 'b', artist_credit_name: 'Tool' },
    { recording_mbid: 'dddddddd-0000-4000-8000-000000000004', recording_name: 'c', artist_credit_name: 'Tool' },
    { recording_mbid: 'eeeeeeee-0000-4000-8000-000000000005', recording_name: 'd', artist_credit_name: 'Boris' },
  ];
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('lb-radio')) {
      return new Response(JSON.stringify({ payload: { jspf: { playlist: { track: [] } } } }), { status: 200 });
    }
    return new Response(JSON.stringify(similar), { status: 200 });
  }) as unknown as typeof fetch;
  const lb = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl });
  try {
    await withEngine({}, async (engine) => {
      const station = await engine.station(
        { kind: 'artist', value: 'Converge' }, { recordingMbid: REC_A },
      );
      assert.equal(station.source, 'similar');
      // Three Tool tracks in, two out — and Boris is not left until last.
      assert.deepEqual(station.entries.map((e) => e.artist), ['Tool', 'Boris', 'Tool']);
    }, lb);
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// "Songs like this song" is a different question from "songs like this band".
// LB Radio's prompt language has no recording element, so asking it would
// silently widen straight back out to the artist — recording similarity is
// the only thing that answers the question that was actually asked.
test('a song seed uses recording similarity, not the artist', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radio-song-'));
  const asked: string[] = [];
  const similar = Array.from({ length: 20 }, (_, n) => ({
    recording_mbid: `0000000${n}-0000-4000-8000-00000000000${n % 10}`,
    recording_name: `like ${n}`,
    artist_credit_name: `Artist ${n % 7}`,
  }));
  const fetchImpl = (async (url: string) => {
    asked.push(String(url));
    if (String(url).includes('lb-radio')) {
      return new Response(JSON.stringify({ payload: { jspf: { playlist: { track: [] } } } }), { status: 200 });
    }
    if (String(url).includes('metadata/recording')) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify(similar), { status: 200 });
  }) as unknown as typeof fetch;
  const lb = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl });
  try {
    await withEngine({}, async (engine) => {
      const station = await engine.station({ kind: 'track', value: 'Converge' }, { recordingMbid: REC_A });
      assert.equal(station.source, 'similar');
      assert.ok(station.entries.length >= 12);
      assert.ok(
        asked.some((url) => url.includes('similar-recordings')),
        'similarity must be the first thing asked',
      );
      assert.ok(
        !asked.some((url) => url.includes('lb-radio')),
        'a healthy song station must not fall back to artist radio',
      );
    }, lb);
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// An obscure track has no neighbours in the similarity data. Handing back four
// tracks is not a station, so it widens — and says that it did.
test('a song with too few neighbours widens to the artist and says so', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radio-thin-'));
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('lb-radio')) {
      return new Response(JSON.stringify({
        payload: { jspf: { playlist: { track: [
          { creator: 'Boris', title: 'Dear', identifier: [`https://musicbrainz.org/recording/${REC_C}`] },
        ] } } },
      }), { status: 200 });
    }
    if (String(url).includes('metadata/recording')) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify([
      { recording_mbid: REC_B, recording_name: 'only one', artist_credit_name: 'Tool' },
    ]), { status: 200 });
  }) as unknown as typeof fetch;
  const lb = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl });
  try {
    await withEngine({}, async (engine) => {
      const station = await engine.station({ kind: 'track', value: 'Converge' }, { recordingMbid: REC_A });
      assert.equal(station.source, 'similar+artist');
      assert.deepEqual(station.entries.map((e) => e.title).sort(), ['Dear', 'only one']);
    }, lb);
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Similarity carries no duration, and duration is what stops the fetch-ahead
// grabbing a live take or an hour-long mix off YouTube.
test('durations are filled in for unowned tracks that lack them', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'radio-dur-'));
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('metadata/recording')) {
      return new Response(JSON.stringify({ [REC_B]: { recording: { name: 'a', length: 201000 } } }), { status: 200 });
    }
    if (String(url).includes('lb-radio')) {
      return new Response(JSON.stringify({ payload: { jspf: { playlist: { track: [] } } } }), { status: 200 });
    }
    return new Response(JSON.stringify([
      { recording_mbid: REC_B, recording_name: 'a', artist_credit_name: 'Tool' },
    ]), { status: 200 });
  }) as unknown as typeof fetch;
  const lb = new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl });
  try {
    await withEngine({}, async (engine) => {
      const station = await engine.station({ kind: 'track', value: 'X' }, { recordingMbid: REC_A });
      const found = station.entries.find((e) => e.recordingMbid === REC_B);
      assert.equal(found?.durationMs, 201000);
    }, lb);
  } finally {
    lb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
