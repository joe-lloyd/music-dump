// Spotify artist → MusicBrainz artist id (MBID) resolution. Lidarr's custom
// import list only understands MBIDs, so /api/lidarr-list (server.ts) serves
// from the artist_mbid cache this stage fills. Runs outside the Spotify-quota
// try in main.ts: musicbrainz.org is a separate API with its own limits
// (1 req/s, mandatory User-Agent).
import { TasteDb } from './db.ts';

const MB_API = 'https://musicbrainz.org/ws/2';
const UA = 'spotify-taste-db/1.0 (https://github.com/joe-lloyd/music-dump)';
// Per-run cap: first run resolves the whole eligible backlog at ~1.1s each,
// later runs only touch new artists and stale no-matches.
const MB_LIMIT = Number(process.env.LIDARR_MB_LIMIT ?? 500);
// Artists with at least this many liked tracks qualify even when not followed.
// server.ts applies the same threshold when serving the list — keep in sync.
const MIN_LIKED = Number(process.env.LIDARR_MIN_LIKED ?? 3);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mbGet(pathName: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${MB_API}/${pathName}`);
  for (const [k, v] of Object.entries({ ...params, fmt: 'json' })) url.searchParams.set(k, v);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if ((res.status === 429 || res.status === 503) && attempt <= 4) {
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`musicbrainz ${pathName} failed (${res.status})`);
    return res.json();
  }
}

// Case/diacritic-insensitive comparison — "Beyoncé" credits vs Spotify's name.
function normalize(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeLucene(term: string): string {
  return term.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');
}

// Strongest signal: an ISRC identifies a specific recording, and MB returns
// its artist credits — no fuzzy matching involved beyond picking our artist
// out of the credit list (collabs credit several artists).
async function resolveViaIsrc(db: TasteDb, artistId: string, artistName: string): Promise<string | null> {
  const isrcs = (db.db.prepare(`
    SELECT DISTINCT t.isrc FROM tracks t
    JOIN track_artists ta ON ta.track_id = t.id
    LEFT JOIN liked_tracks lt ON lt.track_id = t.id
    WHERE ta.artist_id = ? AND t.isrc IS NOT NULL
    ORDER BY (lt.track_id IS NOT NULL) DESC, t.popularity DESC
    LIMIT 2`).all(artistId) as { isrc: string }[]).map((r) => r.isrc);
  const wanted = normalize(artistName);
  for (const isrc of isrcs) {
    const body = await mbGet(`isrc/${encodeURIComponent(isrc)}`, { inc: 'artist-credits' });
    await sleep(1100);
    for (const rec of body?.recordings ?? []) {
      for (const credit of rec['artist-credit'] ?? []) {
        if (credit.artist?.id && normalize(credit.artist.name ?? credit.name ?? '') === wanted) {
          return credit.artist.id;
        }
      }
    }
  }
  return null;
}

// Fallback: name search. Only accept an exact (normalized) name match — a
// wrong MBID makes Lidarr monitor a stranger's discography, so prefer a miss
// ('' row, retried monthly) over a guess.
async function resolveViaSearch(artistName: string): Promise<string | null> {
  const body = await mbGet('artist', { query: `artist:"${escapeLucene(artistName)}"`, limit: '5' });
  await sleep(1100);
  const wanted = normalize(artistName);
  const hits = (body?.artists ?? []) as { id: string; name: string; score?: number }[];
  const exact = hits.filter((h) => normalize(h.name) === wanted);
  exact.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return exact[0]?.id ?? null;
}

export async function syncMusicBrainz(db: TasteDb): Promise<number> {
  // Eligible = worth having in Lidarr: followed, or enough liked tracks.
  // Unresolved = no cache row yet, or a no-match ('') older than 30 days.
  const pending = db.db.prepare(`
    SELECT a.id, a.name FROM artists a
    LEFT JOIN artist_mbid am ON am.artist_id = a.id
    WHERE a.removed_at IS NULL
      AND (a.is_followed = 1
        OR (SELECT COUNT(*) FROM track_artists ta JOIN liked_tracks lt ON lt.track_id = ta.track_id
             WHERE ta.artist_id = a.id AND lt.removed_at IS NULL) >= ?)
      AND (am.artist_id IS NULL OR (am.mbid = '' AND am.resolved_at < datetime('now', '-30 days')))
    ORDER BY a.is_followed DESC, a.followers DESC
    LIMIT ?`).all(MIN_LIKED, MB_LIMIT) as { id: string; name: string }[];
  console.log(`MusicBrainz: resolving ${pending.length} artists...`);
  let resolved = 0;
  let done = 0;
  for (const artist of pending) {
    let mbid: string | null = null;
    let method = 'isrc';
    try {
      mbid = await resolveViaIsrc(db, artist.id, artist.name);
      if (!mbid) {
        method = 'name';
        mbid = await resolveViaSearch(artist.name);
      }
    } catch (err) {
      // Leave no row behind — the artist is retried next run.
      console.warn(`MusicBrainz: aborting for this run: ${(err as Error).message}`);
      break;
    }
    db.run(
      `INSERT OR REPLACE INTO artist_mbid (artist_id, mbid, method, resolved_at) VALUES (?, ?, ?, ?)`,
      artist.id, mbid ?? '', mbid ? method : null, new Date().toISOString(),
    );
    if (mbid) resolved++;
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${pending.length} (${resolved} matched)`);
  }
  console.log(`  ${resolved}/${done} matched`);
  return resolved;
}
