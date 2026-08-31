(() => {
  const audio = document.querySelector('#audio');
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
  const toast = document.querySelector('#toast');
  const archiveState = document.querySelector('#archive-state');
  const archiveLabel = document.querySelector('#archive-label');
  const archiveDetail = document.querySelector('#archive-detail');
  const wakeButton = document.querySelector('#wake-button');

  const STORAGE_KEY = 'music-taste-player-v1';
  let queue = [];
  let queueIndex = -1;
  let current = null;
  let pendingTrackId = null;
  let toastTimer;

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

  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ queue, queueIndex, volume: audio.volume }));
    } catch { /* private browsing can deny storage */ }
  };

  const restore = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      queue = Array.isArray(saved.queue) ? saved.queue.filter((item) => item?.id).slice(0, 500) : [];
      queueIndex = Number.isInteger(saved.queueIndex) && saved.queueIndex < queue.length ? saved.queueIndex : -1;
      audio.volume = Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : .72;
      volume.value = String(audio.volume);
    } catch {
      queue = [];
      queueIndex = -1;
      audio.volume = .72;
    }
  };

  const renderQueue = () => {
    queueCount.textContent = String(queue.length);
    queueList.innerHTML = queue.length ? queue.map((item, index) => `
      <button class="queue-item${index === queueIndex ? ' on' : ''}" type="button" data-queue-index="${index}">
        <span class="queue-index">${String(index + 1).padStart(2, '0')}</span>
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
    })).filter((item) => item.id && !seen.has(item.id) && seen.add(item.id));
    queueIndex = Math.max(0, queue.findIndex((item) => item.id === selectedId));
    renderQueue();
    save();
  };

  const setArtwork = (track) => {
    art.removeAttribute('src');
    artFallback.textContent = (track.name || 'MT').slice(0, 1).toUpperCase();
    if (!track.album_id) return;
    art.dataset.cdn = track.image_url || '';
    art.src = `/img/albums/${encodeURIComponent(track.album_id)}.jpg`;
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
    const artwork = track.album_id ? [
      { src: `/img/albums/${encodeURIComponent(track.album_id)}.jpg`, sizes: '512x512', type: 'image/jpeg' },
    ] : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artists || '',
      album: track.album || '',
      artwork,
    });
  };

  const showUnavailable = (result) => {
    bar.dataset.state = 'error';
    overline.textContent = result.reason === 'archive-offline' ? 'Archive asleep' : 'Unavailable locally';
    title.textContent = result.track?.name || queue[queueIndex]?.name || 'Cannot play this track';
    byline.textContent = result.detail || 'No local audio source is available';
    wakeButton.hidden = !(result.wakeAvailable && result.reason === 'archive-offline');
    notify(result.detail || 'This track is not available in the local archive');
  };

  const playAt = async (index) => {
    if (!queue.length || index < 0 || index >= queue.length) return;
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
      audio.src = result.streamUrl;
      playButton.disabled = false;
      scrubber.disabled = false;
      await audio.play();
      save();
      renderQueue();
    } catch (err) {
      showUnavailable({ reason: 'player-error', detail: err.message || 'Playback could not start' });
    }
  };

  const next = () => {
    if (queueIndex + 1 < queue.length) playAt(queueIndex + 1);
    else {
      audio.pause();
      audio.currentTime = 0;
      bar.dataset.state = 'paused';
    }
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
  volume.addEventListener('input', () => { audio.volume = Number(volume.value); save(); });
  queueButton.addEventListener('click', () => {
    queuePanel.hidden = !queuePanel.hidden;
    queueButton.setAttribute('aria-expanded', String(!queuePanel.hidden));
  });
  queueClose.addEventListener('click', () => {
    queuePanel.hidden = true;
    queueButton.setAttribute('aria-expanded', 'false');
  });
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

  audio.addEventListener('play', () => { bar.dataset.state = 'playing'; if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  audio.addEventListener('pause', () => { if (bar.dataset.state !== 'error') bar.dataset.state = 'paused'; if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('durationchange', updateProgress);
  audio.addEventListener('ended', next);
  audio.addEventListener('error', () => {
    if (!audio.src) return;
    bar.dataset.state = 'error';
    overline.textContent = 'Playback interrupted';
    byline.textContent = 'The local file could not be streamed';
    notify('Playback stopped. The archive may have gone offline.');
    refreshStatus(true);
  });

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

  restore();
  renderQueue();
  refreshStatus();
})();
