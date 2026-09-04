import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  albumScore, artistMatches, isCanonicalAlbum, parseRecordingGroups, parseRelease,
  pickAlbumGroup, resolveAlbum,
  type GroupCandidate, type ReferenceAlbum,
} from './albumref.ts';
import { UpgradeStore } from './upgrades.ts';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'albumref-'));
  let now = Date.parse('2026-09-03T10:00:00.000Z');
  const store = new UpgradeStore(path.join(dir, 'queue.db'), () => now, () => 0.5);
  return {
    store,
    advance(ms: number) { now += ms; },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// A MusicBrainz release payload, trimmed to the fields parseRelease reads.
function releaseBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'REL-0001',
    title: 'Night Drive',
    date: '2019-04-05',
    'artist-credit': [{ name: 'Local Signals', artist: { id: 'ART-1', name: 'Local Signals' } }],
    'release-group': {
      id: 'RG-0001',
      title: 'Night Drive',
      'primary-type': 'Album',
      'first-release-date': '2019-04-05',
    },
    media: [{
      position: 1,
      tracks: [
        { position: 1, title: 'Streetlight Frequency', length: 214_000, recording: { id: 'REC-1' } },
        { position: 2, title: 'Half Awake', length: 198_500, recording: { id: 'REC-2' } },
      ],
    }],
    ...over,
  };
}

function album(over: Partial<ReferenceAlbum> = {}): ReferenceAlbum {
  return {
    releaseGroupMbid: 'rg-0001',
    releaseMbid: 'rel-0001',
    title: 'Night Drive',
    artist: 'Local Signals',
    artistMbid: 'art-1',
    primaryType: 'Album',
    secondaryTypes: [],
    firstReleased: '2019-04-05',
    tracks: [
      { disc: 1, position: 1, recordingMbid: 'rec-1', title: 'Streetlight Frequency', lengthMs: 214_000 },
      { disc: 1, position: 2, recordingMbid: 'rec-2', title: 'Half Awake', lengthMs: 198_500 },
    ],
    ...over,
  };
}

function candidate(over: Partial<GroupCandidate> = {}): GroupCandidate {
  return {
    releaseGroupMbid: 'rg-a', releaseMbid: 'rel-a', title: 'An Album',
    artist: 'Local Signals',
    primaryType: 'Album', secondaryTypes: [], firstReleased: '2019-04-05',
    releaseDate: '2019-04-05', trackCount: 11,
    ...over,
  };
}

// --- shaping MusicBrainz --------------------------------------------------

test('reads a tracklist, its album identity and its credit off one release', () => {
  const parsed = parseRelease(releaseBody());
  assert.ok(parsed);
  // Lowercased everywhere: this id is compared against ids from ListenBrainz
  // and from Lidarr, and only one of the three promises a case.
  assert.equal(parsed.releaseGroupMbid, 'rg-0001');
  assert.equal(parsed.releaseMbid, 'rel-0001');
  assert.equal(parsed.artist, 'Local Signals');
  assert.equal(parsed.artistMbid, 'art-1');
  assert.equal(parsed.tracks.length, 2);
  assert.deepEqual(parsed.tracks[0], {
    disc: 1, position: 1, recordingMbid: 'rec-1',
    title: 'Streetlight Frequency', lengthMs: 214_000,
  });
});

test('keeps a collaboration credited the way the record credits it', () => {
  const parsed = parseRelease(releaseBody({
    'artist-credit': [
      { name: 'Igorrr', joinphrase: ' and ', artist: { id: 'ART-9', name: 'Igorrr' } },
      { name: 'Ruby My Dear', artist: { id: 'ART-10', name: 'Ruby My Dear' } },
    ],
  }));
  assert.equal(parsed?.artist, 'Igorrr and Ruby My Dear');
  // The first credit is the album artist - the one Lidarr would file it under.
  assert.equal(parsed?.artistMbid, 'art-9');
});

test('numbers multi-disc tracks by their own disc, not one long run', () => {
  const parsed = parseRelease(releaseBody({
    media: [
      { position: 1, tracks: [{ position: 1, title: 'One', recording: { id: 'R1' } }] },
      { position: 2, tracks: [{ position: 1, title: 'Two', recording: { id: 'R2' } }] },
    ],
  }));
  assert.deepEqual(
    parsed?.tracks.map((track) => `${track.disc}:${track.position}`),
    ['1:1', '2:1'],
  );
});

test('a release with no tracklist is not an album reference', () => {
  // The whole value of a reference album is the tracklist. Without one there
  // is nothing to show and nothing to compare the library against.
  assert.equal(parseRelease(releaseBody({ media: [] })), null);
  assert.equal(parseRelease({ id: 'REL', title: 'x' }), null);
  assert.equal(parseRelease(null), null);
});

test('collapses several releases of one album into a single candidate', () => {
  const groups = parseRecordingGroups({
    releases: [
      { id: 'REL-CD', date: '2019-04-05', status: 'Official', 'track-count': 11, 'release-group': { id: 'RG-1', title: 'Night Drive', 'primary-type': 'Album', 'first-release-date': '2019-04-05' } },
      { id: 'REL-VINYL', date: '2020-01-01', status: 'Official', 'track-count': 11, 'release-group': { id: 'RG-1', title: 'Night Drive', 'primary-type': 'Album', 'first-release-date': '2019-04-05' } },
      { id: 'REL-COMP', date: '2023-06-01', 'track-count': 40, 'release-group': { id: 'RG-2', title: 'Chillout Annual', 'primary-type': 'Album', 'secondary-types': ['Compilation'] } },
    ],
  });
  assert.equal(groups.length, 2);
  // And within the group, the edition that came out first.
  assert.equal(groups.find((group) => group.releaseGroupMbid === 'rg-1')?.releaseMbid, 'rel-cd');
});

test('prefers the original edition even when the reissue is listed first', () => {
  // The regression that Insurgentes exposed. Every release of one group
  // reports the SAME `first-release-date`, so a tiebreak on that field
  // compared a value to itself and quietly kept whichever release MusicBrainz
  // listed first. Here that is the 5-track bonus disc; the answer wanted is
  // the 39-track original, because it is the one "build out the album" builds.
  const group = { id: 'RG-1', title: 'Insurgentes', 'primary-type': 'Album', 'first-release-date': '2008-11-26' };
  const groups = parseRecordingGroups({
    releases: [
      { id: 'REL-BONUS', date: '2010-10-25', 'track-count': 5, 'release-group': group },
      { id: 'REL-BOOK', date: '2008-11-26', 'track-count': 39, 'release-group': group },
    ],
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.releaseMbid, 'rel-book');
  // The group's date still describes the group, not the edition chosen.
  assert.equal(groups[0]?.firstReleased, '2008-11-26');
  assert.equal(groups[0]?.releaseDate, '2008-11-26');
});

test('a release with no date of its own never outranks one that has a date', () => {
  const group = { id: 'RG-1', title: 'Insurgentes', 'primary-type': 'Album', 'first-release-date': '2008-11-26' };
  const groups = parseRecordingGroups({
    releases: [
      { id: 'REL-UNDATED', 'release-group': group },
      { id: 'REL-BOOK', date: '2008-11-26', 'release-group': group },
    ],
  });
  assert.equal(groups[0]?.releaseMbid, 'rel-book');
});

// --- choosing the album ---------------------------------------------------

test('ranks a studio album above the compilation the song also appears on', () => {
  assert.ok(albumScore({ primaryType: 'Album', secondaryTypes: [] })
    > albumScore({ primaryType: 'Album', secondaryTypes: ['Compilation'] }));
  assert.ok(albumScore({ primaryType: 'Album', secondaryTypes: [] })
    > albumScore({ primaryType: 'Single', secondaryTypes: [] }));
  assert.ok(albumScore({ primaryType: 'Album', secondaryTypes: [] })
    > albumScore({ primaryType: 'Album', secondaryTypes: ['Live'] }));
  // An unset primary type is common enough that it must not read as "bad":
  // above a single, and above the shapes that are somebody else's packaging.
  assert.ok(albumScore({ primaryType: null, secondaryTypes: [] })
    > albumScore({ primaryType: 'Single', secondaryTypes: [] }));
  assert.ok(albumScore({ primaryType: null, secondaryTypes: [] })
    > albumScore({ primaryType: 'Album', secondaryTypes: ['Compilation'] }));
  // Penalties stack, so a live compilation is worse than either.
  assert.ok(albumScore({ primaryType: 'Album', secondaryTypes: ['Live'] })
    > albumScore({ primaryType: 'Album', secondaryTypes: ['Live', 'Compilation'] }));
});

test('only an album-shaped release with more than one track is worth keeping', () => {
  assert.equal(isCanonicalAlbum(album()), true);
  assert.equal(isCanonicalAlbum(album({ primaryType: 'EP' })), true);
  assert.equal(isCanonicalAlbum(album({ primaryType: 'Single' })), false);
  assert.equal(isCanonicalAlbum(album({ secondaryTypes: ['Compilation'] })), false);
  assert.equal(isCanonicalAlbum(album({ secondaryTypes: ['Live'] })), false);
  // A single filed as an album teaches the library nothing it did not have.
  assert.equal(isCanonicalAlbum(album({ tracks: [album().tracks[0]!] })), false);
});

test('picks the record over the compilation, and the original over the reissue', () => {
  const picked = pickAlbumGroup([
    candidate({ releaseGroupMbid: 'rg-comp', primaryType: 'Album', secondaryTypes: ['Compilation'] }),
    candidate({ releaseGroupMbid: 'rg-album' }),
    candidate({ releaseGroupMbid: 'rg-single', primaryType: 'Single' }),
  ]);
  assert.equal(picked?.releaseGroupMbid, 'rg-album');

  const original = pickAlbumGroup([
    candidate({ releaseGroupMbid: 'rg-deluxe', firstReleased: '2020-11-01' }),
    candidate({ releaseGroupMbid: 'rg-original', firstReleased: '2019-04-05' }),
  ]);
  assert.equal(original?.releaseGroupMbid, 'rg-original');
});

test('picks nothing out of nothing, rather than a half-identified release', () => {
  assert.equal(pickAlbumGroup([]), null);
  assert.equal(pickAlbumGroup([candidate({ releaseMbid: '' })]), null);
});

// --- how many MusicBrainz calls it costs ---------------------------------

test('costs one call when the release ListenBrainz gave us is the album', async () => {
  const fetched: string[] = [];
  const resolved = await resolveAlbum({ recordingMbid: 'rec-1', releaseMbid: 'rel-0001' }, {
    byRelease: async (mbid) => { fetched.push(mbid); return album(); },
    groups: async () => { throw new Error('should not have looked for a better album'); },
  });
  assert.equal(resolved?.releaseGroupMbid, 'rg-0001');
  assert.deepEqual(fetched, ['rel-0001']);
});

test('goes looking when that release turns out to be a single', async () => {
  const fetched: string[] = [];
  const resolved = await resolveAlbum({ recordingMbid: 'rec-1', releaseMbid: 'rel-single' }, {
    byRelease: async (mbid) => {
      fetched.push(mbid);
      return mbid === 'rel-single'
        ? album({ releaseGroupMbid: 'rg-single', primaryType: 'Single', tracks: [album().tracks[0]!] })
        : album();
    },
    groups: async () => [candidate({ releaseGroupMbid: 'rg-0001', releaseMbid: 'rel-0001' })],
  });
  assert.equal(resolved?.releaseGroupMbid, 'rg-0001');
  assert.deepEqual(fetched, ['rel-single', 'rel-0001']);
});

test('answers nothing rather than a single or the compilation it is also on', async () => {
  // A blank is the honest answer when no real album turns up. Returning either
  // of these would put "send this to Lidarr" in front of a 40-track
  // greatest-hits or a one-track single, and Lidarr would go and get it.
  const single = album({ releaseGroupMbid: 'rg-single', primaryType: 'Single', tracks: [album().tracks[0]!] });
  const resolved = await resolveAlbum({ recordingMbid: 'rec-1', releaseMbid: 'rel-single' }, {
    byRelease: async () => single,
    groups: async () => [candidate({
      releaseGroupMbid: 'rg-comp', releaseMbid: 'rel-comp', secondaryTypes: ['Compilation'],
    })],
  });
  assert.equal(resolved, null);
});

test('rejects the Various Artists compilation the song merely appears on', async () => {
  // The real case: Bonobo's "Kerala" resolves through MusicBrainz to
  // "Chillout Sessions 20", a 42-track Various Artists DJ-mix. Its type alone
  // is not damning enough - who it is credited to is.
  const compilation = album({
    releaseGroupMbid: 'rg-chillout', title: 'Chillout Sessions 20',
    artist: 'Various Artists', primaryType: 'Album', secondaryTypes: ['Compilation', 'DJ-mix'],
  });
  const resolved = await resolveAlbum({ recordingMbid: 'rec-1', releaseMbid: 'rel-chillout', artist: 'Bonobo' }, {
    byRelease: async () => compilation,
    groups: async () => [candidate({ artist: 'Various Artists', secondaryTypes: ['Compilation'] })],
  });
  assert.equal(resolved, null);
});

test('will not accept a real album by the wrong artist', async () => {
  // A recording id that turns out to be somebody else's song entirely. Loading
  // their album as this track's reference would be worse than a blank.
  const resolved = await resolveAlbum({ releaseMbid: 'rel-0001', artist: 'Igorrr' }, {
    byRelease: async () => album(),
    groups: async () => [],
  });
  assert.equal(resolved, null);
});

test('accepts the album when only the collaboration credit differs', async () => {
  const resolved = await resolveAlbum({ releaseMbid: 'rel-0001', artist: 'Local Signals & Guest' }, {
    byRelease: async () => album(),
    groups: async () => [],
  });
  assert.equal(resolved?.releaseGroupMbid, 'rg-0001');
});

test('compares credits by name, allowing for how differently they are written', () => {
  assert.equal(artistMatches('Bonobo', 'Bonobo'), true);
  assert.equal(artistMatches('Bonobo & Arooj Aftab', 'Bonobo'), true);
  assert.equal(artistMatches('Bonobo', 'Bonobo and Arooj Aftab'), true);
  assert.equal(artistMatches('Beyoncé', 'Beyonce'), true);
  assert.equal(artistMatches('Bonobo', 'Various Artists'), false);
  assert.equal(artistMatches('Bonobo', 'Igorrr'), false);
  // Nothing to compare must not become a reason to reject.
  assert.equal(artistMatches(null, 'Bonobo'), true);
  assert.equal(artistMatches('Bonobo', ''), true);
});

test('does not re-fetch the release it has already parsed', async () => {
  const fetched: string[] = [];
  await resolveAlbum({ recordingMbid: 'rec-1', releaseMbid: 'rel-0001' }, {
    byRelease: async (mbid) => {
      fetched.push(mbid);
      return album({ primaryType: 'Single', tracks: [album().tracks[0]!] });
    },
    // The better group points at the release we already have in hand.
    groups: async () => [candidate({ releaseGroupMbid: 'rg-better', releaseMbid: 'rel-0001' })],
  });
  assert.deepEqual(fetched, ['rel-0001']);
});

test('a recording whose groups are all somebody else\'s costs no third call', async () => {
  const fetched: string[] = [];
  const resolved = await resolveAlbum(
    { recordingMbid: 'rec-1', releaseMbid: 'rel-single', artist: 'Local Signals' },
    {
      byRelease: async (mbid) => {
        fetched.push(mbid);
        return album({ primaryType: 'Single', tracks: [album().tracks[0]!] });
      },
      groups: async () => [candidate({ releaseMbid: 'rel-va', artist: 'Various Artists' })],
    },
  );
  assert.equal(resolved, null);
  // Filtered out before it cost a request, not after.
  assert.deepEqual(fetched, ['rel-single']);
});

test('a recording with no release still resolves through its groups', async () => {
  const resolved = await resolveAlbum({ recordingMbid: 'rec-1', releaseMbid: null }, {
    byRelease: async () => album(),
    groups: async () => [candidate({ releaseGroupMbid: 'rg-0001', releaseMbid: 'rel-0001' })],
  });
  assert.equal(resolved?.releaseGroupMbid, 'rg-0001');
});

test('no identity at all resolves to nothing, without calling anything', async () => {
  const resolved = await resolveAlbum({}, {
    byRelease: async () => { throw new Error('nothing to fetch'); },
    groups: async () => { throw new Error('nothing to look up'); },
  });
  assert.equal(resolved, null);
});

// --- storing the reference ------------------------------------------------

test('stores an album and reads its tracklist back in order', () => {
  const f = fixture();
  try {
    f.store.saveReferenceAlbum(album({
      tracks: [
        { disc: 2, position: 1, recordingMbid: 'rec-3', title: 'Third', lengthMs: null },
        { disc: 1, position: 1, recordingMbid: 'rec-1', title: 'First', lengthMs: 100 },
        { disc: 1, position: 2, recordingMbid: 'rec-2', title: 'Second', lengthMs: 200 },
      ],
    }));
    const stored = f.store.referenceAlbum('rg-0001');
    assert.deepEqual(stored?.tracks.map((track) => track.title), ['First', 'Second', 'Third']);
    assert.deepEqual(stored?.secondaryTypes, []);
    assert.equal(stored?.artist, 'Local Signals');
    assert.equal(f.store.referenceAlbum('rg-nothing'), null);
  } finally {
    f.close();
  }
});

test('re-resolving replaces the tracklist rather than merging two records', () => {
  const f = fixture();
  try {
    f.store.saveReferenceAlbum(album());
    f.store.saveReferenceAlbum(album({
      releaseMbid: 'rel-deluxe',
      secondaryTypes: ['Live'],
      tracks: [{ disc: 1, position: 1, recordingMbid: 'rec-9', title: 'Only This', lengthMs: null }],
    }));
    const stored = f.store.referenceAlbum('rg-0001');
    assert.deepEqual(stored?.tracks.map((track) => track.title), ['Only This']);
    assert.equal(stored?.releaseMbid, 'rel-deluxe');
    assert.deepEqual(stored?.secondaryTypes, ['Live']);
  } finally {
    f.close();
  }
});

test('refuses an album with no tracks', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.saveReferenceAlbum(album({ tracks: [] })), /at least one track/);
  } finally {
    f.close();
  }
});

test('remembers a miss so the same blank is not looked up every poll', () => {
  const f = fixture();
  try {
    assert.equal(f.store.albumLookup('Local Signals', 'Half Awake'), null);
    f.store.rememberAlbumLookup('Local Signals', 'Half Awake', null);
    assert.equal(f.store.albumLookup('Local Signals', 'Half Awake'), '');
    f.store.rememberAlbumLookup('Local Signals', 'Half Awake', 'rg-0001');
    assert.equal(f.store.albumLookup('Local Signals', 'Half Awake'), 'rg-0001');
    // Same normalization the library match uses, so "&" and case do not
    // create a second blank for a song already looked up.
    assert.equal(f.store.albumLookup('local signals', 'half awake'), 'rg-0001');
  } finally {
    f.close();
  }
});

test('offers unresolved singles newest first, and retries a stale miss', () => {
  const f = fixture();
  try {
    const first = f.store.create({
      artist: 'Local Signals', title: 'Half Awake',
      sourceUrl: 'ytsearch5:Local Signals Half Awake', downloader: 'yt-dlp',
      recordingMbid: 'rec-2',
    });
    const second = f.store.create({
      artist: 'Igorrr', title: 'Barbecue',
      sourceUrl: 'ytsearch5:Igorrr Barbecue', downloader: 'yt-dlp',
      releaseMbid: 'rel-maigre',
    });
    assert.deepEqual(f.store.jobsAwaitingAlbum().map((job) => job.id), [second.id, first.id]);

    // A track with no MusicBrainz identity is still offered: ListenBrainz can
    // turn artist+title into one, and only the caller knows whether it is
    // configured. This table's job is to say which albums are blank.
    const third = f.store.create({
      artist: 'Nobody', title: 'Unknown',
      sourceUrl: 'ytsearch5:Nobody Unknown', downloader: 'yt-dlp',
    });
    assert.deepEqual(
      f.store.jobsAwaitingAlbum().map((job) => job.id),
      [third.id, second.id, first.id],
    );
    // A track already resolved to a miss drops out until the retry window.
    f.store.rememberAlbumLookup('Nobody', 'Unknown', null);

    // Attached: done, stop offering it.
    f.store.attachAlbum(second.id, 'rg-maigre');
    assert.deepEqual(f.store.jobsAwaitingAlbum().map((job) => job.id), [first.id]);

    // A miss is not retried immediately...
    f.store.rememberAlbumLookup('Local Signals', 'Half Awake', null);
    assert.deepEqual(f.store.jobsAwaitingAlbum(), []);
    // ...but is once MusicBrainz has had a month to gain the release - and
    // that goes for every blank whose miss has aged out, not just the newest.
    f.advance(31 * 86_400_000);
    assert.deepEqual(f.store.jobsAwaitingAlbum().map((job) => job.id), [third.id, first.id]);
  } finally {
    f.close();
  }
});

test('counts the album tracks the queue already accounts for', () => {
  const f = fixture();
  try {
    f.store.saveReferenceAlbum(album());
    const job = f.store.create({
      artist: 'Local Signals', title: 'Half Awake',
      sourceUrl: 'ytsearch5:Local Signals Half Awake', downloader: 'yt-dlp',
    });
    const coverage = f.store.albumCoverage('rg-0001');
    // Track two of two: the single we already went and got.
    assert.deepEqual([...coverage.keys()], ['1:2']);
    assert.equal(coverage.get('1:2')?.id, job.id);
    assert.equal(f.store.albumCoverage('rg-nothing').size, 0);
  } finally {
    f.close();
  }
});

// --- wanting the whole record --------------------------------------------

test('asking twice for one album is one want', () => {
  const f = fixture();
  try {
    f.store.saveReferenceAlbum(album());
    const first = f.store.wantAlbum('rg-0001', 'lidarr');
    assert.equal(first.status, 'pending');
    f.store.markAlbumWant('rg-0001', 'sent');
    // A second click must not put the album back in the push queue.
    const again = f.store.wantAlbum('rg-0001', 'lidarr');
    assert.equal(again.status, 'sent');
    assert.equal(f.store.pendingAlbumWants().length, 0);
  } finally {
    f.close();
  }
});

test('changing route is a new request for the same album', () => {
  const f = fixture();
  try {
    f.store.saveReferenceAlbum(album());
    f.store.wantAlbum('rg-0001', 'lidarr');
    f.store.markAlbumWant('rg-0001', 'failed', 'eliot asleep');
    const switched = f.store.wantAlbum('rg-0001', 'youtube', 'https://youtu.be/example');
    assert.equal(switched.route, 'youtube');
    assert.equal(switched.status, 'pending');
    assert.equal(switched.last_error, null);
    assert.equal(switched.source_url, 'https://youtu.be/example');
    // One album, one row - not one row per mind changed.
    assert.equal(f.store.pendingAlbumWants().length, 1);
  } finally {
    f.close();
  }
});

test('the push queue carries the album name and only the wanted route', () => {
  const f = fixture();
  try {
    f.store.saveReferenceAlbum(album());
    f.store.saveReferenceAlbum(album({ releaseGroupMbid: 'rg-0002', title: 'Maigre', artist: 'Igorrr' }));
    f.store.wantAlbum('rg-0001', 'lidarr');
    f.store.wantAlbum('rg-0002', 'youtube');

    const lidarr = f.store.pendingAlbumWants('lidarr');
    assert.deepEqual(lidarr.map((want) => want.release_group_mbid), ['rg-0001']);
    assert.equal(lidarr[0]?.title, 'Night Drive');
    assert.equal(lidarr[0]?.artist, 'Local Signals');
    assert.equal(f.store.pendingAlbumWants().length, 2);

    // A failed push stays in the queue: eliot being asleep is the ordinary
    // case, not a reason to lose the request.
    f.store.markAlbumWant('rg-0001', 'failed', 'ssh: connect: host is down');
    assert.deepEqual(f.store.pendingAlbumWants('lidarr').map((want) => want.status), ['failed']);
    f.store.markAlbumWant('rg-0001', 'done');
    assert.equal(f.store.pendingAlbumWants('lidarr').length, 0);
  } finally {
    f.close();
  }
});

test('cannot want an album nobody has resolved', () => {
  const f = fixture();
  try {
    // The release-group id is the whole request. Accepting one we have never
    // seen would put an unchecked id in front of Lidarr.
    assert.throws(() => f.store.wantAlbum('rg-unknown', 'lidarr'), /not been resolved/);
  } finally {
    f.close();
  }
});
