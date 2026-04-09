const socket = typeof io === 'function'
  ? io()
  : { on() {}, emit() {}, off() {} };

const params = new URLSearchParams(window.location.search);
const roomId = decodeURIComponent(window.location.pathname.split('/room/')[1] || '');
const roomAccessToken = String(params.get('access') || '').trim();

const USER_KEY_STORAGE = 'anivmeste_user_key';
const USERNAME_STORAGE = 'username';
const MANUAL_USERNAME_STORAGE = 'saved_username_manual';

const SEARCH_MIN_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 300;

const SEARCH_ENDPOINTS = [
  '/api/kodik/search',
  '/api/yummy/search'
];

const SELECTION_ENDPOINTS = [
  '/api/kodik/anime/by-selection',
  '/api/yummy/anime/by-selection'
];

let isHost = false;
let latestSearchToken = 0;
let activeSearchAbortController = null;
let lastSearchResults = [];

let selectedAnime = null;
let currentState = {
  animeId: null,
  animeUrl: null,
  episodeNumber: null,
  embedUrl: null,
  title: null,
  playback: { paused: true, currentTime: 0, updatedAt: Date.now() }
};

const usersList = document.getElementById('usersList');
const hostBadge = document.getElementById('hostBadge');
const searchInput = document.getElementById('searchInput');
const searchStatus = document.getElementById('searchStatus');
const animeList = document.getElementById('animeList');
const selectedAnimeInfo = document.getElementById('selectedAnimeInfo');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const nicknameInput = document.getElementById('nicknameInput');
const saveNicknameBtn = document.getElementById('saveNicknameBtn');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

function debounce(fn, wait) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

function safeLocalStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeLocalStorageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

function sanitizeUsername(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
}

function normalizeSearchQuery(value) {
  return String(value || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function canControl() {
  return roomId === 'solo' || isHost;
}

function getMoscowTimeString() {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
}

function updateControlState() {
  const disabled = !canControl();

  if (searchInput) {
    searchInput.disabled = disabled;
    searchInput.placeholder = disabled ? 'Только хост может искать аниме' : 'Введите название аниме...';
  }

  if (hostBadge) {
    hostBadge.textContent = canControl() ? 'Хост' : 'Зритель';
  }

  animeList?.querySelectorAll('button').forEach((btn) => {
    btn.disabled = disabled;
  });
}

function updateSelectedAnimeInfoContent(anime = null) {
  if (!selectedAnimeInfo) return;

  if (!anime) {
    selectedAnimeInfo.innerHTML = `
      <div class="empty-selected-anime">
        <p>Пока ничего не выбрано</p>
        <p class="small-note">Начните поиск аниме в поле выше.</p>
      </div>
    `;
    return;
  }

  selectedAnimeInfo.innerHTML = `
    <div class="selected-anime-layout">
      ${anime.poster ? `<img class="selected-anime-poster" src="${escapeHtml(anime.poster)}" loading="lazy" alt="${escapeHtml(anime.title)}">` : ''}
      <div class="selected-anime-body">
        <h3 class="selected-anime-title">${escapeHtml(anime.title)}</h3>
        <div class="selected-anime-meta">
          ${anime.year ? `${escapeHtml(anime.year)}` : ''}${anime.type ? ` • ${escapeHtml(anime.type)}` : ''}${anime.status ? ` • ${escapeHtml(anime.status)}` : ''}
        </div>
        ${anime.description ? `<p class="selected-anime-description">${escapeHtml(anime.description)}</p>` : ''}
      </div>
    </div>
  `;
}

function showPlaceholderUi(title = 'Ничего не выбрано', description = 'Выберите аниме') {
  const playerWrapper = document.getElementById('playerWrapper');
  if (!playerWrapper) return;

  playerWrapper.innerHTML = `
    <div class="placeholder">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(description)}</p>
    </div>
  `;
}

function mountIframe(embedUrl, title = 'Плеер') {
  const playerWrapper = document.getElementById('playerWrapper');
  if (!playerWrapper) return;

  playerWrapper.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = embedUrl;
  iframe.title = title;
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.setAttribute('frameborder', '0');
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  playerWrapper.appendChild(iframe);
}

async function readJsonSafely(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    throw new Error(`Сервер вернул не JSON. HTTP ${response.status}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Сервер вернул битый JSON');
  }
}

async function fetchFromAny(urls, options = {}) {
  let lastError = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, options);
      const data = await readJsonSafely(response);

      if (!response.ok) {
        const message = data?.error || `HTTP ${response.status}`;
        const err = new Error(message);
        err.status = response.status;
        throw err;
      }

      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Не удалось выполнить запрос');
}

function renderAnimeResults(items) {
  if (!animeList) return;

  if (!items.length) {
    animeList.innerHTML = '';
    animeList.classList.remove('visible');
    return;
  }

  animeList.innerHTML = items.slice(0, 8).map((item) => `
    <button type="button" class="search-result-item" data-anime-id="${escapeHtml(item.animeId)}">
      ${item.poster ? `<img class="search-result-poster" src="${escapeHtml(item.poster)}" loading="lazy" alt="${escapeHtml(item.title)}">` : '<div class="search-result-poster search-result-poster-empty"></div>'}
      <div class="search-result-content">
        <div class="search-result-title">${escapeHtml(item.title)}</div>
        <div class="search-result-meta">${escapeHtml(item.year || '')}${item.type ? ` • ${escapeHtml(item.type)}` : ''}</div>
      </div>
    </button>
  `).join('');

  animeList.classList.add('visible');

  animeList.querySelectorAll('.search-result-item').forEach((btn) => {
    btn.disabled = !canControl();
    btn.addEventListener('click', async () => {
      const picked = items.find((i) => i.animeId === btn.dataset.animeId);
      if (!picked) return;
      animeList.classList.remove('visible');
      await selectAnime(picked);
    });
  });
}

async function fetchSearchResults(rawQuery, token) {
  const encoded = encodeURIComponent(rawQuery);
  const urls = SEARCH_ENDPOINTS.map((base) => `${base}?q=${encoded}`);

  const data = await fetchFromAny(urls, {
    headers: { Accept: 'application/json' },
    signal: activeSearchAbortController?.signal
  });

  if (token !== latestSearchToken) return;

  lastSearchResults = Array.isArray(data) ? data : [];
  renderAnimeResults(lastSearchResults);

  if (searchStatus) {
    searchStatus.textContent = lastSearchResults.length
      ? `Найдено: ${lastSearchResults.length}`
      : 'Ничего не найдено';
  }
}

const debouncedSearchAnime = debounce(async (query) => {
  const rawQuery = String(query || '').trim();
  const normalized = normalizeSearchQuery(rawQuery);

  if (!rawQuery || normalized.length < SEARCH_MIN_LENGTH) {
    latestSearchToken += 1;
    if (activeSearchAbortController) {
      activeSearchAbortController.abort();
      activeSearchAbortController = null;
    }
    lastSearchResults = [];
    renderAnimeResults([]);
    if (searchStatus) searchStatus.textContent = 'Введите минимум 2 символа';
    return;
  }

  if (!canControl()) return;

  latestSearchToken += 1;
  const token = latestSearchToken;

  if (activeSearchAbortController) {
    activeSearchAbortController.abort();
  }
  activeSearchAbortController = new AbortController();

  if (searchStatus) searchStatus.textContent = 'Поиск...';

  try {
    await fetchSearchResults(rawQuery, token);
  } catch (error) {
    if (token !== latestSearchToken) return;
    if (error?.name === 'AbortError') return;

    if (searchStatus) {
      searchStatus.textContent = 'Ошибка API поиска. Проверь server.js маршруты /api/kodik/*';
    }
    renderAnimeResults([]);
  }
}, SEARCH_DEBOUNCE_MS);

async function selectAnime(item) {
  if (!item || !canControl()) return;
  if (selectedAnimeInfo) selectedAnimeInfo.innerHTML = 'Загрузка...';

  try {
    const data = await fetchFromAny(
      SELECTION_ENDPOINTS,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          animeUrl: item.animeUrl,
          animeId: item.animeId,
          title: item.title,
          year: item.year,
          shikimoriId: item.shikimoriId,
          kodikId: item.kodikId
        })
      }
    );

    selectedAnime = {
      ...data,
      videos: Array.isArray(data?.videos) ? data.videos : []
    };

    updateSelectedAnimeInfoContent(selectedAnime);

    const firstVideo = selectedAnime.videos.find((v) => v?.iframeUrl || v?.iframe_url);
    if (!firstVideo) {
      showPlaceholderUi('Нет доступных серий', 'Не удалось найти рабочий iframe для выбранного тайтла');
      return;
    }

    const embedUrl = firstVideo.iframeUrl || firstVideo.iframe_url;
    const episodeNumber = Number(firstVideo.number) || Number(firstVideo.index) || 1;
    const title = `${selectedAnime.title} — серия ${episodeNumber}`;

    currentState = {
      animeId: selectedAnime.animeId || null,
      animeUrl: selectedAnime.animeUrl || null,
      episodeNumber,
      embedUrl,
      title,
      playback: {
        paused: true,
        currentTime: 0,
        updatedAt: Date.now()
      }
    };

    mountIframe(embedUrl, title);

    if (roomId !== 'solo') {
      socket.emit('change-video', {
        roomId,
        embedUrl,
        title,
        animeId: currentState.animeId,
        animeUrl: currentState.animeUrl,
        episodeNumber: currentState.episodeNumber
      });
    }
  } catch (error) {
    updateSelectedAnimeInfoContent(null);
    showPlaceholderUi('Ошибка', 'Не удалось загрузить аниме. Проверь маршруты /api/kodik/anime/by-selection и /api/yummy/anime/by-selection');
  }
}

function resolveInitialUsername() {
  const usernameFromQuery = sanitizeUsername(params.get('username'));
  const savedUsername = sanitizeUsername(safeLocalStorageGet(USERNAME_STORAGE));
  const hasManualUsername = safeLocalStorageGet(MANUAL_USERNAME_STORAGE) === '1';

  if (usernameFromQuery) {
    safeLocalStorageSet(USERNAME_STORAGE, usernameFromQuery);
    safeLocalStorageSet(MANUAL_USERNAME_STORAGE, '1');
    return usernameFromQuery;
  }

  if (hasManualUsername && savedUsername) return savedUsername;

  const fallback = 'Guest';
  safeLocalStorageSet(USERNAME_STORAGE, fallback);
  safeLocalStorageSet(MANUAL_USERNAME_STORAGE, '0');
  return fallback;
}

let username = resolveInitialUsername();

function getOrCreateUserKey() {
  let key = safeLocalStorageGet(USER_KEY_STORAGE);
  if (!key) {
    key = `uk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    safeLocalStorageSet(USER_KEY_STORAGE, key);
  }
  return key;
}
const userKey = getOrCreateUserKey();

if (nicknameInput) {
  nicknameInput.value = username;
}

function saveNickname() {
  const next = sanitizeUsername(nicknameInput?.value);
  if (!next) {
    alert('Введите ник');
    return;
  }

  const prev = username;
  username = next;
  safeLocalStorageSet(USERNAME_STORAGE, username);
  safeLocalStorageSet(MANUAL_USERNAME_STORAGE, '1');

  if (roomId !== 'solo') {
    socket.emit('change-username', { roomId, username });
  } else if (prev !== username && chatMessages) {
    const div = document.createElement('div');
    div.className = 'chat-system-message';
    div.textContent = `Теперь вы ${username}`;
    chatMessages.appendChild(div);
  }
}

function renderUsers(users) {
  if (!usersList) return;

  if (!Array.isArray(users) || users.length === 0) {
    usersList.innerHTML = `<div class="empty-state">Пока никого нет</div>`;
    return;
  }

  usersList.innerHTML = users.map((user) => `
    <div class="user-item">
      <div class="user-main">
        <div class="user-identity">
          <span class="user-name">${escapeHtml(user.username)}</span>
          ${user.isHost ? `<span class="host-label">Хост</span>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

socket.on('connect', () => {
  if (roomId !== 'solo') {
    socket.emit('join-room', { roomId, username, userKey, accessToken: roomAccessToken });
  } else {
    isHost = true;
    updateControlState();
    showPlaceholderUi('Ничего не выбрано', 'Выберите аниме');
  }
});

socket.on('join-error', ({ message }) => {
  alert(message || 'Не удалось войти в комнату');
  window.location.href = '/';
});

socket.on('you-are-host', () => {
  isHost = true;
  updateControlState();
});

socket.on('sync-state', (state) => {
  isHost = !!state?.isHost;
  updateControlState();

  currentState = {
    animeId: state?.animeId ?? null,
    animeUrl: state?.animeUrl ?? null,
    episodeNumber: state?.episodeNumber ?? null,
    embedUrl: state?.embedUrl ?? null,
    title: state?.title ?? null,
    playback: state?.playback || { paused: true, currentTime: 0, updatedAt: Date.now() }
  };

  if (currentState.embedUrl) {
    mountIframe(currentState.embedUrl, currentState.title || 'Плеер');
  } else {
    showPlaceholderUi('Ничего не выбрано', isHost ? 'Выберите аниме' : 'Хост пока не запустил тайтл');
  }
});

socket.on('video-changed', (state) => {
  currentState = {
    animeId: state?.animeId ?? null,
    animeUrl: state?.animeUrl ?? null,
    episodeNumber: state?.episodeNumber ?? null,
    embedUrl: state?.embedUrl ?? null,
    title: state?.title ?? null,
    playback: { paused: true, currentTime: 0, updatedAt: Date.now() }
  };

  if (currentState.embedUrl) {
    mountIframe(currentState.embedUrl, currentState.title || 'Плеер');
  } else {
    showPlaceholderUi('Ничего не выбрано', 'Хост пока не запустил тайтл');
  }
});

socket.on('room-users', renderUsers);

socket.on('system-message', ({ text }) => {
  if (!chatMessages || !text) return;
  const wrap = document.createElement('div');
  wrap.className = 'chat-system-message';
  wrap.textContent = String(text);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

socket.on('chat-message', ({ username: author, message, time }) => {
  if (!chatMessages) return;
  const wrap = document.createElement('div');
  wrap.className = `chat-message ${author === username ? 'self' : ''}`;
  wrap.innerHTML = `
    <div class="chat-message-head">${escapeHtml(author)} • ${escapeHtml(time || getMoscowTimeString())}</div>
    <div class="chat-message-text">${escapeHtml(message || '')}</div>
  `;
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

if (searchInput) {
  searchInput.addEventListener('input', () => {
    debouncedSearchAnime(searchInput.value);
  });

  searchInput.addEventListener('focus', () => {
    if (lastSearchResults.length) renderAnimeResults(lastSearchResults);
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      animeList?.classList.remove('visible');
      searchInput.blur();
      debouncedSearchAnime.cancel();
    }
  });
}

if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', async () => {
    const inviteParams = new URLSearchParams();
    if (roomAccessToken) inviteParams.set('access', roomAccessToken);

    const query = inviteParams.toString();
    const inviteUrl = `${window.location.origin}/room/${encodeURIComponent(roomId)}${query ? `?${query}` : ''}`;

    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      window.prompt('Скопируйте ссылку:', inviteUrl);
    }
  });
}

if (saveNicknameBtn) {
  saveNicknameBtn.addEventListener('click', saveNickname);
}

if (nicknameInput) {
  nicknameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveNickname();
  });
}

if (sendBtn && chatInput) {
  sendBtn.addEventListener('click', () => {
    const message = chatInput.value.trim();
    if (!message) return;

    if (roomId !== 'solo') {
      socket.emit('chat-message', { roomId, username, message });
    } else if (chatMessages) {
      const wrap = document.createElement('div');
      wrap.className = 'chat-message self';
      wrap.innerHTML = `
        <div class="chat-message-head">${escapeHtml(username)} • ${escapeHtml(getMoscowTimeString())}</div>
        <div class="chat-message-text">${escapeHtml(message)}</div>
      `;
      chatMessages.appendChild(wrap);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    chatInput.value = '';
    chatInput.focus();
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });
}

window.addEventListener('beforeunload', () => {
  if (activeSearchAbortController) {
    activeSearchAbortController.abort();
    activeSearchAbortController = null;
  }
});

updateControlState();
updateSelectedAnimeInfoContent(null);
showPlaceholderUi('Ничего не выбрано', 'Выберите аниме');
renderUsers([]);