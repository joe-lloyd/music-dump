import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseContinuation, genreSimilarity, type ContinuationAlbum } from './continuation.ts';

const album = (
  id: string, artist: string, sortDate: string, genres: string[] = [], affinity = 0,
): ContinuationAlbum => ({ id, name: id, artist, sortDate, genres, affinity });

test('walks the rest of the current artist catalogue in release order', () => {
  const albums = [
    album('a-new', 'A', '2026-01-01'),
    album('a-middle', 'A', '2024-01-01'),
    album('a-old', 'A', '2020-01-01'),
    album('b-new', 'B', '2026-02-01'),
  ];
  assert.deepEqual(chooseContinuation(albums, { currentAlbumId: 'a-middle' }), {
    album: albums[2], reason: 'same-artist', vibeScore: 0,
  });
});

test('wraps within an artist catalogue before changing artist', () => {
  const albums = [album('a-new', 'A', '2026-01-01'), album('a-old', 'A', '2020-01-01')];
  assert.equal(chooseContinuation(albums, { currentAlbumId: 'a-old' })?.album.id, 'a-new');
});

test('never repeats an album already heard in this autoplay run', () => {
  const albums = [
    album('a-new', 'A', '2026-01-01'),
    album('a-old', 'A', '2020-01-01'),
    album('b-new', 'B', '2026-02-01'),
  ];
  const choice = chooseContinuation(albums, {
    currentAlbumId: 'a-old', visitedAlbumIds: ['a-new', 'a-old'],
  });
  assert.equal(choice?.album.id, 'b-new');
});

test('keeps a chill run in a broad chill lane without an exact genre match', () => {
  assert.ok(genreSimilarity(['ambient pop'], ['downtempo']) > 0);
  const albums = [
    album('a', 'A', '2026-01-01', ['ambient pop']),
    album('b', 'B', '2026-01-01', ['downtempo'], 1),
    album('c', 'C', '2026-01-01', ['death metal'], 999),
  ];
  const choice = chooseContinuation(albums, { currentAlbumId: 'a', visitedAlbumIds: ['a'] });
  assert.equal(choice?.album.id, 'b');
  assert.equal(choice?.reason, 'same-vibe');
});

test('uses affinity only to break equal vibe matches', () => {
  const albums = [
    album('a', 'A', '2026-01-01', ['dream pop']),
    album('b', 'B', '2024-01-01', ['ambient'], 20),
    album('c', 'C', '2026-01-01', ['chillwave'], 50),
  ];
  assert.equal(chooseContinuation(albums, { currentAlbumId: 'a' })?.album.id, 'c');
});

test('falls back to the next artist and that artist newest unplayed album', () => {
  const albums = [
    album('b', 'Beta', '2026-01-01'),
    album('c-old', 'Charlie', '2020-01-01'),
    album('c-new', 'Charlie', '2025-01-01'),
    album('d', 'Delta', '2024-01-01'),
  ];
  const choice = chooseContinuation(albums, { currentAlbumId: 'b' });
  assert.equal(choice?.album.id, 'c-new');
  assert.equal(choice?.reason, 'next-artist');
});

test('returns null once every album is excluded', () => {
  assert.equal(chooseContinuation([album('a', 'A', '2026-01-01')], {
    currentAlbumId: 'a', visitedAlbumIds: ['a'],
  }), null);
});
