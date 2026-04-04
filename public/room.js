const socket = io();

const CONFIG = window.AnivmesteConfig || {};
const SUPPORT_CONFIG = CONFIG.support || {};
const BOOSTY_URL = SUPPORT_CONFIG.boostyUrl || '#';
const DONATIONALERTS_URL = SUPPORT_CONFIG.donationAlertsUrl || '#';

const params = new URLSearchParams(window.location.search);
const roomId = decodeURIComponent(window.location.pathname.split('/room/')[1] || '');

function updateRoomDocumentMeta(currentRoomId) {
  const title = currentRoomId === 'solo'
    ? 'Одиночный просмотр'
    : `Комната: ${currentRoomId}`;

  document.title = `${title} — Anivmeste`;

  const roomTitleEl = document.getElementById('roomTitle');
  if (roomTitleEl) {
    roomTitleEl.textContent = title;
  }
}

updateRoomDocumentMeta(roomId);

const USER_KEY_STORAGE = 'anivmeste_user_key';
const USERNAME_STORAGE = 'username';
const MANUAL_USERNAME_STORAGE = 'saved_username_manual';

const RANDOM_NICK_ADJECTIVES = [
  'Swift', 'Silent', 'Crimson', 'Silver', 'Golden', 'Shadow', 'Lunar', 'Solar', 'Misty', 'Stormy',
  'Frozen', 'Burning', 'Shining', 'Dark', 'Bright', 'Wild', 'Calm', 'Rapid', 'Lucky', 'Cosmic',
  'Electric', 'Ancient', 'Hidden', 'Secret', 'Fierce', 'Gentle', 'Brave', 'Noble', 'Clever', 'Crazy',
  'Dreamy', 'Ghostly', 'Royal', 'Tiny', 'Mega', 'Hyper', 'Epic', 'Magic', 'Cyber', 'Neon',
  'Velvet', 'Iron', 'Crystal', 'Phantom', 'Thunder', 'Ashen', 'Scarlet', 'Emerald', 'Ivory', 'Obsidian',
  'Azure', 'Ruby', 'Sapphire', 'Amber', 'Pearl', 'Snowy', 'Windy', 'Dizzy', 'Mellow', 'Glowing',
  'Stealthy', 'Vivid', 'Arcane', 'Quantum', 'Pixel', 'Turbo', 'Nova', 'Stellar', 'Void', 'Night',
  'Dawn', 'Dusk', 'Blazing', 'Chill', 'Savage', 'Elegant', 'Fearless', 'Wicked', 'Radiant', 'Hollow'
];

const RANDOM_NICK_NOUNS = [
  'Fox', 'Wolf', 'Tiger', 'Dragon', 'Phoenix', 'Raven', 'Falcon', 'Hawk', 'Panda', 'Rabbit',
  'Samurai', 'Ninja', 'Ronin', 'Knight', 'Wizard', 'Mage', 'Hunter', 'Rider', 'Pirate', 'Guardian',
  'Otter', 'Bear', 'Eagle', 'Shark', 'Panther', 'Lynx', 'Crow', 'Viper', 'Leopard', 'Cobra',
  'Kitsune', 'Tanuki', 'Yokai', 'Spirit', 'Ghost', 'Demon', 'Angel', 'Comet', 'Meteor', 'Star',
  'Moon', 'Blade', 'Arrow', 'Storm', 'Flame', 'Frost', 'Thunder', 'Shadow', 'Spark', 'Stone',
  'Echo', 'Whisper', 'Glitch', 'Pixel', 'Byte', 'Cipher', 'Nova', 'Orbit', 'Voyager', 'Drifter',
  'Wanderer', 'Sage', 'Monk', 'Brawler', 'Sniper', 'Scout', 'Captain', 'King', 'Queen', 'Prince',
  'Princess', 'Beast', 'Slayer', 'Seeker', 'Walker', 'Chaser', 'Nomad', 'Reaper', 'Sentinel', 'Alchemist'
];

function sanitizeUsername(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 30);
}

function buildAllNicknameVariants() {
  const variants = [];

  for (const adjective of RANDOM_NICK_ADJECTIVES) {
    for (const noun of RANDOM_NICK_NOUNS) {
      variants.push(`${adjective} ${noun}`);
    }
  }

  return variants;
}

function pickRandomItem(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items[Math.floor(Math.random() * items.length)] || null;
}

function generateRandomNickname() {
  const allVariants = buildAllNicknameVariants();
  if (!allVariants.length) return `Guest${Math.floor(1000 + Math.random() * 9000)}`;

  const randomBase = pickRandomItem(allVariants) || 'Guest';
  const suffix = Math.floor(10 + Math.random() * 90);
  return `${randomBase}${suffix}`.slice(0, 30);
}

function resolveInitialUsername() {
  const usernameFromQuery = sanitizeUsername(params.get('username'));
  const savedUsername = sanitizeUsername(localStorage.getItem(USERNAME_STORAGE));
  const hasManualUsername = localStorage.getItem(MANUAL_USERNAME_STORAGE) === '1';

  if (usernameFromQuery) {
    localStorage.setItem(USERNAME_STORAGE, usernameFromQuery);
    localStorage.setItem(MANUAL_USERNAME_STORAGE, '1');
    return usernameFromQuery;
  }

  if (hasManualUsername && savedUsername) {
    return savedUsername;
  }

  const randomUsername = generateRandomNickname();
  localStorage.setItem(USERNAME_STORAGE, randomUsername);
  localStorage.setItem(MANUAL_USERNAME_STORAGE, '0');
  return randomUsername;
}

let username = resolveInitialUsername();

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
let selectedSeason = null;
let searchDebounce = null;
let lastSearchResults = [];
let showAllSearchResults = false;
let latestSearchToken = 0;
let pendingPlaybackApply = null;
let isRemoteAction = false;
let userInteractedWithPlayer = false;
let hostTimeBroadcastTimer = null;
let kodikTimeRequestTimer = null;
let userTimeBroadcastTimer = null;
let hostPlaybackGuardTimer = null;
let hasShownHostMessage = false;
let lastKnownHostTime = null;
let lastKnownHostTimeAt = 0;
let hasShownFirstEpisodeHint = false;
let watchOrderExpanded = true;

let isOverlayPlayerOpen = false;
let isOverlaySeasonOpen = false;
let isOverlayEpisodeOpen = false;

let lastSentSeekAt = 0;

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

const hostBadge = document.getElementById('hostBadge');
const usersList = document.getElementById('usersList');
const placeholder = document.getElementById('placeholder');
const animeList = document.getElementById('animeList');
const searchInput = document.getElementById('searchInput');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const cinemaModeBtn = document.getElementById('cinemaModeBtn');
const supportRoomBtn = document.getElementById('supportRoomBtn');
const roomPage = document.getElementById('roomPage');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const searchStatus = document.getElementById('searchStatus');
const selectedAnimeInfo = document.getElementById('selectedAnimeInfo');
const hostSearchHint = document.getElementById('hostSearchHint');
const nicknameInput = document.getElementById('nicknameInput');
const saveNicknameBtn = document.getElementById('saveNicknameBtn');

const playerTopOverlay = document.getElementById('playerTopOverlay');

const overlayPlayerDropdown = document.getElementById('overlayPlayerDropdown');
const overlaySeasonDropdown = document.getElementById('overlaySeasonDropdown');
const overlayEpisodeDropdown = document.getElementById('overlayEpisodeDropdown');

const overlayPlayerBtn = document.getElementById('overlayPlayerBtn');
const overlaySeasonBtn = document.getElementById('overlaySeasonBtn');
const overlayEpisodeBtn = document.getElementById('overlayEpisodeBtn');

const overlayPlayerBtnText = document.getElementById('overlayPlayerBtnText');
const overlaySeasonBtnText = document.getElementById('overlaySeasonBtnText');
const overlayEpisodeBtnText = document.getElementById('overlayEpisodeBtnText');

const overlayPlayerMenu = document.getElementById('overlayPlayerMenu');
const overlaySeasonMenu = document.getElementById('overlaySeasonMenu');
const overlayEpisodeMenu = document.getElementById('overlayEpisodeMenu');

const roomSupportModal = document.getElementById('roomSupportModal');
const roomSupportModalBackdrop = document.getElementById('roomSupportModalBackdrop');
const closeRoomSupportModalBtn = document.getElementById('closeRoomSupportModalBtn');
const roomSupportDescription = document.getElementById('roomSupportDescription');
const roomSupportThanks = document.getElementById('roomSupportThanks');
const roomSupportBoostyLink = document.getElementById('roomSupportBoostyLink');
const roomSupportDonationAlertsLink = document.getElementById('roomSupportDonationAlertsLink');

if (nicknameInput) {
  nicknameInput.value = username;
}

if (roomSupportDescription) {
  roomSupportDescription.textContent = SUPPORT_CONFIG.description || '';
}
if (roomSupportThanks) {
  roomSupportThanks.textContent = SUPPORT_CONFIG.thanksText || '';
}
if (roomSupportBoostyLink) {
  roomSupportBoostyLink.href = BOOSTY_URL;
}
if (roomSupportDonationAlertsLink) {
  roomSupportDonationAlertsLink.href = DONATIONALERTS_URL;
}

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

const canControl = () => roomId === 'solo' || isHost;

function getMoscowTimeString() {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
}

function sys(text) {
  if (!text) return;
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

async function readJsonSafely(response) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  if (!contentType.includes('application/json')) {
    throw new Error(`Сервер вернул не JSON. Проверь деплой API маршрутов. HTTP ${response.status}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Сервер вернул битый JSON');
  }
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

function getSeasonNumber(video) {
  const season = Number(video?.season);
  return season > 0 ? season : 1;
}

function getIframeUrl(video) {
  return video?.iframeUrl || video?.iframe_url || null;
}

function sortSearchResults(items) {
  return [...(items || [])].sort((a, b) => {
    const yearA = Number(a?.year) || 9999;
    const yearB = Number(b?.year) || 9999;

    if (yearA !== yearB) return yearA - yearB;
    return String(a?.title || '').localeCompare(String(b?.title || ''), 'ru');
  });
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

  return [...map.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name, 'ru');
  });
}

function getVideosBySelectedPlayer(videos) {
  if (!selectedPlayer) return [];
  return (videos || []).filter(v => getPlayerName(v) === selectedPlayer && !!getIframeUrl(v));
}

function getUniqueSeasons(videos) {
  const map = new Map();

  for (const video of videos || []) {
    const season = getSeasonNumber(video);
    if (!map.has(season)) {
      map.set(season, { season, count: 1 });
    } else {
      map.get(season).count += 1;
    }
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

    if (!map.has(ep)) {
      map.set(ep, { ...video, episodeNumber: ep });
    }
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

  animeList?.querySelectorAll('button').forEach(btn => btn.disabled = disabled);

  overlayPlayerBtn && (overlayPlayerBtn.disabled = disabled);
  overlaySeasonBtn && (overlaySeasonBtn.disabled = disabled);
  overlayEpisodeBtn && (overlayEpisodeBtn.disabled = disabled);

  overlayPlayerMenu?.querySelectorAll('button').forEach(btn => btn.disabled = disabled);
  overlaySeasonMenu?.querySelectorAll('button').forEach(btn => btn.disabled = disabled);
  overlayEpisodeMenu?.querySelectorAll('button').forEach(btn => btn.disabled = disabled);
}

function showPlaceholder(title = 'Ничего не выбрано', description = 'Выберите аниме') {
  const oldFrame = document.getElementById('videoFrame');
  if (oldFrame) oldFrame.remove();

  if (placeholder) {
    placeholder.className = 'placeholder';
    placeholder.style.display = 'flex';
    placeholder.innerHTML = `<div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>`;
  }

  hideOverlay();
  resetBridge();
}

function showBlockedAnimeMessage(message = 'Данное аниме запрещено на территории вашей страны') {
  selectedAnime = null;
  currentState = {
    animeId: null,
    animeUrl: null,
    episodeNumber: null,
    embedUrl: null,
    title: null,
    duration: 0,
    playback: {
      paused: true,
      currentTime: 0,
      updatedAt: Date.now()
    }
  };

  if (selectedAnimeInfo) {
    selectedAnimeInfo.innerHTML = `
      <div class="selected-anime-layout">
        <div class="selected-anime-body">
          <h3 class="selected-anime-title">Просмотр недоступен</h3>
          <p class="selected-anime-description">${escapeHtml(message)}</p>
        </div>
      </div>
    `;
  }

  showPlaceholder('Просмотр недоступен', message);
}

function showViewerHint(text = 'Если видео не стартовало автоматически, кликните по плееру один раз. После этого play/pause будут работать лучше.') {
  if (isHost || roomId === 'solo' || !placeholder) return;

  placeholder.className = 'placeholder placeholder-click-through';
  placeholder.style.display = 'flex';
  placeholder.innerHTML = `
    <div>
      <h2>Серия загружена</h2>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function hideViewerHintOverlay() {
  if (!placeholder) return;
  if (!placeholder.classList.contains('placeholder-click-through')) return;
  placeholder.style.display = 'none';
}

function showFirstEpisodeHintForHost() {
  if (!isHost || roomId === 'solo' || hasShownFirstEpisodeHint) return;
  hasShownFirstEpisodeHint = true;
  sys('После загрузки первой серии при необходимости кликните по плееру один раз и нажмите play.');
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

  if (targetTime !== null && targetTime > 0.2) {
    sendSeekToIframe(targetTime);
  }

  setTimeout(() => {
    if (paused) {
      sendPauseToIframe();
    } else {
      if (isHost || roomId === 'solo' || userInteractedWithPlayer) {
        hideViewerHintOverlay();
        sendPlayToIframe();
      } else {
        showViewerHint();
      }
    }
  }, 220);

  setTimeout(() => {
    isRemoteAction = false;
  }, 1200);
}

function applyPlaybackStateWhenReady(playback, attempts = 12) {
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

function stopHostPlaybackGuard() {
  if (hostPlaybackGuardTimer) {
    clearInterval(hostPlaybackGuardTimer);
    hostPlaybackGuardTimer = null;
  }
}

function startHostPlaybackGuard() {
  stopHostPlaybackGuard();

  if (!isHost || roomId === 'solo') return;

  hostPlaybackGuardTimer = setInterval(() => {
    if (!isHost || roomId === 'solo') return;
    if (!currentState.embedUrl) return;
    if (bridge.playerType !== 'kodik') return;
    if (currentState.playback.paused) return;

    const currentTime = currentState.playback.currentTime;
    if (typeof currentTime !== 'number' || Number.isNaN(currentTime)) return;

    const now = Date.now();

    if (lastKnownHostTime === null) {
      lastKnownHostTime = currentTime;
      lastKnownHostTimeAt = now;
      return;
    }

    const progressed = currentTime > lastKnownHostTime + 0.15;

    if (progressed) {
      lastKnownHostTime = currentTime;
      lastKnownHostTimeAt = now;
      return;
    }

    const stuckFor = now - lastKnownHostTimeAt;

    if (stuckFor >= 7000) {
      currentState.playback.paused = true;
      currentState.playback.updatedAt = Date.now();

      sendPauseToIframe();

      socket.emit('player-control', {
        roomId,
        action: 'pause',
        currentTime
      });

      sys('Воспроизведение поставлено на паузу: возможно, у хоста открылась реклама или плеер временно остановился.');

      lastKnownHostTime = currentTime;
      lastKnownHostTimeAt = now;
    }
  }, 2500);
}

function loadIframe(embedUrl) {
  if (!embedUrl) {
    showPlaceholder('Серия не запущена', 'У выбранного тайтла отсутствует iframe');
    return;
  }

  stopHostTimers();
  stopUserTimeTimer();
  stopHostPlaybackGuard();
  resetBridge();
  lastKnownHostTime = null;
  lastKnownHostTimeAt = 0;

  const iframe = createFreshIframe(embedUrl);
  bridge.playerType = detectPlayerType(embedUrl);

  if (placeholder) placeholder.style.display = 'none';

  iframe.addEventListener('load', () => {
    ensureBridgeWindow();

    setTimeout(() => {
      sendPauseToIframe();
    }, 500);

    if (bridge.playerType === 'kodik') {
      startUserTimeTimer();
    }

    if (isHost && bridge.playerType === 'kodik') {
      startHostTimers();
      startHostPlaybackGuard();
      showFirstEpisodeHintForHost();
    }

    if (pendingPlaybackApply) {
      const pb = pendingPlaybackApply;
      pendingPlaybackApply = null;
      setTimeout(() => applyPlaybackStateWhenReady(pb, 12), 1200);
    }

    if (!isHost && roomId !== 'solo') {
      setTimeout(() => {
        if (!userInteractedWithPlayer) {
          showViewerHint('Если серия не стартовала, нажмите прямо по плееру один раз. Подсказка не мешает клику.');
        }
      }, 1800);
    }
  });
}

function startHostTimers() {
  stopHostTimers();

  kodikTimeRequestTimer = setInterval(() => {
    if (!isHost || !currentState.embedUrl) return;
    requestKodikTime();
  }, 2500);

  hostTimeBroadcastTimer = setInterval(() => {
    if (!isHost || roomId === 'solo') return;

    const ct = currentState.playback.currentTime;
    if (typeof ct === 'number' && ct >= 0) {
      socket.emit('player-control', {
        roomId,
        action: 'timeupdate',
        currentTime: ct
      });
    }
  }, 3500);
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
  }, 4000);
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
      </div>
    `;
  }).join('');
}

async function loadWatchOrder(shikimoriId) {
  if (!shikimoriId) return null;

  try {
    const response = await fetch(`/api/watch-order?shikimoriId=${encodeURIComponent(shikimoriId)}`);
    const data = await readJsonSafely(response);
    if (!response.ok) throw new Error(data?.error || 'Не удалось загрузить порядок просмотра');
    return data;
  } catch (error) {
    console.error('WATCH ORDER FRONT ERROR:', error);
    return null;
  }
}

function renderWatchOrderBlock(watchOrderData) {
  if (!watchOrderData?.items?.length) return '';

  return `
    <div class="watch-order-block">
      <button type="button" class="watch-order-toggle ${watchOrderExpanded ? 'expanded' : ''}" id="watchOrderToggleBtn">
        <span>Порядок просмотра</span>
        <span class="watch-order-toggle-arrow">${watchOrderExpanded ? '⌃' : '⌄'}</span>
      </button>

      <div class="watch-order-list ${watchOrderExpanded ? 'expanded' : 'collapsed'}" id="watchOrderList">
        ${watchOrderData.items.map(item => `
          <button
            type="button"
            class="watch-order-item ${item.isCurrent ? 'current' : ''}"
            data-watch-order-item="1"
            data-shikimori-id="${escapeHtml(item.shikimoriId)}"
            data-anime-id="${escapeHtml(item.animeId)}"
            data-anime-url="${escapeHtml(item.animeUrl)}"
            data-title="${escapeHtml(item.title)}"
            data-year="${escapeHtml(item.year || '')}"
          >
            <div class="watch-order-item-main">
              <span class="watch-order-item-index">${item.order}.</span>
              <span class="watch-order-item-title">${escapeHtml(item.title)}</span>
            </div>
            <div class="watch-order-item-meta">
              ${escapeHtml(item.kind)}${item.relationLabel ? `, ${escapeHtml(item.relationLabel)}` : ''}${item.year ? `, ${escapeHtml(item.year)}` : ''}
            </div>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function bindWatchOrderEvents() {
  const toggleBtn = document.getElementById('watchOrderToggleBtn');
  const listEl = document.getElementById('watchOrderList');

  if (toggleBtn && listEl) {
    toggleBtn.addEventListener('click', () => {
      watchOrderExpanded = !watchOrderExpanded;
      listEl.classList.toggle('expanded', watchOrderExpanded);
      listEl.classList.toggle('collapsed', !watchOrderExpanded);
      toggleBtn.classList.toggle('expanded', watchOrderExpanded);

      const arrow = toggleBtn.querySelector('.watch-order-toggle-arrow');
      if (arrow) {
        arrow.textContent = watchOrderExpanded ? '⌃' : '⌄';
      }
    });
  }

  document.querySelectorAll('[data-watch-order-item="1"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!canControl()) return;

      const item = {
        animeId: btn.dataset.animeId,
        animeUrl: btn.dataset.animeUrl,
        title: btn.dataset.title,
        year: btn.dataset.year || '',
        shikimoriId: Number(btn.dataset.shikimoriId) || null,
        kodikId: null
      };

      await selectAnime(item);
    });
  });
}

async function renderSelectedAnimeInfo(anime) {
  if (!selectedAnimeInfo) return;

  const players = getUniquePlayers(anime?.videos || []);
  const seasons = getUniqueSeasons(anime?.videos || []);
  const episodes = getUniqueEpisodes(anime?.videos || []);

  const watchOrderData = anime?.shikimoriId
    ? await loadWatchOrder(anime.shikimoriId)
    : null;

  selectedAnimeInfo.innerHTML = `
    <div class="selected-anime-layout">
      ${anime.poster ? `<img class="selected-anime-poster" src="${escapeHtml(anime.poster)}" loading="lazy">` : ''}
      <div class="selected-anime-body">
        <h3 class="selected-anime-title">${escapeHtml(anime.title)}</h3>
        <div class="selected-anime-meta">
          ${escapeHtml(anime.year || '')}${anime.type ? ` • ${escapeHtml(anime.type)}` : ''}${anime.status ? ` • ${escapeHtml(anime.status)}` : ''}
        </div>
        <p class="selected-anime-description">${escapeHtml(anime.description || 'Описание отсутствует')}</p>
        <div class="selected-anime-extra">
          Озвучек: ${players.length} • Сезонов: ${seasons.length} • Серий: ${episodes.length}
        </div>
        ${renderWatchOrderBlock(watchOrderData)}
      </div>
    </div>
  `;

  bindWatchOrderEvents();
}

function renderAnimeResults(items) {
  if (!animeList) return;

  if (!items.length) {
    animeList.innerHTML = '';
    animeList.classList.remove('visible');
    return;
  }

  const sortedItems = sortSearchResults(items);
  const visibleItems = showAllSearchResults ? sortedItems : sortedItems.slice(0, 5);
  const needToggle = sortedItems.length > 5;

  animeList.innerHTML = `
    ${visibleItems.map((item, index) => `
      <button
        type="button"
        class="search-result-item ${item.animeUrl === selectedAnime?.animeUrl ? 'active' : ''}"
        data-index="${index}"
      >
        ${item.poster ? `<img class="search-result-poster" src="${escapeHtml(item.poster)}" loading="lazy">` : '<div class="search-result-poster search-result-poster-empty"></div>'}
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

  animeList.querySelectorAll('.search-result-item').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', async () => {
      const sortedNow = sortSearchResults(lastSearchResults);
      const visibleNow = showAllSearchResults ? sortedNow : sortedNow.slice(0, 5);
      const index = Number(btn.dataset.index);
      const item = visibleNow[index];
      if (!item) return;

      animeList.classList.remove('visible');
      animeList.innerHTML = '';

      await selectAnime(item);
    });
  });

  const toggleBtn = document.getElementById('searchResultsToggleBtn');
  if (toggleBtn) {
    toggleBtn.disabled = !canControl();
    toggleBtn.addEventListener('click', () => {
      showAllSearchResults = !showAllSearchResults;
      renderAnimeResults(lastSearchResults);
    });
  }
}

function hideOverlayMenus() {
  isOverlayPlayerOpen = false;
  isOverlaySeasonOpen = false;
  isOverlayEpisodeOpen = false;

  overlayPlayerDropdown?.classList.remove('open');
  overlaySeasonDropdown?.classList.remove('open');
  overlayEpisodeDropdown?.classList.remove('open');
}

function hideOverlay() {
  hideOverlayMenus();
  playerTopOverlay?.classList.add('hidden');
}

function showOverlay() {
  if (!playerTopOverlay) return;
  playerTopOverlay.classList.remove('hidden');
}

function renderOverlayControls() {
  if (!selectedAnime) {
    hideOverlay();
    return;
  }

  const videos = selectedAnime.videos || [];
  const players = getUniquePlayers(videos);

  if (!selectedPlayer && players.length) {
    selectedPlayer = players[0].name;
  }

  const byPlayer = getVideosBySelectedPlayer(videos);
  const seasons = getUniqueSeasons(byPlayer);

  if (!selectedSeason) {
    selectedSeason = seasons[0]?.season || 1;
  }

  if (!seasons.find(s => s.season === selectedSeason)) {
    selectedSeason = seasons[0]?.season || 1;
  }

  const bySeason = getVideosBySelectedSeason(byPlayer);
  const episodes = getUniqueEpisodes(bySeason);

  if (overlayPlayerBtnText) {
    overlayPlayerBtnText.textContent = selectedPlayer || 'Озвучка';
  }

  if (overlaySeasonBtnText) {
    overlaySeasonBtnText.textContent = `${selectedSeason || 1} сезон`;
  }

  if (overlayEpisodeBtnText) {
    overlayEpisodeBtnText.textContent = `${currentState.episodeNumber || episodes[0]?.episodeNumber || 1} серия`;
  }

  overlayPlayerMenu.innerHTML = players.map(player => `
    <button
      type="button"
      class="overlay-dropdown-item ${player.name === selectedPlayer ? 'active' : ''}"
      data-player="${escapeHtml(player.name)}"
    >
      <span>${escapeHtml(player.name)}</span>
      <span class="overlay-item-count">${player.count}</span>
    </button>
  `).join('');

  overlaySeasonMenu.innerHTML = seasons.map(season => `
    <button
      type="button"
      class="overlay-dropdown-item ${season.season === selectedSeason ? 'active' : ''}"
      data-season="${season.season}"
    >
      <span>${season.season} сезон</span>
      <span class="overlay-item-count">${season.count}</span>
    </button>
  `).join('');

  overlayEpisodeMenu.innerHTML = episodes.map(episode => `
    <button
      type="button"
      class="overlay-dropdown-item overlay-dropdown-item-episode ${episode.episodeNumber === currentState.episodeNumber ? 'active' : ''}"
      data-episode="${episode.episodeNumber}"
      title="Серия ${episode.episodeNumber}"
    >
      ${episode.episodeNumber}
    </button>
  `).join('');

  overlaySeasonDropdown.style.display = seasons.length > 1 ? '' : 'none';

  overlayPlayerDropdown?.classList.toggle('open', isOverlayPlayerOpen);
  overlaySeasonDropdown?.classList.toggle('open', isOverlaySeasonOpen);
  overlayEpisodeDropdown?.classList.toggle('open', isOverlayEpisodeOpen);

  overlayPlayerMenu.querySelectorAll('[data-player]').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', () => {
      selectedPlayer = btn.dataset.player;
      selectedSeason = null;
      isOverlayPlayerOpen = false;

      const refreshedByPlayer = getVideosBySelectedPlayer(selectedAnime?.videos || []);
      const seasonsAfterPlayerChange = getUniqueSeasons(refreshedByPlayer);
      selectedSeason = seasonsAfterPlayerChange[0]?.season || 1;

      renderOverlayControls();

      const refreshedBySeason = getVideosBySelectedSeason(refreshedByPlayer);
      const firstEpisode = getUniqueEpisodes(refreshedBySeason)[0];
      if (firstEpisode) {
        launchEpisode(firstEpisode, selectedAnime);
      }
    });
  });

  overlaySeasonMenu.querySelectorAll('[data-season]').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', () => {
      selectedSeason = Number(btn.dataset.season) || 1;
      isOverlaySeasonOpen = false;
      renderOverlayControls();

      const refreshedByPlayer = getVideosBySelectedPlayer(selectedAnime?.videos || []);
      const refreshedBySeason = getVideosBySelectedSeason(refreshedByPlayer);
      const firstEpisode = getUniqueEpisodes(refreshedBySeason)[0];
      if (firstEpisode) {
        launchEpisode(firstEpisode, selectedAnime);
      }
    });
  });

  overlayEpisodeMenu.querySelectorAll('[data-episode]').forEach(btn => {
    btn.disabled = !canControl();
    btn.addEventListener('click', () => {
      const episodeNumber = Number(btn.dataset.episode);
      const refreshedByPlayer = getVideosBySelectedPlayer(selectedAnime?.videos || []);
      const refreshedBySeason = getVideosBySelectedSeason(refreshedByPlayer);
      const episode = getUniqueEpisodes(refreshedBySeason).find(v => v.episodeNumber === episodeNumber);
      if (!episode) return;

      isOverlayEpisodeOpen = false;
      renderOverlayControls();
      launchEpisode(episode, selectedAnime);
    });
  });

  showOverlay();
  updateControlState();
}

function launchEpisode(episode, anime) {
  if (!episode) return;

  const embedUrl = getIframeUrl(episode);
  const season = getSeasonNumber(episode);
  const episodeNumber = getEpisodeNumber(episode);
  const playerName = getPlayerName(episode);
  const title = `${anime?.title || 'Аниме'} — ${playerName}, сезон ${season}, серия ${episodeNumber}`;

  currentState = {
    animeId: anime?.animeId ?? null,
    animeUrl: anime?.animeUrl ?? null,
    episodeNumber,
    embedUrl,
    title,
    duration: 0,
    playback: {
      paused: true,
      currentTime: 0,
      updatedAt: Date.now()
    }
  };

  selectedSeason = season;
  selectedPlayer = playerName;
  hasShownFirstEpisodeHint = false;

  userInteractedWithPlayer = true;
  loadIframe(embedUrl);
  renderOverlayControls();

  if (roomId !== 'solo') {
    socket.emit('change-video', {
      roomId,
      embedUrl,
      title,
      animeId: currentState.animeId,
      animeUrl: currentState.animeUrl,
      episodeNumber
    });
  } else {
    sys(`Вы выбрали: ${title}`);
  }
}

async function searchAnime(query) {
  const rawQuery = String(query || '').trim();

  if (!rawQuery || rawQuery.length < 2) {
    if (animeList) {
      animeList.innerHTML = '';
      animeList.classList.remove('visible');
    }
    if (searchStatus) searchStatus.textContent = 'Введите минимум 2 символа';
    return;
  }

  if (!canControl()) return;

  if (searchStatus) searchStatus.textContent = 'Поиск...';
  showAllSearchResults = false;
  latestSearchToken += 1;
  const token = latestSearchToken;

  if (animeList) {
    animeList.innerHTML = '';
    animeList.classList.remove('visible');
  }

  try {
    const response = await fetch(`/api/yummy/search?q=${encodeURIComponent(rawQuery)}`);
    const data = await readJsonSafely(response);

    if (token !== latestSearchToken) return;
    if (!response.ok) throw new Error(data?.error || 'Ошибка поиска');

    lastSearchResults = sortSearchResults(Array.isArray(data) ? data : []);
    renderAnimeResults(lastSearchResults);

    if (searchStatus) {
      searchStatus.textContent = lastSearchResults.length
        ? `Найдено: ${lastSearchResults.length}`
        : 'Ничего не найдено';
    }
  } catch (error) {
    if (token !== latestSearchToken) return;
    if (searchStatus) searchStatus.textContent = error.message || 'Ошибка поиска';
    if (animeList) {
      animeList.innerHTML = '';
      animeList.classList.remove('visible');
    }
  }
}

async function selectAnime(itemOrAnimeUrl) {
  const selectedItem = typeof itemOrAnimeUrl === 'object' && itemOrAnimeUrl
    ? itemOrAnimeUrl
    : lastSearchResults.find(item => item.animeUrl === itemOrAnimeUrl);

  if (!selectedItem || !canControl()) return;

  if (selectedAnimeInfo) selectedAnimeInfo.innerHTML = 'Загрузка...';

  try {
    const response = await fetch('/api/yummy/anime/by-selection', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        animeUrl: selectedItem.animeUrl,
        animeId: selectedItem.animeId,
        title: selectedItem.title,
        year: selectedItem.year,
        shikimoriId: selectedItem.shikimoriId,
        kodikId: selectedItem.kodikId
      })
    });

    const data = await readJsonSafely(response);

    if (!response.ok) {
      if (response.status === 403 && data?.code === 'ANIME_BLOCKED_BY_COUNTRY') {
        showBlockedAnimeMessage(data?.error || 'Данное аниме запрещено на территории вашей страны');
        return;
      }

      throw new Error(data?.error || 'Не удалось загрузить аниме');
    }

    selectedAnime = {
      ...data,
      shikimoriId: selectedItem.shikimoriId || data.shikimoriId || null,
      videos: Array.isArray(data?.videos) ? data.videos : []
    };

    const context = findDefaultContext(selectedAnime.videos);

    if (!context) {
      await renderSelectedAnimeInfo(selectedAnime);
      showPlaceholder('Нет доступных серий', 'Для выбранного тайтла не удалось найти рабочий плеер');
      return;
    }

    selectedPlayer = context.player;
    selectedSeason = context.season;

    await renderSelectedAnimeInfo(selectedAnime);
    renderOverlayControls();
    launchEpisode(context.episode, selectedAnime);
  } catch (error) {
    if (selectedAnimeInfo) {
      selectedAnimeInfo.innerHTML = `<div>${escapeHtml(error.message || 'Ошибка')}</div>`;
    }
    showPlaceholder('Ошибка', error.message || 'Не удалось загрузить аниме');
    hideOverlay();
  }
}

function saveNickname() {
  const newUsername = sanitizeUsername(nicknameInput?.value);

  if (!newUsername) {
    alert('Введите ник');
    return;
  }

  const oldUsername = username;
  username = newUsername;
  localStorage.setItem(USERNAME_STORAGE, username);
  localStorage.setItem(MANUAL_USERNAME_STORAGE, '1');

  if (nicknameInput) {
    nicknameInput.value = username;
  }

  if (roomId !== 'solo') {
    socket.emit('change-username', { roomId, username });
  } else if (oldUsername !== username) {
    sys(`Теперь вы ${username}`);
  }
}

window.addEventListener('pointerdown', () => {
  userInteractedWithPlayer = true;
  hideViewerHintOverlay();
});

window.addEventListener('keydown', () => {
  userInteractedWithPlayer = true;
  hideViewerHintOverlay();
});

document.addEventListener('click', (event) => {
  const withinSearch = event.target.closest('.anime-search-section, .center-search-panel');
  if (!withinSearch) {
    animeList?.classList.remove('visible');
  }

  const withinOverlay = event.target.closest('.player-top-overlay');
  if (!withinOverlay) {
    hideOverlayMenus();
  }
});

overlayPlayerBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!canControl()) return;
  isOverlayPlayerOpen = !isOverlayPlayerOpen;
  isOverlaySeasonOpen = false;
  isOverlayEpisodeOpen = false;
  renderOverlayControls();
});

overlaySeasonBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!canControl()) return;
  isOverlaySeasonOpen = !isOverlaySeasonOpen;
  isOverlayPlayerOpen = false;
  isOverlayEpisodeOpen = false;
  renderOverlayControls();
});

overlayEpisodeBtn?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (!canControl()) return;
  isOverlayEpisodeOpen = !isOverlayEpisodeOpen;
  isOverlayPlayerOpen = false;
  isOverlaySeasonOpen = false;
  renderOverlayControls();
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

        if (isHost) {
          lastKnownHostTime = seconds;
          lastKnownHostTimeAt = Date.now();
        }
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
            : 0
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
            : 0
        });
      }

      if (key === 'kodik_player_seek') {
        const seekTime = Number(value?.time);
        if (!Number.isNaN(seekTime) && seekTime >= 0) {
          const now = Date.now();
          if (now - lastSentSeekAt < 500) return;
          lastSentSeekAt = now;

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
  stopHostPlaybackGuard();
});

socket.on('you-are-host', () => {
  isHost = true;
  updateControlState();

  if (currentState.embedUrl) {
    startHostTimers();
    startHostPlaybackGuard();
  }

  if (!hasShownHostMessage) {
    sys('Вы хост комнаты');
    hasShownHostMessage = true;
  }
});

socket.on('sync-state', (state) => {
  isHost = !!state.isHost;
  updateControlState();

  if (!isHost) {
    stopHostPlaybackGuard();
  } else if (currentState.embedUrl) {
    startHostPlaybackGuard();
  }

  currentState = {
    animeId: state.animeId ?? null,
    animeUrl: state.animeUrl ?? null,
    episodeNumber: state.episodeNumber ?? null,
    embedUrl: state.embedUrl ?? null,
    title: state.title ?? null,
    duration: currentState.duration || 0,
    playback: state.playback || {
      paused: true,
      currentTime: 0,
      updatedAt: 0
    }
  };

  if (currentState.embedUrl) {
    loadIframe(currentState.embedUrl);
    pendingPlaybackApply = currentState.playback;
    applyPlaybackStateWhenReady(currentState.playback, 12);
  } else {
    showPlaceholder('Ничего не выбрано', isHost ? 'Выберите аниме' : 'Хост пока не запустил тайтл');
  }

  if (selectedAnime?.videos?.length) {
    renderOverlayControls();
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
      currentTime: 0,
      updatedAt: Date.now()
    }
  };

  if (selectedAnime?.videos?.length) {
    renderOverlayControls();
  }

  if (currentState.embedUrl) {
    loadIframe(currentState.embedUrl);
    pendingPlaybackApply = currentState.playback;
    applyPlaybackStateWhenReady(currentState.playback, 12);
  } else {
    showPlaceholder('Ничего не выбрано', 'Хост пока не запустил тайтл');
  }
});

socket.on('player-control', ({ action, currentTime, paused, updatedAt }) => {
  if (roomId === 'solo' || isHost) return;

  const safeTime = typeof currentTime === 'number' && !Number.isNaN(currentTime)
    ? currentTime
    : currentState.playback.currentTime;

  currentState.playback = {
    paused: typeof paused === 'boolean' ? paused : action === 'pause',
    currentTime: safeTime ?? 0,
    updatedAt: Number(updatedAt || Date.now()) || Date.now()
  };

  if (action === 'seek' || action === 'play' || action === 'pause' || action === 'timeupdate') {
    applyPlaybackStateWhenReady(currentState.playback, 12);
  }
});

socket.on('room-users', renderUsers);
socket.on('system-message', ({ text }) => sys(text));

socket.on('chat-message', ({ username: author, message, time }) => {
  if (!chatMessages || !window.ChatModule) return;
  ChatModule.appendMessage(chatMessages, {
    username: author,
    message,
    time,
    isSelf: author === username
  });
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
  cinemaModeBtn.addEventListener('click', () => {
    roomPage?.classList.toggle('cinema-mode');
  });
}

if (supportRoomBtn) {
  supportRoomBtn.addEventListener('click', openRoomSupportModal);
}

roomSupportModalBackdrop?.addEventListener('click', closeRoomSupportModal);
closeRoomSupportModalBtn?.addEventListener('click', closeRoomSupportModal);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && roomSupportModal && !roomSupportModal.classList.contains('hidden')) {
    closeRoomSupportModal();
  }
});

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
    } else if (window.ChatModule && chatMessages) {
      ChatModule.appendMessage(chatMessages, {
        username,
        message,
        time: getMoscowTimeString(),
        isSelf: true
      });
    }

    chatInput.value = '';
    chatInput.focus();
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });
}

window.addEventListener('beforeunload', () => {
  stopHostTimers();
  stopUserTimeTimer();
  stopHostPlaybackGuard();
});

updateControlState();
showPlaceholder('Ничего не выбрано', 'Выберите аниме');
renderUsers([]);