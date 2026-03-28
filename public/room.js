const socket = io();

const params = new URLSearchParams(window.location.search);
const username = params.get('username') || 'Гость';
const roomId = window.location.pathname.split('/room/')[1];

let isHost = false;
let selectedAnime = null;
let selectedPlayer = null;
let searchDebounce = null;
let lastSearchResults = [];
let pendingPlaybackApply = null;
let isRemoteAction = false;

let hostAutoSyncTimer = null;
let viewerAutoSyncTimer = null;

let currentState = {
  animeId: null,
  animeUrl: null,
  episodeNumber: null,
  embedUrl: null,
  title: null,
  playback: {
    paused: true,
    currentTime: 0,
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
const syncBtn = document.getElementById('syncBtn');
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

const hostSyncPanel = document.getElementById('hostSyncPanel');
const hostPlayBtn = document.getElementById('hostPlayBtn');
const hostPauseBtn = document.getElementById('hostPauseBtn');
const hostSeekBtn = document.getElementById('hostSeekBtn');

if (roomTitle) {
  roomTitle.textContent = roomId === 'solo' ? 'Одиночный просмотр' : `Комната: ${roomId}`;
}

const canControl = () => roomId === 'solo' || isHost;

function sys(text) {
  console.log(text);
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

function getPlayerName(video) {
  return String(
    video?.player ||
    video?.data?.player ||
    video?.dubbing ||
    video?.data?.dubbing ||
    'unknown'
  ).trim();
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
  return (videos || []).filter(video => {
    return getPlayerName(video) === selectedPlayer && !!getIframeUrl(video);
  });
}

function getUniqueEpisodes(videos) {
  const map = new Map();

  for (const video of videos || []) {
    const episodeNumber = getEpisodeNumber(video);
    const iframeUrl = getIframeUrl(video);

    if (!episodeNumber || !iframeUrl) continue;

    if (!map.has(episodeNumber)) {
      map.set(episodeNumber, {
        ...video,
        episodeNumber
      });
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

  if (hostSyncPanel) {
    hostSyncPanel.classList.toggle('hidden', !canControl());
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
    placeholder.innerHTML = `
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
    `;
  }

  resetBridge();
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
  const selected = String(selectedPlayer || '').toLowerCase();

  if (full.includes('alloha') || full.includes('iframecvh') || selected.includes('alloha')) return 'alloha';
  if (full.includes('kodik') || selected.includes('kodik')) return 'kodik';
  if (full.includes('sibnet') || selected.includes('sibnet')) return 'sibnet';
  if (full.includes('cvh') || selected.includes('cvh')) return 'cvh';
  return 'unknown';
}

let bridge = {
  playerType: 'unknown',
  sourceWindow: null,
  sourceOrigin: null
};

function resetBridge() {
  bridge = {
    playerType: 'unknown',
    sourceWindow: null,
    sourceOrigin: null
  };
}

function postToCapturedSource(payload) {
  if (!bridge.sourceWindow || !bridge.sourceOrigin) return false;

  try {
    bridge.sourceWindow.postMessage(payload, bridge.sourceOrigin);
    return true;
  } catch {
    return false;
  }
}

function sendPlayToIframe() {
  postToCapturedSource(JSON.stringify({ event: 'play' }));
  postToCapturedSource(JSON.stringify({ method: 'play' }));
  postToCapturedSource(JSON.stringify({ command: 'play' }));
  postToCapturedSource({ event: 'play' });
  postToCapturedSource({ method: 'play' });
  postToCapturedSource({ command: 'play' });
}

function sendPauseToIframe() {
  postToCapturedSource(JSON.stringify({ event: 'pause' }));
  postToCapturedSource(JSON.stringify({ method: 'pause' }));
  postToCapturedSource(JSON.stringify({ command: 'pause' }));
  postToCapturedSource({ event: 'pause' });
  postToCapturedSource({ method: 'pause' });
  postToCapturedSource({ command: 'pause' });
}

function sendSeekToIframe(time) {
  postToCapturedSource(JSON.stringify({ event: 'seek', time }));
  postToCapturedSource(JSON.stringify({ method: 'seek', time }));
  postToCapturedSource(JSON.stringify({ command: 'seek', time }));
  postToCapturedSource({ event: 'seek', time });
  postToCapturedSource({ method: 'seek', time });
  postToCapturedSource({ command: 'seek', time });
}

function getLocalPlaybackSnapshot() {
  const playback = currentState.playback || {
    paused: true,
    currentTime: 0,
    updatedAt: Date.now()
  };

  let currentTime = Number(playback.currentTime || 0) || 0;
  const paused = !!playback.paused;
  const updatedAt = Number(playback.updatedAt || Date.now()) || Date.now();

  if (!paused) {
    currentTime += (Date.now() - updatedAt) / 1000;
  }

  return {
    paused,
    currentTime,
    updatedAt: Date.now()
  };
}

function applyPlaybackState(playback) {
  if (!playback) return;

  if (!bridge.sourceWindow || !bridge.sourceOrigin) {
    pendingPlaybackApply = playback;
    return;
  }

  const paused = typeof playback.paused === 'boolean' ? playback.paused : true;
  let targetTime = Number(playback.currentTime || 0) || 0;
  const updatedAt = Number(playback.updatedAt || 0) || 0;

  if (!paused && updatedAt) {
    targetTime += (Date.now() - updatedAt) / 1000;
  }

  isRemoteAction = true;

  sendSeekToIframe(targetTime);

  if (paused) {
    sendPauseToIframe();
  } else {
    sendPlayToIframe();
  }

  setTimeout(() => {
    isRemoteAction = false;
  }, 800);
}

function applyPlaybackStateWhenReady(playback, attempts = 10) {
  if (!playback) return;

  const tryApply = () => {
    if (bridge.sourceWindow && bridge.sourceOrigin) {
      applyPlaybackState(playback);
      pendingPlaybackApply = null;
      return;
    }

    if (attempts <= 0) {
      pendingPlaybackApply = playback;
      return;
    }

    attempts -= 1;
    setTimeout(tryApply, 900);
  };

  tryApply();
}

function loadIframe(embedUrl, title) {
  if (!embedUrl) {
    showPlaceholder('Серия не запущена', 'У серии отсутствует iframe');
    return;
  }

  resetBridge();

  const iframe = createFreshIframe(embedUrl);
  bridge.playerType = detectPlayerType(embedUrl);

  if (placeholder) {
    placeholder.style.display = 'none';
  }

  if (nowPlayingText) {
    nowPlayingText.textContent = title || 'Без названия';
  }

  iframe.addEventListener('load', () => {
    if (pendingPlaybackApply) {
      setTimeout(() => applyPlaybackStateWhenReady(pendingPlaybackApply), 1200);
    }
  });
}

function renderUsers(users) {
  if (!usersList) return;

  if (!Array.isArray(users) || users.length === 0) {
    usersList.innerHTML = `<div class="empty-state">Пока никого нет</div>`;
    return;
  }

  usersList.innerHTML = users.map(user => `
    <div class="user-item">
      <div class="user-main">
        <span>${escapeHtml(user.username)}</span>
        ${user.isHost ? `<span class="host-label">Хост</span>` : ''}
      </div>
      <div class="user-status">${escapeHtml(user.watchStatus || 'Не начал')}</div>
    </div>
  `).join('');
}

function renderSelectedAnimeInfo(anime) {
  if (!selectedAnimeInfo) return;

  selectedAnimeInfo.innerHTML = `
    <div class="selected-anime-card" style="display:flex;gap:16px;align-items:flex-start;">
      ${anime.poster ? `
        <img
          src="${escapeHtml(anime.poster)}"
          alt="${escapeHtml(anime.title)}"
          loading="lazy"
          style="width:120px;min-width:120px;height:170px;object-fit:cover;border-radius:12px;background:#111827;"
        >
      ` : ''}
      <div style="min-width:0;">
        <h3 style="margin:0 0 10px;">${escapeHtml(anime.title)}</h3>
        <div style="color:#9fb0d3;margin-bottom:10px;">
          ${escapeHtml(anime.year || '')}
          ${anime.type ? ` • ${escapeHtml(anime.type)}` : ''}
          ${anime.status ? ` • ${escapeHtml(anime.status)}` : ''}
        </div>
        <p style="margin:0;line-height:1.6;">${escapeHtml(anime.description || 'Описание отсутствует')}</p>
      </div>
    </div>
  `;
}

function renderAnimeResults(items) {
  if (!animeList) return;

  if (!items.length) {
    animeList.innerHTML = `<div class="empty-state">Ничего не найдено</div>`;
    return;
  }

  animeList.innerHTML = items.map(item => `
    <button
      type="button"
      class="anime-card ${item.animeUrl === selectedAnime?.animeUrl ? 'active' : ''}"
      data-anime-url="${escapeHtml(item.animeUrl)}"
    >
      <div class="anime-card-content">
        ${item.poster ? `<img class="anime-card-poster" src="${escapeHtml(item.poster)}" alt="${escapeHtml(item.title)}" loading="lazy">` : ''}
        <div class="anime-card-info">
          <div class="anime-card-title">${escapeHtml(item.title)}</div>
          <div class="anime-card-subtitle">
            ${escapeHtml(item.year || '')}${item.type ? ` • ${escapeHtml(item.type)}` : ''}
          </div>
        </div>
      </div>
    </button>
  `).join('');

  animeList.querySelectorAll('button').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', async () => {
      const animeUrl = btn.dataset.animeUrl;
      await selectAnime(animeUrl);
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
    <button
      type="button"
      class="episode-btn ${player.name === selectedPlayer ? 'active' : ''}"
      data-player="${escapeHtml(player.name)}"
    >
      ${escapeHtml(player.name)} (${player.count})
    </button>
  `).join('');

  playerList.querySelectorAll('button').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', () => {
      selectedPlayer = btn.dataset.player;
      renderPlayers(selectedAnime?.videos || []);
      const videosByPlayer = getVideosBySelectedPlayer(selectedAnime?.videos || []);
      const episodes = getUniqueEpisodes(videosByPlayer);
      renderEpisodes(episodes);
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
    <button
      type="button"
      class="episode-btn ${episode.episodeNumber === currentState.episodeNumber ? 'active' : ''}"
      data-episode="${episode.episodeNumber}"
    >
      Серия ${episode.episodeNumber}
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
        playback: {
          paused: true,
          currentTime: 0,
          updatedAt: Date.now()
        }
      };

      loadIframe(embedUrl, title);
      renderEpisodes(getUniqueEpisodes(videos));

      if (roomId !== 'solo') {
        socket.emit('change-video', {
          roomId,
          videoSrc: embedUrl,
          embedUrl,
          title,
          animeId: currentState.animeId,
          animeUrl: currentState.animeUrl,
          episodeNumber: currentState.episodeNumber
        });
      }
    });
  });
}

async function searchAnime(query) {
  if (!query || query.trim().length < 2) {
    if (animeList) animeList.innerHTML = '';
    if (searchStatus) searchStatus.textContent = 'Введите минимум 2 символа';
    return;
  }

  if (!canControl()) return;

  if (searchStatus) {
    searchStatus.textContent = 'Поиск...';
  }

  try {
    const response = await fetch(`/api/yummy/search?q=${encodeURIComponent(query.trim())}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || 'Ошибка поиска');
    }

    lastSearchResults = Array.isArray(data) ? data : [];
    renderAnimeResults(lastSearchResults);

    if (searchStatus) {
      searchStatus.textContent = lastSearchResults.length
        ? `Найдено: ${lastSearchResults.length}`
        : 'Ничего не найдено';
    }
  } catch (error) {
    if (searchStatus) {
      searchStatus.textContent = error.message || 'Ошибка поиска';
    }
    if (animeList) {
      animeList.innerHTML = '';
    }
  }
}

async function selectAnime(animeUrl) {
  if (!animeUrl || !canControl()) return;

  if (selectedAnimeInfo) {
    selectedAnimeInfo.innerHTML = 'Загрузка...';
  }

  if (playerList) {
    playerList.innerHTML = `<div class="empty-state">Загрузка плееров...</div>`;
  }

  if (episodesList) {
    episodesList.innerHTML = `<div class="empty-state">Сначала выберите плеер</div>`;
  }

  try {
    const response = await fetch(`/api/yummy/anime/${encodeURIComponent(animeUrl)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error || 'Не удалось загрузить аниме');
    }

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
    if (selectedAnimeInfo) {
      selectedAnimeInfo.innerHTML = `<div>${escapeHtml(error.message || 'Ошибка')}</div>`;
    }
    if (playerList) {
      playerList.innerHTML = `<div class="empty-state">Не удалось загрузить плееры</div>`;
    }
    if (episodesList) {
      episodesList.innerHTML = `<div class="empty-state">Не удалось загрузить серии</div>`;
    }
  }
}

function sendHostPlaybackCommand(action) {
  if (!canControl()) return;
  if (!currentState.embedUrl) {
    sys('Сначала запустите серию');
    return;
  }

  const snapshot = getLocalPlaybackSnapshot();

  currentState.playback = {
    paused: action === 'pause' ? true : action === 'play' ? false : snapshot.paused,
    currentTime: snapshot.currentTime,
    updatedAt: Date.now()
  };

  socket.emit('player-control', {
    roomId,
    action,
    currentTime: currentState.playback.currentTime
  });

  applyPlaybackState(currentState.playback);
}

function startAutoSyncLoops() {
  stopAutoSyncLoops();

  if (roomId === 'solo') return;

  if (isHost) {
    hostAutoSyncTimer = setInterval(() => {
      if (!currentState.embedUrl) return;

      const snapshot = getLocalPlaybackSnapshot();
      currentState.playback = snapshot;

      socket.emit('player-control', {
        roomId,
        action: snapshot.paused ? 'pause' : 'timeupdate',
        currentTime: snapshot.currentTime
      });
    }, 3000);
  } else {
    viewerAutoSyncTimer = setInterval(() => {
      socket.emit('sync-request', { roomId });
    }, 3000);
  }
}

function stopAutoSyncLoops() {
  if (hostAutoSyncTimer) {
    clearInterval(hostAutoSyncTimer);
    hostAutoSyncTimer = null;
  }

  if (viewerAutoSyncTimer) {
    clearInterval(viewerAutoSyncTimer);
    viewerAutoSyncTimer = null;
  }
}

window.addEventListener('message', (event) => {
  try {
    let payload = event.data;

    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = { raw: event.data };
      }
    }

    const origin = String(event.origin || '');
    if (!origin) return;

    bridge.sourceOrigin = origin;
    bridge.sourceWindow = event.source;

    const eventName = payload?.event || payload?.method || payload?.command || 'unknown';
    const time = Number(payload?.time || payload?.currentTime || 0) || 0;

    if (!isRemoteAction && roomId !== 'solo' && isHost) {
      if (eventName === 'play') {
        currentState.playback.paused = false;
        currentState.playback.currentTime = time;
        currentState.playback.updatedAt = Date.now();
      }

      if (eventName === 'pause') {
        currentState.playback.paused = true;
        currentState.playback.currentTime = time;
        currentState.playback.updatedAt = Date.now();
      }

      if (eventName === 'seek') {
        currentState.playback.currentTime = time;
        currentState.playback.updatedAt = Date.now();
      }

      if (eventName === 'timeupdate') {
        currentState.playback.currentTime = time;
        currentState.playback.updatedAt = Date.now();
      }
    }

    if (pendingPlaybackApply) {
      const state = pendingPlaybackApply;
      pendingPlaybackApply = null;
      setTimeout(() => applyPlaybackState(state), 250);
    }
  } catch (error) {
    console.error(error);
  }
});

socket.on('connect', () => {
  sys(`SOCKET connected: ${socket.id}`);

  if (roomId !== 'solo') {
    socket.emit('join-room', { roomId, username });
  } else {
    isHost = true;
    updateControlState();
    startAutoSyncLoops();
  }
});

socket.on('disconnect', () => {
  sys('SOCKET disconnected');
  stopAutoSyncLoops();
});

socket.on('connect_error', (err) => {
  sys(`SOCKET error: ${err?.message || err}`);
});

socket.on('you-are-host', () => {
  isHost = true;
  updateControlState();
  startAutoSyncLoops();
  sys('Вы назначены хостом');
});

socket.on('sync-state', (state) => {
  isHost = !!state.isHost;
  updateControlState();
  startAutoSyncLoops();

  currentState = {
    animeId: state.animeId ?? null,
    animeUrl: state.animeUrl ?? null,
    episodeNumber: state.episodeNumber ?? null,
    embedUrl: state.embedUrl ?? null,
    title: state.title ?? null,
    playback: state.playback || {
      paused: true,
      currentTime: 0,
      updatedAt: 0
    }
  };

  if (currentState.embedUrl) {
    loadIframe(currentState.embedUrl, currentState.title);
    pendingPlaybackApply = currentState.playback;
    applyPlaybackStateWhenReady(currentState.playback);
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
    playback: state.playback || {
      paused: true,
      currentTime: 0,
      updatedAt: 0
    }
  };

  if (currentState.embedUrl) {
    loadIframe(currentState.embedUrl, currentState.title);
    pendingPlaybackApply = currentState.playback;
    applyPlaybackStateWhenReady(currentState.playback);
  } else {
    showPlaceholder('Ничего не выбрано', 'Хост пока не запустил серию');
  }
});

socket.on('player-control', ({ currentTime, paused, updatedAt }) => {
  if (roomId === 'solo') return;
  if (isHost) return;

  currentState.playback = {
    paused: typeof paused === 'boolean' ? paused : true,
    currentTime: Number(currentTime || 0) || 0,
    updatedAt: Number(updatedAt || Date.now()) || Date.now()
  };

  applyPlaybackStateWhenReady(currentState.playback);
});

socket.on('room-users', (users) => {
  renderUsers(users);
});

socket.on('system-message', ({ text }) => {
  sys(text);
});

socket.on('chat-message', ({ username, message, time }) => {
  if (!chatMessages || !window.ChatModule) return;
  ChatModule.appendMessage(chatMessages, { username, message, time });
});

if (hostPlayBtn) {
  hostPlayBtn.addEventListener('click', () => {
    sendHostPlaybackCommand('play');
  });
}

if (hostPauseBtn) {
  hostPauseBtn.addEventListener('click', () => {
    sendHostPlaybackCommand('pause');
  });
}

if (hostSeekBtn) {
  hostSeekBtn.addEventListener('click', () => {
    sendHostPlaybackCommand('seek');
  });
}

if (searchInput) {
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const value = searchInput.value;
    searchDebounce = setTimeout(() => {
      searchAnime(value);
    }, 400);
  });
}

if (syncBtn) {
  syncBtn.addEventListener('click', () => {
    if (roomId !== 'solo') {
      socket.emit('sync-request', { roomId });
    }
  });
}

if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      sys('Ссылка на комнату скопирована');
    } catch {
      sys('Не удалось скопировать ссылку');
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
  stopAutoSyncLoops();
});

updateControlState();
showPlaceholder('Ничего не выбрано', 'Выберите аниме и серию');
renderUsers([]);