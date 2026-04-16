window.PlayerModule = (() => {
  let currentIframe = null;
  let isHost = false;
  let onVideoChangedCallback = null;
  let onEndedCallback = null;

  // Очередь команд до готовности плеера
  let commandQueue = [];
  let playerReady = false;
  let playerReadyTimer = null;

  // ── Утилиты ──────────────────────────────────────────────────────────────

  function normalizeUrl(url) {
    if (!url) return '';
    if (String(url).startsWith('//')) return `https:${url}`;
    return String(url);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function detectPlayerType(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return 'unknown';
    if (u.includes('kodik')) return 'kodik';
    return 'unknown';
  }

  // ── Overlay helpers ───────────────────────────────────────────────────────

  function extractOverlay(container) {
    if (!container) return null;
    const overlay = container.querySelector('#playerTopOverlay');
    if (overlay && overlay.parentNode === container) {
      overlay.remove();
      return overlay;
    }
    return null;
  }

  function restoreOverlay(container, overlayEl) {
    if (!container || !overlayEl) return;
    if (!container.contains(overlayEl)) {
      container.appendChild(overlayEl);
    }
  }

  // ── postMessage к Kodik ───────────────────────────────────────────────────

  /**
   * Отправляет команду в Kodik iframe.
   * Если плеер ещё не готов — ставит в очередь.
   * Поддерживает оба формата (объект и JSON-строка).
   */
  function sendKodikCommand(method, params = {}, force = false) {
    if (!currentIframe?.contentWindow) return false;

    if (!playerReady && !force) {
      // Кладём в очередь, дедупируем однотипные команды
      commandQueue = commandQueue.filter(c => c.method !== method);
      commandQueue.push({ method, params });
      return true;
    }

    const payload = { source: 'external', method, params };

    try {
      currentIframe.contentWindow.postMessage(payload, '*');
      return true;
    } catch {
      try {
        currentIframe.contentWindow.postMessage(JSON.stringify(payload), '*');
        return true;
      } catch {
        return false;
      }
    }
  }

  function flushCommandQueue() {
    const queue = [...commandQueue];
    commandQueue = [];
    for (const { method, params } of queue) {
      sendKodikCommand(method, params, true);
    }
  }

  // ── Iframe creation ───────────────────────────────────────────────────────

  function createIframe({ src, title = 'Без названия' } = {}) {
    const normalizedSrc = normalizeUrl(src);
    if (!normalizedSrc) return null;

    const iframe = document.createElement('iframe');
    iframe.src = normalizedSrc;
    iframe.title = title;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('loading', 'eager');
    iframe.setAttribute('referrerpolicy', 'origin');

    iframe.style.display = 'block';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.minHeight = '0';
    iframe.style.border = '0';
    iframe.style.borderRadius = '18px';
    iframe.style.background = '#000';

    currentIframe = iframe;
    playerReady = false;
    commandQueue = [];

    if (playerReadyTimer) clearTimeout(playerReadyTimer);

    // Fallback: считаем плеер готовым через 3 сек даже без события
    playerReadyTimer = setTimeout(() => {
      if (!playerReady) {
        playerReady = true;
        flushCommandQueue();
      }
    }, 3000);

    return iframe;
  }

  function clearPlayer(container) {
    if (!container) return;
    const overlay = extractOverlay(container);

    playerReady = false;
    commandQueue = [];
    if (playerReadyTimer) { clearTimeout(playerReadyTimer); playerReadyTimer = null; }
    currentIframe = null;
    container.innerHTML = '';

    restoreOverlay(container, overlay);
  }

  function mountIframe(container, { src, title } = {}) {
    if (!container) return null;

    const overlay = extractOverlay(container);

    playerReady = false;
    commandQueue = [];
    if (playerReadyTimer) { clearTimeout(playerReadyTimer); playerReadyTimer = null; }
    currentIframe = null;
    container.innerHTML = '';

    const iframe = createIframe({ src, title });
    if (!iframe) {
      const wrapper = document.createElement('div');
      wrapper.className = 'placeholder';
      wrapper.innerHTML = `
        <div class="placeholder-content">
          <h2>${escapeHtml('Ошибка загрузки')}</h2>
          <p>${escapeHtml('Не удалось загрузить плеер')}</p>
        </div>
      `;
      container.appendChild(wrapper);
      restoreOverlay(container, overlay);
      return null;
    }

    container.appendChild(iframe);
    restoreOverlay(container, overlay);
    return iframe;
  }

  function showPlaceholder(container, {
    title = 'Ничего не выбрано',
    description = 'Выберите аниме и серию'
  } = {}) {
    if (!container) return;

    const overlay = extractOverlay(container);

    playerReady = false;
    commandQueue = [];
    if (playerReadyTimer) { clearTimeout(playerReadyTimer); playerReadyTimer = null; }
    currentIframe = null;
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'placeholder';
    wrapper.innerHTML = `
      <div class="placeholder-content">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
    `;

    container.appendChild(wrapper);
    restoreOverlay(container, overlay);
  }

  // ── Playback API ──────────────────────────────────────────────────────────

  function play() {
    return sendKodikCommand('play');
  }

  function pause() {
    return sendKodikCommand('pause');
  }

  function seek(time) {
    const safeTime = Number(time);
    if (Number.isNaN(safeTime) || safeTime < 0) return false;
    return sendKodikCommand('setTime', { time: safeTime });
  }

  function seekTo(time) {
    return seek(time);
  }

  function setHostState(state) {
    isHost = !!state;
  }

  function onVideoChanged(callback) {
    onVideoChangedCallback = typeof callback === 'function' ? callback : null;
  }

  function onEpisodeEnded(callback) {
    onEndedCallback = typeof callback === 'function' ? callback : null;
  }

  function goToNextEpisode() {
    return sendKodikCommand('nextEpisode');
  }

  // ── Message handler ───────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    if (!currentIframe || event.source !== currentIframe.contentWindow) return;

    let data;
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }

    if (!data || data.type !== 'kodik:api:public') return;

    const eventName = data.event;
    const payload = data.payload || {};

    // ── Плеер готов ──
    if (eventName === 'player:ready' || eventName === 'ready') {
      if (!playerReady) {
        playerReady = true;
        if (playerReadyTimer) { clearTimeout(playerReadyTimer); playerReadyTimer = null; }
        flushCommandQueue();
      }
      return;
    }

    // ── Время / длительность ──
    if (eventName === 'player:time-update') {
      const seconds = typeof payload === 'number' ? payload : Number(payload);
      if (!Number.isNaN(seconds) && seconds >= 0) {
        window.dispatchEvent(new CustomEvent('player:time-update', { detail: { time: seconds } }));
      }
      return;
    }

    if (eventName === 'player:duration-update') {
      const duration = typeof payload === 'number' ? payload : Number(payload);
      if (!Number.isNaN(duration) && duration > 0) {
        window.dispatchEvent(new CustomEvent('player:duration-update', { detail: { duration } }));
      }
      return;
    }

    // ── Play / Pause ──
    if (eventName === 'player:play') {
      window.dispatchEvent(new CustomEvent('player:play'));
      return;
    }

    if (eventName === 'player:pause') {
      window.dispatchEvent(new CustomEvent('player:pause'));
      return;
    }

    // ── Смена серии внутри плеера ──
    if (eventName === 'change:episode') {
      if (isHost && onVideoChangedCallback) {
        onVideoChangedCallback({
          type: 'episode',
          season: payload.season,
          episode: payload.episode,
          newUrl: payload.link
        });
      }
      if (!isHost) {
        setTimeout(() => sendKodikCommand('setEpisode', payload, true), 10);
      }
      return;
    }

    // ── Смена озвучки внутри плеера ──
    if (eventName === 'change:translation') {
      if (isHost && onVideoChangedCallback) {
        onVideoChangedCallback({
          type: 'translation',
          translationId: payload.id,
          translationTitle: payload.title,
          newUrl: payload.link
        });
      }
      if (!isHost) {
        setTimeout(() => sendKodikCommand('setTranslation', payload, true), 10);
      }
      return;
    }

    // ── Конец серии ──
    if (eventName === 'ended') {
      if (onEndedCallback) onEndedCallback();
      return;
    }

    // ── Реклама ──
    if (eventName === 'advertisement:end') {
      window.dispatchEvent(new CustomEvent('player:advertisement-ended'));
      return;
    }
  });

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    normalizeUrl,
    detectPlayerType,
    createIframe,
    clearPlayer,
    mountIframe,
    showPlaceholder,
    play,
    pause,
    seek,
    seekTo,
    setHostState,
    onVideoChanged,
    onEpisodeEnded,
    goToNextEpisode
  };
})();
