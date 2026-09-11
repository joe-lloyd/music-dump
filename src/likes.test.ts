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
