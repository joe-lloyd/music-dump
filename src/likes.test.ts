import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LikesStore } from './likes.ts';

test('local choices are idempotent and retain explicit removals independently of Spotify', () => {
  const store = new LikesStore(':memory:');
  store.set('song', true);
  store.set('song', true);
  assert.equal(store.choices().length, 1);
  store.set('song', false);
  assert.equal(store.choices()[0].liked, 0);
  store.set('local:song', true);
  assert.equal(store.choices().length, 2);
  store.db.close();
});

test('album and artist likes live apart from tracks and from each other', () => {
  const store = new LikesStore(':memory:');
  store.set('same-id', true, 'album');
  store.set('same-id', false, 'artist');
  store.set('same-id', true);
  assert.deepEqual(store.choices('album').map(c => [c.id, c.liked]), [['same-id', 1]]);
  assert.deepEqual(store.choices('artist').map(c => [c.id, c.liked]), [['same-id', 0]]);
  assert.deepEqual(store.choices('track').map(c => [c.id, c.liked]), [['same-id', 1]]);
  assert.deepEqual(store.liked('artist'), []);
  store.set('same-id', true, 'artist');
  assert.equal(store.liked('artist').length, 1);
  store.db.close();
});
