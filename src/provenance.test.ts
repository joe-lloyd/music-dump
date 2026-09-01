import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ProvenanceStore, albumMatchKey, libAlbumId, libTrackId, provenanceKey, qualityLabel,
  qualityTier, type ScanInput,
} from './provenance.ts';

const withStore = (fn: (store: ProvenanceStore) => void): void => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prov-'));
  const store = new ProvenanceStore(path.join(dir, 'provenance.db'));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

test('quality tiers put the real pipelines where you would expect them', () => {
  // A FLAC's bitrate describes the music, not the fidelity, so it must never
  // reach the lossy thresholds - 700 kbps is not "high", it is lossless.
  assert.equal(qualityTier({ codec: 'flac', bitrate: 700, sampleRate: 44_100, bitDepth: 16 }), 'lossless');
  assert.equal(qualityTier({ codec: 'flac', bitrate: 2200, sampleRate: 44_100, bitDepth: 24 }), 'hires');
  assert.equal(qualityTier({ codec: 'flac', bitrate: 2200, sampleRate: 96_000, bitDepth: 16 }), 'hires');
  assert.equal(qualityTier({ codec: 'alac', bitrate: null, sampleRate: 44_100, bitDepth: 16 }), 'lossless');
  // usenet MP3-320 vs YouTube Opus - the two the badges most need to separate.
  assert.equal(qualityTier({ codec: 'mp3', bitrate: 320, sampleRate: 44_100, bitDepth: null }), 'high');
  assert.equal(qualityTier({ codec: 'opus', bitrate: 130, sampleRate: 48_000, bitDepth: null }), 'standard');
  // Same YouTube download, different tracks: loudness moves the measured
  // bitrate around and must not move the badge with it.
  assert.equal(qualityTier({ codec: 'opus', bitrate: 120, sampleRate: 48_000, bitDepth: null }), 'standard');
  assert.equal(qualityTier({ codec: 'opus', bitrate: 147, sampleRate: 48_000, bitDepth: null }), 'standard');
  assert.equal(qualityTier({ codec: 'opus', bitrate: 70, sampleRate: 48_000, bitDepth: null }), 'low');
  assert.equal(qualityTier({ codec: 'mp3', bitrate: 64, sampleRate: 44_100, bitDepth: null }), 'low');
  assert.equal(qualityTier({ codec: null, bitrate: null, sampleRate: null, bitDepth: null }), 'low');
});

test('quality labels stay short enough for a badge', () => {
  assert.equal(qualityLabel('hires', { codec: 'flac', bitrate: null, sampleRate: 96_000, bitDepth: 24 }), '24/96');
  assert.equal(qualityLabel('lossless', { codec: 'flac', bitrate: null, sampleRate: 44_100, bitDepth: 16 }), 'FLAC');
  assert.equal(qualityLabel('high', { codec: 'mp3', bitrate: 320, sampleRate: 44_100, bitDepth: null }), '320k');
});

test('match keys ignore the credit noise that differs between tags and Spotify', () => {
  assert.equal(
    provenanceKey('Igorrr, Ruby My Dear', 'Barbecue'),
    provenanceKey('Igorrr feat. Someone', 'barbecue'),
  );
  assert.equal(provenanceKey('', 'Barbecue'), '');
  assert.equal(provenanceKey('Igorrr', ''), '');
});

const row = (over: Partial<ScanInput> = {}): ScanInput => ({
  path: '/data/library/music/A/Album/track.flac',
  artist: 'Slayer',
  title: 'War Ensemble',
  album: 'Seasons in the Abyss',
  source: 'usenet',
  detail: 'nzbgeek',
  codec: 'flac',
  bitrate: 900,
  sample_rate: 44_100,
  bit_depth: 16,
  size_bytes: 48_169_704,
  mtime: 1_700_000_000,
  ...over,
});

test('upsert is idempotent per path and rewrites the badge in place', () => {
  withStore((store) => {
    assert.equal(store.upsert([row()]), 1);
    assert.equal(store.upsert([row({ source: 'torrent', detail: 'thepiratebay' })]), 1);
    const found = store.row('/data/library/music/A/Album/track.flac');
    assert.equal(found?.source, 'torrent');
    assert.equal(found?.detail, 'thepiratebay');
    assert.equal(store.summary().total, 1);
  });
});

test('an unknown source is stored as unknown rather than trusted', () => {
  withStore((store) => {
    store.upsert([row({ source: 'napster' })]);
    assert.equal(store.row(row().path)?.source, 'unknown');
  });
});

test('badges pick the best copy when the same song exists twice', () => {
  withStore((store) => {
    store.upsert([
      row({ path: '/lib/opus.opus', codec: 'opus', bitrate: 130, bit_depth: null, source: 'youtube' }),
      row({ path: '/lib/flac.flac', codec: 'flac', bit_depth: 16, source: 'usenet' }),
    ]);
    const badge = store.badges(0).get(provenanceKey('Slayer', 'War Ensemble'));
    assert.equal(badge?.tier, 'lossless');
    assert.equal(badge?.source, 'usenet');
  });
});

test('rows without an artist or title never collide under the empty key', () => {
  withStore((store) => {
    store.upsert([
      row({ path: '/lib/a.flac', artist: '', title: '' }),
      row({ path: '/lib/b.flac', artist: '', title: '' }),
    ]);
    assert.equal(store.badges(0).size, 0);
    assert.equal(store.summary().total, 2);
  });
});

test('album keys reconcile Lidarr folder names with the tags inside them', () => {
  const bare = albumMatchKey('Slayer', 'Seasons in the Abyss');
  assert.equal(albumMatchKey('Slayer', 'Seasons in the Abyss (1990) [Album]'), bare);
  assert.equal(albumMatchKey('Slayer', 'Seasons in the Abyss [Album]'), bare);
  assert.equal(albumMatchKey('Slayer', ''), '');
});

test('an album badge reports the modal tier, not the best or worst track', () => {
  withStore((store) => {
    // Nine FLACs and one bonus MP3: the record is a FLAC record.
    const tracks = Array.from({ length: 9 }, (_, i) => row({
      path: `/lib/flac-${i}.flac`, title: `Track ${i}`, album: 'Seasons in the Abyss',
    }));
    tracks.push(row({
      path: '/lib/bonus.mp3', title: 'Bonus', album: 'Seasons in the Abyss',
      codec: 'mp3', bitrate: 320, bit_depth: null, source: 'torrent',
    }));
    store.upsert(tracks);
    const badge = store.albumBadges(0).get(albumMatchKey('Slayer', 'Seasons in the Abyss (1990) [Album]'));
    assert.equal(badge?.tier, 'lossless');
    assert.equal(badge?.source, 'usenet');
  });
});

test('rescanning invalidates the album cache as well as the track cache', () => {
  withStore((store) => {
    store.upsert([row({ path: '/lib/a.mp3', codec: 'mp3', bitrate: 320, bit_depth: null })]);
    assert.equal(store.albumBadges().get(albumMatchKey('Slayer', 'Seasons in the Abyss'))?.tier, 'high');
    // Same default TTL, so a stale cache would still answer "high" here.
    store.upsert([row({ path: '/lib/a.mp3' })]);
    assert.equal(store.albumBadges().get(albumMatchKey('Slayer', 'Seasons in the Abyss'))?.tier, 'lossless');
  });
});

test('an album is the folder, so feature credits do not split a record', () => {
  withStore((store) => {
    // Real shape of the bug: one release, two different tagged artists.
    store.upsert([
      row({ path: '/lib/Serj/Covers/01.flac', artist: 'Serj Tankian', album: 'Covers' }),
      row({ path: '/lib/Serj/Covers/02.flac', artist: 'Serj Tankian feat. Bic Runga', album: 'Covers' }),
      row({ path: '/lib/Serj/Covers/03.flac', artist: 'Serj Tankian', album: 'Covers' }),
    ]);
    const albums = store.albums();
    assert.equal(albums.length, 1, 'one folder is one album');
    assert.equal(albums[0].total_tracks, 3);
    // The credit most tracks carry, not whoever happens to be first.
    assert.equal(albums[0].artists, 'Serj Tankian');
  });
});

test('album and track lookups are indexed, not full scans', () => {
  withStore((store) => {
    store.upsert([
      row({ path: '/lib/A/One/01.flac', album: 'One', title: 'a' }),
      row({ path: '/lib/A/One/02.flac', album: 'One', title: 'b' }),
      row({ path: '/lib/A/Two/01.flac', album: 'Two', title: 'c' }),
    ]);
    const id = libAlbumId('/lib/A/One/01.flac');
    assert.equal(store.albumTracks(id).length, 2);
    assert.equal(store.albumTracks(libAlbumId('/lib/A/Two/01.flac')).length, 1);
    assert.equal(store.trackById(libTrackId('/lib/A/Two/01.flac'))?.title, 'c');
    assert.equal(store.trackById('libtrack-nothing'), null);

    // The ids must be stored, not recomputed per request: an album page and
    // its cover both hit this, and a full scan per call took the server down.
    const plan = store.db.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM track_provenance WHERE album_id = ?',
    ).all(id) as { detail: string }[];
    assert.match(plan.map((step) => step.detail).join(' '), /USING INDEX/);
  });
});

test('track order follows disc then track number, not filename luck', () => {
  withStore((store) => {
    store.upsert([
      row({ path: '/lib/A/B/z.flac', album: 'B', title: 'second', track_number: 2, disc_number: 1 }),
      row({ path: '/lib/A/B/a.flac', album: 'B', title: 'first', track_number: 1, disc_number: 1 }),
      row({ path: '/lib/A/B/m.flac', album: 'B', title: 'disc two', track_number: 1, disc_number: 2 }),
    ]);
    const tracks = store.albumTracks(libAlbumId('/lib/A/B/a.flac'));
    assert.deepEqual(tracks.map((t) => t.title), ['first', 'second', 'disc two']);
  });
});

test('prune drops files the scanner no longer sees', () => {
  withStore((store) => {
    store.upsert([row({ path: '/lib/a.flac' }), row({ path: '/lib/b.flac' })]);
    assert.equal(store.prune(['/lib/a.flac']), 1);
    assert.equal(store.summary().total, 1);
    assert.equal(store.prune(['/lib/a.flac']), 0);
  });
});

test('fingerprints let a rescan skip untouched files', () => {
  withStore((store) => {
    store.upsert([row({ path: '/lib/a.flac', mtime: 42, size_bytes: 7 })]);
    assert.equal(store.fingerprints().get('/lib/a.flac'), '42:7');
  });
});

test('summary counts by source and by derived tier', () => {
  withStore((store) => {
    store.upsert([
      row({ path: '/lib/a.flac', title: 'One' }),
      row({ path: '/lib/b.mp3', title: 'Two', codec: 'mp3', bitrate: 320, bit_depth: null, source: 'torrent' }),
      row({ path: '/lib/c.opus', title: 'Three', codec: 'opus', bitrate: 130, bit_depth: null, source: 'youtube' }),
    ]);
    const summary = store.summary();
    assert.deepEqual(summary.sources, { usenet: 1, torrent: 1, youtube: 1 });
    assert.deepEqual(summary.tiers, { lossless: 1, high: 1, standard: 1 });
    assert.equal(summary.total, 3);
    assert.ok(summary.scannedAt);
  });
});
