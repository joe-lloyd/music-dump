// The album a track belongs to, for music the library only holds as a single.
//
// A track pulled from YouTube arrives with an artist, a title and nothing else:
// no album, no tracklist, no idea what record it came off. That is the blank
// this fills. Given a recording it resolves the album, stores the whole
// tracklist as a *reference* - rows describing music we do not have - and from
// there the album can be asked for whole, from Lidarr or from YouTube.
//
// Why MusicBrainz and not Lidarr, when the point is to ask Lidarr for it:
// Lidarr runs on eliot behind an API key that deliberately never leaves that
// box (HomeLab: pi-server/lidarr-library-sync), and eliot sleeps. A lookup on
// a UI click can depend on neither. It does not need to - Lidarr's
// foreignAlbumId IS the MusicBrainz release-group id, so resolving here
// produces exactly the identifier Lidarr is later asked with.

import { mbGet, sleep } from './musicbrainz.ts';

/** One row of a tracklist, whether or not the library has it. */
export interface ReferenceTrack {
  position: number;
  disc: number;
  recordingMbid: string | null;
  title: string;
  lengthMs: number | null;
}

export interface ReferenceAlbum {
  /** Lidarr's foreignAlbumId. The album's identity everywhere in this feature. */
  releaseGroupMbid: string;
  /** The specific release the tracklist was read from. Editions differ. */
  releaseMbid: string;
  title: string;
  artist: string;
  artistMbid: string | null;
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleased: string | null;
  tracks: ReferenceTrack[];
}

/** A release-group a recording appears on, before we pay for its tracklist. */
export interface GroupCandidate {
  releaseGroupMbid: string;
  releaseMbid: string;
  title: string;
  artist: string;
  primaryType: string | null;
  secondaryTypes: string[];
  /** The release-GROUP's first release date. Identical for every edition. */
  firstReleased: string | null;
  /** This edition's own date, which is what separates original from reissue. */
  releaseDate: string | null;
  trackCount: number;
}

// How much a release-group looks like "the album this song is off".
//
// The question has a wrong answer that matters: ask Lidarr for the compilation
// a track also appears on and it monitors, downloads and files forty tracks of
// greatest hits instead of the record. So a studio album outranks everything,
// and the shapes that are usually somebody else's packaging of the song -
// compilations, live sets, DJ mixes - fall below even an unknown type.
const PRIMARY_SCORE: Record<string, number> = {
  album: 100,
  ep: 70,
  other: 30,
  single: 15,
  broadcast: 5,
};
const SECONDARY_PENALTY: Record<string, number> = {
  // Heavy enough to put a compilation *below* a release whose type nobody has
  // filled in. At 60 the two tied, and the tie broke on release date - which
  // would hand a 1998 greatest-hits the album slot over an untyped record.
  compilation: 70,
  live: 50,
  'dj-mix': 50,
  'mixtape/street': 40,
  remix: 40,
  demo: 25,
  soundtrack: 10,
  interview: 100,
  audiobook: 100,
  audio_drama: 100,
  spokenword: 100,
};

// An unknown primary type scores between EP and Other: MusicBrainz leaves it
// unset often enough that treating "unset" as "bad" would reject real albums.
const UNKNOWN_PRIMARY = 40;
const EP_SCORE = 70;

export function albumScore(album: { primaryType: string | null; secondaryTypes: string[] }): number {
  const primary = album.primaryType?.toLowerCase() ?? '';
  let score = primary ? PRIMARY_SCORE[primary] ?? UNKNOWN_PRIMARY : UNKNOWN_PRIMARY;
  for (const secondary of album.secondaryTypes) {
    score -= SECONDARY_PENALTY[secondary.toLowerCase()] ?? 0;
  }
  return score;
}

/**
 * Good enough to stop looking.
 *
 * ListenBrainz hands us a release for free alongside the recording id, but
 * which release it picked is not our choice - often enough it is a single or a
 * compilation. This is the test for "keep it" versus "spend two more
 * MusicBrainz calls finding the record proper".
 */
export function isCanonicalAlbum(album: {
  primaryType: string | null;
  secondaryTypes: string[];
  tracks?: unknown[];
}): boolean {
  if (albumScore(album) < EP_SCORE) return false;
  // A one-track "album" is a single wearing the wrong type. Loading it as a
  // reference teaches the library nothing it did not already have.
  return !album.tracks || album.tracks.length > 1;
}

/**
 * Is this record credited to the artist whose song we are placing?
 *
 * The check that catches what type scoring alone does not. Resolving Bonobo's
 * "Kerala" against MusicBrainz really does answer "Chillout Sessions 20", a
 * 42-track Various Artists DJ-mix - a compilation the song appears on, not the
 * record it is off. Nothing about its *type* is unusual enough to reject; who
 * it is credited to is.
 *
 * Containment in either direction, because the two names legitimately differ:
 * a track credited "Bonobo & Arooj Aftab" comes off an album credited "Bonobo".
 */
export function artistMatches(wanted: string | null | undefined, credited: string): boolean {
  const a = normalizeArtist(wanted);
  const b = normalizeArtist(credited);
  if (!a || !b) return true;      // nothing to compare - do not reject on it
  return a === b || a.includes(b) || b.includes(a);
}

function normalizeArtist(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The best album among the release-groups a recording appears on.
 *
 * Ties break on the earliest release: when a song is on both the album and its
 * deluxe reissue, the original is the record it is *off*.
 */
export function pickAlbumGroup(candidates: GroupCandidate[]): GroupCandidate | null {
  const ranked = candidates
    .filter((candidate) => candidate.releaseGroupMbid && candidate.releaseMbid)
    .map((candidate) => ({ candidate, score: albumScore(candidate) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dateA = a.candidate.firstReleased ?? '9999';
      const dateB = b.candidate.firstReleased ?? '9999';
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      // Last resort, and only so the choice is the same on every run.
      return a.candidate.releaseGroupMbid.localeCompare(b.candidate.releaseGroupMbid);
    });
  return ranked[0]?.candidate ?? null;
}

/** "Bonobo & Arooj Aftab" from MusicBrainz's credit array, joinphrases included. */
function creditName(credits: unknown): string {
  if (!Array.isArray(credits)) return '';
  return credits
    .map((credit) => {
      const entry = credit as { name?: string; artist?: { name?: string }; joinphrase?: string };
      return `${entry.name ?? entry.artist?.name ?? ''}${entry.joinphrase ?? ''}`;
    })
    .join('')
    .trim();
}

function firstArtistMbid(credits: unknown): string | null {
  if (!Array.isArray(credits)) return null;
  for (const credit of credits) {
    const id = (credit as { artist?: { id?: string } }).artist?.id;
    if (id) return String(id).toLowerCase();
  }
  return null;
}

function secondaryTypesOf(group: unknown): string[] {
  const raw = (group as { 'secondary-types'?: unknown })?.['secondary-types'];
  return Array.isArray(raw) ? raw.map((type) => String(type)) : [];
}

/**
 * Shape a MusicBrainz release into an album reference.
 *
 * Kept separate from the fetch so the rules above can be tested against
 * recorded payloads rather than the live API.
 */
export function parseRelease(body: unknown): ReferenceAlbum | null {
  const release = body as {
    id?: string;
    title?: string;
    date?: string;
    'artist-credit'?: unknown;
    'release-group'?: {
      id?: string;
      title?: string;
      'primary-type'?: string;
      'first-release-date'?: string;
      'artist-credit'?: unknown;
    };
    media?: { position?: number; tracks?: unknown[] }[];
  } | null;
  const group = release?.['release-group'];
  if (!release?.id || !group?.id) return null;

  const tracks: ReferenceTrack[] = [];
  for (const [index, medium] of (release.media ?? []).entries()) {
    const disc = Number(medium?.position) || index + 1;
    for (const [trackIndex, raw] of (medium?.tracks ?? []).entries()) {
      const track = raw as {
        position?: number;
        title?: string;
        length?: number;
        recording?: { id?: string; title?: string; length?: number };
      };
      const title = String(track.title ?? track.recording?.title ?? '').trim();
      if (!title) continue;
      const length = Number(track.length ?? track.recording?.length);
      tracks.push({
        disc,
        position: Number(track.position) || trackIndex + 1,
        recordingMbid: track.recording?.id ? String(track.recording.id).toLowerCase() : null,
        title,
        lengthMs: Number.isFinite(length) && length > 0 ? Math.round(length) : null,
      });
    }
  }
  if (!tracks.length) return null;

  const credits = release['artist-credit'] ?? group['artist-credit'];
  return {
    releaseGroupMbid: String(group.id).toLowerCase(),
    releaseMbid: String(release.id).toLowerCase(),
    title: String(group.title ?? release.title ?? '').trim(),
    artist: creditName(credits),
    artistMbid: firstArtistMbid(credits),
    primaryType: group['primary-type'] ? String(group['primary-type']) : null,
    secondaryTypes: secondaryTypesOf(group),
    firstReleased: group['first-release-date'] || release.date || null,
    tracks,
  };
}

/** Every release-group the recording appears on, ranking data only. */
export function parseRecordingGroups(body: unknown): GroupCandidate[] {
  const releases = (body as { releases?: unknown[] } | null)?.releases;
  if (!Array.isArray(releases)) return [];
  // One entry per release-group: several releases of one album (CD, vinyl,
  // reissue) are the same answer, and only one of them needs fetching.
  const byGroup = new Map<string, GroupCandidate>();
  for (const raw of releases) {
    const release = raw as {
      id?: string;
      date?: string;
      status?: string;
      'track-count'?: number;
      'artist-credit'?: unknown;
      media?: { 'track-count'?: number }[];
      'release-group'?: {
        id?: string;
        title?: string;
        'primary-type'?: string;
        'first-release-date'?: string;
        'artist-credit'?: unknown;
      };
    };
    const group = release['release-group'];
    if (!release.id || !group?.id) continue;
    const id = String(group.id).toLowerCase();
    const trackCount = Number(release['track-count'])
      || (release.media ?? []).reduce((sum, medium) => sum + (Number(medium?.['track-count']) || 0), 0);
    const candidate: GroupCandidate = {
      releaseGroupMbid: id,
      releaseMbid: String(release.id).toLowerCase(),
      title: String(group.title ?? '').trim(),
      artist: creditName(release['artist-credit'] ?? group['artist-credit']),
      primaryType: group['primary-type'] ? String(group['primary-type']) : null,
      secondaryTypes: secondaryTypesOf(group),
      firstReleased: group['first-release-date'] || release.date || null,
      releaseDate: release.date || null,
      trackCount,
    };
    const existing = byGroup.get(id);
    // Within one group prefer the earliest release: that is the edition whose
    // tracklist is the album as it came out, rather than a later reissue.
    //
    // On the RELEASE's own date, not the group's. Every edition of a group
    // reports the same `first-release-date`, so comparing that compared a
    // value to itself and the winner was whichever release MusicBrainz
    // happened to list first. Insurgentes is the case that showed it: the
    // 3-disc hardback book edition and a later 5-track digital bonus disc are
    // one group, and picking the wrong one means "build out the album"
    // rebuilds five tracks instead of thirty-nine.
    if (!existing || (candidate.releaseDate ?? '9999') < (existing.releaseDate ?? '9999')) {
      byGroup.set(id, candidate);
    }
  }
  return [...byGroup.values()];
}

const RELEASE_INC = 'recordings+artist-credits+release-groups';
const RECORDING_INC = 'releases+release-groups+artist-credits';

/** The tracklist of one release, as an album reference. */
export async function fetchAlbumByRelease(releaseMbid: string): Promise<ReferenceAlbum | null> {
  const body = await mbGet(`release/${encodeURIComponent(releaseMbid)}`, { inc: RELEASE_INC });
  await sleep(1100);
  return parseRelease(body);
}

export async function fetchRecordingGroups(recordingMbid: string): Promise<GroupCandidate[]> {
  const body = await mbGet(`recording/${encodeURIComponent(recordingMbid)}`, { inc: RECORDING_INC });
  await sleep(1100);
  return parseRecordingGroups(body);
}

export interface ResolveInput {
  recordingMbid?: string | null;
  releaseMbid?: string | null;
  /** Who the track is by. Supplying it is what rejects a Various Artists comp. */
  artist?: string | null;
}

/**
 * The album a recording belongs to, in as few MusicBrainz calls as it takes.
 *
 * One call in the common case: ListenBrainz already hands the release id over
 * with the recording id (server.ts's radio enrichment stores both on the job),
 * and a release fetch returns the tracklist and its release-group together. A
 * second and third are spent only when that release turns out to be a single or
 * a compilation - which is the case worth spending them on.
 *
 * The fetchers are injectable so the orchestration is testable without the
 * network, and so a caller can share one budget across many tracks.
 */
export async function resolveAlbum(
  input: ResolveInput,
  deps: {
    byRelease?: (releaseMbid: string) => Promise<ReferenceAlbum | null>;
    groups?: (recordingMbid: string) => Promise<GroupCandidate[]>;
  } = {},
): Promise<ReferenceAlbum | null> {
  const byRelease = deps.byRelease ?? fetchAlbumByRelease;
  const groups = deps.groups ?? fetchRecordingGroups;

  const acceptable = (album: ReferenceAlbum | null): boolean =>
    Boolean(album && isCanonicalAlbum(album) && artistMatches(input.artist, album.artist));

  let fallback: ReferenceAlbum | null = null;
  if (input.releaseMbid) {
    const album = await byRelease(input.releaseMbid);
    if (acceptable(album)) return album;
    fallback = album;
  }
  if (input.recordingMbid) {
    const candidates = (await groups(input.recordingMbid))
      .filter((candidate) => artistMatches(input.artist, candidate.artist));
    const best = pickAlbumGroup(candidates);
    if (best
      && best.releaseMbid !== input.releaseMbid
      && (!fallback || albumScore(best) > albumScore(fallback))) {
      const album = await byRelease(best.releaseMbid);
      if (acceptable(album)) return album;
      if (album && (!fallback || albumScore(album) > albumScore(fallback))) fallback = album;
    }
  }

  // Nothing album-shaped and credited to this artist. A blank is the honest
  // answer: the alternative is offering to send Lidarr after a 42-track DJ-mix
  // because the song happens to appear on it, and Lidarr would go and get it.
  return acceptable(fallback) ? fallback : null;
}
