import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { ProvenanceStore } from './provenance.ts';
import { TasteDb } from './db.ts';

test('HTTP: local playlist CRUD, album intake and repeated requests', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'music-workflows-'));
  const dbFile = path.join(dir, 'taste.db');
  const db = new TasteDb(dbFile);
  db.run("INSERT INTO artists (id, name) VALUES ('artist', 'Porcupine Tree')");
  db.run("INSERT INTO albums (id, name) VALUES ('album', 'Test album')");
  for (const [id, name, number] of [['one', 'Even Less', 1], ['two', 'Dark Matter', 2]]) {
    db.run('INSERT INTO tracks (id, name, album_id, track_number, disc_number, duration_ms) VALUES (?, ?, ?, ?, 1, 180000)', id, name, 'album', number);
    db.run('INSERT INTO track_artists VALUES (?, ?, 0)', id, 'artist');
  }
  db.db.close();
  const scanned = new ProvenanceStore(path.join(dir, 'provenance.db'));
  scanned.upsert([{ path: '/data/library/music/CD/Even Less.flac', artist: 'Porcupine Tree', title: 'Even Less', album: 'Test album', codec: 'flac', duration_ms: 180000 }]);
  scanned.close();
  const jellyfin = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ Items: [{ Id: 'audio-one', Name: 'Even Less', Artists: ['Porcupine Tree'], Album: 'Test album', Container: 'flac', RunTimeTicks: 1800000000, Path: '/eliot-media/music/CD/Even Less.flac' }], TotalRecordCount: 1 }));
  });
  jellyfin.listen(0, '127.0.0.1'); await once(jellyfin, 'listening');
  const jellyfinAddress = jellyfin.address();
  assert.ok(jellyfinAddress && typeof jellyfinAddress === 'object');
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', path.join(import.meta.dirname, 'server.ts')], {
    env: { ...process.env, PORT: String(port), SPOTIFY_DB: dbFile, PLAYLISTS_DB: path.join(dir, 'playlists.db'),
      UPGRADES_DB: path.join(dir, 'upgrades.db'), APP_PLAYS_DB: path.join(dir, 'plays.db'), PROVENANCE_DB: path.join(dir, 'provenance.db'),
      DISCOGS_DB: path.join(dir, 'discogs.db'), LYRICS_DB: path.join(dir, 'lyrics.db'), JELLYFIN_URL: `http://127.0.0.1:${jellyfinAddress.port}`, JELLYFIN_API_KEY: 'fixture', MUSIC_SOURCE_HOST: '', UPGRADE_WORKER_TOKEN: 'fixture-worker-token-123', LISTENBRAINZ_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  async function post(route: string, body: unknown) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    assert.ok(data && typeof data === 'object');
    return data;
  }
  try {
    for (let i = 0; i < 100; i++) {
      if (output.includes('taste-db ui on')) break;
      if (child.exitCode !== null) assert.fail(output);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(output, /taste-db ui on/);
    const playlists = await (await fetch(base + '/api/playlists')).json();
    assert.ok(Array.isArray(playlists));
    const seed = playlists.find((p: { name: string }) => p.name === 'Voyage 35');
    const setlist = await (await fetch(base + '/api/playlist-tracks?id=' + seed.id)).json();
    assert.ok(Array.isArray(setlist));
    assert.equal(setlist.length, 13);
    assert.equal(setlist[12].name, 'Radioactive Toy');
    const resolved = await (await fetch(base + '/api/player/resolve?id=' + setlist[0].id)).json();
    assert.ok(resolved && typeof resolved === 'object' && 'available' in resolved);
    assert.equal(resolved.available, true, 'seeded setlist must resolve the existing recording');
    const ownedUrl = base + '/api/upgrades/owned?artist=Porcupine%20Tree&title=Even%20Less';
    assert.equal((await fetch(ownedUrl)).status, 401);
    const owned = await (await fetch(ownedUrl, { headers: { Authorization: 'Bearer fixture-worker-token-123' } })).json();
    assert.deepEqual(owned, { files: [{ path: '/data/library/music/CD/Even Less.flac' }] });
    const created = await post('/api/local-playlists', { name: 'Mine', trackIds: ['one', 'two'] });
    assert.ok('id' in created && typeof created.id === 'string');
    await post('/api/local-playlists', { id: created.id, name: 'Reordered', trackIds: ['two', 'one', 'two'] });
    const saved = await (await fetch(base + '/api/playlist-tracks?id=' + created.id)).json();
    assert.ok(Array.isArray(saved));
    assert.deepEqual(saved.map((t: { id: string }) => t.id), ['two', 'one', 'two']);
    await post('/api/local-playlists', { id: created.id, action: 'delete' });
    const first = await post('/api/albums/import-tracks', { albumId: 'album' });
    const repeat = await post('/api/albums/import-tracks', { albumId: 'album' });
    assert.ok('jobs' in first && Array.isArray(first.jobs));
    assert.ok('jobs' in repeat && Array.isArray(repeat.jobs));
    assert.equal(first.jobs.length, 2);
    assert.deepEqual(repeat.jobs.map((j: { id: number }) => j.id), first.jobs.map((j: { id: number }) => j.id));
    assert.equal(first.jobs[0].source_url, 'ytsearch5:Porcupine Tree Even Less');
    const batch = await post('/api/upgrades', { sourceUrl: 'https://youtu.be/album', sourceMode: 'chapters', artist: 'Porcupine Tree', album: 'Test album' });
    assert.ok('job' in batch && batch.job && typeof batch.job === 'object' && 'source_mode' in batch.job);
    assert.equal(batch.job.source_mode, 'chapters');
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    await new Promise<void>(resolve => jellyfin.close(() => resolve()));
    rmSync(dir, { recursive: true });
  }
});
