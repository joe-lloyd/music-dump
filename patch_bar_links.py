"""Player bar links to the album, and pages show which track is playing."""
from pathlib import Path

# ---------------------------------------------------------------- markup
html = Path('public/index.html')
h = html.read_text(encoding='utf-8')

old = """    <div class="player-art"><img id="player-art" alt=""><span id="player-art-fallback">MT</span></div>"""
new = """    <a class="player-art" id="player-art-link" href="#"><img id="player-art" alt=""><span id="player-art-fallback">MT</span></a>"""
assert h.count(old) == 1
h = h.replace(old, new)

old2 = """      <b id="player-title">Choose a track</b>
      <span id="player-byline">Play from your downloaded collection</span>"""
new2 = """      <b id="player-title">Choose a track</b>
      <span id="player-byline">Play from your downloaded collection</span>"""
assert h.count(old2) == 1
html.write_text(h, encoding='utf-8')
print('markup: art is a link')

# ---------------------------------------------------------------- player.js
p = Path('public/player.js')
s = p.read_text(encoding='utf-8')


def swap(old, new, n=1):
    global s
    assert s.count(old) == n, f"expected {n}, found {s.count(old)}: {old[:70]!r}"
    s = s.replace(old, new)


swap("""  const art = document.querySelector('#player-art');""",
"""  const art = document.querySelector('#player-art');
  const artLink = document.querySelector('#player-art-link');""")

# Point the art and the album name at the album page.
swap("""      title.textContent = current.name;
      byline.textContent = [current.artists, current.album].filter(Boolean).join(' · ');
      overline.textContent = 'Local archive · Jellyfin';""",
"""      title.textContent = current.name;
      // The album is a link. Every album in the library has a page now, so
      // there is always somewhere for it to go.
      const albumHref = current.album_id ? `#album/${encodeURIComponent(current.album_id)}` : '';
      byline.innerHTML = [
        current.artists ? escapeHtml(current.artists) : '',
        current.album
          ? (albumHref
            ? `<a href="${albumHref}" class="player-album">${escapeHtml(current.album)}</a>`
            : escapeHtml(current.album))
          : '',
      ].filter(Boolean).join(' · ');
      artLink.href = albumHref || '#';
      artLink.classList.toggle('linked', Boolean(albumHref));
      overline.textContent = 'Local archive · Jellyfin';
      markNowPlaying(current.id);""")

# A now-playing marker the pages can style, kept in sync with the audio.
swap("""  const setArtwork = (track) => {""",
"""  /**
   * Mark the row for the playing track wherever it appears on the page.
   *
   * Done from here rather than by re-rendering the view: the player outlives
   * navigation, and a track can be visible on several surfaces at once (an
   * album page and the queue, say). Re-applied after every navigation via the
   * hashchange hook below.
   */
  let nowPlayingId = null;
  const markNowPlaying = (trackId) => {
    nowPlayingId = trackId ?? nowPlayingId;
    document.querySelectorAll('[data-track-id].playing').forEach((el) => el.classList.remove('playing'));
    if (!nowPlayingId) return;
    document.querySelectorAll(`[data-track-id="${CSS.escape(nowPlayingId)}"]`)
      .forEach((el) => el.classList.add('playing'));
  };
  // Views are replaced wholesale on navigation, taking the marker with them.
  window.addEventListener('hashchange', () => setTimeout(() => markNowPlaying(), 60));
  document.addEventListener('music:rendered', () => markNowPlaying());

  const setArtwork = (track) => {""")

# Reflect paused/playing state on the marked row too.
swap("""  volume.addEventListener('input', () => {""",
"""  for (const event of ['play', 'pause']) {
    audioA.addEventListener(event, () => markNowPlaying());
    audioB.addEventListener(event, () => markNowPlaying());
  }

  volume.addEventListener('input', () => {""")

p.write_text(s, encoding='utf-8')
print('player.js: album link + now-playing marker')
