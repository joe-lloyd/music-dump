// Song radio: an endless station from a seed, mixing music we own with music
// we do not.
//
// The point is discovery, so a station that only plays the library would miss
// it entirely. But a station made ONLY of music we lack cannot start playing
// for however long the first download takes. The mix is the whole design:
// lead with something owned so audio starts immediately, then interleave, and
// let the fetch-ahead in the server turn the unowned ones into real files
// before the queue reaches them.
//
// Resolution is exact, not fuzzy. Lidarr stamps a MusicBrainz recording id on
// every track it imports and the sync caches that against the file path
// (lidarr_recording), so "do we own this recording?" is an index lookup.
// Anything Lidarr never saw - the YouTube singles - falls back to artist+title
// against the scanner's own match_key.
import {
  capPerArtist, spaceArtists,
  type ListenBrainz, type RadioMode, type RadioTrack,
} from './listenbrainz.ts';
import { libTrackId, provenanceKey, type ProvenanceRow, type ProvenanceStore } from './provenance.ts';

export interface RadioSeed {
  /**
   * artist  - "sounds like this artist", the everyday case
   * tag      - a genre/mood station
   * track    - similar to one specific recording
   * stats    - built from what this user actually listens to
   * recs     - ListenBrainz's own recommendations for the user
   */
  kind: 'artist' | 'tag' | 'track' | 'stats' | 'recs';
  value: string;
}

/** Where a station's tracks came from, which the UI says out loud. */
export type RadioSource = 'lb-radio' | 'similar' | 'similar+artist' | 'none';

export interface RadioEntry extends RadioTrack {
  owned: boolean;
  /** Player track id when we hold the file; null when it still has to be fetched. */
  trackId: string | null;
  path: string | null;
  row: ProvenanceRow | null;
}

/** How many tracks one artist may contribute to a station. */
const ARTIST_CAP = 2;
// Below this a station is not worth calling one, and song radio widens out to
// the artist rather than handing back four tracks.
const MIN_STATION = 12;

/**
 * The one artist a station can be built from, out of a credit string.
 *
 * File tags carry credits, not artists: "Bonobo & Arooj Aftab", "Artist feat.
 * Guest", "A, B". LB Radio looks artists up by exact name and answers a credit
 * string with a flat 400 - "could not be looked up. Please use exact
 * spelling." - so a collaboration would silently have no station at all.
 *
 * Reducing is only ever a SECOND attempt, after the exact credit has been
 * tried and rejected. That ordering is what makes it safe to split on "&" and
 * "and" at all: plenty of real bands are called "Simon & Garfunkel", "Belle
 * and Sebastian" or "Earth, Wind & Fire", and every one of them resolves on
 * the first attempt and never reaches this function.
 */
export function primaryArtist(credit: string | null | undefined): string {
  const text = String(credit ?? '').trim();
  if (!text) return '';
  // No "/" - AC/DC and Emerson/Lake/Palmer are single artists, and a slash
  // never separates a featured credit in practice.
  const cut = text.split(/\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|and|&|x)\s+|\s*[,;]\s*/i)[0];
  return (cut || text).trim();
}

export function promptFor(seed: RadioSeed): string {
  const value = seed.value.trim();
  switch (seed.kind) {
    // LB Radio's prompt language has no recording element, so a track seed
    // can only be widened to its artist here. That is the TOP-UP for song
    // radio, not the substance of it - the substance is recording similarity,
    // which station() reaches for first.
    case 'track':
    case 'artist':
      return `artist:(${value})`;
    case 'tag':
      return `tag:(${value})`;
    case 'stats':
      return `stats:(${value})`;
    case 'recs':
      return `recs:(${value})`;
  }
}

/**
 * Interleave owned and unowned so the station starts instantly and still
 * spends most of its time showing you things you have never heard.
 *
 * Leads with an owned track deliberately: the first unowned one has to be
 * downloaded before it can play, and a station that opens with a spinner is a
 * broken station. After that it alternates, falling back to whichever list
 * still has entries.
 */
export function interleave(owned: RadioEntry[], fresh: RadioEntry[]): RadioEntry[] {
  const out: RadioEntry[] = [];
  const left = [...owned];
  const right = [...fresh];
  let takeOwned = true;
  while (left.length || right.length) {
    const from = takeOwned ? left : right;
    const other = takeOwned ? right : left;
    const next = from.shift() ?? other.shift();
    if (next) out.push(next);
    takeOwned = !takeOwned;
  }
  return out;
}

export class RadioEngine {
  private readonly lb: ListenBrainz;
  private readonly provenance: ProvenanceStore;
  private readonly ownedPaths: (mbids: string[]) => Map<string, string>;

  /**
   * `ownedPaths` maps recording MBIDs to library file paths. It is injected
   * rather than queried here so the taste DB stays the server's business and
   * this stays testable without a database.
   */
  constructor(
    lb: ListenBrainz,
    provenance: ProvenanceStore,
    ownedPaths: (mbids: string[]) => Map<string, string>,
  ) {
    this.lb = lb;
    this.provenance = provenance;
    this.ownedPaths = ownedPaths;
  }

  /**
   * Ask LB Radio for a station, retrying once with the credit reduced to its
   * lead artist.
   *
   * LB Radio resolves artists by exact name, so a credit string comes back as
   * a 400 rather than an empty list. Trying the full credit first means real
   * band names containing "&" or "and" are never mangled - they simply
   * succeed - and only a genuine collaboration ever gets cut down.
   */
  private async ask(seed: RadioSeed, mode: RadioMode): Promise<RadioTrack[]> {
    try {
      return await this.lb.radio(promptFor(seed), mode);
    } catch (err) {
      if (seed.kind !== 'artist' && seed.kind !== 'track') throw err;
      const lead = primaryArtist(seed.value);
      if (!lead || lead === seed.value.trim()) throw err;
      return this.lb.radio(promptFor({ kind: seed.kind, value: lead }), mode);
    }
  }

  /** Resolve a batch of ListenBrainz recordings against the library. */
  resolve(tracks: RadioTrack[]): RadioEntry[] {
    const byMbid = this.ownedPaths(tracks.map((track) => track.recordingMbid));
    return tracks.map((track) => {
      let path = byMbid.get(track.recordingMbid) ?? null;
      let row = path ? this.provenance.trackById(libTrackId(path)) : null;
      if (!row) {
        // Not managed by Lidarr, or scanned under a different path: the
        // singles live here. Name matching is the only handle we have.
        row = this.provenance.byMatchKey(provenanceKey(track.artist, track.title));
        path = row?.path ?? null;
      }
      return {
        ...track,
        owned: Boolean(row),
        trackId: row ? libTrackId(row.path) : null,
        path,
        row: row ?? null,
      };
    });
  }

  /**
   * Build a station. Prefers LB Radio, which diversifies internally; falls
   * back to raw recording similarity, which does not, and so is capped and
   * spaced before use.
   */
  async station(seed: RadioSeed, options?: {
    mode?: RadioMode;
    limit?: number;
    recordingMbid?: string;
  }): Promise<{ entries: RadioEntry[]; source: RadioSource }> {
    const limit = options?.limit ?? 40;
    let source: RadioSource = 'none';
    let tracks: RadioTrack[] = [];

    // SONG radio, not band radio. "Songs like this song" is a different
    // question from "songs like this band", and only recording similarity
    // answers it - LB Radio would just widen straight back out to the artist.
    if (seed.kind === 'track' && options?.recordingMbid) {
      try {
        const similar = await this.lb.similar(options.recordingMbid);
        tracks = spaceArtists(capPerArtist(similar, ARTIST_CAP));
        if (tracks.length) source = 'similar';
      } catch {
        tracks = [];
      }
      // Similarity is thin for anything obscure - a track nobody streams next
      // to anything else has no neighbours. Top up from the artist so a song
      // radio always plays, and mark it as the blend it actually is.
      if (tracks.length < MIN_STATION) {
        try {
          const wider = await this.ask(seed, options?.mode ?? 'medium');
          const seen = new Set(tracks.map((track) => track.recordingMbid));
          tracks = tracks.concat(wider.filter((track) => !seen.has(track.recordingMbid)));
          if (tracks.length) source = source === 'similar' ? 'similar+artist' : 'lb-radio';
        } catch { /* whatever similarity found still stands */ }
      }
    }

    if (!tracks.length) {
      try {
        tracks = await this.ask(seed, options?.mode ?? 'medium');
        if (tracks.length) source = 'lb-radio';
      } catch {
        tracks = [];        // fall through to similarity
      }
    }

    if (!tracks.length && options?.recordingMbid) {
      try {
        tracks = spaceArtists(capPerArtist(await this.lb.similar(options.recordingMbid), ARTIST_CAP));
        if (tracks.length) source = 'similar';
      } catch {
        tracks = [];
      }
    }
    if (!tracks.length) return { entries: [], source: 'none' };

    // LB Radio can repeat a recording across its internal strategies.
    const seen = new Set<string>();
    const unique = tracks.filter((track) => {
      if (seen.has(track.recordingMbid)) return false;
      seen.add(track.recordingMbid);
      return true;
    });

    const resolved = this.resolve(unique);
    // Similarity carries no duration, and duration is what stops the
    // fetch-ahead grabbing a live take or an hour-long mix. One bulk call
    // fills it in for the tracks that still need it.
    const missing = resolved.filter((entry) => !entry.owned && !entry.durationMs);
    if (missing.length) {
      try {
        const lengths = await this.lb.recordingLengths(missing.map((entry) => entry.recordingMbid));
        for (const entry of missing) {
          entry.durationMs = lengths.get(entry.recordingMbid) ?? null;
        }
      } catch { /* a station without durations still plays */ }
    }
    const owned = resolved.filter((entry) => entry.owned);
    const fresh = resolved.filter((entry) => !entry.owned);
    return { entries: interleave(owned, fresh).slice(0, limit), source };
  }
}
