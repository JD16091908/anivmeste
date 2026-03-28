const socket = io();

const params = new URLSearchParams(window.location.search);
const username = params.get('username') || 'Гость';
const roomId = decodeURIComponent(window.location.pathname.split('/room/')[1] || '');

// Генерируем и сохраняем уникальный ID пользователя, чтобы при перезагрузке браузер помнил, кто ты
const USER_KEY_STORAGE_KEY = 'aniwatch_user_key_v2';
function getUserKey() {
  let key = localStorage.getItem(USER_KEY_STORAGE_KEY);
  if (!key) {
    key = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem(USER_KEY_STORAGE_KEY, key);
  }
  return key;
}
const userKey = getUserKey();

let isHost = false;
let selectedAnime = null;
let selectedPlayer = null;
let searchDebounce = null;
let lastSearchResults = [];
let pendingPlaybackApply = null;
let isRemoteAction = false;
let userInteractedWithPlayer = false;
let lastHostKnownTime = null;

let viewerAutoSyncTimer = null;
let kodikTimeRequestTimer = null;

let currentState = {
  animeId: null, animeUrl: null, episodeNumber: null, embedUrl: null, title: null, duration: 0,
  playback: { paused: true, currentTime: null, updatedAt: 0 }
};

// DOM Elements
const roomTitle = document.getElementById('roomTitle');
const hostBadge = document.getElementById('hostBadge');
const usersList = document.getElementById('usersList');
const nowPlayingText = document.getElementById('nowPlayingText');
const placeholder = document.getElementById('placeholder');
const animeList = document.getElementById('animeList');
const playerList = document.getElementById('playerList');
const episodesList = document.getElementById('episodesList');
const searchInput = document.getElementById('searchInput');
// syncBtn удален
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

if (roomTitle) roomTitle.textContent = roomId === 'solo' ? 'Одиночный просмотр' : `Комната: ${roomId}`;

const canControl = () => roomId === 'solo' || isHost;

function sys(text) {
  console.log(text);
  if (chatMessages && window.ChatModule) ChatModule.appendSystemMessage(chatMessages, text);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeUrl(url) { if (!url) return url; if (url.startsWith('//')) return `https:${url}`; return url; }
function getPlayerName(video) { return String(video?.player || video?.dubbing || 'unknown').trim(); }
function getEpisodeNumber(video) { return Number(video?.number) || Number(video?.index) || 0; }
function getIframeUrl(video) { return video?.iframeUrl || video?.iframe_url || null; }

function getUniquePlayers(videos) {
  const map = new Map();
  for (const video of videos || []) {
    const iframeUrl = getIframeUrl(video); if (!iframeUrl) continue;
    const name = getPlayerName(video);
    if (!map.has(name)) map.set(name, { name, count: 1 }); else map.get(name).count++;
  }
  return [...map.values()];
}

function getVideosBySelectedPlayer(videos) {
  if (!selectedPlayer) return [];
  return (videos || []).filter(video => getPlayerName(video) === selectedPlayer && !!getIframeUrl(video));
}

function getUniqueEpisodes(videos) {
  const map = new Map();
  for (const video of videos || []) {
    const n = getEpisodeNumber(video); const url = getIframeUrl(video);
    if (!n || !url) continue;
    if (!map.has(n)) map.set(n, { ...video, episodeNumber: n });
  }
  return [...map.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
}

function updateControlState() {
  const disabled = !canControl();
  if (searchInput) { searchInput.disabled = disabled; searchInput.placeholder = disabled ? 'Только хост...' : 'Введите название...'; }
  if (hostBadge) hostBadge.textContent = canControl() ? '👑 Хост' : '👀 Зритель';
  // hostSyncPanel скрыт в CSS hidden
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

function createFreshIframe(embedUrl) {
  const oldFrame = document.getElementById('videoFrame'); if (oldFrame) oldFrame.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'videoFrame'; iframe.src = normalizeUrl(embedUrl);
  iframe.allow = 'autoplay; fullscreen; picture-in-picture';
  iframe.setAttribute('allowfullscreen', ''); iframe.setAttribute('frameborder', '0');
  iframe.style.width = '100%'; iframe.style.height = '100%'; iframe.style.border = '0';
  iframe.style.display = 'block';
  if (placeholder?.parentNode) placeholder.parentNode.appendChild(iframe);
  return iframe;
}

function detectPlayerType(embedUrl) {
  const full = String(embedUrl || '').toLowerCase();
  if (full.includes('kodik') || selectedPlayer?.includes?.('kodik')) return 'kodik';
  return 'unknown';
}

let bridge = { playerType: 'unknown', iframeWindow: null };
function resetBridge() { bridge = { playerType: 'unknown', iframeWindow: null }; }
function ensureBridgeWindow() { const i = document.getElementById('videoFrame'); if (i?.contentWindow) bridge.iframeWindow = i.contentWindow; }
function postToIframe(payload) { ensureBridgeWindow(); if (!bridge.iframeWindow) return false; try { bridge.iframeWindow.postMessage(payload, '*'); return true; } catch {} return false; }
function postKodikCommand(value) { return postToIframe({ key: 'kodik_player_api', value }); }

function sendPlayToIframe() { if (bridge.playerType === 'kodik') postKodikCommand({ method: 'play' }); }
function sendPauseToIframe() { if (bridge.playerType === 'kodik') postKodikCommand({ method: 'pause' }); }
function sendSeekToIframe(time) { if (bridge.playerType === 'kodik') postKodikCommand({ method: 'seek', seconds: Number(time) || 0 }); }
function requestKodikTime() { if (bridge.playerType === 'kodik') postKodikCommand({ method: 'get_time' }); }

function getLocalPlaybackSnapshot() {
  const pb = currentState.playback || { paused: true, currentTime: null, updatedAt: Date.now() };
  let t = typeof pb.currentTime === 'number' && !Number.isNaN(pb.currentTime) ? pb.currentTime : null;
  const p = !!pb.paused;
  const u = Number(pb.updatedAt || Date.now()) || Date.now();
  if (t !== null && !p) t += (Date.now() - u) / 1000;
  return { paused: p, currentTime: t, updatedAt: Date.now() };
}

function applyPlaybackState(playback, options = {}) {
  if (!playback) return;
  ensureBridgeWindow();
  if (!bridge.iframeWindow) { pendingPlaybackApply = playback; return; }

  let targetTime = playback.currentTime;
  const paused = typeof playback.paused === 'boolean' ? playback.paused : true;
  const updatedAt = Number(playback.updatedAt || 0) || 0;

  // Защита от мусорного времени
  if (typeof targetTime !== 'number' || Number.isNaN(targetTime) || targetTime < 0) return;

  // Корректировка времени вперед
  if (!paused && updatedAt) targetTime += (Date.now() - updatedAt) / 1000;

  const localSnapshot = getLocalPlaybackSnapshot();
  const drift = Math.abs((localSnapshot.currentTime || 0) - targetTime);

  isRemoteAction = true;

  // Перематываем, если разница большая или форсировано
  if (drift > 1.5 || options.forceSeek) sendSeekToIframe(targetTime);

  setTimeout(() => {
    if (paused) sendPauseToIframe();
    else {
       // Играем только если мы хост или уже кликнули плеер один раз
       if (isHost || roomId === 'solo' || userInteractedWithPlayer) sendPlayToIframe();
    }
  }, 150);

  setTimeout(() => isRemoteAction = false, 1000);
}

function applyPlaybackStateWhenReady(playback, attempts = 10, options = {}) {
  if (!playback) return;
  const tryApply = () => {
    ensureBridgeWindow();
    if (bridge.iframeWindow) { applyPlaybackState(playback, options); pendingPlaybackApply = null; return; }
    if (attempts <= 0) { pendingPlaybackApply = playback; return; }
    attempts--; setTimeout(tryApply, 700);
  };
  tryApply();
}

function loadIframe(embedUrl, title) {
  if (!embedUrl) return showPlaceholder('Серия не запущена', 'Нет iframe');
  
  stopKodikTimePolling(); resetBridge();
  const iframe = createFreshIframe(embedUrl);
  bridge.playerType = detectPlayerType(embedUrl);
  
  if (placeholder) placeholder.style.display = 'none';
  if (nowPlayingText) nowPlayingText.textContent = title || 'Без названия';

  iframe.addEventListener('load', () => {
    ensureBridgeWindow();
    if (bridge.playerType === 'kodik') {
      startKodikTimePolling();
      setTimeout(() => requestKodikTime(), 1200);
    }
    if (pendingPlaybackApply) setTimeout(() => applyPlaybackStateWhenReady(pendingPlaybackApply, 10, { forceSeek: true }), 1000);
  });
}

function startKodikTimePolling() {
  stopKodikTimePolling();
  kodikTimeRequestTimer = setInterval(() => {
    if (currentState.embedUrl && bridge.playerType === 'kodik') requestKodikTime();
  }, 3000);
}
function stopKodikTimePolling() { if (kodikTimeRequestTimer) clearInterval(kodikTimeRequestTimer); }

function renderUsers(users) {
  if (!usersList) return;
  usersList.innerHTML = (Array.isArray(users) && users.length ? users.map(u => `
    <div class="user-item">
      <div class="user-main"><span>${escapeHtml(u.username)}</span>${u.isHost ? '<span class="host-label">Хост</span>' : ''}</div>
      <div class="user-status">${escapeHtml(u.watchStatus || 'Не начал')}</div>
    </div>
  `).join('') : '<div class="empty-state">Пока никого нет</div>');
}

function renderSelectedAnimeInfo(anime) {
  if (!selectedAnimeInfo) return;
  selectedAnimeInfo.innerHTML = `
    <div class="selected-anime-card" style="display:flex;gap:16px;align-items:flex-start;">
      ${anime.poster ? `<img src="${escapeHtml(anime.poster)}" alt="" loading="lazy" style="width:120px;height:170px;object-fit:cover;border-radius:12px;background:#111827;">` : ''}
      <div><h3 style="margin:0 0 10px;">${escapeHtml(anime.title)}</h3>
      <div style="color:#9fb0d3;margin-bottom:10px;">${escapeHtml(anime.year || '')} ${anime.type ? ' • '+escapeHtml(anime.type) : ''}</div>
      <p style="margin:0;line-height:1.6;">${escapeHtml(anime.description || 'Описание отсутствует')}</p></div>
    </div>`;
}

function renderAnimeResults(items) {
  if (!animeList) return;
  animeList.innerHTML = (items.length ? items.map(item => `
    <button type="button" class="anime-card ${item.animeUrl === selectedAnime?.animeUrl ? 'active' : ''}" data-anime-url="${escapeHtml(item.animeUrl)}">
      <div class="anime-card-content">${item.poster ? `<img class="anime-card-poster" src="${escapeHtml(item.poster)}" loading="lazy">` : ''}
      <div class="anime-card-info"><div class="anime-card-title">${escapeHtml(item.title)}</div><div class="anime-card-subtitle">${escapeHtml(item.year || '')}</div></div></div>
    </button>
  `).join('') : '<div class="empty-state">Ничего не найдено</div>');
  animeList.querySelectorAll('button').forEach(btn => { btn.disabled = !canControl(); btn.onclick = () => selectAnime(btn.dataset.animeUrl); });
}

function renderPlayers(videos) {
  if (!playerList) return;
  const players = getUniquePlayers(videos);
  playerList.innerHTML = (players.length ? players.map(p => `<button type="button" class="episode-btn ${p.name === selectedPlayer ? 'active' : ''}" data-player="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>`).join('') : '<div class="empty-state">Нет плееров</div>');
  playerList.querySelectorAll('button').forEach(btn => { btn.disabled = !canControl(); btn.onclick = () => { selectedPlayer = btn.dataset.player; renderEpisodes(getUniqueEpisodes(getVideosBySelectedPlayer(selectedAnime?.videos||[]))); }});
}

function renderEpisodes(episodes) {
  if (!episodesList) return;
  episodesList.innerHTML = (episodes.length ? episodes.map(e => `<button type="button" class="episode-btn ${e.episodeNumber === currentState.episodeNumber ? 'active' : ''}" data-episode="${e.episodeNumber}">Серия ${e.episodeNumber}</button>`).join('') : '<div class="empty-state">Нет серий</div>');
  episodesList.querySelectorAll('button').forEach(btn => { btn.disabled = !canControl(); btn.onclick = async () => {
    const eNum = Number(btn.dataset.episode);
    const v = getVideosBySelectedPlayer(selectedAnime?.videos||[]).find(v => v.episodeNumber === eNum);
    if (!v) return;
    lastHostKnownTime = null;
    currentState = { ...currentState, episodeNumber: eNum, embedUrl: getIframeUrl(v), title: `${selectedAnime?.title} — серия ${eNum}`, playback: {paused:true, currentTime:null} };
    userInteractedWithPlayer = canControl();
    loadIframe(currentState.embedUrl, currentState.title);
    renderEpisodes([...episodes]); // update active
    if (roomId !== 'solo') socket.emit('change-video', { roomId, videoSrc: currentState.embedUrl, embedUrl: currentState.embedUrl, title: currentState.title, animeId: selectedAnime?.animeId, animeUrl: selectedAnime?.animeUrl, episodeNumber: eNum });
  }});
}

async function searchAnime(query) {
  if (!query?.trim().length > 1 || !canControl()) return;
  searchStatus.textContent = 'Поиск...';
  try {
    const r = await fetch(`/api/yummy/search?q=${encodeURIComponent(query.trim())}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Ошибка');
    lastSearchResults = Array.isArray(d) ? d : [];
    renderAnimeResults(lastSearchResults);
    searchStatus.textContent = lastSearchResults.length ? `Найдено: ${lastSearchResults.length}` : 'Ничего';
  } catch (e) { searchStatus.textContent = e.message; }
}

async function selectAnime(animeUrl) {
  if (!animeUrl || !canControl()) return;
  selectedAnimeInfo.innerHTML = 'Загрузка...'; playerList.innerHTML = '<div class="empty-state">Загрузка...</div>';
  try {
    const r = await fetch(`/api/yummy/anime/${encodeURIComponent(animeUrl)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    selectedAnime = {...d, videos: d.videos||[]}; selectedPlayer = null; currentState.episodeNumber = null;
    renderSelectedAnimeInfo(selectedAnime); renderPlayers(selectedAnime.videos); episodesList.innerHTML = '<div class="empty-state">Сначала выберите плеер</div>';
  } catch (e) { alert(e.message); }
}

function startViewerSyncLoop() {
  stopViewerSyncLoop();
  if (roomId === 'solo' || isHost) return;
  viewerAutoSyncTimer = setInterval(() => socket.emit('sync-request', { roomId }), 7000);
}
function stopViewerSyncLoop() { if (viewerAutoSyncTimer) clearInterval(viewerAutoSyncTimer); }

window.addEventListener('pointerdown', () => userInteractedWithPlayer = true);
window.addEventListener('keydown', () => userInteractedWithPlayer = true);

window.addEventListener('message', (event) => {
  try {
    const p = event.data; if (!p || typeof p !== 'object') return;
    if (p.key?.startsWith('kodik_player_')) {
      const key = p.key, val = p.value;
      if (key === 'kodik_player_time_update') {
        const s = Number(val) || Number(val?.time);
        if (!Number.isNaN(s) && s >= 0) { currentState.playback.currentTime = s; currentState.playback.updatedAt = Date.now(); if (isHost) lastHostKnownTime = s; }
      }
      if (key === 'kodik_player_duration_update') currentState.duration = Number(val) || 0;
      if (!isRemoteAction && roomId !== 'solo' && isHost) {
        if (key === 'kodik_player_play') { currentState.playback.paused = false; currentState.playback.updatedAt = Date.now(); currentState.playback.currentTime = lastHostKnownTime || 0; socket.emit('player-control', {roomId, action:'play', currentTime: currentState.playback.currentTime}); }
        if (key === 'kodik_player_pause') { currentState.playback.paused = true; currentState.playback.updatedAt = Date.now(); currentState.playback.currentTime = lastHostKnownTime || 0; socket.emit('player-control', {roomId, action:'pause', currentTime: currentState.playback.currentTime}); }
        if (key === 'kodik_player_seek') { const t = Number(val?.time); if (!Number.isNaN(t) && t>=0) { currentState.playback.currentTime=t; currentState.playback.updatedAt=Date.now(); lastHostKnownTime=t; socket.emit('player-control', {roomId, action:'seek', currentTime:t}); } }
      }
    }
  } catch(e) {}
});

socket.on('connect', () => { sys(`SOCKET: ${socket.id}`); if (roomId !== 'solo') socket.emit('join-room', { roomId, username, userKey }); else isHost = true; });
socket.on('disconnect', () => { stopViewerSyncLoop(); stopKodikTimePolling(); });
socket.on('you-are-host', () => { isHost = true; updateControlState(); stopViewerSyncLoop(); sys('Вы хост'); });

socket.on('sync-state', (state) => {
  isHost = !!state.isHost; updateControlState();
  if (isHost) stopViewerSyncLoop(); else startViewerSyncLoop();
  currentState = { ...currentState, ...state };
  if (currentState.embedUrl) {
    loadIframe(currentState.embedUrl, currentState.title);
    // Применяем время только если оно реальное (>0.3 сек)
    if (typeof currentState.playback.currentTime === 'number' && currentState.playback.currentTime > 0.3) {
       pendingPlaybackApply = currentState.playback;
       applyPlaybackStateWhenReady(currentState.playback, 10, {forceSeek:true});
    }
  } else showPlaceholder('Ничего не выбрано', 'Хост запускает');
});

socket.on('video-changed', (state) => {
  currentState = { ...currentState, ...state };
  if (currentState.embedUrl) loadIframe(currentState.embedUrl, currentState.title);
  else showPlaceholder('Ничего не выбрано', 'Ожидание');
});

socket.on('player-control', ({ action, currentTime, paused, updatedAt }) => {
  if (roomId === 'solo' || isHost) return;
  const t = Number(currentTime);
  // Игнорируем команды с нулевым временем, если это не seek (чтобы не сбрасывало видео на старт при артефактах сети)
  if (action !== 'seek' && (!Number.isFinite(t) || t < 0.5)) return;
  
  currentState.playback = { paused: paused, currentTime: Number.isFinite(t) ? t : null, updatedAt: updatedAt || Date.now() };
  
  if (action === 'seek') applyPlaybackStateWhenReady(currentState.playback, 10, {forceSeek:true});
  else if (action === 'play') applyPlaybackStateWhenReady(currentState.playback, 10, {skipPause:true});
  else if (action === 'pause') applyPlaybackStateWhenReady(currentState.playback, 10);
});

socket.on('room-users', renderUsers);
socket.on('system-message', ({text}) => sys(text));
socket.on('chat-message', ({username,message,time}) => { if (chatMessages && window.ChatModule) ChatModule.appendMessage(chatMessages, {username, message, time}); });

if (searchInput) searchInput.oninput = () => { clearTimeout(searchDebounce); searchDebounce = setTimeout(() => searchAnime(searchInput.value), 400); };
if (copyLinkBtn) copyLinkBtn.onclick = async () => { navigator.clipboard.writeText(`${window.location.origin}/room/${encodeURIComponent(roomId)}?username=${encodeURIComponent(username)}`).then(()=>sys('Ссылка скопирована')); };
if (cinemaModeBtn) cinemaModeBtn.onclick = () => roomPage.classList.toggle('cinema-mode');
if (sendBtn && chatInput) { sendBtn.onclick = () => { if (chatInput.value.trim()) socket.emit('chat-message', {roomId, username: username, message: chatInput.value.trim()}); chatInput.value=''; }; chatInput.onkeydown = e=>{if(e.key==='Enter')sendBtn.click()}; }
statusButtons.forEach(b=> b.onclick = ()=> socket.emit('update-watch-status', {roomId, status: b.dataset.status}));

updateControlState(); showPlaceholder('Выберите аниме', 'Ищите сверху'); renderUsers([]);