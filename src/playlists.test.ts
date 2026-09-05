import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlaylistStore, voyage35 } from './playlists.ts';

test('Voyage 35 persists its order, edits, duplicates and deletion across restarts', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'playlists-'));
  const file = path.join(dir, 'playlists.db');
  let store = new PlaylistStore(file);
  try {
    const seed = store.list()[0];
    assert.equal(seed.name, 'Voyage 35');
    const songs = store.tracks(seed.id);
    assert.deepEqual(songs.map(t => t.name), voyage35);
    assert.equal(songs.length, 13);
    assert.equal(songs[11].name, 'Voyage 34');
    assert.equal(songs[12].name, 'Radioactive Toy');
    const id = store.save(null, 'Mine', '', []);
    assert.equal(store.list().length, 2);
    store.save(id, 'Renamed', 'Notes', [songs[2], songs[0], songs[2]]);
    store.close(); store = new PlaylistStore(file);
    assert.deepEqual(store.tracks(id).map(t => t.name), [voyage35[2], voyage35[0], voyage35[2]]);
    assert.equal(store.list().find(p => p.id === id)?.name, 'Renamed');
    store.remove(seed.id);
    store.close(); store = new PlaylistStore(file);
    assert.equal(store.list().length, 1);
    assert.throws(() => store.save('spotify-id', 'No', '', []));
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
