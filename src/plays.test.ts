import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlaysStore } from './plays.ts';

test('records plays, clamps runaway durations, and queries them back', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plays-'));
  const store = new PlaysStore(path.join(dir, 'app-plays.db'));
  try {
    store.record('track-1', 185_000, true);
    store.record('track-1', 42_000.7, false);
    store.record('track-2', 99 * 60 * 60 * 1000, true); // clamped to one hour
    const rows = store.all<{ track_id: string; ms_played: number; completed: number }>(
      'SELECT track_id, ms_played, completed FROM app_plays ORDER BY id');
    assert.equal(rows.length, 3);
    assert.deepEqual({ ...rows[0] }, { track_id: 'track-1', ms_played: 185_000, completed: 1 });
    assert.equal(rows[1].ms_played, 42_001);
    assert.equal(rows[2].ms_played, 60 * 60 * 1000);
    const [count] = store.all<{ n: number }>('SELECT COUNT(*) n FROM app_plays WHERE track_id = ?', 'track-1');
    assert.equal(count.n, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
