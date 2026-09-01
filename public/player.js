(() => {
  // Two audio elements: the visible one plays, the other pre-buffers the
  // next queue item so track transitions don't wait on resolve + first
  // byte. `audio` always points at the active element.
  const audioA = document.querySelector('#audio');
  const audioB = new Audio();
  audioB.preload = 'auto';
  let audio = audioA;
  let prefetch = null;
  const standby = () => (audio === audioA ? audioB : audioA);
  const bar = document.querySelector('#player-bar');
  const playButton = document.querySelector('#player-play');
  const previousButton = document.querySelector('#previous-button');
  const nextButton = document.querySelector('#next-button');
  const scrubber = document.querySelector('#scrubber');
  const elapsed = document.querySelector('#elapsed');
  const remaining = document.querySelector('#remaining');
  const volume = document.querySelector('#volume');
  const title = document.querySelector('#player-title');
  const byline = document.querySelector('#player-byline');
  const overline = document.querySelector('#player-overline');
  const art = document.querySelector('#player-art');
  const artFallback = document.querySelector('#player-art-fallback');
  const queueButton = document.querySelector('#queue-button');
  const queuePanel = document.querySelector('#queue-panel');
  const queueClose = document.querySelector('#queue-close');
  const queueList = document.querySelector('#queue-list');
  const queueCount = document.querySelector('#queue-count');
  const lyricsButton = document.querySelector('#lyrics-button');
  const lyricsPanel = document.querySelector('#lyrics-panel');
  const lyricsClose = document.querySelector('#lyrics-close');
  const lyricsBody = document.querySelector('#lyrics-body');
  const lyricsTitle = document.querySelector('#lyrics-title');
  const lyricsSource = document.querySelector('#lyrics-source');
  const lyricsOffsetLabel = document.querySelector('#lyrics-offset');
  const lyricsEarlier = document.querySelector('#lyrics-earlier');
  const lyricsLater = document.querySelector('#lyrics-later');
  const toast = document.querySelector('#toast');
  const archiveState = document.querySelector('#archive-state');
  const archiveLabel = document.querySelector('#archive-label');
  const archiveDetail = document.querySelector('#archive-detail');
  const wakeButton = document.querySelector('#wake-button');

  const STORAGE_KEY = 'music-taste-player-v1';
  const OFFSETS_KEY = 'music-taste-lyric-offsets-v1';
  let queue = [];
  let queueIndex = -1;
  let current = null;
  let pendingTrackId = null;
  let toastTimer;
  // Local play log: accumulated listened-milliseconds for the current
  // track, flushed to the server when the track ends or is left. The
  // server ignores anything under 20s, so skims never count.
  let playLog = null;

  const flushPlay = (completed) => {
    const log = playLog;
    playLog = null;
    if (!log || log.ms < 20000) return;
    const body = JSON.stringify({ id: log.trackId, msPlayed: Math.round(log.ms), completed });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/player/played', new Blob([body], { type: 'application/json' })))) {
      fetch('/api/player/played', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  };

  const startPlayLog = (trackId) => { playLog = { trackId, ms: 0, lastT: 0 }; };

  const tickPlayLog = () => {
    if (!playLog) return;
    const t = audio.currentTime;
    const dt = t - playLog.lastT;
    if (dt > 0 && dt < 2) playLog.ms += dt * 1000; // seeks and swaps produce big jumps - don't count them
    playLog.lastT = t;
  };

  let lyricsData = null;
  let lyricsTrackId = null;
  let lyricsFetch = 0;
  let activeLyricLine = -1;
  let activeWordIndex = -1;
  let lyricsScrolledAt = 0;
  let wordRaf = 0;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const rounded = Math.floor(seconds);
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
  };

  const notify = (message) => {
    toast.textContent = message;
    toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 4200);
  };

  let pendingResume = null;
  let lastPositionSave = 0;

  const save = () => {
    try {
      const resume = current && audio.currentTime > 5
        ? { id: current.id, pos: Math.floor(audio.currentTime) }
        : pendingResume;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ queue, queueIndex, volume: audio.volume, resume }));
    } catch { /* private browsing can deny storage */ }
  };

  const restore = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      queue = Array.isArray(saved.queue) ? saved.queue.filter((item) => item?.id).slice(0, 500) : [];
      queueIndex = Number.isInteger(saved.queueIndex) && saved.queueIndex < queue.length ? saved.queueIndex : -1;
      audioA.volume = audioB.volume = Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : .52;
      // The stored value is the gain; the slider shows its position.
      volume.value = String(positionFor(audio.volume));
      // Reopening the page keeps the track and the spot in it: paint the
      // bar in a resume state and seek after the first (gesture-gated) play.
      const item = queue[queueIndex];
      if (saved.resume?.id && item && saved.resume.id === item.id && Number.isFinite(saved.resume.pos)) {
        pendingResume = saved.resume;
        overline.textContent = 'Pick up where you left off';
        title.textContent = item.name;
        byline.textContent = `${item.artists ? `${item.artists} · ` : ''}paused at ${formatTime(pendingResume.pos)}`;
        artFallback.textContent = (item.name || 'MT').slice(0, 1).toUpperCase();
        elapsed.textContent = formatTime(pendingResume.pos);
        if (item.durationMs) {
          scrubber.value = String(Math.round((pendingResume.pos / (item.durationMs / 1000)) * 1000));
          remaining.textContent = `−${formatTime(Math.max(0, item.durationMs / 1000 - pendingResume.pos))}`;
        }
        bar.dataset.state = 'paused';
        playButton.disabled = false;
      }
    } catch {
      queue = [];
      queueIndex = -1;
      audioA.volume = audioB.volume = .52;
    }
  };

  // Local and library albums are served by this app; only Spotify ids go to
  // the /img/albums route. Same rule as the pages, so a track looks identical
  // wherever it appears.
  // Inline onerror needs a global. Same two-step as the pages: try the
  // app-served cover, fall back to the CDN url, then let the letter show.
  window.queueArtError = (img) => {
    const cdn = img.dataset.cdn;
    if (cdn) { img.dataset.cdn = ''; img.src = cdn; return; }
    img.remove();
  };

  const artUrl = (albumId) => {
    if (!albumId) return '';
    return /^(localalbum|libalbum)-/.test(albumId)
      ? `/img/local/${encodeURIComponent(albumId)}.jpg`
      : `/img/albums/${encodeURIComponent(albumId)}.jpg`;
  };

  const renderQueue = () => {
    queueCount.textContent = String(queue.length);
    queueList.innerHTML = queue.length ? queue.map((item, index) => `
      <button class="queue-item${index === queueIndex ? ' on' : ''}" type="button" data-queue-index="${index}">
        <span class="queue-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="queue-art">${item.albumId
          ? `<img src="${escapeHtml(artUrl(item.albumId))}" alt="" loading="lazy"
                  data-cdn="${escapeHtml(item.imageUrl || '')}" onerror="queueArtError(this)">`
          : ''}<i>${escapeHtml((item.name || '?').slice(0, 1).toUpperCase())}</i></span>
        <span><b>${escapeHtml(item.name || 'Unknown track')}</b><small>${escapeHtml(item.artists || '')}</small></span>
        <span class="queue-duration">${formatTime((item.durationMs ?? 0) / 1000)}</span>
      </button>`).join('') : '<div class="empty">Your queue is empty</div>';
  };

  const setQueueFromButtons = (buttons, selectedId) => {
    const seen = new Set();
    queue = buttons.map((button) => ({
      id: button.dataset.trackId,
      name: button.dataset.trackName || 'Unknown track',
      artists: button.dataset.trackArtists || '',
      durationMs: Number(button.dataset.trackDuration || 0),
      albumId: button.dataset.trackAlbum || '',
      imageUrl: button.dataset.trackImage || '',
    })).filter((item) => item.id && !seen.has(item.id) && seen.add(item.id));
    queueIndex = Math.max(0, queue.findIndex((item) => item.id === selectedId));
    renderQueue();
    save();
  };

  const setArtwork = (track) => {
    art.removeAttribute('src');
    artFallback.textContent = (track.name || 'MT').slice(0, 1).toUpperCase();
    const albumId = track.album_id || track.albumId;
    if (!albumId) return;
    art.dataset.cdn = track.image_url || track.imageUrl || '';
    art.src = artUrl(albumId);
  };

  art.addEventListener('error', () => {
    const cdn = art.dataset.cdn;
    if (cdn) {
      art.dataset.cdn = '';
      art.src = cdn;
    } else {
      art.removeAttribute('src');
    }
  });

  const updateMediaSession = (track) => {
    if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;
    // The OS media panel and lock screen read this. It used to hardcode the
    // Spotify route, so anything from the local library showed no art at all
    // outside the browser tab.
    const albumId = track.album_id || track.albumId;
    const artwork = albumId
      ? [{ src: artUrl(albumId), sizes: '512x512', type: 'image/jpeg' }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artists || '',
      album: track.album || '',
      artwork,
    });
  };

  const lyricShift = () => {
    if (!lyricsTrackId) return 0;
    try {
      const shift = JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '{}')[lyricsTrackId];
      return Number.isFinite(shift) ? shift : 0;
    } catch { return 0; }
  };

  const updateShiftLabel = () => {
    const shift = lyricShift();
    lyricsOffsetLabel.textContent = `${shift > 0 ? '+' : ''}${shift.toFixed(1)}s`;
  };

  const nudgeLyrics = (delta) => {
    if (!lyricsTrackId) return;
    try {
      const offsets = JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '{}');
      offsets[lyricsTrackId] = Math.round(((offsets[lyricsTrackId] ?? 0) + delta) * 10) / 10;
      if (!offsets[lyricsTrackId]) delete offsets[lyricsTrackId];
      localStorage.setItem(OFFSETS_KEY, JSON.stringify(offsets));
    } catch { /* private browsing can deny storage */ }
    updateShiftLabel();
    syncLyrics(true);
  };

  // Highlight the last line whose (shifted) timestamp has passed; keep it
  // centred unless the listener scrolled the panel themselves just now.
  const syncLyrics = (force = false) => {
    const lines = lyricsData?.synced;
    if (!lines?.length || (lyricsPanel.hidden && !force)) return;
    const now = audio.currentTime;
    const shift = lyricShift();
    let index = -1;
    while (index + 1 < lines.length && lines[index + 1].time + shift <= now) index += 1;
    if (index === activeLyricLine && !force) return;
    lyricsBody.querySelector('.lyric-line.on')?.classList.remove('on');
    activeLyricLine = index;
    activeWordIndex = -1;
    if (index < 0) return;
    const el = lyricsBody.querySelector(`[data-line="${index}"]`);
    if (!el) return;
    el.classList.add('on');
    if (Date.now() - lyricsScrolledAt > 4000) {
      lyricsBody.scrollTop = el.offsetTop - lyricsBody.clientHeight / 2 + el.offsetHeight / 2;
    }
  };

  // Word-by-word highlight, only when the source carried real word timing.
  // Runs on an animation frame while the panel is open and audio plays —
  // timeupdate's ~4 Hz cadence is too coarse for word sweeps.
  const syncWords = () => {
    const words = lyricsData?.synced?.[activeLyricLine]?.words;
    if (!words || lyricsPanel.hidden) return;
    const shift = lyricShift();
    let index = -1;
    while (index + 1 < words.length && words[index + 1].time + shift <= audio.currentTime) index += 1;
    if (index === activeWordIndex) return;
    const lineEl = lyricsBody.querySelector(`[data-line="${activeLyricLine}"]`);
    if (!lineEl) return;
    lineEl.querySelectorAll('.w').forEach((el, i) => el.classList.toggle('sung', i <= index));
    activeWordIndex = index;
  };

  const wordLoop = () => {
    syncWords();
    wordRaf = (!lyricsPanel.hidden && !audio.paused) ? requestAnimationFrame(wordLoop) : 0;
  };
  const ensureWordLoop = () => {
    if (!wordRaf && !lyricsPanel.hidden && !audio.paused) wordRaf = requestAnimationFrame(wordLoop);
  };

  const renderLyrics = () => {
    const data = lyricsData;
    activeLyricLine = -1;
    if (!data) return;
    if (data.instrumental) {
      lyricsSource.textContent = 'Instrumental';
      lyricsBody.innerHTML = '<div class="empty">An instrumental — nothing to sing along to</div>';
    } else if (data.synced?.length) {
      const wordly = data.synced.some((line) => line.words?.length);
      lyricsSource.textContent = (data.source === 'jellyfin' ? 'Synced · local library' : 'Synced · LRCLIB') + (wordly ? ' · word timing' : '');
      lyricsBody.innerHTML = data.synced.map((line, index) =>
        `<button class="lyric-line" type="button" data-line="${index}">${
          line.words?.length
            ? line.words.map((word, wi) => `<span class="w" data-w="${wi}">${escapeHtml(word.text)}</span>`).join(' ')
            : (escapeHtml(line.text) || '♪')
        }</button>`).join('');
      lyricsBody.scrollTop = 0;
      syncLyrics(true);
    } else if (data.plain) {
      lyricsSource.textContent = data.source === 'jellyfin' ? 'Unsynchronized · local library' : 'Unsynchronized · LRCLIB';
      lyricsBody.innerHTML = `<div class="lyrics-plain">${escapeHtml(data.plain)}</div>`;
      lyricsBody.scrollTop = 0;
    } else {
      lyricsSource.textContent = 'Lyrics';
      lyricsBody.innerHTML = '<div class="empty">No lyrics found for this track</div>';
    }
  };

  const clearLyrics = (message) => {
    lyricsFetch += 1;
    lyricsData = null;
    lyricsTrackId = null;
    activeLyricLine = -1;
    lyricsButton.disabled = true;
    lyricsSource.textContent = 'Lyrics';
    lyricsTitle.textContent = 'Nothing playing';
    lyricsBody.innerHTML = `<div class="empty">${escapeHtml(message ?? 'Play a track to follow its lyrics')}</div>`;
    updateShiftLabel();
  };

  const loadLyrics = async (track) => {
    lyricsData = null;
    lyricsTrackId = track.id;
    activeLyricLine = -1;
    lyricsButton.disabled = false;
    lyricsTitle.textContent = track.name;
    lyricsSource.textContent = 'Lyrics';
    lyricsBody.innerHTML = '<div class="empty">Looking for lyrics…</div>';
    updateShiftLabel();
    const token = ++lyricsFetch;
    try {
      const response = await fetch(`/api/player/lyrics?id=${encodeURIComponent(track.id)}`);
      if (!response.ok) throw new Error(`lyrics ${response.status}`);
      const data = await response.json();
      if (token !== lyricsFetch) return;
      lyricsData = data;
    } catch {
      if (token !== lyricsFetch) return;
      lyricsData = { available: false, synced: null, plain: null, instrumental: false, source: null };
    }
    renderLyrics();
  };

  const showUnavailable = (result) => {
    bar.dataset.state = 'error';
    overline.textContent = result.reason === 'archive-offline' ? 'Archive asleep' : 'Unavailable locally';
    title.textContent = result.track?.name || queue[queueIndex]?.name || 'Cannot play this track';
    if (result.reason === 'not-matched' && result.track) {
      const query = encodeURIComponent(`${(result.track.artists || '').split(',')[0]} ${result.track.album || result.track.name}`.trim());
      byline.innerHTML = `${escapeHtml(result.detail || 'No local file')} · <a href="https://bandcamp.com/search?q=${query}&item_type=a" target="_blank" rel="noopener">Bandcamp ↗</a>`;
    } else {
      byline.textContent = result.detail || 'No local audio source is available';
    }
    wakeButton.hidden = !(result.wakeAvailable && result.reason === 'archive-offline');
    clearLyrics('Lyrics follow local playback');
    notify(result.detail || 'This track is not available in the local archive');
  };

  const playAt = async (index) => {
    if (!queue.length || index < 0 || index >= queue.length) return;
    flushPlay(false);
    prefetch = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    current = null;
    scrubber.disabled = true;
    scrubber.value = '0';
    elapsed.textContent = '0:00';
    remaining.textContent = '−0:00';
    queueIndex = index;
    pendingTrackId = queue[index].id;
    renderQueue();
    save();
    bar.dataset.state = 'loading';
    playButton.disabled = true;
    overline.textContent = 'Finding local file';
    title.textContent = queue[index].name;
    byline.textContent = queue[index].artists || 'Matching with Jellyfin…';

    try {
      const response = await fetch(`/api/player/resolve?id=${encodeURIComponent(queue[index].id)}`);
      if (!response.ok) throw new Error(`Player returned ${response.status}`);
      const result = await response.json();
      if (pendingTrackId !== queue[index].id) return;
      if (!result.available) {
        showUnavailable(result);
        return;
      }

      current = result.track;
      queue[index] = {
        ...queue[index],
        name: current.name,
        artists: current.artists || '',
        durationMs: current.duration_ms || queue[index].durationMs,
      };
      pendingTrackId = null;
      title.textContent = current.name;
      byline.textContent = [current.artists, current.album].filter(Boolean).join(' · ');
      overline.textContent = 'Local archive · Jellyfin';
      setArtwork(current);
      updateMediaSession(current);
      loadLyrics(current);
      audio.src = result.streamUrl;
      playButton.disabled = false;
      scrubber.disabled = false;
      startPlayLog(current.id);
      await audio.play();
      if (pendingResume?.id === current.id && pendingResume.pos > 0) audio.currentTime = pendingResume.pos;
      pendingResume = null;
      save();
      renderQueue();
    } catch (err) {
      showUnavailable({ reason: 'player-error', detail: err.message || 'Playback could not start' });
    }
  };

  // ~20s before a track ends, resolve the next queue item and buffer it in
  // the standby element; `next` then swaps elements instead of re-fetching.
  const prefetchNext = async () => {
    const upNext = queue[queueIndex + 1];
    if (!upNext || prefetch?.trackId === upNext.id) return;
    prefetch = { trackId: upNext.id, ready: false, track: null };
    try {
      const response = await fetch(`/api/player/resolve?id=${encodeURIComponent(upNext.id)}`);
      if (prefetch?.trackId !== upNext.id) return;
      const result = response.ok ? await response.json() : { available: false };
      if (prefetch?.trackId !== upNext.id || !result.available) return;
      const el = standby();
      el.src = result.streamUrl;
      el.load();
      prefetch.track = result.track;
      prefetch.ready = true;
    } catch { /* fall back to the normal resolve path on ended */ }
  };

  const next = () => {
    flushPlay(true);
    const index = queueIndex + 1;
    if (index >= queue.length) {
      audio.pause();
      audio.currentTime = 0;
      bar.dataset.state = 'paused';
      return;
    }
    if (prefetch?.ready && prefetch.trackId === queue[index].id && prefetch.track) {
      const old = audio;
      audio = standby();
      old.pause();
      old.removeAttribute('src');
      old.load();
      queueIndex = index;
      current = prefetch.track;
      pendingTrackId = null;
      prefetch = null;
      bar.dataset.state = 'loading';
      title.textContent = current.name;
      byline.textContent = [current.artists, current.album].filter(Boolean).join(' · ');
      overline.textContent = 'Local archive · Jellyfin';
      setArtwork(current);
      updateMediaSession(current);
      loadLyrics(current);
      playButton.disabled = false;
      scrubber.disabled = false;
      renderQueue();
      save();
      startPlayLog(current.id);
      audio.play().catch(() => playAt(index));
      return;
    }
    playAt(index);
  };

  const previous = () => {
    if (audio.currentTime > 4) {
      audio.currentTime = 0;
    } else if (queueIndex > 0) {
      playAt(queueIndex - 1);
    }
  };

  const updateProgress = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : (current?.duration_ms ?? 0) / 1000;
    scrubber.value = duration ? String(Math.round((audio.currentTime / duration) * 1000)) : '0';
    elapsed.textContent = formatTime(audio.currentTime);
    remaining.textContent = `−${formatTime(Math.max(0, duration - audio.currentTime))}`;
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && Number.isFinite(duration) && duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, duration) }); } catch { /* unsupported state */ }
    }
    if (duration && duration - audio.currentTime < 20 && !audio.paused) prefetchNext();
    if (!audio.paused && Date.now() - lastPositionSave > 5000) {
      lastPositionSave = Date.now();
      save();
    }
  };

  const refreshStatus = async (force = false) => {
    try {
      const response = await fetch(`/api/player/status${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const status = await response.json();
      archiveState.dataset.state = status.state;
      archiveLabel.textContent = status.state === 'ready' ? 'Archive ready' : status.state === 'archive-offline' ? 'Archive asleep' : status.state === 'unconfigured' ? 'Playback setup pending' : 'Jellyfin unavailable';
      archiveDetail.textContent = status.detail;
      wakeButton.hidden = !(status.wakeAvailable && status.state === 'archive-offline');
      return status;
    } catch {
      archiveState.dataset.state = 'jellyfin-offline';
      archiveLabel.textContent = 'Player status unknown';
      archiveDetail.textContent = 'Could not reach the player API';
      return null;
    }
  };

  document.addEventListener('click', (event) => {
    const trackButton = event.target.closest('.track-play');
    if (trackButton) {
      const scope = trackButton.closest('.rows') || document.querySelector('#main');
      setQueueFromButtons([...scope.querySelectorAll('.track-play')], trackButton.dataset.trackId);
      playAt(queueIndex);
      return;
    }

    const albumButton = event.target.closest('.play-album');
    if (albumButton) {
      const buttons = [...document.querySelectorAll('#main .track-play')];
      if (!buttons.length) return;
      setQueueFromButtons(buttons, buttons[0].dataset.trackId);
      playAt(0);
      return;
    }

    const queueItem = event.target.closest('[data-queue-index]');
    if (queueItem) playAt(Number(queueItem.dataset.queueIndex));
  });

  playButton.addEventListener('click', () => {
    if (!audio.src && queueIndex >= 0) playAt(queueIndex);
    else if (audio.paused) audio.play().catch((err) => notify(err.message));
    else audio.pause();
  });
  previousButton.addEventListener('click', previous);
  nextButton.addEventListener('click', next);
  scrubber.addEventListener('input', () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = (Number(scrubber.value) / 1000) * audio.duration;
  });
  // Loudness is perceived roughly logarithmically, so a linear slider spends
  // most of its travel in a range that already sounds loud and makes the first
  // few percent lurch. Squaring the position gives back a slider where a small
  // move near the bottom is a small change in what you hear.
  //
  // Squared rather than a full dB curve because it needs an exact inverse for
  // restoring the saved position, and x^2 / sqrt(x) is exactly invertible.
  const gainFor = (position) => Math.max(0, Math.min(1, Number(position))) ** 2;
  const positionFor = (gain) => Math.sqrt(Math.max(0, Math.min(1, Number(gain))));

  volume.addEventListener('input', () => {
    audioA.volume = audioB.volume = gainFor(volume.value);
    save();
  });
  // The queue and lyrics panels share the same corner — only one at a time.
  queueButton.addEventListener('click', () => {
    queuePanel.hidden = !queuePanel.hidden;
    queueButton.setAttribute('aria-expanded', String(!queuePanel.hidden));
    if (!queuePanel.hidden) {
      lyricsPanel.hidden = true;
      lyricsButton.setAttribute('aria-expanded', 'false');
    }
  });
  queueClose.addEventListener('click', () => {
    queuePanel.hidden = true;
    queueButton.setAttribute('aria-expanded', 'false');
  });
  lyricsButton.addEventListener('click', () => {
    lyricsPanel.hidden = !lyricsPanel.hidden;
    lyricsButton.setAttribute('aria-expanded', String(!lyricsPanel.hidden));
    if (!lyricsPanel.hidden) {
      queuePanel.hidden = true;
      queueButton.setAttribute('aria-expanded', 'false');
      syncLyrics(true);
      ensureWordLoop();
    }
  });
  lyricsClose.addEventListener('click', () => {
    lyricsPanel.hidden = true;
    lyricsButton.setAttribute('aria-expanded', 'false');
  });
  lyricsEarlier.addEventListener('click', () => nudgeLyrics(-0.5));
  lyricsLater.addEventListener('click', () => nudgeLyrics(0.5));
  lyricsBody.addEventListener('click', (event) => {
    const line = event.target.closest('.lyric-line');
    const lines = lyricsData?.synced;
    if (!line || !lines) return;
    audio.currentTime = Math.max(0, lines[Number(line.dataset.line)].time + lyricShift());
    lyricsScrolledAt = 0;
    syncLyrics(true);
  });
  for (const gesture of ['wheel', 'touchmove', 'pointerdown']) {
    lyricsBody.addEventListener(gesture, () => { lyricsScrolledAt = Date.now(); }, { passive: true });
  }
  wakeButton.addEventListener('click', async () => {
    wakeButton.disabled = true;
    wakeButton.textContent = 'Waking eliot…';
    try {
      const response = await fetch('/api/player/wake', { method: 'POST' });
      if (!response.ok) throw new Error(`Wake request returned ${response.status}`);
      notify('Wake signal sent. Waiting for the archive…');
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const status = await refreshStatus(true);
        if (status?.state === 'ready') {
          notify('The archive is awake and ready');
          if (pendingTrackId && queueIndex >= 0) playAt(queueIndex);
          return;
        }
      }
      notify('Eliot is taking longer than expected. Try again in a moment.');
    } catch (err) {
      notify(err.message || 'Could not send the wake signal');
    } finally {
      wakeButton.disabled = false;
      wakeButton.textContent = 'Wake eliot';
    }
  });

  for (const el of [audioA, audioB]) {
    el.addEventListener('play', (e) => { if (e.target !== audio) return; bar.dataset.state = 'playing'; ensureWordLoop(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
    el.addEventListener('pause', (e) => { if (e.target !== audio) return; if (bar.dataset.state !== 'error') bar.dataset.state = 'paused'; if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
    el.addEventListener('timeupdate', (e) => { if (e.target !== audio) return; tickPlayLog(); updateProgress(); syncLyrics(); });
    el.addEventListener('durationchange', (e) => { if (e.target === audio) updateProgress(); });
    el.addEventListener('ended', (e) => { if (e.target === audio) next(); });
    el.addEventListener('error', (e) => {
      if (e.target !== audio) { prefetch = null; return; } // a failed pre-buffer just falls back to the resolve path
      if (!audio.src) return;
      bar.dataset.state = 'error';
      overline.textContent = 'Playback interrupted';
      byline.textContent = 'The local file could not be streamed';
      notify('Playback stopped. The archive may have gone offline.');
      refreshStatus(true);
    });
  }

  if ('mediaSession' in navigator) {
    const handlers = {
      play: () => audio.play(), pause: () => audio.pause(), previoustrack: previous, nexttrack: next,
      seekbackward: (details) => { audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10)); },
      seekforward: (details) => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (details.seekOffset || 10)); },
      seekto: (details) => { if (details.seekTime != null) audio.currentTime = details.seekTime; },
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* action not supported */ }
    }
  }

  addEventListener('pagehide', () => { save(); flushPlay(false); });

  restore();
  renderQueue();
  refreshStatus();
})();
