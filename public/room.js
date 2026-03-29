const socket = io();

const params = new URLSearchParams(window.location.search);
const username = params.get('username') || 'Гость';
const roomId = decodeURIComponent(window.location.pathname.split('/room/')[1] || '');

const USER_KEY_STORAGE = 'aniwatch_user_key';

function getOrCreateUserKey() {
  let key = localStorage.getItem(USER_KEY_STORAGE);
  if (!key) {
    key = `uk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(USER_KEY_STORAGE, key);
  }
  return key;
}

const userKey = getOrCreateUserKey();

let isHost = false;
let selectedAnime = null;
let selectedPlayer = null;
let searchDebounce = null;
let lastSearchResults = [];
let pendingPlaybackApply = null;
let isRemoteAction = false;
let userInteractedWithPlayer = false;
let hostTimeBroadcastTimer = null;
let kodikTimeRequestTimer = null;
let userTimeBroadcastTimer = null;

let currentState = {
  animeId: null,
  animeUrl: null,
  episodeNumber: null,
  embedUrl: null,
  title: null,
  duration: 0,
  playback: {
    paused: true,
    currentTime: null,
    updatedAt: 0
  }
};

const roomTitle = document.getElementById('roomTitle');
const hostBadge = document.getElementById('hostBadge');
const usersList = document.getElementById('usersList');
const nowPlayingText = document.getElementById('nowPlayingText');
const placeholder = document.getElementById('placeholder');
const animeList = document.getElementById('animeList');
const playerList = document.getElementById('playerList');
const episodesList = document.getElementById('episodesList');
const searchInput = document.getElementById('searchInput');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const cinemaModeBtn = document.getElementById('cinemaModeBtn');
const roomPage = document.getElementById('roomPage');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const statusButtons = document.querySelectorAll('.status-btn');
const searchStatus = document.getElementById('searchStatus');
const selectedAnimeInfo = document.getElementById('selectedAnimeInfo');
const hostSearchHint = document.getElementById('hostSearchHint');

if (roomTitle) {
  roomTitle.textContent = roomId === 'solo' ? 'Одиночный просмотр' : `Комната: ${roomId}`;
}

const canControl = () => roomId === 'solo' || isHost;

function sys(text) {
  console.log('[sys]', text);
  if (chatMessages && window.ChatModule) {
    ChatModule.appendSystemMessage(chatMessages, text);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeUrl(url) {
  if (!url) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

function formatWatchTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getPlayerName(video) {
  return String(video?.player || video?.dubbing || 'unknown').trim();
}

function getEpisodeNumber(video) {
  return Number(video?.number) || Number(video?.index) || 0;
}

function getIframeUrl(video) {
  return video?.iframeUrl || video?.iframe_url || null;
}

function getUniquePlayers(videos) {
  const map = new Map();
  for (const video of videos || []) {
    const iframeUrl = getIframeUrl(video);
    if (!iframeUrl) continue;
    const name = getPlayerName(video);
    if (!map.has(name)) {
      map.set(name, { name, count: 1 });
    } else {
      map.get(name).count += 1;
    }
  }
  return [...map.values()];
}

function getVideosBySelectedPlayer(videos) {
  if (!selectedPlayer) return [];
  return (videos || []).filter(v => getPlayerName(v) === selectedPlayer && !!getIframeUrl(v));
}

function getUniqueEpisodes(videos) {
  const map = new Map();
  for (const video of videos || []) {
    const ep = getEpisodeNumber(video);
    const url = getIframeUrl(video);
    if (!ep || !url) continue;
    if (!map.has(ep)) {
      map.set(ep, { ...video, episodeNumber: ep });
    }
  }
  return [...map.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
}

function updateControlState() {
  const disabled = !canControl();

  if (searchInput) {
    searchInput.disabled = disabled;
    searchInput.placeholder = disabled
      ? 'Только хост может искать аниме'
      : 'Введите название аниме...';
  }

  if (hostSearchHint) {
    hostSearchHint.textContent = disabled
      ? 'Искать и выбирать серии может только хост комнаты'
      : 'Вы можете искать тайтлы и запускать серии для всей комнаты';
  }

  if (hostBadge) {
    hostBadge.textContent = canControl() ? '👑 Хост' : '👀 Зритель';
  }

  animeList?.querySelectorAll('button').forEach(btn => btn.disabled = disabled);
  playerList?.querySelectorAll('button').forEach(btn => btn.disabled = disabled);
  episodesList?.querySelectorAll('button').forEach(btn => btn.disabled = disabled);
}

function showPlaceholder(title = 'Ничего не выбрано', description = 'Выберите аниме и серию') {
  if (nowPlayingText) nowPlayingText.textContent = title;

  const oldFrame = document.getElementById('videoFrame');
  if (oldFrame) oldFrame.remove();

  if (placeholder) {
    placeholder.style.display = 'flex';
    placeholder.innerHTML = `<div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>`;
  }

  resetBridge();
}

function showViewerHint() {
  if (isHost || roomId === 'solo' || !placeholder) return;

  placeholder.style.display = 'flex';
  placeholder.innerHTML = `
    <div>
      <h2>Серия загружена</h2>
      <p>Если видео не стартовало автоматически, кликните по плееру один раз. После этого play/pause будут работать лучше.</p>
    </div>
  `;
}

function createFreshIframe(embedUrl) {
  const oldFrame = document.getElementById('videoFrame');
  if (oldFrame) oldFrame.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'videoFrame';
  iframe.src = normalizeUrl(embedUrl);
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.setAttribute('allowfullscreen', '');
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('loading', 'eager');
  iframe.setAttribute('referrerpolicy', 'origin');
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.style.display = 'block';

  if (placeholder?.parentNode) {
    placeholder.parentNode.appendChild(iframe);
  }

  return iframe;
}

function detectPlayerType(embedUrl) {
  const full = String(embedUrl || '').toLowerCase();
  if (full.includes('kodik')) return 'kodik';
  return 'unknown';
}

let bridge = {
  playerType: 'unknown',
  iframeWindow: null
};

function resetBridge() {
  bridge = {
    playerType: 'unknown',
    iframeWindow: null
  };
}

function ensureBridgeWindow() {
  const iframe = document.getElementById('videoFrame');
  if (iframe?.contentWindow) {
    bridge.iframeWindow = iframe.contentWindow;
  }
}

function postToIframe(payload) {
  ensureBridgeWindow();
  if (!bridge.iframeWindow) return false;
  try {
    bridge.iframeWindow.postMessage(payload, '*');
    return true;
  } catch {
    return false;
  }
}

function postKodikCommand(value) {
  return postToIframe({
    key: 'kodik_player_api',
    value
  });
}

function sendPlayToIframe() {
  if (bridge.playerType === 'kodik') {
    postKodikCommand({ method: 'play' });
  }
}

function sendPauseToIframe() {
  if (bridge.playerType === 'kodik') {
    postKodikCommand({ method: 'pause' });
  }
}

function sendSeekToIframe(time) {
  if (bridge.playerType === 'kodik') {
    postKodikCommand({ method: 'seek', seconds: Number(time) || 0 });
  }
}

function requestKodikTime() {
  if (bridge.playerType === 'kodik') {
    postKodikCommand({ method: 'get_time' });
  }
}

function applyPlaybackState(playback) {
  if (!playback) return;

  ensureBridgeWindow();
  if (!bridge.iframeWindow) {
    pendingPlaybackApply = playback;
    return;
  }

  let targetTime = playback.currentTime;
  const paused = typeof playback.paused === 'boolean' ? playback.paused : true;
  const updatedAt = Number(playback.updatedAt || 0) || 0;

  if (typeof targetTime !== 'number' || Number.isNaN(targetTime) || targetTime < 0) {
    targetTime = null;
  }

  if (targetTime !== null && !paused && updatedAt) {
    targetTime += (Date.now() - updatedAt) / 1000;
  }

  isRemoteAction = true;

  if (targetTime !== null && targetTime > 0.5) {
    sendSeekToIframe(targetTime);
  }

  setTimeout(() => {
    if (paused) {
      sendPauseToIframe();
    } else {
      if (isHost || roomId === 'solo' || userInteractedWithPlayer) {
        sendPlayToIframe();
      } else {
        showViewerHint();
      }
    }
  }, 180);

  setTimeout(() => {
    isRemoteAction = false;
  }, 1200);
}

function applyPlaybackStateWhenReady(playback, attempts = 10) {
  if (!playback) return;

  const tryApply = () => {
    ensureBridgeWindow();
    if (bridge.iframeWindow) {
      applyPlaybackState(playback);
      pendingPlaybackApply = null;
      return;
    }
    if (attempts <= 0) {
      pendingPlaybackApply = playback;
      return;
    }
    attempts -= 1;
    setTimeout(tryApply, 700);
  };

  tryApply();
}

function loadIframe(embedUrl, title) {
  if (!embedUrl) {
    showPlaceholder('Серия не запущена', 'У серии отсутствует iframe');
    return;
  }

  stopHostTimers();
  stopUserTimeTimer();
  resetBridge();

  const iframe = createFreshIframe(embedUrl);
  bridge.playerType = detectPlayerType(embedUrl);

  if (placeholder) placeholder.style.display = 'none';
  if (nowPlayingText) nowPlayingText.textContent = title || 'Без названия';

  iframe.addEventListener('load', () => {
    ensureBridgeWindow();

    if (bridge.playerType === 'kodik') {
      startUserTimeTimer();
    }

    if (isHost && bridge.playerType === 'kodik') {
      startHostTimers();
    }

    if (pendingPlaybackApply) {
      const pb = pendingPlaybackApply;
      pendingPlaybackApply = null;
      setTimeout(() => applyPlaybackStateWhenReady(pb, 10), 1000);
    }

    if (!isHost && roomId !== 'solo') {
      setTimeout(() => {
        if (!userInteractedWithPlayer) showViewerHint();
      }, 1800);
    }
  });
}

function startHostTimers() {
  stopHostTimers();

  kodikTimeRequestTimer = setInterval(() => {
    if (!isHost || !currentState.embedUrl) return;
    requestKodikTime();
  }, 2000);

  hostTimeBroadcastTimer = setInterval(() => {
    if (!isHost || roomId === 'solo') return;

    const ct = currentState.playback.currentTime;
    if (typeof ct === 'number' && ct > 0.5) {
      socket.emit('player-control', {
        roomId,
        action: 'timeupdate',
        currentTime: ct
      });
    }
  }, 2500);
}

function stopHostTimers() {
  if (kodikTimeRequestTimer) {
    clearInterval(kodikTimeRequestTimer);
    kodikTimeRequestTimer = null;
  }
  if (hostTimeBroadcastTimer) {
    clearInterval(hostTimeBroadcastTimer);
    hostTimeBroadcastTimer = null;
  }
}

function startUserTimeTimer() {
  stopUserTimeTimer();

  if (roomId === 'solo') return;

  userTimeBroadcastTimer = setInterval(() => {
    if (!currentState.embedUrl) return;
    if (bridge.playerType !== 'kodik') return;

    requestKodikTime();

    const ct = currentState.playback.currentTime;
    if (typeof ct === 'number' && ct >= 0) {
      socket.emit('update-user-time', {
        roomId,
        currentTime: ct
      });
    }
  }, 2000);
}

function stopUserTimeTimer() {
  if (userTimeBroadcastTimer) {
    clearInterval(userTimeBroadcastTimer);
    userTimeBroadcastTimer = null;
  }
}

function renderUsers(users) {
  if (!usersList) return;
  if (!Array.isArray(users) || users.length === 0) {
    usersList.innerHTML = `<div class="empty-state">Пока никого нет</div>`;
    return;
  }

  usersList.innerHTML = users.map(user => {
    const hasTime = typeof user.currentTime === 'number' && !Number.isNaN(user.currentTime);
    const timeText = hasTime ? formatWatchTime(user.currentTime) : '—:—';

    return `
      <div class="user-item">
        <div class="user-main">
          <div class="user-identity">
            <span class="user-name">${escapeHtml(user.username)}</span>
            ${user.isHost ? `<span class="host-label">Хост</span>` : ''}
          </div>
          <div class="user-time" title="Текущее время просмотра">${escapeHtml(timeText)}</div>
        </div>
        <div class="user-status">${escapeHtml(user.watchStatus || 'Не начал')}</div>
      </div>
    `;
  }).join('');
}

function renderSelectedAnimeInfo(anime) {
  if (!selectedAnimeInfo) return;

  selectedAnimeInfo.innerHTML = `
    <div class="selected-anime-layout">
      ${anime.poster ? `<img class="selected-anime-poster" src="${escapeHtml(anime.poster)}" loading="lazy">` : ''}
      <div class="selected-anime-body">
        <h3 class="selected-anime-title">${escapeHtml(anime.title)}</h3>
        <div class="selected-anime-meta">
          ${escapeHtml(anime.year || '')}${anime.type ? ` • ${escapeHtml(anime.type)}` : ''}${anime.status ? ` • ${escapeHtml(anime.status)}` : ''}
        </div>
        <p class="selected-anime-description">${escapeHtml(anime.description || 'Описание отсутствует')}</p>
      </div>
    </div>
  `;
}

function renderAnimeResults(items) {
  if (!animeList) return;

  if (!items.length) {
    animeList.innerHTML = '';
    animeList.classList.remove('visible');
    return;
  }

  animeList.innerHTML = items.map(item => `
    <button
      type="button"
      class="search-result-item ${item.animeUrl === selectedAnime?.animeUrl ? 'active' : ''}"
      data-anime-url="${escapeHtml(item.animeUrl)}"
    >
      ${item.poster ? `<img class="search-result-poster" src="${escapeHtml(item.poster)}" loading="lazy">` : '<div class="search-result-poster search-result-poster-empty"></div>'}
      <div class="search-result-content">
        <div class="search-result-title">${escapeHtml(item.title)}</div>
        <div class="search-result-meta">${escapeHtml(item.year || '')}${item.type ? ` • ${escapeHtml(item.type)}` : ''}</div>
      </div>
    </button>
  `).join('');

  animeList.classList.add('visible');

  animeList.querySelectorAll('button').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', async () => {
      await selectAnime(btn.dataset.animeUrl);
      animeList.classList.remove('visible');
    });
  });
}

function renderPlayers(videos) {
  if (!playerList) return;
  const players = getUniquePlayers(videos);

  if (!players.length) {
    playerList.innerHTML = `<div class="empty-state">Нет доступных плееров</div>`;
    return;
  }

  playerList.innerHTML = players.map(player => `
    <button type="button" class="selector-chip ${player.name === selectedPlayer ? 'active' : ''}" data-player="${escapeHtml(player.name)}">
      ${escapeHtml(player.name)} <span class="selector-chip-count">${player.count}</span>
    </button>
  `).join('');

  playerList.querySelectorAll('button').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', () => {
      selectedPlayer = btn.dataset.player;
      renderPlayers(selectedAnime?.videos || []);
      const videosByPlayer = getVideosBySelectedPlayer(selectedAnime?.videos || []);
      renderEpisodes(getUniqueEpisodes(videosByPlayer));
    });
  });
}

function renderEpisodes(episodes) {
  if (!episodesList) return;

  if (!episodes.length) {
    episodesList.innerHTML = `<div class="empty-state">Серий для этого плеера нет</div>`;
    return;
  }

  episodesList.innerHTML = episodes.map(episode => `
    <button type="button" class="episode-tile ${episode.episodeNumber === currentState.episodeNumber ? 'active' : ''}" data-episode="${episode.episodeNumber}">
      ${episode.episodeNumber}
    </button>
  `).join('');

  episodesList.querySelectorAll('button').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', () => {
      const episodeNumber = Number(btn.dataset.episode);
      const videos = getVideosBySelectedPlayer(selectedAnime?.videos || []);
      const episode = getUniqueEpisodes(videos).find(v => v.episodeNumber === episodeNumber);
      if (!episode) return;

      const embedUrl = getIframeUrl(episode);
      const title = `${selectedAnime?.title || 'Аниме'} — серия ${episodeNumber}`;

      currentState = {
        animeId: selectedAnime?.animeId ?? null,
        animeUrl: selectedAnime?.animeUrl ?? null,
        episodeNumber,
        embedUrl,
        title,
        duration: 0,
        playback: {
          paused: true,
          currentTime: null,
          updatedAt: Date.now()
        }
      };

      userInteractedWithPlayer = true;
      loadIframe(embedUrl, title);
      renderEpisodes(getUniqueEpisodes(videos));

      if (roomId !== 'solo') {
        socket.emit('change-video', {
          roomId,
          embedUrl,
          title,
          animeId: currentState.animeId,
          animeUrl: currentState.animeUrl,
          episodeNumber
        });
      }
    });
  });
}

async function searchAnime(query) {
  if (!query || query.trim().length < 2) {
    if (animeList) {
      animeList.innerHTML = '';
      animeList.classList.remove('visible');
    }
    if (searchStatus) searchStatus.textContent = 'Введите минимум 2 символа';
    return;
  }

  if (!canControl()) return;

  if (searchStatus) searchStatus.textContent = 'Поиск...';

  try {
    const response = await fetch(`/api/yummy/search?q=${encodeURIComponent(query.trim())}`);
    const data = await response.json();

    if (!response.ok) throw new Error(data?.error || 'Ошибка поиска');

    lastSearchResults = Array.isArray(data) ? data.slice(0, 8) : [];
    renderAnimeResults(lastSearchResults);

    if (searchStatus) {
      searchStatus.textContent = lastSearchResults.length
        ? `Найдено: ${lastSearchResults.length}`
        : 'Ничего не найдено';
    }
  } catch (error) {
    if (searchStatus) searchStatus.textContent = error.message || 'Ошибка поиска';
    if (animeList) {
      animeList.innerHTML = '';
      animeList.classList.remove('visible');
    }
  }
}

async function selectAnime(animeUrl) {
  if (!animeUrl || !canControl()) return;

  if (selectedAnimeInfo) selectedAnimeInfo.innerHTML = 'Загрузка...';
  if (playerList) playerList.innerHTML = `<div class="empty-state">Загрузка плееров...</div>`;
  if (episodesList) episodesList.innerHTML = `<div class="empty-state">Сначала выберите плеер</div>`;

  try {
    const response = await fetch(`/api/yummy/anime/${encodeURIComponent(animeUrl)}`);
    const data = await response.json();

    if (!response.ok) throw new Error(data?.error || 'Не удалось загрузить аниме');

    selectedAnime = {
      ...data,
      videos: Array.isArray(data?.videos) ? data.videos : []
    };

    selectedPlayer = null;
    currentState.episodeNumber = null;

    renderSelectedAnimeInfo(selectedAnime);
    renderPlayers(selectedAnime.videos);
    episodesList.innerHTML = `<div class="empty-state">Сначала выберите плеер</div>`;
    renderAnimeResults(lastSearchResults);
  } catch (error) {
    if (selectedAnimeInfo) selectedAnimeInfo.innerHTML = `<div>${escapeHtml(error.message || 'Ошибка')}</div>`;
    if (playerList) playerList.innerHTML = `<div class="empty-state">Не удалось загрузить плееры</div>`;
    if (episodesList) episodesList.innerHTML = `<div class="empty-state">Не удалось загрузить серии</div>`;
  }
}

window.addEventListener('pointerdown', () => {
  userInteractedWithPlayer = true;
});

window.addEventListener('keydown', () => {
  userInteractedWithPlayer = true;
});

document.addEventListener('click', (event) => {
  const withinSearch = event.target.closest('.center-search-panel');
  if (!withinSearch) {
    animeList?.classList.remove('visible');
  }
});

window.addEventListener('message', (event) => {
  try {
    const payload = event.data;
    if (!payload || typeof payload !== 'object') return;
    if (!payload.key?.startsWith?.('kodik_player_')) return;

    const key = payload.key;
    const value = payload.value;

    if (key === 'kodik_player_time_update') {
      const seconds = typeof value === 'number' ? value : Number(value);
      if (!Number.isNaN(seconds) && seconds >= 0) {
        currentState.playback.currentTime = seconds;
        currentState.playback.updatedAt = Date.now();
      }
    }

    if (key === 'kodik_player_duration_update') {
      currentState.duration = Number(value) || 0;
    }

    if (!isRemoteAction && roomId !== 'solo' && isHost) {
      if (key === 'kodik_player_play') {
        currentState.playback.paused = false;
        currentState.playback.updatedAt = Date.now();

        socket.emit('player-control', {
          roomId,
          action: 'play',
          currentTime: typeof currentState.playback.currentTime === 'number'
            ? currentState.playback.currentTime
            : null
        });
      }

      if (key === 'kodik_player_pause') {
        currentState.playback.paused = true;
        currentState.playback.updatedAt = Date.now();

        socket.emit('player-control', {
          roomId,
          action: 'pause',
          currentTime: typeof currentState.playback.currentTime === 'number'
            ? currentState.playback.currentTime
            : null
        });
      }

      if (key === 'kodik_player_seek') {
        const seekTime = Number(value?.time);
        if (!Number.isNaN(seekTime) && seekTime >= 0) {
          currentState.playback.currentTime = seekTime;
          currentState.playback.updatedAt = Date.now();

          socket.emit('player-control', {
            roomId,
            action: 'seek',
            currentTime: seekTime
          });
        }
      }
    }

    if (pendingPlaybackApply) {
      const state = pendingPlaybackApply;
      pendingPlaybackApply = null;
      setTimeout(() => applyPlaybackState(state), 300);
    }
  } catch (error) {
    console.error(error);
  }
});

socket.on('connect', () => {
  if (roomId !== 'solo') {
    socket.emit('join-room', { roomId, username, userKey });
  } else {
    isHost = true;
    updateControlState();
  }
});

socket.on('disconnect', () => {
  stopHostTimers();
  stopUserTimeTimer();
});

socket.on('you-are-host', () => {
  isHost = true;
  updateControlState();
  if (currentState.embedUrl) {
    startHostTimers();
  }
  sys('Вы хост комнаты');
});

socket.on('sync-state', (state) => {
  isHost = !!state.isHost;
  updateControlState();

  currentState = {
    animeId: state.animeId ?? null,
    animeUrl: state.animeUrl ?? null,
    episodeNumber: state.episodeNumber ?? null,
    embedUrl: state.embedUrl ?? null,
    title: state.title ?? null,
    duration: currentState.duration || 0,
    playback: state.playback || {
      paused: true,
      currentTime: null,
      updatedAt: 0
    }
  };

  if (currentState.embedUrl) {
    loadIframe(currentState.embedUrl, currentState.title);

    if (typeof currentState.playback.currentTime === 'number' && currentState.playback.currentTime > 0.5) {
      pendingPlaybackApply = currentState.playback;
      applyPlaybackStateWhenReady(currentState.playback, 10);
    }
  } else {
    showPlaceholder('Ничего не выбрано', 'Хост пока не запустил серию');
  }
});

socket.on('video-changed', (state) => {
  currentState = {
    animeId: state.animeId ?? null,
    animeUrl: state.animeUrl ?? null,
    episodeNumber: state.episodeNumber ?? null,
    embedUrl: state.embedUrl ?? null,
    title: state.title ?? null,
    duration: 0,
    playback: {
      paused: true,
      currentTime: null,
      updatedAt: 0
    }
  };

  if (currentState.embedUrl) {
    loadIframe(currentState.embedUrl, currentState.title);
  } else {
    showPlaceholder('Ничего не выбрано', 'Хост пока не запустил серию');
  }
});

socket.on('player-control', ({ action, currentTime, paused, updatedAt }) => {
  if (roomId === 'solo' || isHost) return;

  const safeTime = typeof currentTime === 'number' && !Number.isNaN(currentTime)
    ? currentTime
    : currentState.playback.currentTime;

  currentState.playback = {
    paused: typeof paused === 'boolean' ? paused : action === 'pause',
    currentTime: safeTime ?? null,
    updatedAt: Number(updatedAt || Date.now()) || Date.now()
  };

  if (action === 'seek' || action === 'play' || action === 'pause') {
    applyPlaybackStateWhenReady(currentState.playback, 10);
  }
});

socket.on('room-users', renderUsers);

socket.on('system-message', ({ text }) => sys(text));

socket.on('chat-message', ({ username, message, time }) => {
  if (!chatMessages || !window.ChatModule) return;
  ChatModule.appendMessage(chatMessages, { username, message, time });
});

if (searchInput) {
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const value = searchInput.value;
    searchDebounce = setTimeout(() => searchAnime(value), 300);
  });

  searchInput.addEventListener('focus', () => {
    if (lastSearchResults.length) {
      renderAnimeResults(lastSearchResults);
    }
  });
}

if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', async () => {
    const inviteUrl = `${window.location.origin}/room/${encodeURIComponent(roomId)}?username=${encodeURIComponent(username)}`;

    try {
      await navigator.clipboard.writeText(inviteUrl);
      sys('Ссылка скопирована');
    } catch {
      window.prompt('Скопируйте ссылку:', inviteUrl);
    }
  });
}

if (cinemaModeBtn) {
  cinemaModeBtn.addEventListener('click', () => {
    roomPage?.classList.toggle('cinema-mode');
  });
}

if (sendBtn && chatInput) {
  sendBtn.addEventListener('click', () => {
    const message = chatInput.value.trim();
    if (!message) return;

    if (roomId !== 'solo') {
      socket.emit('chat-message', { roomId, username, message });
    } else if (window.ChatModule && chatMessages) {
      ChatModule.appendMessage(chatMessages, {
        username,
        message,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    }

    chatInput.value = '';
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });
}

statusButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const status = btn.dataset.status || 'Неизвестно';
    if (roomId !== 'solo') {
      socket.emit('update-watch-status', { roomId, status });
    }
  });
});

window.addEventListener('beforeunload', () => {
  stopHostTimers();
  stopUserTimeTimer();
});

updateControlState();
showPlaceholder('Ничего не выбрано', 'Выберите аниме и серию');
renderUsers([]);