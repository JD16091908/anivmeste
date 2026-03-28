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

  function createIframe({ src, title = 'Без названия' } = {}) {
    const iframe = document.createElement('iframe');
    iframe.src = normalizeUrl(src);
    iframe.title = title;
    iframe.allow = 'autoplay; fullscreen; picture-in-picture';
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('loading', 'eager');
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

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  // ✨ Новая логика для работы с официальным Kodik API
  function sendKodikCommand(method, params = {}) {
    if (!currentIframe?.contentWindow) return;

    currentIframe.contentWindow.postMessage(JSON.stringify({
      source: 'external',
      method,
      params
    }), '*');
  }

  function play() {
    sendKodikCommand('play');
  }

  function pause() {
    sendKodikCommand('pause');
  }

  function seek(time) {
    sendKodikCommand('setTime', { time });
  }

  function setHostState(state) {
    isHost = state;
  }

  function onVideoChanged(callback) {
    onVideoChangedCallback = callback;
  }

  function onEpisodeEnded(callback) {
    onEndedCallback = callback;
  }

  // Глобальный обработчик событий от Kodik
  window.addEventListener('message', (event) => {
    if (!currentIframe || event.source !== currentIframe.contentWindow) return;

    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type !== 'kodik:api:public') return;

    const eventName = data.event;
    const payload = data.payload;

    // ✅ Хост переключил серию прямо внутри плеера - переключаем всем
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
        // Обычные пользователи не могут переключать серию сами
        setTimeout(() => sendKodikCommand('setEpisode', payload), 10);
      }
    }

    // ✅ Хост переключил озвучку - переключаем всем
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
        // Обычные пользователи не могут переключать озвучку сами
        setTimeout(() => sendKodikCommand('setTranslation', payload), 10);
      }
    }

    // ✅ Серия закончилась
    if (eventName === 'ended') {
      if (onEndedCallback) onEndedCallback();
    }

    // ✅ Магическая фича: автоматическая коррекция синхронизации после рекламы
    if (eventName === 'advertisement:end') {
      window.dispatchEvent(new CustomEvent('player:advertisement-ended'));
    }

  });

  function goToNextEpisode() {
    sendKodikCommand('nextEpisode');
  }

  return {
    normalizeUrl,
    createIframe,
    clearPlayer,
    mountIframe,
    showPlaceholder,

    // Новые публичные методы
    play,
    pause,
    seek,
    setHostState,
    onVideoChanged,
    onEpisodeEnded,
    goToNextEpisode
  };
})();