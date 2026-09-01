import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ShelfStore, albumKey, toShelfItem } from './discogs.ts';

const withShelf = (fn: (shelf: ShelfStore) => void): void => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shelf-'));
  const shelf = new ShelfStore(path.join(dir, 'discogs.db'));
  try {
    fn(shelf);
  } finally {
    shelf.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

const release = (id: number, artist: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  basic_information: {
    id,
    title,
    year: 1990,
    thumb: 'https://img/t.jpg',
    cover_image: 'https://img/c.jpg',
    artists: [{ name: artist }],
    labels: [{ name: 'Def American', catno: '7599-24307-2' }],
    formats: [{ name: 'CD', qty: '1', descriptions: ['Album', 'CD'] }],
    genres: ['Rock'],
    ...over,
  },
});

test('collection entries flatten into shelf items', () => {
  const item = toShelfItem(release(123, 'Slayer (2)', 'Seasons in the Abyss'));
  assert.equal(item.release_id, 123);
  // Discogs disambiguates same-named artists with a trailing number.
  assert.equal(item.artist, 'Slayer');
  assert.equal(item.title, 'Seasons in the Abyss');
  assert.equal(item.year, 1990);
  assert.equal(item.catno, '7599-24307-2');
  // "CD" appears as both the format name and a description; not twice.
  assert.equal(item.format, 'CD, Album');
  assert.equal(item.genres, '["Rock"]');
});

test('album keys survive the edition noise Discogs titles carry', () => {
  const bare = albumKey('Slayer', 'Seasons in the Abyss');
  assert.equal(albumKey('Slayer', 'Seasons in the Abyss (Remastered)'), bare);
  assert.equal(albumKey('Slayer', 'Seasons in the Abyss [Deluxe Edition]'), bare);
  assert.equal(albumKey('Slayer & Friends', 'Seasons in the Abyss'), bare);
  assert.equal(albumKey('', 'Seasons in the Abyss'), '');
});

test('sync adds, refreshes, and reports what changed', () => {
  withShelf((shelf) => {
    let result = shelf.sync([release(1, 'Slayer', 'Reign in Blood'), release(2, 'Tool', 'Ænima')], 'joe');
    assert.deepEqual(result, { added: 2, updated: 0, removed: 0 });
    assert.equal(shelf.list().length, 2);

    result = shelf.sync([release(1, 'Slayer', 'Reign in Blood (Remastered)'), release(2, 'Tool', 'Ænima')], 'joe');
    assert.deepEqual(result, { added: 0, updated: 2, removed: 0 });
    assert.equal(shelf.get(1)?.title, 'Reign in Blood (Remastered)');

    const sync = shelf.lastSync();
    assert.equal(sync.username, 'joe');
    assert.equal(sync.released, 2);
  });
});

test('a sync never overwrites the status the user set', () => {
  withShelf((shelf) => {
    shelf.sync([release(1, 'Slayer', 'Reign in Blood')], 'joe');
    shelf.setStatus(1, 'ripped', '/data/library/music/Slayer/Reign in Blood (1986) [Album]');
    shelf.sync([release(1, 'Slayer', 'Reign in Blood')], 'joe');
    const item = shelf.get(1);
    assert.equal(item?.status, 'ripped');
    assert.equal(item?.rip_path, '/data/library/music/Slayer/Reign in Blood (1986) [Album]');
  });
});

test('discs that leave the collection are dropped unless already ripped', () => {
  withShelf((shelf) => {
    shelf.sync([release(1, 'Slayer', 'Reign in Blood'), release(2, 'Tool', 'Ænima')], 'joe');
    shelf.setStatus(1, 'ripped');
    // Both gone from Discogs: the ripped one is still in the library, so it
    // stays; the unripped one is genuinely gone.
    const result = shelf.sync([], 'joe');
    assert.equal(result.removed, 1);
    assert.ok(shelf.get(1));
    assert.equal(shelf.get(2), null);
  });
});

test('reconcile flips shelf discs the library has grown, and only those', () => {
  withShelf((shelf) => {
    shelf.sync([
      release(1, 'Slayer', 'Reign in Blood'),
      release(2, 'Tool', 'Ænima'),
      release(3, 'Nirvana', 'Bleach'),
    ], 'joe');
    shelf.setStatus(3, 'skip');
    const inLibrary = new Set([albumKey('Slayer', 'Reign in Blood'), albumKey('Nirvana', 'Bleach')]);
    assert.equal(shelf.reconcile(inLibrary), 1);
    assert.equal(shelf.get(1)?.status, 'ripped');
    assert.equal(shelf.get(2)?.status, 'shelf');
    // An explicit skip is the user's decision and must survive reconciliation.
    assert.equal(shelf.get(3)?.status, 'skip');
  });
});

test('setStatus rejects a status the schema would not accept', () => {
  withShelf((shelf) => {
    shelf.sync([release(1, 'Slayer', 'Reign in Blood')], 'joe');
    assert.throws(() => shelf.setStatus(1, 'melted' as 'shelf'), /unknown status/);
  });
});

test('single adds and removals work without a collection sync', () => {
  withShelf((shelf) => {
    assert.equal(shelf.add(release(9, 'Portishead', 'Dummy'))?.title, 'Dummy');
    assert.equal(shelf.list().length, 1);
    assert.equal(shelf.remove(9), true);
    assert.equal(shelf.remove(9), false);
  });
});
