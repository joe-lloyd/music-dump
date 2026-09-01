// Which file on disk is a record's cover.
//
// Its own module because three request handlers each grew a copy of this and
// the copies drifted: every card in the Albums page's "Saved" section came
// back blank while the same records showed art on Latest. One answer, one
// place, under test.
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';

export type Artwork = { file: string; type: string };

/** How recently a file changed; 0 when it cannot be read at all. */
function mtime(at: string): number {
  try {
    return statSync(at).mtimeMs;
  } catch {
    return 0;
  }
}

function artworkAt(file: string): Artwork | null {
  try {
    statSync(file);
    return { file, type: file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' };
  } catch {
    return null;
  }
}

/** The names a whole-album cover goes by, in the order they are trusted. */
export const COVER_NAMES = ['cover.jpg', 'folder.jpg', 'cover.png', 'folder.png'];

/**
 * The cover for a directory, searching upward toward the library root.
 *
 * A multi-disc release keeps its audio in "Album/12 Vinyl 01/" while cover.jpg
 * stays in "Album/", so looking only beside the track finds nothing. Bounded
 * to three levels and never escapes the library root, so a stray file high up
 * cannot become the art for half the collection.
 */
export function findCover(startDir: string, libraryRoot: string): Artwork | null {
  const root = path.resolve(libraryRoot);
  let dir = path.resolve(startDir);
  for (let up = 0; up < 3; up += 1) {
    if (dir !== root && !dir.startsWith(root + path.sep)) return null;
    for (const name of COVER_NAMES) {
      const found = artworkAt(path.join(dir, name));
      if (found) return found;
    }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * What a record looks like, wherever it is asked for.
 *
 * Three surfaces used to answer this three separate ways and drifted apart
 * twice. /img/folder learned the singles fallback; the library-album branch of
 * /img/local was given a copy of it; and locally imported albums were left
 * checking four hard-coded cover names that a singles folder does not have -
 * so the Albums page's whole "Saved" section came back blank while the very
 * same records showed their art on Latest.
 *
 * `trackFile` is the audio when the caller has ONE record in mind. That is the
 * difference that matters: a single sharing a folder with a dozen others then
 * gets its own sleeve rather than a sibling's.
 */
export function resolveArtwork(
  libraryRoot: string,
  dirAbs: string,
  trackFile?: string | null,
): Artwork | null {
  // A single's own sidecar is the most specific answer there is, and it is
  // what both the artwork backfill and yt-dlp write: "<track name>.jpg".
  if (trackFile) {
    const stem = path.join(path.dirname(trackFile), path.parse(trackFile).name);
    for (const ext of ['.jpg', '.png']) {
      const found = artworkAt(stem + ext);
      if (found) return found;
    }
  }
  const cover = findCover(dirAbs, libraryRoot);
  if (cover) return cover;
  // Last resort: the newest sidecar in the folder. A singles folder has no
  // cover.jpg on purpose - each single wears its own art - so a card standing
  // for the whole folder borrows the freshest sleeve rather than showing
  // nothing. Asked for by one single whose OWN art is missing, a sibling's is
  // still a better answer than a blank: 10 of 62 collections keyed on exactly
  // such a file. Ordinary album folders have cover.jpg and never reach this.
  try {
    const newest = readdirSync(dirAbs)
      .filter((file) => file.toLowerCase().endsWith('.jpg') && !file.startsWith('.'))
      .map((file) => path.join(dirAbs, file))
      .map((file) => ({ file, at: mtime(file) }))
      .sort((a, b) => b.at - a.at)[0];
    if (newest) return { file: newest.file, type: 'image/jpeg' };
  } catch { /* unreadable while eliot sleeps */ }
  return null;
}
