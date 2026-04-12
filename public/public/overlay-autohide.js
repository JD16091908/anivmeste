(() => {
  const SELECT_URL_PARTS = [
    '/api/kodik/anime/by-selection',
    '/api/yummy/anime/by-selection'
  ];

  const META_KEY = '__anivmesteSelectionMeta';

  function safeNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function isSerialType(typeValue) {
    const t = String(typeValue || '').toLowerCase();
    return t.includes('serial');
  }

  function getUniqueEpisodeKeys(videos) {
    const set = new Set();
    for (const v of Array.isArray(videos) ? videos : []) {
      const season = safeNumber(v?.season, 1) || 1;
      const number = safeNumber(v?.number ?? v?.episodeNumber ?? v?.index, null);
      if (!number) continue;
      set.add(`${season}:${number}`);
    }
    return set;
  }

  function computeMeta(selectionData) {
    const type = selectionData?.type || '';
    const videos = Array.isArray(selectionData?.videos) ? selectionData.videos : [];

    const unique = getUniqueEpisodeKeys(videos);
    const uniqueEpisodes = unique.size;

    const serial = isSerialType(type);

    // Логика под твоё требование:
    // фильмы/спешлы обычно не serial и имеют 1 уникальную серию
    const singleEpisodeNonSerial = !serial && uniqueEpisodes <= 1;

    return {
      type,
      serial,
      uniqueEpisodes,
      singleEpisodeNonSerial,
      updatedAt: Date.now()
    };
  }

  function getDom() {
    return {
      overlayPlayerDropdown: document.getElementById('overlayPlayerDropdown'),
      overlaySeasonDropdown: document.getElementById('overlaySeasonDropdown'),
      overlayEpisodeDropdown: document.getElementById('overlayEpisodeDropdown'),
      overlaySeasonMenu: document.getElementById('overlaySeasonMenu'),
      overlayEpisodeMenu: document.getElementById('overlayEpisodeMenu')
    };
  }

  function setDisplay(el, visible) {
    if (!el) return;
    el.style.display = visible ? '' : 'none';
  }

  function closeDropdown(dropdown) {
    if (!dropdown) return;
    dropdown.classList.remove('open');
  }

  function applyVisibility() {
    const dom = getDom();
    const meta = window[META_KEY];

    // Всегда оставляем озвучку (на всякий)
    setDisplay(dom.overlayPlayerDropdown, true);

    // Если меты нет — ничего не прячем
    if (!meta) {
      setDisplay(dom.overlaySeasonDropdown, true);
      setDisplay(dom.overlayEpisodeDropdown, true);
      return;
    }

    if (meta.singleEpisodeNonSerial) {
      // Оставляем только озвучку
      closeDropdown(dom.overlaySeasonDropdown);
      closeDropdown(dom.overlayEpisodeDropdown);

      setDisplay(dom.overlaySeasonDropdown, false);
      setDisplay(dom.overlayEpisodeDropdown, false);
    } else {
      setDisplay(dom.overlaySeasonDropdown, true);
      setDisplay(dom.overlayEpisodeDropdown, true);
    }
  }

  function installFetchTap() {
    if (window.__anivmesteFetchTapped) return;
    window.__anivmesteFetchTapped = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = async (...args) => {
      const response = await originalFetch(...args);

      try {
        const url = String(args?.[0] || '');
        const shouldTap = SELECT_URL_PARTS.some(part => url.includes(part));
        if (!shouldTap) return response;

        const clone = response.clone();
        clone.json().then((data) => {
          try {
            window[META_KEY] = computeMeta(data);
            applyVisibility();
          } catch (e) {
            console.warn('overlay-autohide meta error:', e);
          }
        }).catch(() => {});
      } catch {}

      return response;
    };
  }

  function installMenuObservers() {
    const dom = getDom();
    const targets = [dom.overlaySeasonMenu, dom.overlayEpisodeMenu].filter(Boolean);
    if (!targets.length) return;

    const observer = new MutationObserver(() => {
      applyVisibility();
    });

    targets.forEach(t => {
      observer.observe(t, { childList: true, subtree: true });
    });
  }

  function init() {
    installFetchTap();
    installMenuObservers();
    applyVisibility();

    document.addEventListener('visibilitychange', applyVisibility);
    window.addEventListener('focus', applyVisibility);
    window.addEventListener('resize', applyVisibility);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();