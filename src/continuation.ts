// Album-to-album autoplay selection.
//
// This deliberately works from metadata already on disk. MusicBrainz gives
// the app durable artist identities, but not useful energy/mood features;
// making a public API call while a record is ending would also put silence on
// the play path. The Spotify-era genre cache is enough to keep an ambient or
// downtempo run in roughly the same lane, and the deterministic fallback still
// works for artists which have no genre metadata at all.
import { normalizeMusicText } from './jellyfin.ts';

export type ContinuationReason = 'same-artist' | 'same-vibe' | 'next-artist';

export interface ContinuationAlbum {
  id: string;
  name: string;
  artist: string;
  /** ISO release date when known; otherwise the date the files landed. */
  sortDate: string;
  genres: string[];
  /** Personal affinity. Only breaks ties after musical similarity. */
  affinity: number;
}

export interface ContinuationChoice {
  album: ContinuationAlbum;
  reason: ContinuationReason;
  /** Non-zero only when local genre metadata found a meaningful overlap. */
  vibeScore: number;
}

const GENRE_WORDS_TO_IGNORE = new Set([
  'and', 'music', 'modern', 'new', 'classic', 'alternative', 'contemporary',
]);

// Broad mood/instrumentation lanes catch useful relationships which literal
// genre equality misses: "chillwave", "ambient pop" and "downtempo" should
// be allowed to follow one another even though their words do not overlap.
const VIBE_LANES: Record<string, string[]> = {
  chill: ['ambient', 'chill', 'downtempo', 'dream pop', 'lo fi', 'lounge', 'trip hop', 'slowcore'],
  heavy: ['metal', 'hardcore', 'grind', 'sludge', 'doom', 'noise rock', 'post hardcore'],
  electronic: ['electronic', 'electronica', 'techno', 'house', 'trance', 'synth', 'drum and bass', 'idm'],
  hiphop: ['hip hop', 'rap', 'trap', 'grime', 'boom bap'],
  soul: ['soul', 'r and b', 'rnb', 'funk', 'motown', 'gospel'],
  folk: ['folk', 'country', 'americana', 'bluegrass', 'singer songwriter'],
  jazz: ['jazz', 'bebop', 'fusion', 'bossa nova'],
  classical: ['classical', 'baroque', 'romantic', 'orchestral', 'chamber'],
};

function artistKey(value: string): string {
  return normalizeMusicText(value);
}

function normalizedGenres(genres: string[]): string[] {
  return [...new Set(genres.map(normalizeMusicText).filter(Boolean))];
}

function genreWords(genres: string[]): Set<string> {
  const out = new Set<string>();
  for (const genre of normalizedGenres(genres)) {
    for (const word of genre.split(' ')) {
      if (word.length > 2 && !GENRE_WORDS_TO_IGNORE.has(word)) out.add(word);
    }
  }
  return out;
}

function lanesFor(genres: string[]): Set<string> {
  const joined = ` ${normalizedGenres(genres).join(' | ')} `;
  const lanes = new Set<string>();
  for (const [lane, terms] of Object.entries(VIBE_LANES)) {
    if (terms.some((term) => joined.includes(normalizeMusicText(term)))) lanes.add(lane);
  }
  return lanes;
}

/**
 * Similarity from cached genre labels. Exact labels are strongest, shared
 * descriptive words next, and a broad vibe lane is the last useful signal.
 */
export function genreSimilarity(left: string[], right: string[]): number {
  const a = new Set(normalizedGenres(left));
  const b = new Set(normalizedGenres(right));
  if (!a.size || !b.size) return 0;
  let score = 0;
  for (const genre of a) if (b.has(genre)) score += 100;
  const aw = genreWords(left);
  const bw = genreWords(right);
  for (const word of aw) if (bw.has(word)) score += 20;
  const al = lanesFor(left);
  const bl = lanesFor(right);
  for (const lane of al) if (bl.has(lane)) score += 12;
  return score;
}

function newestFirst(a: ContinuationAlbum, b: ContinuationAlbum): number {
  return b.sortDate.localeCompare(a.sortDate) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function latestPerArtist(albums: ContinuationAlbum[]): ContinuationAlbum[] {
  const groups = new Map<string, ContinuationAlbum[]>();
  for (const album of albums) {
    const key = artistKey(album.artist);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(album);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => group.sort(newestFirst)[0]);
}

/**
 * Pick the album which should be appended when the current queue runs out.
 *
 * 1. Walk the current artist's albums newest-to-oldest, wrapping around so a
 *    session started in the middle still hears the rest of their catalogue.
 * 2. From every other artist, consider their newest unplayed album and prefer
 *    genre/mood overlap. Personal affinity breaks ties, not the vibe.
 * 3. With no genre evidence, move alphabetically to the next artist and play
 *    their newest album. That makes the fallback predictable and endless.
 */
export function chooseContinuation(
  albums: ContinuationAlbum[],
  options: { currentAlbumId?: string | null; currentArtist?: string | null; visitedAlbumIds?: Iterable<string> },
): ContinuationChoice | null {
  const visited = new Set(options.visitedAlbumIds ?? []);
  if (options.currentAlbumId) visited.add(options.currentAlbumId);
  const available = albums.filter((album) => album.id && !visited.has(album.id));
  if (!available.length) return null;

  const current = albums.find((album) => album.id === options.currentAlbumId);
  const currentArtist = artistKey(current?.artist || options.currentArtist || '');
  const artistAlbums = albums.filter((album) => artistKey(album.artist) === currentArtist).sort(newestFirst);
  if (currentArtist && artistAlbums.length) {
    const currentIndex = artistAlbums.findIndex((album) => album.id === options.currentAlbumId);
    const ordered = currentIndex < 0
      ? artistAlbums
      : artistAlbums.slice(currentIndex + 1).concat(artistAlbums.slice(0, currentIndex));
    const sameArtist = ordered.find((album) => !visited.has(album.id));
    if (sameArtist) return { album: sameArtist, reason: 'same-artist', vibeScore: 0 };
  }

  const otherArtists = latestPerArtist(available.filter((album) => artistKey(album.artist) !== currentArtist));
  if (!otherArtists.length) return null;
  const seedGenres = current?.genres ?? albums.find((album) => artistKey(album.artist) === currentArtist)?.genres ?? [];
  const ranked = otherArtists.map((album) => ({ album, vibeScore: genreSimilarity(seedGenres, album.genres) }))
    .sort((a, b) => b.vibeScore - a.vibeScore
      || b.album.affinity - a.album.affinity
      || newestFirst(a.album, b.album));
  if (ranked[0].vibeScore > 0) {
    return { album: ranked[0].album, reason: 'same-vibe', vibeScore: ranked[0].vibeScore };
  }

  const byArtist = otherArtists.sort((a, b) => artistKey(a.artist).localeCompare(artistKey(b.artist)) || newestFirst(a, b));
  const after = byArtist.find((album) => artistKey(album.artist) > currentArtist);
  return { album: after ?? byArtist[0], reason: 'next-artist', vibeScore: 0 };
}
