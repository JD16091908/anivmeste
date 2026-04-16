const socket = io();

const CONFIG = window.AnivmesteConfig || {};
const SUPPORT_CONFIG = CONFIG.support || {};
const BOOSTY_URL = SUPPORT_CONFIG.boostyUrl || '#';
const DONATIONALERTS_URL = SUPPORT_CONFIG.donationAlertsUrl || '#';

const params = new URLSearchParams(window.location.search);
const roomId = decodeURIComponent(window.location.pathname.split('/room/')[1] || '');

const SEARCH_ENDPOINTS = ['/api/kodik/search', '/api/yummy/search'];
const SELECT_ENDPOINTS = ['/api/kodik/anime/by-selection', '/api/yummy/anime/by-selection'];

// ─── Синхронизация: константы ────────────────────────────────────────────────
const SYNC_TOLERANCE_SEC   = 2.5;   // допустимое расхождение в секундах
const SYNC_DRIFT_INTERVAL  = 2000;  // период проверки дрейфа (мс)
const SYNC_SEEK_COOLDOWN   = 1500;  // минимальный интервал между принудительными seek'ами (мс)
const HOST_BROADCAST_INTERVAL = 800; // хост шлёт время каждые N мс
const USER_TIME_INTERVAL   = 1000;  // зритель шлёт своё время каждые N мс

function updateRoomDocumentMeta(currentRoomId) {
  const title = currentRoomId === 'solo' ? 'Одиночный просмотр' : 'Комната просмотра';
  document.title = `${title} — Anivmeste`;
  const roomTitleEl = document.getElementById('roomTitle');
  if (roomTitleEl) roomTitleEl.textContent = title;
}

updateRoomDocumentMeta(roomId);

const USER_KEY_STORAGE        = 'anivmeste_user_key';
const USERNAME_STORAGE        = 'username';
const MANUAL_USERNAME_STORAGE = 'saved_username_manual';

const SEARCH_MIN_LENGTH     = 2;
const SEARCH_DEBOUNCE_MS    = 300;
const SEARCH_CLIENT_CACHE_TTL_MS  = 3 * 60 * 1000;
const SEARCH_CLIENT_CACHE_MAX     = 70;

const RANDOM_NICK_ADJECTIVES = [
  'Swift','Silent','Crimson','Silver','Golden','Shadow','Lunar','Solar','Misty','Stormy',
  'Frozen','Burning','Shining','Dark','Bright','Wild','Calm','Rapid','Lucky','Cosmic',
  'Electric','Ancient','Hidden','Secret','Fierce','Gentle','Brave','Noble','Clever','Crazy',
  'Dreamy','Ghostly','Royal','Tiny','Mega','Hyper','Epic','Magic','Cyber','Neon',
  'Velvet','Iron','Crystal','Phantom','Thunder','Ashen','Scarlet','Emerald','Ivory','Obsidian',
  'Azure','Ruby','Sapphire','Amber','Pearl','Snowy','Windy','Dizzy','Mellow','Glowing',
  'Stealthy','Vivid','Arcane','Quantum','Pixel','Turbo','Nova','Stellar','Void','Night',
  'Dawn','Dusk','Blazing','Chill','Savage','Elegant','Fearless','Wicked','Radiant','Hollow'
];

const RANDOM_NICK_NOUNS = [
  'Fox','Wolf','Tiger','Dragon','Phoenix','Raven','Falcon','Hawk','Panda','Rabbit',
  'Samurai','Ninja','Ronin','Knight','Wizard','Mage','Hunter','Rider','Pirate','Guardian',
  'Otter','Bear','Eagle','Shark','Panther','Lynx','Crow','Viper','Leopard','Cobra',
  'Kitsune','Tanuki','Yokai','Spirit','Ghost','Demon','Angel','Comet','Meteor','Star',
  'Moon','Blade','Arrow','Storm','Flame','Frost','Thunder','Shadow','Spark','Stone',
  'Echo','Whisper','Glitch','Pixel','Byte','Cipher','Nova','Orbit','Voyager','Drifter',
  'Wanderer','Sage','Monk','Brawler','Sniper','Scout','Captain','King','Queen','Prince',
  'Princess','Beast','Slayer','Seeker','Walker','Chaser','Nomad','Reaper','Sentinel','Alchemist'
];

// ─── localStorage ─────────────────────────────────────────────────────────────

function safeLocalStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeLocalStorageSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function sanitizeUsername(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
}

function normalizeSearchQuery(value) {
  return String(value || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

function pickRandomItem(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items[Math.floor(Math.random() * items.length)] || null;
}

function generateRandomNickname() {
  const adjective = pickRandomItem(RANDOM_NICK_ADJECTIVES) || 'Guest';
  const noun = pickRandomItem(RANDOM_NICK_NOUNS) || 'User';
  return `${adjective} ${noun}`.slice(0, 30);
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

  const randomUsername = generateRandomNickname();
  safeLocalStorageSet(USERNAME_STORAGE, randomUsername);
  safeLocalStorageSet(MANUAL_USERNAME_STORAGE, '0');
  return randomUsername;
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

// ─── Состояние ────────────────────────────────────────────────────────────────

let isHost = false;
let selectedAnime = null;
let selectedPlayer = null;
// selectedSeason оставляем для внутренней логики (фильтрация видео), но не показываем кнопку
let selectedSeason = null;
let latestSearchToken = 0;
let pendingPlaybackApply = null;
let userInteractedWithPlayer = false;
let hostTimeBroadcastTimer = null;
let userTimeBroadcastTimer = null;
let driftCheckTimer = null;
let hasShownHostMessage = false;
let lastKnownHostTime = null;
let lastKnownHostTimeAt = 0;
let lastAppliedTargetTime = null;
let lastAppliedAt = 0;
let lastForcedSyncAt = 0;
let hasShownFirstEpisodeHint = false;
let audioContext = null;
let latestRoomUsers = [];
let usersRenderTicker = null;
let showAllSearchResults = false;
let lastSearchResults = [];
let lastSearchQueryNormalized = '';
let activeSearchAbortController = null;
let lastRenderedSearchSignature = '';
const clientSearchCache = new Map();

let isOverlayPlayerOpen = false;
let isOverlayEpisodeOpen = false;

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

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const hostBadge                  = document.getElementById('hostBadge');
const usersList                  = document.getElementById('usersList');
const animeList                  = document.getElementById('animeList');
const searchInput                = document.getElementById('searchInput');
const copyLinkBtn                = document.getElementById('copyLinkBtn');
const cinemaModeBtn              = document.getElementById('cinemaModeBtn');
const supportRoomBtn             = document.getElementById('supportRoomBtn');
const roomPage                   = document.getElementById('roomPage');
const chatMessages               = document.getElementById('chatMessages');
const chatInput                  = document.getElementById('chatInput');
const sendBtn                    = document.getElementById('sendBtn');
const searchStatus               = document.getElementById('searchStatus');
const selectedAnimeInfo          = document.getElementById('selectedAnimeInfo');
const hostSearchHint             = document.getElementById('hostSearchHint');
const nicknameInput              = document.getElementById('nicknameInput');
const saveNicknameBtn            = document.getElementById('saveNicknameBtn');

const overlayPlayerDropdown      = document.getElementById('overlayPlayerDropdown');
const overlayEpisodeDropdown     = document.getElementById('overlayEpisodeDropdown');
const overlayPlayerBtn           = document.getElementById('overlayPlayerBtn');
const overlayEpisodeBtn          = document.getElementById('overlayEpisodeBtn');
const overlayPlayerBtnText       = document.getElementById('overlayPlayerBtnText');
const overlayEpisodeBtnText      = document.getElementById('overlayEpisodeBtnText');
const overlayPlayerMenu          = document.getElementById('overlayPlayerMenu');
const overlayEpisodeMenu         = document.getElementById('overlayEpisodeMenu');

const roomSupportModal           = document.getElementById('roomSupportModal');
const roomSupportModalBackdrop   = document.getElementById('roomSupportModalBackdrop');
const closeRoomSupportModalBtn   = document.getElementById('closeRoomSupportModalBtn');
const roomSupportDescription     = document.getElementById('roomSupportDescription');
const roomSupportThanks          = document.getElementById('roomSupportThanks');
const roomSupportBoostyLink      = document.getElementById('roomSupportBoostyLink');
const roomSupportDonationAlertsLink = document.getElementById('roomSupportDonationAlertsLink');

// ─── Начальное заполнение ─────────────────────────────────────────────────────

if (nicknameInput) nicknameInput.value = username;
if (roomSupportDescription) roomSupportDescription.textContent = SUPPORT_CONFIG.description || '';
if (roomSupportThanks) roomSupportThanks.textContent = SUPPORT_CONFIG.thanksText || '';
if (roomSupportBoostyLink) roomSupportBoostyLink.href = BOOSTY_URL;
if (roomSupportDonationAlertsLink) roomSupportDonationAlertsLink.href = DONATIONALERTS_URL;

// ─── Debounce ─────────────────────────────────────────────────────────────────

if (!window.AnivmesteDebounce) {
  window.AnivmesteDebounce = function debounce(fn, wait = 300) {
    let t = null;
    const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  };
}

// ─── AudioContext ─────────────────────────────────────────────────────────────

function ensureAudioContext() {
  if (audioContext) return audioContext;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  audioContext = new AudioCtx();
  return audioContext;
}

function unlockAudioContext() {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function playChatSound() {
  try {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    const gain2 = ctx.createGain();
    const masterGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(1320, now);
    osc1.frequency.exponentialRampToValueAtTime(1760, now + 0.045);
    osc2.frequency.setValueAtTime(990, now);
    osc2.frequency.exponentialRampToValueAtTime(1320, now + 0.05);

    gain1.gain.setValueAtTime(0.0001, now);
    gain1.gain.exponentialRampToValueAtTime(0.018, now + 0.006);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

    gain2.gain.setValueAtTime(0.0001, now);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.006);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(3200, now);
    filter.Q.setValueAtTime(0.6, now);
    masterGain.gain.setValueAtTime(0.9, now);

    osc1.connect(gain1); osc2.connect(gain2);
    gain1.connect(filter); gain2.connect(filter);
    filter.connect(masterGain);
    masterGain.connect(ctx.destination);

    osc1.start(now); osc2.start(now);
    osc1.stop(now + 0.085); osc2.stop(now + 0.085);
  } catch (error) {
    console.warn('Не удалось воспроизвести звук чата:', error);
  }
}

// ─── Support modal ────────────────────────────────────────────────────────────

function openRoomSupportModal() {
  if (!roomSupportModal) return;
  roomSupportModal.classList.remove('hidden', 'is-hiding');
  roomSupportModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => roomSupportModal.classList.add('is-visible'));
}

function closeRoomSupportModal() {
  if (!roomSupportModal || roomSupportModal.classList.contains('hidden')) return;
  roomSupportModal.classList.remove('is-visible');
  roomSupportModal.classList.add('is-hiding');
  setTimeout(() => {
    roomSupportModal.classList.add('hidden');
    roomSupportModal.classList.remove('is-hiding');
    roomSupportModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }, 220);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const canControl = () => roomId === 'solo' || isHost;

function getMoscowTimeString() {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
}

function sys(text) {
  if (!text) return;
  if (chatMessages && window.ChatModule) {
    window.ChatModule.appendSystemMessage(chatMessages, text);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

async function readJsonSafely(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  if (!contentType.includes('application/json')) throw new Error(`Сервер вернул не JSON. HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { throw new Error('Сервер вернул битый JSON'); }
}

async function fetchJsonFallback(endpoints, options = {}) {
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, options);
      const data = await readJsonSafely(response);
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      return data;
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('Сервис временно недоступен');
}

function formatWatchTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ─── Видео / озвучки / сезоны / серии ────────────────────────────────────────

function getPlayerName(video) {
  return String(video?.player || video?.dubbing || 'unknown').trim();
}

function getEpisodeNumber(video) {
  return Number(video?.number) || Number(video?.index) || 0;
}

function getSeasonNumber(video) {
  const season = Number(video?.season);
  return season > 0 ? season : 1;
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
    if (!map.has(name)) map.set(name, { name, episodeNumbers: new Set() });
    const epNum = getEpisodeNumber(video);
    if (epNum > 0) map.get(name).episodeNumbers.add(epNum);
  }
  return [...map.values()]
    .map(p => ({ name: p.name, count: p.episodeNumbers.size || 1 }))
    .sort((a, b) => b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name, 'ru'));
}

function getVideosBySelectedPlayer(videos) {
  if (!selectedPlayer) return [];
  return (videos || []).filter(v => getPlayerName(v) === selectedPlayer && !!getIframeUrl(v));
}

function getUniqueSeasons(videos) {
  const map = new Map();
  for (const video of videos || []) {
    const season = getSeasonNumber(video);
    if (!map.has(season)) map.set(season, { season, count: 1 });
    else map.get(season).count += 1;
  }
  return [...map.values()].sort((a, b) => a.season - b.season);
}

function getVideosBySelectedSeason(videos) {
  if (!selectedSeason) return [];
  return (videos || []).filter(v => getSeasonNumber(v) === selectedSeason);
}

function getUniqueEpisodes(videos) {
  const map = new Map();
  for (const video of videos || []) {
    const ep = getEpisodeNumber(video);
    const url = getIframeUrl(video);
    if (!ep || !url) continue;
    if (!map.has(ep)) map.set(ep, { ...video, episodeNumber: ep });
  }
  return [...map.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
}

function findDefaultContext(videos) {
  const players = getUniquePlayers(videos);
  if (!players.length) return null;
  const player = players[0].name;
  const byPlayer = (videos || []).filter(v => getPlayerName(v) === player && !!getIframeUrl(v));
  const seasons = getUniqueSeasons(byPlayer);
  const season = seasons[0]?.season || 1;
  const bySeason = byPlayer.filter(v => getSeasonNumber(v) === season);
  const episodes = getUniqueEpisodes(bySeason);
  const episode = episodes[0] || null;
  if (!episode) return null;
  return { player, season, episode };
}

// ─── Синхронизация (хост → зрители) ──────────────────────────────────────────

/**
 * Вычисляет актуальное время хоста с учётом задержки с момента последнего обновления.
 */
function getInterpolatedHostTime() {
  if (lastKnownHostTime === null) return null;
  if (currentState.playback.paused) return lastKnownHostTime;
  const elapsed = (Date.now() - lastKnownHostTimeAt) / 1000;
  return lastKnownHostTime + elapsed;
}

/**
 * Применяет состояние воспроизведения к плееру.
 * Использует интерполяцию для компенсации сетевой задержки.
 */
function applyPlaybackState(playback, { force = false } = {}) {
  if (!window.PlayerModule || !playback) return;

  const now = Date.now();
  let targetTime = typeof playback.currentTime === 'number' && !Number.isNaN(playback.currentTime)
    ? playback.currentTime
    : null;

  // Интерполируем время: компенсируем задержку с момента updatedAt
  if (targetTime !== null && !playback.paused && playback.updatedAt) {
    const networkDelay = Math.max(0, (now - Number(playback.updatedAt)) / 1000);
    targetTime = targetTime + networkDelay;
  }

  // Seek только если нужно (не слишком часто и значимое расхождение)
  if (targetTime !== null) {
    const timeSinceLastApply = now - lastAppliedAt;
    const drift = Math.abs((lastAppliedTargetTime ?? -999) - targetTime);

    if (force || timeSinceLastApply > SYNC_SEEK_COOLDOWN || drift > SYNC_TOLERANCE_SEC) {
      try { window.PlayerModule.seekTo(targetTime); } catch {}
      lastAppliedTargetTime = targetTime;
      lastAppliedAt = now;
    }
  }

  // Play / Pause
  if (playback.paused) {
    try { window.PlayerModule.pause(); } catch {}
  } else {
    try { window.PlayerModule.play(); } catch {}
  }
}

/**
 * Проверяет дрейф у зрителя и корректирует, если расхождение > SYNC_TOLERANCE_SEC.
 */
function checkDrift() {
  if (isHost || roomId === 'solo') return;
  if (!currentState.embedUrl) return;
  if (currentState.playback.paused) return;

  const hostTime = getInterpolatedHostTime();
  if (hostTime === null) return;

  const myTime = currentState.playback.currentTime;
  if (typeof myTime !== 'number' || Number.isNaN(myTime)) return;

  const drift = Math.abs(myTime - hostTime);
  const now = Date.now();

  if (drift > SYNC_TOLERANCE_SEC && now - lastForcedSyncAt > SYNC_SEEK_COOLDOWN) {
    console.log(`[Sync] drift=${drift.toFixed(2)}s, seeking to hostTime=${hostTime.toFixed(2)}s`);
    try { window.PlayerModule.seekTo(hostTime); } catch {}
    lastAppliedTargetTime = hostTime;
    lastAppliedAt = now;
    lastForcedSyncAt = now;
  }
}

function startDriftCheck() {
  stopDriftCheck();
  if (roomId === 'solo' || isHost) return;
  driftCheckTimer = setInterval(checkDrift, SYNC_DRIFT_INTERVAL);
}

function stopDriftCheck() {
  if (driftCheckTimer) { clearInterval(driftCheckTimer); driftCheckTimer = null; }
}

// ─── Таймеры хоста / зрителя ─────────────────────────────────────────────────

function startHostTimers() {
  stopHostTimers();
  if (!isHost || roomId === 'solo') return;

  hostTimeBroadcastTimer = setInterval(() => {
    if (!isHost || roomId === 'solo' || !currentState.embedUrl) return;
    const ct = currentState.playback.currentTime;
    if (typeof ct === 'number' && ct >= 0) {
      socket.emit('player-control', {
        roomId, action: 'timeupdate', currentTime: ct
      });
    }
  }, HOST_BROADCAST_INTERVAL);
}

function stopHostTimers() {
  if (hostTimeBroadcastTimer) { clearInterval(hostTimeBroadcastTimer); hostTimeBroadcastTimer = null; }
}

function startUserTimeTimer() {
  stopUserTimeTimer();
  if (roomId === 'solo') return;

  userTimeBroadcastTimer = setInterval(() => {
    if (!currentState.embedUrl) return;
    const ct = currentState.playback.currentTime;
    if (typeof ct === 'number' && ct >= 0) {
      socket.emit('update-user-time', { roomId, currentTime: ct });
    }
  }, USER_TIME_INTERVAL);
}

function stopUserTimeTimer() {
  if (userTimeBroadcastTimer) { clearInterval(userTimeBroadcastTimer); userTimeBroadcastTimer = null; }
}

// ─── Нативные события плеера ──────────────────────────────────────────────────

// Обновляем currentState.playback.currentTime по событиям от PlayerModule
window.addEventListener('player:time-update', (e) => {
  const seconds = e.detail?.time;
  if (typeof seconds !== 'number' || Number.isNaN(seconds) || seconds < 0) return;

  currentState.playback.currentTime = seconds;
  currentState.playback.updatedAt = Date.now();

  if (isHost) {
    lastKnownHostTime = seconds;
    lastKnownHostTimeAt = Date.now();
  }
});

window.addEventListener('player:duration-update', (e) => {
  const d = e.detail?.duration;
  if (typeof d === 'number' && d > 0) currentState.duration = d;
});

// Хост: события play/pause от самого плеера транслируем в комнату
window.addEventListener('player:play', () => {
  if (!isHost || roomId === 'solo') return;
  currentState.playback.paused = false;
  currentState.playback.updatedAt = Date.now();
  socket.emit('player-control', {
    roomId, action: 'play', currentTime: currentState.playback.currentTime
  });
});

window.addEventListener('player:pause', () => {
  if (!isHost || roomId === 'solo') return;
  currentState.playback.paused = true;
  currentState.playback.updatedAt = Date.now();
  socket.emit('player-control', {
    roomId, action: 'pause', currentTime: currentState.playback.currentTime
  });
});

// ─── UI helpers ───────────────────────────────────────────────────────────────

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
      ? 'Искать и выбирать тайтл может только хост комнаты'
      : 'Вы можете искать тайтлы и запускать плеер для всей комнаты';
  }

  if (hostBadge) {
    hostBadge.textContent = canControl() ? '👑 Хост' : '👀 Зритель';
  }

  animeList?.querySelectorAll('button').forEach(btn => { btn.disabled = disabled; });
  if (overlayPlayerBtn) overlayPlayerBtn.disabled = disabled;
  if (overlayEpisodeBtn) overlayEpisodeBtn.disabled = disabled;
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

  const players  = getUniquePlayers(anime?.videos || []);
  const seasons  = getUniqueSeasons(anime?.videos || []);
  const episodes = getUniqueEpisodes(anime?.videos || []);
  const descriptionContent = anime.description
    ? `<p class="selected-anime-description">${escapeHtml(anime.description)}</p>`
    : '';

  selectedAnimeInfo.innerHTML = `
    <div class="selected-anime-layout">
      ${anime.poster ? `<img class="selected-anime-poster" src="${escapeHtml(anime.poster)}" loading="lazy" alt="${escapeHtml(anime.title)}">` : ''}
      <div class="selected-anime-body">
        <h3 class="selected-anime-title">${escapeHtml(anime.title)}</h3>
        <div class="selected-anime-meta">
          ${anime.year ? escapeHtml(String(anime.year)) : ''}${anime.type ? ` • ${escapeHtml(anime.type)}` : ''}${anime.status ? ` • ${escapeHtml(anime.status)}` : ''}
        </div>
        ${descriptionContent}
        <div class="selected-anime-extra">Озвучек: ${players.length} • Сезонов: ${seasons.length} • Серий: ${episodes.length}</div>
      </div>
    </div>
  `;
}

function showPlaceholderUi(title = 'Ничего не выбрано', description = 'Выберите аниме') {
  const playerWrapper = document.getElementById('playerWrapper');
  if (!playerWrapper || !window.PlayerModule) return;
  window.PlayerModule.showPlaceholder(playerWrapper, { title, description });
}

function showBlockedAnimeMessage(message = 'Данное аниме запрещено на территории вашей страны') {
  selectedAnime = null;
  currentState = {
    animeId: null, animeUrl: null, episodeNumber: null, embedUrl: null, title: null,
    duration: 0, playback: { paused: true, currentTime: 0, updatedAt: Date.now() }
  };
  updateSelectedAnimeInfoContent(null);
  showPlaceholderUi('Просмотр недоступен', message);
}

function showViewerHint(text = 'Если видео не стартовало автоматически, кликните по плееру один раз.') {
  const playerWrapper = document.getElementById('playerWrapper');
  if (!playerWrapper || !window.PlayerModule || isHost || roomId === 'solo') return;
  window.PlayerModule.showPlaceholder(playerWrapper, { title: 'Серия загружена', description: text });
  playerWrapper.querySelector('.placeholder')?.classList.add('placeholder-click-through');
}

function hideViewerHintOverlay() {
  const playerWrapper = document.getElementById('playerWrapper');
  if (!playerWrapper) return;
  const placeholderEl = playerWrapper.querySelector('.placeholder');
  if (!placeholderEl) return;
  if (!placeholderEl.classList.contains('placeholder-click-through')) return;
  placeholderEl.style.display = 'none';
}

function showFirstEpisodeHintForHost() {
  if (!isHost || roomId === 'solo' || hasShownFirstEpisodeHint) return;
  hasShownFirstEpisodeHint = true;
  sys('После загрузки первой серии при необходимости кликните по плееру один раз и нажмите play.');
}

// ─── Bridge / iframe ──────────────────────────────────────────────────────────

let bridge = { playerType: 'unknown', iframeWindow: null };

function resetBridge() {
  bridge = { playerType: 'unknown', iframeWindow: null };
}

function detachPlayerOverlayFromWrapper(playerWrapper) {
  if (!playerWrapper) return null;
  const overlayEl = document.getElementById('playerTopOverlay');
  if (!overlayEl) return null;
  if (overlayEl.parentNode === playerWrapper) { overlayEl.remove(); return overlayEl; }
  return null;
}

function attachPlayerOverlayToWrapper(playerWrapper, overlayEl) {
  if (!playerWrapper || !overlayEl) return;
  if (!playerWrapper.contains(overlayEl)) playerWrapper.appendChild(overlayEl);
}

function hideOverlayMenus() {
  isOverlayPlayerOpen  = false;
  isOverlayEpisodeOpen = false;
  overlayPlayerDropdown?.classList.remove('open');
  overlayEpisodeDropdown?.classList.remove('open');
}

function hideOverlay() {
  hideOverlayMenus();
  document.getElementById('playerTopOverlay')?.classList.add('hidden');
}

function showOverlay() {
  document.getElementById('playerTopOverlay')?.classList.remove('hidden');
}

function loadIframe(embedUrl) {
  const playerWrapper = document.getElementById('playerWrapper');
  if (!playerWrapper || !window.PlayerModule) return;

  if (!embedUrl) {
    showPlaceholderUi('Серия не запущена', 'У выбранного тайтла отсутствует iframe');
    return;
  }

  stopHostTimers();
  stopUserTimeTimer();
  stopDriftCheck();
  resetBridge();
  lastKnownHostTime    = null;
  lastKnownHostTimeAt  = 0;
  lastAppliedTargetTime = null;
  lastAppliedAt        = 0;
  lastForcedSyncAt     = 0;
  pendingPlaybackApply = null;

  const preservedOverlay = detachPlayerOverlayFromWrapper(playerWrapper);

  window.PlayerModule.mountIframe(playerWrapper, { src: embedUrl, title: currentState.title });

  attachPlayerOverlayToWrapper(playerWrapper, preservedOverlay);

  bridge.playerType = typeof window.PlayerModule.detectPlayerType === 'function'
    ? window.PlayerModule.detectPlayerType(embedUrl)
    : 'unknown';

  // Зритель: пауза сразу, потом применяем синхронизацию
  if (!isHost && roomId !== 'solo') {
    setTimeout(() => {
      try { window.PlayerModule.pause(); } catch {}
    }, 200);
  }

  startUserTimeTimer();

  if (isHost) {
    startHostTimers();
    showFirstEpisodeHintForHost();
  } else if (roomId !== 'solo') {
    startDriftCheck();
  }

  if (pendingPlaybackApply) {
    const pb = pendingPlaybackApply;
    pendingPlaybackApply = null;
    setTimeout(() => applyPlaybackState(pb, { force: true }), 800);
  }

  setTimeout(() => {
    if (selectedAnime) {
      try { renderOverlayControls(); } catch {}
    }
  }, 50);

  if (!isHost && roomId !== 'solo') {
    setTimeout(() => {
      if (!userInteractedWithPlayer) {
        showViewerHint('Если серия не стартовала, нажмите по плееру один раз.');
      }
    }, 800);
  }
}

// ─── Overlay controls (только озвучка + серии) ────────────────────────────────

function renderOverlayControls() {
  if (!selectedAnime) { hideOverlay(); return; }

  const videos  = selectedAnime.videos || [];
  const players = getUniquePlayers(videos);

  if (!selectedPlayer && players.length) selectedPlayer = players[0].name;

  const byPlayer = getVideosBySelectedPlayer(videos);
  const seasons  = getUniqueSeasons(byPlayer);

  // Внутренне выбираем сезон (для фильтрации серий), но кнопку не показываем
  if (!selectedSeason || !seasons.find(s => s.season === selectedSeason)) {
    selectedSeason = seasons[0]?.season || 1;
  }

  const bySeason = getVideosBySelectedSeason(byPlayer);
  const episodes = getUniqueEpisodes(bySeason);

  const currentPlayerData = players.find(p => p.name === selectedPlayer);
  const episodeCount = currentPlayerData ? currentPlayerData.count : episodes.length;

  // ── Кнопка озвучки ──
  if (overlayPlayerBtnText) {
    overlayPlayerBtnText.textContent = selectedPlayer
      ? `${selectedPlayer} (${episodeCount} сер.)`
      : 'Озвучка';
  }

  // ── Кнопка серии ──
  const currentEpNumber = currentState.episodeNumber || episodes[0]?.episodeNumber || 1;
  if (overlayEpisodeBtnText) {
    overlayEpisodeBtnText.textContent = `${currentEpNumber} серия`;
  }

  // ── Меню озвучек ──
  if (overlayPlayerMenu) {
    overlayPlayerMenu.innerHTML = players.map(player => `
      <button
        type="button"
        class="overlay-dropdown-item ${player.name === selectedPlayer ? 'active' : ''}"
        data-player="${escapeHtml(player.name)}"
      >
        <span class="overlay-item-player-name">${escapeHtml(player.name)}</span>
        <span class="overlay-item-count">${player.count}</span>
      </button>
    `).join('');
  }

  // ── Меню серий ──
  if (overlayEpisodeMenu) {
    overlayEpisodeMenu.innerHTML = episodes.map(episode => `
      <button
        type="button"
        class="overlay-dropdown-item overlay-dropdown-item-episode ${episode.episodeNumber === currentState.episodeNumber ? 'active' : ''}"
        data-episode="${episode.episodeNumber}"
      >
        ${episode.episodeNumber}
      </button>
    `).join('');
  }

  // ── Обработчики озвучек ──
  overlayPlayerMenu?.querySelectorAll('[data-player]').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', () => {
      selectedPlayer = btn.dataset.player;
      selectedSeason = null;
      isOverlayPlayerOpen = false;
      overlayPlayerDropdown?.classList.remove('open');

      const refreshedByPlayer = getVideosBySelectedPlayer(selectedAnime?.videos || []);
      const seasonsAfterChange = getUniqueSeasons(refreshedByPlayer);
      selectedSeason = seasonsAfterChange[0]?.season || 1;

      renderOverlayControls();

      const refreshedBySeason = getVideosBySelectedSeason(refreshedByPlayer);
      const firstEpisode = getUniqueEpisodes(refreshedBySeason)[0];
      if (firstEpisode) launchEpisode(firstEpisode, selectedAnime);
    });
  });

  // ── Обработчики серий ──
  overlayEpisodeMenu?.querySelectorAll('[data-episode]').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', () => {
      const episodeNumber = Number(btn.dataset.episode);
      const refreshedByPlayer = getVideosBySelectedPlayer(selectedAnime?.videos || []);
      const refreshedBySeason = getVideosBySelectedSeason(refreshedByPlayer);
      const episode = getUniqueEpisodes(refreshedBySeason).find(v => v.episodeNumber === episodeNumber);
      if (!episode) return;
      isOverlayEpisodeOpen = false;
      overlayEpisodeDropdown?.classList.remove('open');
      renderOverlayControls();
      launchEpisode(episode, selectedAnime);
    });
  });

  showOverlay();
  updateControlState();
}

function launchEpisode(episode, anime) {
  if (!episode) return;

  const embedUrl     = getIframeUrl(episode);
  const season       = getSeasonNumber(episode);
  const episodeNumber = getEpisodeNumber(episode);
  const playerName   = getPlayerName(episode);
  const title        = `${anime?.title || 'Аниме'} — ${playerName}, сезон ${season}, серия ${episodeNumber}`;

  currentState = {
    animeId: anime?.animeId ?? null,
    animeUrl: anime?.animeUrl ?? null,
    episodeNumber,
    embedUrl,
    title,
    duration: 0,
    playback: { paused: true, currentTime: 0, updatedAt: Date.now() }
  };

  selectedSeason  = season;
  selectedPlayer  = playerName;
  hasShownFirstEpisodeHint = false;
  userInteractedWithPlayer = true;

  loadIframe(embedUrl);
  renderOverlayControls();

  if (roomId !== 'solo') {
    socket.emit('change-video', {
      roomId, embedUrl, title,
      animeId: currentState.animeId,
      animeUrl: currentState.animeUrl,
      episodeNumber
    });
  } else {
    sys(`Вы выбрали: ${title}`);
  }
}

// ─── Поиск ────────────────────────────────────────────────────────────────────

function extractTbIndex(title) {
  const t = String(title || '');
  const m = t.match(/\[(?:tb|тв|tv)[- ]?(\d+)\]/i) || t.match(/\b(?:tb|тв|tv)[- ]?(\d+)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function scoreBucket(score) {
  return Math.floor((Number(score) || 0) / 8000);
}

function sortSearchResults(items) {
  return [...(items || [])].sort((a, b) => {
    const sA = Number(a?.score) || 0;
    const sB = Number(b?.score) || 0;
    const bA = scoreBucket(sA);
    const bB = scoreBucket(sB);
    if (bB !== bA) return bB - bA;

    const spA = Number(a?.serialPriority) || 0;
    const spB = Number(b?.serialPriority) || 0;
    if (spB !== spA) return spB - spA;

    const tbA = extractTbIndex(a?.title);
    const tbB = extractTbIndex(b?.title);
    if (tbA !== null || tbB !== null) {
      if (tbA === null) return 1;
      if (tbB === null) return -1;
      if (tbA !== tbB) return tbA - tbB;
    }

    const yearA = Number(a?.year) || 9999;
    const yearB = Number(b?.year) || 9999;
    if (yearA !== yearB) return yearA - yearB;
    if (sB !== sA) return sB - sA;

    return String(a?.title || '').localeCompare(String(b?.title || ''), 'ru');
  });
}

function buildSearchSignature(items, expanded) {
  const ids = (items || [])
    .map(item => `${item.animeId || ''}:${item.title || ''}:${item.year || ''}:${Number(item.score) || 0}`)
    .join('|');
  return `${expanded ? '1' : '0'}::${ids}`;
}

function pruneClientSearchCache() {
  const now = Date.now();
  for (const [key, entry] of clientSearchCache.entries()) {
    if (!entry || now - entry.createdAt > SEARCH_CLIENT_CACHE_TTL_MS) clientSearchCache.delete(key);
  }
  if (clientSearchCache.size <= SEARCH_CLIENT_CACHE_MAX) return;
  const entries = [...clientSearchCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (entries.length && clientSearchCache.size > SEARCH_CLIENT_CACHE_MAX) {
    const [oldestKey] = entries.shift();
    clientSearchCache.delete(oldestKey);
  }
}

function getClientCachedSearch(query) {
  pruneClientSearchCache();
  const entry = clientSearchCache.get(query);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > SEARCH_CLIENT_CACHE_TTL_MS) { clientSearchCache.delete(query); return null; }
  return entry.data;
}

function setClientCachedSearch(query, data) {
  pruneClientSearchCache();
  clientSearchCache.set(query, { createdAt: Date.now(), data });
}

function clearSearchResultsUi() {
  if (animeList) { animeList.innerHTML = ''; animeList.classList.remove('visible'); }
  lastRenderedSearchSignature = '';
}

function renderAnimeResults(items) {
  if (!animeList) return;
  if (!items.length) { clearSearchResultsUi(); return; }

  const visibleItems = showAllSearchResults ? items : items.slice(0, 5);
  const needToggle   = items.length > 5;
  const nextSignature = buildSearchSignature(items, showAllSearchResults);
  if (lastRenderedSearchSignature === nextSignature) return;

  animeList.innerHTML = `
    ${visibleItems.map(item => `
      <button
        type="button"
        class="search-result-item ${item.animeId === selectedAnime?.animeId ? 'active' : ''}"
        data-anime-id="${escapeHtml(item.animeId)}"
      >
        ${item.poster
          ? `<img class="search-result-poster" src="${escapeHtml(item.poster)}" loading="lazy" alt="${escapeHtml(item.title)}">`
          : '<div class="search-result-poster search-result-poster-empty"></div>'}
        <div class="search-result-content">
          <div class="search-result-title">${escapeHtml(item.title)}</div>
          <div class="search-result-meta">${escapeHtml(item.year || '')}${item.type ? ` • ${escapeHtml(item.type)}` : ''}</div>
        </div>
      </button>
    `).join('')}
    ${needToggle ? `
      <button type="button" class="search-results-toggle" id="searchResultsToggleBtn">
        ${showAllSearchResults ? 'СВЕРНУТЬ РЕЗУЛЬТАТЫ' : 'ОТКРЫТЬ ВСЕ РЕЗУЛЬТАТЫ'}
      </button>
    ` : ''}
  `;

  animeList.classList.add('visible');
  lastRenderedSearchSignature = nextSignature;

  animeList.querySelectorAll('.search-result-item').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', async () => {
      const selectedItemFromResults = items.find(item => item.animeId === btn.dataset.animeId);
      if (!selectedItemFromResults) return;
      clearSearchResultsUi();
      await selectAnime(selectedItemFromResults);
    });
  });

  const toggleBtn = document.getElementById('searchResultsToggleBtn');
  if (toggleBtn) {
    toggleBtn.disabled = !canControl();
    toggleBtn.addEventListener('click', () => {
      showAllSearchResults = !showAllSearchResults;
      lastRenderedSearchSignature = '';
      renderAnimeResults(lastSearchResults);
    });
  }
}

function toggleOverlayDropdown(dropdownElement, isOpenState) {
  if (!dropdownElement) return false;
  const nextState = !isOpenState;
  dropdownElement.classList.toggle('open', nextState);
  if (nextState) {
    if (dropdownElement !== overlayPlayerDropdown)  overlayPlayerDropdown?.classList.remove('open');
    if (dropdownElement !== overlayEpisodeDropdown) overlayEpisodeDropdown?.classList.remove('open');
  }
  return nextState;
}

async function fetchSearchResults(rawQuery, token) {
  const normalizedQuery = normalizeSearchQuery(rawQuery);

  const cached = getClientCachedSearch(normalizedQuery);
  if (cached) {
    if (token !== latestSearchToken) return;
    lastSearchQueryNormalized = normalizedQuery;
    lastSearchResults = cached;
    renderAnimeResults(lastSearchResults);
    if (searchStatus) searchStatus.textContent = lastSearchResults.length ? `Найдено: ${lastSearchResults.length}` : 'Ничего не найдено';
    return;
  }

  if (activeSearchAbortController) activeSearchAbortController.abort();
  activeSearchAbortController = new AbortController();

  const queryString = `q=${encodeURIComponent(rawQuery)}`;
  const endpoints   = SEARCH_ENDPOINTS.map(base => `${base}?${queryString}`);

  const data = await fetchJsonFallback(endpoints, {
    signal: activeSearchAbortController.signal,
    headers: { Accept: 'application/json' }
  });

  if (token !== latestSearchToken) return;

  const prepared = sortSearchResults(Array.isArray(data) ? data : []);
  setClientCachedSearch(normalizedQuery, prepared);

  lastSearchQueryNormalized = normalizedQuery;
  lastSearchResults = prepared;
  renderAnimeResults(lastSearchResults);
  if (searchStatus) searchStatus.textContent = lastSearchResults.length ? `Найдено: ${lastSearchResults.length}` : 'Ничего не найдено';
}

async function triggerSearchNow(rawQuery) {
  const value      = String(rawQuery || '').trim();
  const normalized = normalizeSearchQuery(value);
  if (!value || normalized.length < SEARCH_MIN_LENGTH) return;
  if (!canControl()) return;

  latestSearchToken += 1;
  const token = latestSearchToken;
  showAllSearchResults = false;
  if (searchStatus) searchStatus.textContent = 'Поиск...';

  try {
    await fetchSearchResults(value, token);
  } catch (error) {
    if (token !== latestSearchToken) return;
    if (error?.name === 'AbortError') return;
    if (searchStatus) searchStatus.textContent = 'Ошибка поиска. Попробуйте ещё раз.';
    clearSearchResultsUi();
  }
}

function reopenSearchDropdownFromInput() {
  if (!searchInput || !canControl()) return;
  const rawQuery      = String(searchInput.value || '').trim();
  const normalizedQuery = normalizeSearchQuery(rawQuery);
  if (!rawQuery || normalizedQuery.length < SEARCH_MIN_LENGTH) return;

  if (lastSearchResults.length && lastSearchQueryNormalized === normalizedQuery) {
    renderAnimeResults(lastSearchResults);
    return;
  }

  const cached = getClientCachedSearch(normalizedQuery);
  if (cached && cached.length) {
    lastSearchQueryNormalized = normalizedQuery;
    lastSearchResults = cached;
    renderAnimeResults(lastSearchResults);
    if (searchStatus) searchStatus.textContent = `Найдено: ${lastSearchResults.length}`;
    return;
  }

  triggerSearchNow(rawQuery);
}

const debouncedSearchAnime = window.AnivmesteDebounce(async (query) => {
  const rawQuery        = String(query || '').trim();
  const normalizedQuery = normalizeSearchQuery(rawQuery);

  if (!rawQuery || normalizedQuery.length < SEARCH_MIN_LENGTH) {
    latestSearchToken += 1;
    if (activeSearchAbortController) { activeSearchAbortController.abort(); activeSearchAbortController = null; }
    lastSearchResults = [];
    lastSearchQueryNormalized = '';
    showAllSearchResults = false;
    clearSearchResultsUi();
    if (searchStatus) searchStatus.textContent = 'Введите минимум 2 символа';
    return;
  }

  if (!canControl()) return;

  latestSearchToken += 1;
  const token = latestSearchToken;
  showAllSearchResults = false;
  if (searchStatus) searchStatus.textContent = 'Поиск...';

  try {
    await fetchSearchResults(rawQuery, token);
  } catch (error) {
    if (token !== latestSearchToken) return;
    if (error?.name === 'AbortError') return;
    if (searchStatus) searchStatus.textContent = 'Ошибка поиска. Попробуйте ещё раз.';
    clearSearchResultsUi();
  }
}, SEARCH_DEBOUNCE_MS);

// ─── Выбор аниме ──────────────────────────────────────────────────────────────

async function selectAnime(item) {
  if (!item || !canControl()) return;
  if (selectedAnimeInfo) selectedAnimeInfo.innerHTML = 'Загрузка...';

  try {
    const data = await fetchJsonFallback(SELECT_ENDPOINTS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        animeUrl: item.animeUrl,
        animeId: item.animeId,
        title: item.title,
        year: item.year,
        shikimoriId: item.shikimoriId,
        kodikId: item.kodikId
      })
    });

    selectedAnime = {
      ...data,
      shikimoriId: item.shikimoriId || data.shikimoriId || null,
      videos: Array.isArray(data?.videos) ? data.videos : []
    };

    const context = findDefaultContext(selectedAnime.videos);
    if (!context) {
      updateSelectedAnimeInfoContent(selectedAnime);
      showPlaceholderUi('Нет доступных серий', 'Для выбранного тайтла не удалось найти рабочий плеер');
      hideOverlay();
      return;
    }

    selectedPlayer = context.player;
    selectedSeason = context.season;

    updateSelectedAnimeInfoContent(selectedAnime);
    renderOverlayControls();
    launchEpisode(context.episode, selectedAnime);
  } catch (error) {
    if (String(error?.message || '').includes('ANIME_BLOCKED_BY_COUNTRY')) {
      showBlockedAnimeMessage();
      return;
    }
    updateSelectedAnimeInfoContent(null);
    showPlaceholderUi('Ошибка', error.message || 'Не удалось загрузить аниме');
    hideOverlay();
  }
}

// ─── Никнейм ──────────────────────────────────────────────────────────────────

function saveNickname() {
  const newUsername = sanitizeUsername(nicknameInput?.value);
  if (!newUsername) { alert('Введите ник'); nicknameInput?.focus(); return; }

  const oldUsername = username;
  username = newUsername;
  safeLocalStorageSet(USERNAME_STORAGE, username);
  safeLocalStorageSet(MANUAL_USERNAME_STORAGE, '1');
  if (nicknameInput) nicknameInput.value = username;

  if (roomId !== 'solo') {
    socket.emit('change-username', { roomId, username });
  } else if (oldUsername !== username) {
    sys(`Теперь вы ${username}`);
  }
}

// ─── Users render ─────────────────────────────────────────────────────────────

function getDisplayedUserTime(user) {
  const hasTime = typeof user?.currentTime === 'number' && !Number.isNaN(user.currentTime);
  if (!hasTime) return null;
  const baseTime  = Number(user.currentTime) || 0;
  const updatedAt = Number(user.timeUpdatedAt || 0) || 0;
  if (!updatedAt) return baseTime;
  const diffSeconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
  return baseTime + diffSeconds;
}

function renderUsers(users) {
  if (!usersList) return;
  if (Array.isArray(users)) latestRoomUsers = users.map(user => ({ ...user }));

  if (!Array.isArray(latestRoomUsers) || latestRoomUsers.length === 0) {
    usersList.innerHTML = `<div class="empty-state">Пока никого нет</div>`;
    return;
  }

  usersList.innerHTML = latestRoomUsers.map(user => {
    const displayTime = getDisplayedUserTime(user);
    const timeText    = typeof displayTime === 'number' ? formatWatchTime(displayTime) : '—:—';
    return `
      <div class="user-item">
        <div class="user-main">
          <div class="user-identity">
            <span class="user-name">${escapeHtml(user.username)}</span>
            ${user.isHost ? `<span class="host-label">Хост</span>` : ''}
          </div>
          <div class="user-time" title="Текущее время просмотра">${escapeHtml(timeText)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function startUsersRenderTicker() {
  if (usersRenderTicker) clearInterval(usersRenderTicker);
  usersRenderTicker = setInterval(() => renderUsers(), 1000);
}

// ─── Socket events ────────────────────────────────────────────────────────────

socket.on('connect', () => {
  if (roomId !== 'solo') {
    socket.emit('join-room', { roomId, username, userKey });
  } else {
    isHost = true;
    updateControlState();
    updateSelectedAnimeInfoContent(selectedAnime);
    showPlaceholderUi(currentState.title || 'Ничего не выбрано', 'Выберите аниме');
  }
});

socket.on('join-error', ({ message }) => {
  alert(message || 'Не удалось войти в комнату');
  window.location.href = '/';
});

socket.on('disconnect', () => {
  stopHostTimers();
  stopUserTimeTimer();
  stopDriftCheck();
});

socket.on('you-are-host', () => {
  isHost = true;
  updateControlState();
  stopDriftCheck();

  if (currentState.embedUrl) startHostTimers();
  if (!hasShownHostMessage) { sys('Вы хост комнаты'); hasShownHostMessage = true; }
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
    playback: state.playback || { paused: true, currentTime: 0, updatedAt: 0 }
  };

  if (currentState.embedUrl) {
    loadIframe(currentState.embedUrl);
    pendingPlaybackApply = currentState.playback;
    setTimeout(() => applyPlaybackState(pendingPlaybackApply, { force: true }), 900);
  } else {
    showPlaceholderUi('Ничего не выбрано', isHost ? 'Выберите аниме' : 'Хост пока не запустил тайтл');
    hideOverlay();
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
    playback: { paused: true, currentTime: 0, updatedAt: Date.now() }
  };

  if (currentState.embedUrl) {
    loadIframe(currentState.embedUrl);
    pendingPlaybackApply = currentState.playback;
  } else {
    showPlaceholderUi('Ничего не выбрано', 'Хост пока не запустил тайтл');
    hideOverlay();
  }
});

socket.on('player-control', ({ action, currentTime, paused, updatedAt }) => {
  if (roomId === 'solo' || isHost) return;

  const safeTime = typeof currentTime === 'number' && !Number.isNaN(currentTime)
    ? currentTime
    : currentState.playback.currentTime;

  const newPaused = typeof paused === 'boolean' ? paused : action === 'pause';

  // Обновляем эталонное время хоста для дрейф-коррекции
  lastKnownHostTime   = safeTime ?? 0;
  lastKnownHostTimeAt = Date.now();

  currentState.playback = {
    paused: newPaused,
    currentTime: safeTime ?? 0,
    updatedAt: Number(updatedAt || Date.now()) || Date.now()
  };

  const now = Date.now();

  if (action === 'play' || action === 'pause') {
    // Для play/pause применяем немедленно с компенсацией задержки
    applyPlaybackState(currentState.playback, { force: true });
    lastAppliedAt = now;
    lastAppliedTargetTime = safeTime;
    lastForcedSyncAt = now;
  } else if (action === 'seek') {
    // seek от хоста — применяем, если не делали это недавно
    if (now - lastAppliedAt > 300) {
      applyPlaybackState(currentState.playback, { force: true });
      lastAppliedAt = now;
      lastAppliedTargetTime = safeTime;
      lastForcedSyncAt = now;
    }
  }
  // timeupdate — только обновляем эталон, дрейф-чекер сам разберётся
});

socket.on('room-users', renderUsers);

socket.on('system-message', ({ text }) => sys(text));

socket.on('chat-message', ({ username: author, message, time }) => {
  if (!chatMessages || !window.ChatModule) return;
  const isSelfMessage = author === username;
  window.ChatModule.appendMessage(chatMessages, { username: author, message, time, isSelf: isSelfMessage });
  if (!isSelfMessage) playChatSound();
});

// ─── DOM event listeners ──────────────────────────────────────────────────────

window.addEventListener('pointerdown', () => {
  userInteractedWithPlayer = true;
  hideViewerHintOverlay();
  unlockAudioContext();
});

window.addEventListener('keydown', () => {
  userInteractedWithPlayer = true;
  hideViewerHintOverlay();
  unlockAudioContext();
});

document.addEventListener('click', (event) => {
  const withinSearch  = event.target.closest('.anime-search-section, .center-search-panel');
  if (!withinSearch) animeList?.classList.remove('visible');

  const withinOverlay = event.target.closest('.player-top-overlay');
  if (!withinOverlay) hideOverlayMenus();
});

overlayPlayerBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!canControl()) return;
  isOverlayPlayerOpen  = toggleOverlayDropdown(overlayPlayerDropdown, isOverlayPlayerOpen);
  isOverlayEpisodeOpen = false;
});

overlayEpisodeBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!canControl()) return;
  isOverlayEpisodeOpen = toggleOverlayDropdown(overlayEpisodeDropdown, isOverlayEpisodeOpen);
  isOverlayPlayerOpen  = false;
});

if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', async () => {
    const inviteUrl = `${window.location.origin}/room/${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      sys('Ссылка скопирована');
    } catch {
      window.prompt('Скопируйте ссылку:', inviteUrl);
    }
  });
}

if (cinemaModeBtn) {
  cinemaModeBtn.addEventListener('click', () => roomPage?.classList.toggle('cinema-mode'));
}

if (supportRoomBtn) supportRoomBtn.addEventListener('click', openRoomSupportModal);
roomSupportModalBackdrop?.addEventListener('click', closeRoomSupportModal);
closeRoomSupportModalBtn?.addEventListener('click', closeRoomSupportModal);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && roomSupportModal && !roomSupportModal.classList.contains('hidden')) {
    closeRoomSupportModal();
  }
});

if (saveNicknameBtn) saveNicknameBtn.addEventListener('click', saveNickname);

if (nicknameInput) {
  nicknameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNickname(); });
}

if (sendBtn && chatInput) {
  sendBtn.addEventListener('click', () => {
    const message = chatInput.value.trim();
    if (!message) return;
    unlockAudioContext();
    playChatSound();

    if (roomId !== 'solo') {
      socket.emit('chat-message', { roomId, username, message });
    } else if (window.ChatModule && chatMessages) {
      window.ChatModule.appendMessage(chatMessages, {
        username, message, time: getMoscowTimeString(), isSelf: true
      });
    }
    chatInput.value = '';
    chatInput.focus();
  });

  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBtn.click(); });
}

if (searchInput) {
  searchInput.addEventListener('input', () => debouncedSearchAnime(searchInput.value));
  searchInput.addEventListener('click', () => reopenSearchDropdownFromInput());
  searchInput.addEventListener('focus', () => reopenSearchDropdownFromInput());
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      clearSearchResultsUi();
      searchInput.blur();
      debouncedSearchAnime.cancel();
    }
  });
}

window.addEventListener('beforeunload', () => {
  stopHostTimers();
  stopUserTimeTimer();
  stopDriftCheck();
  if (usersRenderTicker) { clearInterval(usersRenderTicker); usersRenderTicker = null; }
  if (activeSearchAbortController) { activeSearchAbortController.abort(); activeSearchAbortController = null; }
});

// ─── Инициализация ────────────────────────────────────────────────────────────

updateControlState();
updateSelectedAnimeInfoContent(null);
showPlaceholderUi('Ничего не выбрано', isHost ? 'Выберите аниме' : 'Хост пока не запустил тайтл');
renderUsers([]);
startUsersRenderTicker();
