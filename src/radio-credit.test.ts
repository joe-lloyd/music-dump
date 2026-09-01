import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ListenBrainz } from './listenbrainz.ts';
import { ProvenanceStore } from './provenance.ts';
import { RadioEngine, primaryArtist } from './radio.ts';

const REC = 'cccccccc-0000-4000-8000-000000000003';

function engineWith(lb: ListenBrainz): { engine: RadioEngine; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'credit-'));
  const provenance = new ProvenanceStore(path.join(dir, 'prov.db'));
  const engine = new RadioEngine(lb, provenance, () => new Map());
  return {
    engine,
    dispose: () => {
      provenance.close();
      lb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function stub(handler: (prompt: string) => Response): { lb: ListenBrainz; dir: string; prompts: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), 'credit-lb-'));
  const prompts: string[] = [];
  const fetchImpl = (async (url: string) => {
    const text = String(url);
    // Only the station requests are under test; the bulk duration lookup that
    // follows a station carries no prompt and must not land in the list.
    if (!text.includes('lb-radio')) return new Response('{}', { status: 200 });
    const prompt = new URL(text).searchParams.get('prompt') ?? '';
    prompts.push(prompt);
    return handler(prompt);
  }) as unknown as typeof fetch;
  return { lb: new ListenBrainz({ dbFile: path.join(dir, 'lb.db'), token: 't', fetchImpl }), dir, prompts };
}

const playlist = (creator: string) => new Response(JSON.stringify({
  payload: { jspf: { playlist: { track: [
    { creator, title: 'A Song', identifier: [`https://musicbrainz.org/recording/${REC}`] },
  ] } } },
}), { status: 200 });

const rejected = () => new Response('{"error":"Artist could not be looked up"}', { status: 400 });

// A slash never separates a featured credit, but it is inside plenty of real
// names — so it must not split, or AC/DC becomes "AC".
test('a slash is part of a name, not a separator', () => {
  assert.equal(primaryArtist('AC/DC'), 'AC/DC');
  assert.equal(primaryArtist('Emerson/Lake/Palmer'), 'Emerson/Lake/Palmer');
  assert.equal(primaryArtist('Godspeed You! Black Emperor'), 'Godspeed You! Black Emperor');
  assert.equal(primaryArtist('Nine Inch Nails'), 'Nine Inch Nails');
});

test('a credit string is reduced to the one artist a station can use', () => {
  assert.equal(primaryArtist('Bonobo & Arooj Aftab'), 'Bonobo');
  assert.equal(primaryArtist('Bonobo feat. Bajka'), 'Bonobo');
  assert.equal(primaryArtist('Run the Jewels ft. Zack de la Rocha'), 'Run the Jewels');
  assert.equal(primaryArtist('The Roots, Erykah Badu, Eve'), 'The Roots');
  assert.equal(primaryArtist('Converge'), 'Converge');
  assert.equal(primaryArtist(''), '');
  assert.equal(primaryArtist(null), '');
});

// "Simon & Garfunkel" is one band and "Bonobo & Arooj Aftab" is two artists,
// and nothing in the strings themselves tells them apart. What does tell them
// apart is that ListenBrainz resolves one and rejects the other — so the full
// credit is always tried first, and only a rejection triggers the reduction.
test('a real band name containing & is never reduced, because it resolves', async () => {
  const { lb, dir, prompts } = stub((prompt) =>
    prompt.includes('Simon & Garfunkel') ? playlist('Simon & Garfunkel') : rejected());
  const { engine, dispose } = engineWith(lb);
  try {
    const station = await engine.station({ kind: 'artist', value: 'Simon & Garfunkel' });
    assert.equal(station.entries.length, 1);
    assert.deepEqual(prompts, ['artist:(Simon & Garfunkel)'], 'must not have retried');
  } finally {
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a collaboration ListenBrainz rejects is retried with the lead artist', async () => {
  const { lb, dir, prompts } = stub((prompt) =>
    prompt === 'artist:(Bonobo)' ? playlist('Caribou') : rejected());
  const { engine, dispose } = engineWith(lb);
  try {
    const station = await engine.station({ kind: 'artist', value: 'Bonobo & Arooj Aftab' });
    assert.equal(station.entries.length, 1);
    assert.deepEqual(prompts, ['artist:(Bonobo & Arooj Aftab)', 'artist:(Bonobo)']);
  } finally {
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a name with nothing to reduce is not asked for twice', async () => {
  const { lb, dir, prompts } = stub(() => rejected());
  const { engine, dispose } = engineWith(lb);
  try {
    const station = await engine.station({ kind: 'artist', value: 'Converge' });
    assert.deepEqual(station.entries, []);
    assert.deepEqual(prompts, ['artist:(Converge)']);
  } finally {
    dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
