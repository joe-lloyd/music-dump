// The Albums page showed blank cards for records that had art on Latest,
// twice, because three request handlers each answered "what does this look
// like?" their own way. These pin the one answer they now share.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findCover, resolveArtwork } from './artwork.ts';

function library(): { root: string; add: (rel: string, at?: number) => string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'artwork-'));
  return {
    root,
    add(rel, at) {
      const file = path.join(root, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'x');
      if (at !== undefined) utimesSync(file, at, at);
      return file;
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('an ordinary album wears the cover in its folder', () => {
  const lib = library();
  try {
    const cover = lib.add('Tool/Lateralus (2001)/cover.jpg');
    lib.add('Tool/Lateralus (2001)/01 The Grudge.flac');
    const found = resolveArtwork(lib.root, path.join(lib.root, 'Tool/Lateralus (2001)'));
    assert.deepEqual(found, { file: cover, type: 'image/jpeg' });
  } finally {
    lib.dispose();
  }
});

test('a multi-disc release finds the cover a level up', () => {
  const lib = library();
  try {
    const cover = lib.add('Artist/Album (1999)/cover.jpg');
    lib.add('Artist/Album (1999)/CD 01/01 One.flac');
    const found = findCover(path.join(lib.root, 'Artist/Album (1999)/CD 01'), lib.root);
    assert.equal(found?.file, cover);
  } finally {
    lib.dispose();
  }
});

test('the search never climbs out of the library', () => {
  const lib = library();
  try {
    // A cover sitting beside the library must never become its art.
    const outside = path.join(lib.root, '..', `escape-${path.basename(lib.root)}.jpg`);
    writeFileSync(outside, 'x');
    try {
      assert.equal(findCover(lib.root, lib.root), null);
      assert.equal(findCover(path.join(lib.root, 'Artist'), lib.root), null);
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    lib.dispose();
  }
});

// The bug: a locally imported single is ONE record living in a folder shared
// with a dozen unrelated singles, and it was resolved by looking for
// cover.jpg / folder.jpg - names a singles folder does not have. Every such
// card came back blank even though its sleeve was sitting right beside the
// audio.
test('a single in a shared folder wears its own sleeve', () => {
  const lib = library();
  try {
    const audio = lib.add('_Singles/Yppah/In My Drink.opus');
    const own = lib.add('_Singles/Yppah/In My Drink.jpg');
    lib.add('_Singles/Yppah/Someone Else Song.jpg');
    const found = resolveArtwork(lib.root, path.dirname(audio), audio);
    assert.deepEqual(found, { file: own, type: 'image/jpeg' }, 'must not borrow a sibling');
  } finally {
    lib.dispose();
  }
});

// The other half, from the previous round: keying a whole collection on one
// single whose art is missing blanked the card while its siblings held
// sleeves. A sibling's sleeve beats a blank.
test('a single with no art of its own borrows the freshest sibling', () => {
  const lib = library();
  try {
    const audio = lib.add('_Singles/Nosaj Thing/Fated.opus');
    lib.add('_Singles/Nosaj Thing/Old One.jpg', 1_600_000_000);
    const newest = lib.add('_Singles/Nosaj Thing/Newer One.jpg', 1_700_000_000);
    const found = resolveArtwork(lib.root, path.dirname(audio), audio);
    assert.equal(found?.file, newest);
  } finally {
    lib.dispose();
  }
});

test('a folder cover still wins over a stray sidecar', () => {
  const lib = library();
  try {
    const cover = lib.add('Artist/Album (2020)/cover.jpg');
    lib.add('Artist/Album (2020)/02 Track.jpg');
    const found = resolveArtwork(lib.root, path.join(lib.root, 'Artist/Album (2020)'));
    assert.equal(found?.file, cover, 'a whole-album cover speaks for the album');
  } finally {
    lib.dispose();
  }
});

test('a record with no art anywhere resolves to nothing', () => {
  const lib = library();
  try {
    const audio = lib.add('_Singles/Nobody/Untitled.opus');
    assert.equal(resolveArtwork(lib.root, path.dirname(audio), audio), null);
    assert.equal(resolveArtwork(lib.root, path.join(lib.root, 'does/not/exist')), null);
  } finally {
    lib.dispose();
  }
});
