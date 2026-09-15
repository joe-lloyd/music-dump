// Proves a heart on an album or artist lists it and sends its songs to the
// archive, over HTTP and in a browser. Rerunnable: pnpm run verify:likes.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, 'data', 'likes-verification');
mkdirSync(evidence, { recursive: true });
const scratch = mkdtempSync(path.join(evidence, 'run-'));
const fixture = path.join(scratch, 'spotify.db');
copyFileSync(path.join(root, 'data', 'dev-fixture.db'), fixture);
const port = 18082;
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), SPOTIFY_DB: fixture, JELLYFIN_URL: '', LISTENBRAINZ_TOKEN: '' };
for (const name of ['LIKES', 'PLAYLISTS', 'PROVENANCE', 'APP_PLAYS', 'UPGRADES', 'DISCOGS', 'LYRICS']) env[`${name}_DB`] = path.join(scratch, `${name}.db`);
const server = spawn(process.execPath, ['src/server.ts'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', b => { log += b; });
server.stderr.on('data', b => { log += b; });
let browser;
const checks = [];
async function json(url, init) { const response = await fetch(base + url, init); assert.equal(response.status, 200, await response.clone().text()); return response.json(); }
const post = (url, body) => json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const status = async (body) => (await fetch(base + '/api/likes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
const total = (g) => g.queued + g.skipped + g.lossless;
try {
  for (let i = 0; i < 100; i++) {
    try { await json('/api/tracks'); break; } catch { if (i === 99) throw new Error(log); await new Promise(r => setTimeout(r, 100)); }
  }
  // An album Spotify never saved: liking it lists it and queues every song once.
  const album = await json('/api/album?id=al03');
  assert.equal(album.album.is_saved, 0);
  assert(!(await json('/api/albums')).some(a => a.id === 'al03'));
  const liked = await post('/api/likes', { id: 'al03', kind: 'album', liked: true });
  assert.equal(liked.grabbed.queued, album.tracks.length);
  assert.equal((await json('/api/albums')).find(a => a.id === 'al03')?.liked, 1);
  const again = await post('/api/likes', { id: 'al03', kind: 'album', liked: true });
  assert.deepEqual(again.grabbed, { queued: 0, skipped: album.tracks.length, lossless: 0 });
  const queue = await json('/api/upgrades');
  assert.equal(queue.jobs.filter(j => j.album === album.album.name).length, album.tracks.length);
  assert(queue.jobs.every(j => j.auto_upgrade === 1 && j.source_url.startsWith('ytsearch5:')));
  // An artist Spotify never followed: liking covers the whole discography.
  const artist = await json('/api/artist?id=ar06');
  assert.equal(artist.artist.is_followed, 0);
  const discography = [];
  for (const a of artist.albums) discography.push(...(await json('/api/album?id=' + a.id)).tracks);
  assert(discography.length > 0, 'fixture artist needs albums');
  const likedArtist = await post('/api/likes', { id: 'ar06', kind: 'artist', liked: true });
  assert.equal(total(likedArtist.grabbed), discography.length);
  assert.equal(likedArtist.grabbed.queued, new Set(discography.map(t => `${t.artists}\n${t.name}`.toLowerCase())).size);
  assert.equal((await json('/api/artists')).find(a => a.id === 'ar06')?.liked, 1);
  assert.deepEqual(await post('/api/likes/sweep', {}), { queued: 0, skipped: album.tracks.length + discography.length, lossless: 0, likes: 2 });
  // Un-liking leaves the list, and never touches the queue.
  const before = (await json('/api/upgrades')).counts;
  assert.equal((await post('/api/likes', { id: 'al03', kind: 'album', liked: false })).grabbed, null);
  assert(!(await json('/api/albums')).some(a => a.id === 'al03'));
  await post('/api/likes', { id: 'ar06', kind: 'artist', liked: false });
  assert.notEqual((await json('/api/artists')).find(a => a.id === 'ar06')?.liked, 1);
  assert.deepEqual((await json('/api/upgrades')).counts, before);
  // A Spotify follow shows as liked until un-liked here; a Spotify save likewise.
  assert.equal((await json('/api/artists')).find(a => a.id === 'ar01')?.liked, 1);
  assert.equal((await json('/api/albums')).find(a => a.id === 'al02')?.liked, 1);
  assert.equal(await status({ id: 'missing', kind: 'album', liked: true }), 404);
  assert.equal(await status({ id: 'ar01', kind: 'playlist', liked: true }), 422);
  checks.push('HTTP: album like lists and queues once, artist like covers the discography, sweep is idempotent, unlike delists without touching the queue, Spotify saves and follows seed the lists, unknown id and kind rejected');
  browser = await chromium.launch();
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/album/al02');
    await page.getByRole('heading', { name: 'Afterimage', exact: true }).waitFor();
    const remove = page.getByRole('button', { name: 'Remove Afterimage from saved albums' });
    await remove.waitFor();
    assert.equal(await remove.getAttribute('aria-pressed'), 'true');
    await remove.click();
    const add = page.getByRole('button', { name: 'Add Afterimage to saved albums' });
    await add.waitFor();
    await add.click();
    await remove.waitFor();
    await page.getByRole('status').filter({ hasText: /queued for the archive|Already in the archive/ }).waitFor();
    await page.screenshot({ path: path.join(evidence, `album-${width}.png`), fullPage: true });
    await page.goto(base + '/artist/ar06');
    await page.getByRole('heading', { name: 'Hana North', exact: true }).waitFor();
    const follow = page.getByRole('button', { name: 'Add Hana North to favourite artists' });
    await follow.waitFor();
    await follow.click();
    await page.getByRole('button', { name: 'Remove Hana North from favourite artists' }).waitFor();
    await page.getByRole('status').filter({ hasText: /songs queued for the archive|Already in the archive/ }).waitFor();
    await page.screenshot({ path: path.join(evidence, `artist-${width}.png`), fullPage: true });
    await page.goto(base + '/artists');
    await page.getByRole('link', { name: /Hana North/ }).waitFor();
    // Put the fixture back so the next viewport starts from an unliked artist.
    await page.goto(base + '/artist/ar06');
    await page.getByRole('button', { name: 'Remove Hana North from favourite artists' }).click();
    await follow.waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    checks.push(`Browser ${width}px: album heart toggles both ways with a queue report, artist heart queues the discography, artist lists it, no overflow or runtime errors`);
    await page.close();
  }
  writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(checks, null, 2));
  console.log(checks.join('\n'));
} finally {
  await browser?.close();
  server.kill();
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
  writeFileSync(path.join(evidence, 'server.log'), log);
}
