window.PlayerModule = (() => {
  let currentIframe = null;
  let isHost = false;
  let onVideoChangedCallback = null;
  let onEndedCallback = null;

  function normalizeUrl(url) {
    if (!url) return url;
    if (url.startsWith('//')) return `https:${url}`;
    return url;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function createIframe({ src, title = 'Без названия' } = {}) {
    const iframe = document.createElement('iframe');
    iframe.src = normalizeUrl(src);
    iframe.title = title;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('loading', 'eager');
    iframe.setAttribute('referrerpolicy', 'origin');
    iframe.style.display = 'block';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.minHeight = '520px';
    iframe.style.border = '0';
    iframe.style.borderRadius = '18px';
    iframe.style.background = '#000';

    currentIframe = iframe;
    return iframe;
  }

  function clearPlayer(container) {
    if (!container) return;
    currentIframe = null;
    container.innerHTML = '';
  }

  function mountIframe(container, { src, title } = {}) {
    if (!container) return null;

    clearPlayer(container);

    const iframe = createIframe({ src, title });
    container.appendChild(iframe);

    return iframe;
  }

  function showPlaceholder(container, {
    title = 'Ничего не выбрано',
    description = 'Выберите аниме и серию'
  } = {}) {
    if (!container) return;

    clearPlayer(container);

    const wrapper = document.createElement('div');
    wrapper.className = 'placeholder';
    wrapper.innerHTML = `
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
    `;

    container.appendChild(wrapper);
  }

  function sendKodikCommand(method, params = {}) {
    if (!currentIframe?.contentWindow) return false;

    try {
      currentIframe.contentWindow.postMessage(JSON.stringify({
        source: 'external',
        method,
        params
      }), '*');
      return true;
    } catch {
      return false;
    }
  }

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
        setTimeout(() => {
          sendKodikCommand('setEpisode', payload);
        }, 10);
      }
    }

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
        setTimeout(() => {
          sendKodikCommand('setTranslation', payload);
        }, 10);
      }
    }

    if (eventName === 'ended') {
      if (onEndedCallback) {
        onEndedCallback();
      }
    }

    if (eventName === 'advertisement:end') {
      window.dispatchEvent(new CustomEvent('player:advertisement-ended'));
    }
  });

  return {
    normalizeUrl,
    createIframe,
    clearPlayer,
    mountIframe,
    showPlaceholder,
    play,
    pause,
    seek,
    setHostState,
    onVideoChanged,
    onEpisodeEnded,
    goToNextEpisode
  };
})();