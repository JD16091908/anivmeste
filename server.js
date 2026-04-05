const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const crypto = require('crypto');
const geoip = require('geoip-lite');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', true);

const ALLOWED_ORIGINS = new Set([
  'https://anivmeste.ru',
  'https://www.anivmeste.ru',
  'https://anivmeste.onrender.com'
]);

const ROOM_CREATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const ROOM_CREATE_LIMIT_MAX = 5;
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;
const STALE_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const ROOM_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const roomCreationLog = new Map();

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      fontSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:", "https://anivmeste.ru", "https://www.anivmeste.ru", "https://anivmeste.onrender.com"],
      frameSrc: ["'self'", "https:", "http:"],
      mediaSrc: ["'self'", "https:", "http:"],
      manifestSrc: ["'self'"],
      upgradeInsecureRequests: []
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json({ limit: '1mb' }));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(globalLimiter);
app.use('/api', apiLimiter);

const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  cors: {
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origin not allowed'), false);
    },
    credentials: true
  },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin || isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback('Origin not allowed', false);
  }
});

const PORT = process.env.PORT || 3000;
const rooms = {};

const KODIK_TOKEN = process.env.KODIK_TOKEN || 'ea55976b6acc94f41f173e2c702ebf6b';
const KODIK_API_BASE = 'https://kodik-api.com';
const SHIKIMORI_API_BASE = 'https://shikimori.one/api';
const BLOCKED_ANIME_FILE = path.join(__dirname, 'blocked-anime.json');

console.log(KODIK_TOKEN ? '✅ KODIK TOKEN загружен' : '❌ KODIK TOKEN не найден');

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: false,
  index: false,
  maxAge: '1h'
}));

function isApiRequest(req) {
  return req.path.startsWith('/api/');
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeRoomId(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 120);
}

function sanitizeAccessToken(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 128);
}

function secureCompare(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));

  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function loadBlockedAnimeConfig() {
  try {
    if (!fs.existsSync(BLOCKED_ANIME_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(BLOCKED_ANIME_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const normalized = {};

    for (const [countryCode, value] of Object.entries(parsed)) {
      normalized[String(countryCode).toLowerCase()] = {
        titles: Array.isArray(value?.titles) ? value.titles : [],
        shikimoriIds: Array.isArray(value?.shikimoriIds)
          ? value.shikimoriIds.map(Number).filter(id => Number.isFinite(id))
          : []
      };
    }

    return normalized;
  } catch (error) {
    console.error('BLOCKED ANIME LOAD ERROR:', error.message);
    return {};
  }
}

function getBlockedAnimeConfigForCountry(countryCode) {
  const config = loadBlockedAnimeConfig();
  const key = String(countryCode || '').toLowerCase();

  return config[key] || {
    titles: [],
    shikimoriIds: []
  };
}

function getClientIp(req) {
  const xForwardedFor = req.headers['x-forwarded-for'];
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  const realIp = req.headers['x-real-ip'];

  let ip =
    (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) ||
    (typeof realIp === 'string' && realIp.trim()) ||
    (typeof xForwardedFor === 'string' && xForwardedFor.split(',')[0].trim()) ||
    req.ip ||
    req.socket?.remoteAddress ||
    '';

  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  return ip;
}

function cleanupRoomCreationLog() {
  const now = Date.now();

  for (const [ip, timestamps] of roomCreationLog.entries()) {
    const filtered = timestamps.filter(ts => now - ts < ROOM_CREATE_LIMIT_WINDOW_MS);
    if (filtered.length) {
      roomCreationLog.set(ip, filtered);
    } else {
      roomCreationLog.delete(ip);
    }
  }
}

function canCreateRoomForIp(ip) {
  cleanupRoomCreationLog();

  const safeIp = String(ip || 'unknown');
  const timestamps = roomCreationLog.get(safeIp) || [];
  return timestamps.length < ROOM_CREATE_LIMIT_MAX;
}

function registerRoomCreationForIp(ip) {
  cleanupRoomCreationLog();

  const safeIp = String(ip || 'unknown');
  const timestamps = roomCreationLog.get(safeIp) || [];
  timestamps.push(Date.now());
  roomCreationLog.set(safeIp, timestamps);
}

function getCountryByIp(req) {
  const ip = getClientIp(req);

  if (!ip || ip === '127.0.0.1' || ip === '::1') {
    return {
      ip,
      country: process.env.LOCAL_DEV_COUNTRY || 'LOCAL'
    };
  }

  const geo = geoip.lookup(ip);

  return {
    ip,
    country: geo?.country || 'UNKNOWN'
  };
}

function isBlockedForCountry(countryCode, checkData) {
  const config = getBlockedAnimeConfigForCountry(countryCode);

  if (checkData.shikimoriId) {
    const id = Number(checkData.shikimoriId);
    if (config.shikimoriIds.includes(id)) {
      return true;
    }
  }

  if (checkData.title) {
    const normalizedTitle = normalizeSearchText(checkData.title);
    if (normalizedTitle) {
      const blockedByTitle = config.titles.some(item =>
        normalizeSearchText(item) === normalizedTitle
      );

      if (blockedByTitle) return true;
    }
  }

  return false;
}

function isAnimeBlockedForRequest(req, selected = {}, foundItem = null) {
  const geo = getCountryByIp(req);

  const shikimoriIds = [
    selected?.shikimoriId,
    foundItem?.shikimori_id,
    foundItem?.material_data?.shikimori_id
  ].filter(Boolean).map(Number);

  const titles = [
    selected?.title,
    foundItem ? normalizeTitle(foundItem) : '',
    foundItem?.material_data?.title,
    foundItem?.material_data?.ru_title,
    foundItem?.material_data?.anime_title,
    foundItem?.material_data?.full_title
  ].filter(Boolean);

  for (const id of shikimoriIds) {
    if (isBlockedForCountry(geo.country, { shikimoriId: id })) {
      return {
        blocked: true,
        country: geo.country,
        ip: geo.ip,
        reason: 'id'
      };
    }
  }

  for (const title of titles) {
    if (isBlockedForCountry(geo.country, { title })) {
      return {
        blocked: true,
        country: geo.country,
        ip: geo.ip,
        reason: 'title'
      };
    }
  }

  return {
    blocked: false,
    country: geo.country,
    ip: geo.ip
  };
}

async function checkHostAvailable(hostname) {
  try {
    const r = await dns.lookup(hostname);
    return !!r?.address;
  } catch {
    return false;
  }
}

async function kodikGet(endpoint, params = {}) {
  if (!await checkHostAvailable('kodik-api.com')) {
    throw new Error('DNS failed for kodik-api.com');
  }

  const url = `${KODIK_API_BASE}${endpoint}?${new URLSearchParams({
    token: KODIK_TOKEN,
    limit: '1000',
    ...params
  }).toString()}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Kodik HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON: ${text.slice(0, 300)}`);
  }

  if (data?.failed) throw new Error(data.failed);
  return data;
}

async function shikimoriGet(endpoint) {
  const response = await fetch(`${SHIKIMORI_API_BASE}${endpoint}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Anivmeste/1.0'
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Shikimori HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid Shikimori JSON: ${text.slice(0, 300)}`);
  }
}

function normalizePoster(item) {
  const poster =
    item?.poster_url ||
    item?.poster ||
    item?.material_data?.poster_url ||
    item?.material_data?.poster ||
    item?.material_data?.screenshots?.[0] ||
    '';

  if (!poster) return '';
  return poster.startsWith('//') ? `https:${poster}` : poster;
}

function normalizeTitle(item) {
  return (
    item?.title ||
    item?.ru_title ||
    item?.material_data?.title ||
    item?.material_data?.ru_title ||
    item?.material_data?.anime_title ||
    item?.material_data?.full_title ||
    'Без названия'
  );
}

function normalizeDescription(item) {
  return item?.material_data?.description || item?.description || '';
}

function normalizeYear(item) {
  return item?.year || item?.material_data?.year || '';
}

function normalizeType(item) {
  return item?.type || item?.material_data?.type || item?.material_data?.anime_kind || '';
}

function normalizeStatus(item) {
  return item?.material_data?.anime_status || item?.status || '';
}

function getShikimoriId(item) {
  return item?.shikimori_id || item?.material_data?.shikimori_id || null;
}

function getKodikId(item) {
  return item?.id || null;
}

function getMaterialId(item) {
  return item?.material_id || item?.material_data?.id || null;
}

function getLastEpisode(item) {
  return Number(item?.last_episode || item?.material_data?.last_episode || 0);
}

function getStableAnimeId(item) {
  const shikimoriId = getShikimoriId(item);
  const kodikId = getKodikId(item);

  if (shikimoriId) return `shikimori:${shikimoriId}`;
  if (kodikId) return `kodik:${kodikId}`;
  return null;
}

function normalizeTitleKey(value) {
  return normalizeSearchText(value)
    .replace(/\b(tv|тв|movie|film|ova|ona|special|sp)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAllowedAnimeType(item) {
  const type = String(normalizeType(item) || '').toLowerCase();
  return type === 'anime' || type === 'anime-serial' || type.includes('anime');
}

function isSerial(item) {
  const type = String(normalizeType(item) || '').toLowerCase();
  return type.includes('serial');
}

function titleScore(item, query) {
  const q = normalizeSearchText(query);
  const title = normalizeSearchText(normalizeTitle(item));

  if (!q || !title) return 0;
  if (!isAllowedAnimeType(item)) return -1000;

  let score = 0;

  if (title === q) score += 10000;
  else if (title.startsWith(q)) score += 5000;
  else if (title.includes(q)) score += 2500;

  const words = q.split(' ').filter(Boolean);
  for (const word of words) {
    if (word.length < 2) continue;
    if (title === word) score += 1500;
    else if (title.startsWith(word)) score += 400;
    else if (title.includes(word)) score += 150;
  }

  const qYear = q.match(/\b(19|20)\d{2}\b/)?.[0];
  const y = String(normalizeYear(item) || '');
  if (qYear && y === qYear) score += 1000;

  if (isSerial(item)) score += 400;

  return score;
}

function makeSearchItem(item, query) {
  return {
    animeId: getStableAnimeId(item) || `kodik:${getKodikId(item) || 'unknown'}`,
    animeUrl: String(getStableAnimeId(item) || `kodik:${getKodikId(item) || 'unknown'}`),
    title: normalizeTitle(item),
    titleKey: normalizeTitleKey(normalizeTitle(item)),
    year: normalizeYear(item),
    description: normalizeDescription(item),
    poster: normalizePoster(item),
    status: normalizeStatus(item),
    type: normalizeType(item),
    shikimoriId: getShikimoriId(item),
    kodikId: getKodikId(item),
    score: titleScore(item, query),
    serialPriority: isSerial(item) ? 1 : 0
  };
}

function dedupeSearchResults(items, query) {
  const queryKey = normalizeTitleKey(query);
  const strictMap = new Map();

  for (const item of items) {
    const itemKey = item.titleKey || normalizeTitleKey(item.title);
    const year = String(item.year || '');
    const groupKey = `${itemKey}|${year}`;

    const goodMatch =
      itemKey === queryKey ||
      itemKey.includes(queryKey) ||
      queryKey.includes(itemKey);

    if (!goodMatch) continue;

    const existing = strictMap.get(groupKey);
    if (!existing) {
      strictMap.set(groupKey, item);
      continue;
    }

    const currentRank =
      item.score +
      (item.serialPriority ? 800 : 0) +
      (item.poster ? 50 : 0) +
      (item.description ? 20 : 0);

    const existingRank =
      existing.score +
      (existing.serialPriority ? 800 : 0) +
      (existing.poster ? 50 : 0) +
      (existing.description ? 20 : 0);

    if (currentRank > existingRank) {
      strictMap.set(groupKey, item);
    }
  }

  return [...strictMap.values()];
}

function buildEpisodeIframe(link) {
  if (!link) return null;
  return String(link).startsWith('//') ? `https:${link}` : link;
}

function extractEpisodesFromItem(item) {
  const episodes = [];

  const directEpisodes = item?.episodes;
  if (directEpisodes && typeof directEpisodes === 'object') {
    for (const [episodeNumber, link] of Object.entries(directEpisodes)) {
      const iframeUrl = buildEpisodeIframe(
        typeof link === 'string' ? link : link?.link || link?.url || null
      );

      if (!iframeUrl) continue;

      episodes.push({
        videoId: `${item?.id || 'anime'}-${episodeNumber}-${item?.translation?.id || 't'}`,
        number: Number(episodeNumber) || 0,
        season: Number(item?.season) || Number(item?.material_data?.season) || 1,
        index: Number(episodeNumber) || 0,
        iframeUrl,
        dubbing: item?.translation?.title || item?.translation?.name || '',
        player: item?.translation?.title || item?.translation?.name || '',
        playerId: item?.translation?.id || null,
        translationId: item?.translation?.id || null,
        translationTitle: item?.translation?.title || item?.translation?.name || '',
        views: 0,
        duration: 0
      });
    }
  }

  if (episodes.length > 0) return episodes;

  const seasons = item?.seasons || {};
  for (const [seasonNumber, seasonData] of Object.entries(seasons)) {
    if (!seasonData || typeof seasonData !== 'object') continue;

    const seasonEpisodes = seasonData?.episodes || seasonData;
    if (!seasonEpisodes || typeof seasonEpisodes !== 'object') continue;

    for (const [episodeNumber, link] of Object.entries(seasonEpisodes)) {
      const iframeUrl = buildEpisodeIframe(
        typeof link === 'string' ? link : link?.link || link?.url || null
      );

      if (!iframeUrl) continue;

      episodes.push({
        videoId: `${seasonNumber}-${episodeNumber}-${item?.translation?.id || 't'}`,
        number: Number(episodeNumber) || 0,
        season: Number(seasonNumber) || 1,
        index: Number(episodeNumber) || 0,
        iframeUrl,
        dubbing: item?.translation?.title || item?.translation?.name || '',
        player: item?.translation?.title || item?.translation?.name || '',
        playerId: item?.translation?.id || null,
        translationId: item?.translation?.id || null,
        translationTitle: item?.translation?.title || item?.translation?.name || '',
        views: 0,
        duration: 0
      });
    }
  }

  if (episodes.length > 0) return episodes;

  const link = buildEpisodeIframe(item?.link);
  const episodeNumber =
    Number(item?.episode) ||
    Number(item?.last_episode) ||
    Number(item?.sort_episode) ||
    Number(item?.material_data?.episode) ||
    Number(item?.material_data?.last_episode) ||
    null;

  if (link) {
    episodes.push({
      videoId: `${item?.id || 'movie'}-${episodeNumber || 1}-${item?.translation?.id || 't'}`,
      number: episodeNumber || 1,
      season: Number(item?.season) || Number(item?.material_data?.season) || 1,
      index: episodeNumber || 1,
      iframeUrl: link,
      dubbing: item?.translation?.title || item?.translation?.name || '',
      player: item?.translation?.title || item?.translation?.name || '',
      playerId: item?.translation?.id || null,
      translationId: item?.translation?.id || null,
      translationTitle: item?.translation?.title || item?.translation?.name || '',
      views: 0,
      duration: 0
    });
  }

  return episodes;
}

function mergeEpisodes(items) {
  const episodeMap = new Map();

  for (const item of items || []) {
    const episodes = extractEpisodesFromItem(item);

    for (const episode of episodes) {
      const key = `${episode.season}:${episode.number}:${episode.translationId || episode.translationTitle || ''}`;
      if (!episodeMap.has(key)) {
        episodeMap.set(key, episode);
      }
    }
  }

  return [...episodeMap.values()].sort((a, b) => {
    if ((a.season || 1) !== (b.season || 1)) return (a.season || 1) - (b.season || 1);
    return (a.number || 0) - (b.number || 0);
  });
}

function strictMatchResults(items, selected) {
  const selectedTitle = normalizeSearchText(selected?.title);
  const selectedYear = String(selected?.year || '');
  const selectedShikimori = String(selected?.shikimoriId || '');
  const selectedKodik = String(selected?.kodikId || '');

  let filtered = items.filter(item => {
    if (!isAllowedAnimeType(item)) return false;

    const itemTitle = normalizeSearchText(normalizeTitle(item));
    const itemYear = String(normalizeYear(item) || '');
    const itemShikimori = String(getShikimoriId(item) || '');
    const itemKodik = String(getKodikId(item) || '');

    const idMatch =
      (selectedShikimori && itemShikimori === selectedShikimori) ||
      (selectedKodik && itemKodik === selectedKodik);

    const titleMatch =
      selectedTitle &&
      (
        itemTitle === selectedTitle ||
        itemTitle.includes(selectedTitle) ||
        selectedTitle.includes(itemTitle)
      );

    const yearMatch = !selectedYear || itemYear === selectedYear;

    return (idMatch || titleMatch) && yearMatch;
  });

  if (filtered.length > 0) return filtered;

  filtered = items.filter(item => {
    const itemTitle = normalizeSearchText(normalizeTitle(item));
    return selectedTitle && (
      itemTitle === selectedTitle ||
      itemTitle.includes(selectedTitle) ||
      selectedTitle.includes(itemTitle)
    );
  });

  return filtered;
}

function normalizeShikiType(kind) {
  const value = String(kind || '').toLowerCase();

  if (value === 'tv') return 'TV';
  if (value === 'movie') return 'Фильм';
  if (value === 'ova') return 'OVA';
  if (value === 'ona') return 'ONA';
  if (value === 'special') return 'Спешл';
  if (value === 'music') return 'Музыкальное видео';
  return value ? value.toUpperCase() : 'Anime';
}

function relationLabel(relation) {
  const rel = String(relation || '').toLowerCase();

  if (rel === 'prequel') return 'Приквел';
  if (rel === 'sequel') return 'Продолжение';
  if (rel === 'side_story') return 'Побочная история';
  if (rel === 'alternative_version') return 'Альтернативная версия';
  if (rel === 'alternative_setting') return 'Альтернативный мир';
  if (rel === 'full_story') return 'Полная версия истории';
  if (rel === 'parent_story') return 'Основная история';
  if (rel === 'summary') return 'Рекап';
  if (rel === 'character') return 'История персонажей';
  if (rel === 'spin_off') return 'Спин-офф';
  if (rel === 'adaptation') return 'Экранизация';
  if (rel === 'other') return 'Связанный тайтл';
  if (rel === 'current') return 'Выбранный тайтл';
  if (rel === 'mainline') return 'Основная линия';
  if (rel === 'extra') return 'Дополнительно';

  return 'Связанный тайтл';
}

function isRecapOrJunkRelation(relation, kind, title = '') {
  const rel = String(relation || '').toLowerCase();
  const k = String(kind || '').toLowerCase();
  const t = String(title || '').toLowerCase();

  if (rel === 'summary' || rel === 'character') return true;
  if (t.includes('recap') || t.includes('summary') || t.includes('омнибус')) return true;
  if (k === 'special' && rel === 'other') return true;

  return false;
}

function graphNodeFromAnime(anime, relation = 'other') {
  if (!anime?.id) return null;

  return {
    shikimoriId: anime.id,
    title: anime.russian || anime.name || 'Без названия',
    year: anime.aired_on ? Number(String(anime.aired_on).slice(0, 4)) || null : null,
    kind: anime.kind || '',
    relation,
    relationLabel: relationLabel(relation),
    status: anime.status || '',
    poster: anime.image?.original ? `https://shikimori.one${anime.image.original}` : '',
    animeUrl: `shikimori:${anime.id}`,
    animeId: `shikimori:${anime.id}`
  };
}

async function getAnimeWithRelated(shikimoriId) {
  const [animeData, relatedData] = await Promise.all([
    shikimoriGet(`/animes/${shikimoriId}`),
    shikimoriGet(`/animes/${shikimoriId}/related`)
  ]);

  return {
    anime: animeData,
    related: Array.isArray(relatedData) ? relatedData : []
  };
}

function isSideRelation(relation) {
  const rel = String(relation || '').toLowerCase();
  return [
    'side_story',
    'spin_off',
    'alternative_version',
    'alternative_setting',
    'full_story',
    'parent_story',
    'other'
  ].includes(rel);
}

function mainlinePriority(node) {
  const rel = String(node?.relation || '').toLowerCase();
  const kind = String(node?.kind || '').toLowerCase();
  const year = Number(node?.year) || 9999;

  let score = 0;

  if (rel === 'current') score += 10000;
  if (rel === 'mainline') score += 8000;
  if (rel === 'sequel') score += 7000;
  if (rel === 'prequel') score += 7000;

  if (kind === 'tv') score += 3000;
  else if (kind === 'movie') score += 1500;
  else if (kind === 'ova') score += 900;
  else if (kind === 'ona') score += 800;
  else if (kind === 'special') score += 200;

  score -= Math.min(year, 9999);

  return score;
}

function extraPriority(node) {
  const rel = String(node?.relation || '').toLowerCase();
  const kind = String(node?.kind || '').toLowerCase();

  let score = 0;

  if (rel === 'parent_story') score += 1000;
  if (rel === 'full_story') score += 900;
  if (rel === 'side_story') score += 800;
  if (rel === 'spin_off') score += 700;
  if (rel === 'alternative_version') score += 600;
  if (rel === 'alternative_setting') score += 500;
  if (rel === 'other') score += 300;

  if (kind === 'tv') score += 300;
  else if (kind === 'movie') score += 250;
  else if (kind === 'ova') score += 200;
  else if (kind === 'ona') score += 180;
  else if (kind === 'special') score += 50;

  return score;
}

async function buildWatchOrder(startShikimoriId) {
  const cache = new Map();
  const visited = new Set();

  async function loadNode(id) {
    if (cache.has(id)) return cache.get(id);
    const data = await getAnimeWithRelated(id);
    cache.set(id, data);
    return data;
  }

  async function collectConnectedFranchise(rootId) {
    const queue = [rootId];
    const nodesMap = new Map();

    while (queue.length) {
      const currentId = queue.shift();
      if (!currentId || visited.has(currentId)) continue;
      visited.add(currentId);

      const data = await loadNode(currentId);
      const currentNode = graphNodeFromAnime(data.anime, currentId === rootId ? 'current' : 'mainline');

      if (currentNode) {
        nodesMap.set(currentNode.shikimoriId, currentNode);
      }

      for (const item of data.related) {
        const anime = item?.anime;
        const relation = String(item?.relation || '').toLowerCase();
        if (!anime?.id) continue;

        const node = graphNodeFromAnime(anime, relation);
        if (!node) continue;

        if (!nodesMap.has(node.shikimoriId)) {
          nodesMap.set(node.shikimoriId, node);
        }

        if (!isRecapOrJunkRelation(relation, anime.kind, anime.russian || anime.name || '')) {
          queue.push(anime.id);
        }
      }
    }

    return [...nodesMap.values()];
  }

  const allNodes = await collectConnectedFranchise(startShikimoriId);

  const filteredNodes = allNodes.filter(node =>
    !isRecapOrJunkRelation(node.relation, node.kind, node.title)
  );

  const currentNode = filteredNodes.find(node => node.shikimoriId === startShikimoriId) || null;

  const mainlineCandidates = filteredNodes.filter(node => {
    const rel = String(node.relation || '').toLowerCase();
    return rel === 'current' || rel === 'mainline' || rel === 'sequel' || rel === 'prequel';
  });

  const tvMainline = mainlineCandidates.filter(node => String(node.kind || '').toLowerCase() === 'tv');
  const chosenMainlineBase = tvMainline.length ? tvMainline : mainlineCandidates;

  const mainline = [...chosenMainlineBase]
    .sort((a, b) => {
      const yearA = Number(a.year) || 9999;
      const yearB = Number(b.year) || 9999;

      if (yearA !== yearB) return yearA - yearB;

      const scoreA = mainlinePriority(a);
      const scoreB = mainlinePriority(b);
      if (scoreA !== scoreB) return scoreB - scoreA;

      return String(a.title || '').localeCompare(String(b.title || ''), 'ru');
    })
    .filter((node, index, arr) => arr.findIndex(item => item.shikimoriId === node.shikimoriId) === index)
    .map(node => ({
      ...node,
      relation: node.shikimoriId === startShikimoriId ? 'current' : 'mainline',
      relationLabel: node.shikimoriId === startShikimoriId ? 'Выбранный тайтл' : 'Основная линия',
      group: 'main',
      isCurrent: node.shikimoriId === startShikimoriId
    }));

  const mainlineIds = new Set(mainline.map(node => node.shikimoriId));

  const extras = filteredNodes
    .filter(node => !mainlineIds.has(node.shikimoriId))
    .sort((a, b) => {
      const scoreA = extraPriority(a);
      const scoreB = extraPriority(b);
      if (scoreA !== scoreB) return scoreB - scoreA;

      const yearA = Number(a.year) || 9999;
      const yearB = Number(b.year) || 9999;
      if (yearA !== yearB) return yearA - yearB;

      return String(a.title || '').localeCompare(String(b.title || ''), 'ru');
    })
    .map(node => ({
      ...node,
      relationLabel: relationLabel(node.relation),
      group: 'extra',
      isCurrent: node.shikimoriId === startShikimoriId
    }));

  const finalItems = [...mainline, ...extras];

  return {
    items: finalItems.map((item, index) => ({
      order: index + 1,
      shikimoriId: item.shikimoriId,
      animeId: item.animeId,
      animeUrl: item.animeUrl,
      title: item.title,
      year: item.year,
      kind: normalizeShikiType(item.kind),
      relation: item.relation,
      relationLabel: item.relationLabel,
      status: item.status,
      poster: item.poster,
      isCurrent: !!item.isCurrent,
      group: item.group || 'main'
    }))
  };
}

app.get('/api/watch-order', async (req, res) => {
  try {
    const shikimoriId = Number(req.query.shikimoriId);

    if (!shikimoriId || Number.isNaN(shikimoriId)) {
      return res.status(400).json({ error: 'Некорректный shikimoriId' });
    }

    const data = await buildWatchOrder(shikimoriId);
    res.json(data);
  } catch (error) {
    console.error('WATCH ORDER ERROR:', error.message);
    res.status(500).json({ error: 'Не удалось загрузить порядок просмотра', details: error.message });
  }
});

app.get('/api/geo', (req, res) => {
  const geo = getCountryByIp(req);
  res.json({
    ip: geo.ip,
    country: geo.country
  });
});

app.get('/api/blocked-anime', (req, res) => {
  const geo = getCountryByIp(req);
  const config = getBlockedAnimeConfigForCountry(geo.country);

  res.json({
    country: geo.country,
    titles: config.titles.length,
    shikimoriIds: config.shikimoriIds.length,
    titlesList: config.titles,
    shikimoriIdsList: config.shikimoriIds
  });
});

app.get('/api/health/kodik', async (req, res) => {
  try {
    const data = await kodikGet('/search', {
      title: 'Naruto',
      with_material_data: 'true'
    });

    res.json({
      ok: true,
      results: Array.isArray(data?.results) ? data.results.length : 0
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/yummy/search', async (req, res) => {
  try {
    if (!KODIK_TOKEN) return res.status(500).json({ error: 'Нет токена' });

    const query = (req.query.q || req.query.query || req.query.title || '').trim();
    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Введите минимум 2 символа для поиска' });
    }

    const [searchData, listData] = await Promise.all([
      kodikGet('/search', {
        title: query,
        with_material_data: 'true',
        with_episodes: 'true',
        types: 'anime-serial,anime'
      }),
      kodikGet('/list', {
        title: query,
        with_material_data: 'true',
        with_episodes: 'true',
        types: 'anime-serial,anime'
      })
    ]);

    const rawResults = [
      ...(Array.isArray(searchData?.results) ? searchData.results : []),
      ...(Array.isArray(listData?.results) ? listData.results : [])
    ];

    const mapped = rawResults
      .filter(isAllowedAnimeType)
      .map(item => makeSearchItem(item, query))
      .filter(item => item.score >= 1200);

    const deduped = dedupeSearchResults(mapped, query)
      .sort((a, b) => {
        const aRank = a.score + (a.serialPriority ? 800 : 0);
        const bRank = b.score + (b.serialPriority ? 800 : 0);
        return bRank - aRank;
      })
      .slice(0, 10)
      .map(({ score, serialPriority, titleKey, ...item }) => item);

    res.json(deduped);
  } catch (error) {
    console.error('SEARCH ERROR:', error.message);
    res.status(500).json({ error: 'Не удалось выполнить поиск', details: error.message });
  }
});

app.post('/api/yummy/anime/by-selection', async (req, res) => {
  try {
    if (!KODIK_TOKEN) return res.status(500).json({ error: 'Нет токена' });

    const selected = req.body || {};
    if (!selected?.title && !selected?.shikimoriId && !selected?.kodikId) {
      return res.status(400).json({ error: 'Недостаточно данных для выбора аниме' });
    }

    let results = await fetchAnimeBySelection(selected);
    results = strictMatchResults(results, selected);

    if (!results.length) {
      return res.status(404).json({ error: 'Не удалось точно определить выбранное аниме' });
    }

    const exactTitle = normalizeSearchText(selected.title);
    const first = results.find(item => normalizeSearchText(normalizeTitle(item)) === exactTitle) || results[0];

    const restriction = isAnimeBlockedForRequest(req, selected, first);

    if (restriction.blocked) {
      console.log(`[COUNTRY BLOCK] country=${restriction.country} ip=${restriction.ip} reason=${restriction.reason} anime="${normalizeTitle(first)}" shikimoriId=${getShikimoriId(first)}`);

      return res.status(403).json({
        error: 'Данное аниме запрещено на территории вашей страны',
        code: 'ANIME_BLOCKED_BY_COUNTRY',
        country: restriction.country,
        blocked: true
      });
    }

    const animeId = getStableAnimeId(first) || `kodik:${getKodikId(first) || 'unknown'}`;
    const videos = mergeEpisodes(results);

    console.log(`[Anime Selection] ${selected.title} | matched: ${normalizeTitle(first)} | results: ${results.length} | videos: ${videos.length}`);

    res.json({
      animeId,
      animeUrl: animeId,
      title: normalizeTitle(first),
      description: normalizeDescription(first),
      poster: normalizePoster(first),
      year: normalizeYear(first),
      type: normalizeType(first),
      status: normalizeStatus(first),
      shikimoriId: getShikimoriId(first),
      episodes: videos.length || null,
      videos
    });
  } catch (error) {
    console.error('ANIME BY SELECTION ERROR:', error.message);
    res.status(500).json({ error: 'Не удалось загрузить аниме', details: error.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'public', 'support.html')));
app.get('/support.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'support.html')));
app.get('/room/:roomId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));
app.get('/room/:roomId/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));

app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'API route not found',
    method: req.method,
    path: req.originalUrl
  });
});

app.use((req, res) => {
  if (isApiRequest(req)) {
    return res.status(404).json({
      error: 'API route not found',
      method: req.method,
      path: req.originalUrl
    });
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function ensureRoom(roomId, accessToken = '') {
  const safeRoomId = sanitizeRoomId(roomId);
  const safeAccessToken = sanitizeAccessToken(accessToken);
  const now = Date.now();

  if (!rooms[safeRoomId]) {
    rooms[safeRoomId] = {
      creatorUserKey: null,
      creatorSocketId: null,
      accessToken: safeAccessToken || null,
      createdAt: now,
      lastActivityAt: now,
      emptySince: null,
      users: [],
      videoState: {
        embedUrl: null,
        title: 'Ничего не выбрано',
        animeId: null,
        animeUrl: null,
        episodeNumber: null,
        playback: {
          paused: true,
          currentTime: null,
          updatedAt: now
        }
      }
    };
  }

  return rooms[safeRoomId];
}

function touchRoom(room) {
  if (!room) return;
  room.lastActivityAt = Date.now();
  if (room.users.length > 0) {
    room.emptySince = null;
  }
}

function attachCreatorSocketIfOwner(room, socket) {
  if (!room || !socket?.data?.userKey) return;

  if (room.creatorUserKey && room.creatorUserKey === socket.data.userKey) {
    room.creatorSocketId = socket.id;
  }
}

function isRoomHost(room, socket) {
  if (!room || !socket) return false;
  return !!room.creatorUserKey
    && room.creatorUserKey === socket.data.userKey
    && room.creatorSocketId === socket.id;
}

function canJoinRoom(room, providedAccessToken, socket) {
  if (!room) return false;

  if (!room.accessToken) {
    return true;
  }

  if (isRoomHost(room, socket)) {
    return true;
  }

  return secureCompare(room.accessToken, sanitizeAccessToken(providedAccessToken));
}

function getEffectivePlayback(pb) {
  const safe = pb || {
    paused: true,
    currentTime: null,
    updatedAt: Date.now()
  };

  let ct = typeof safe.currentTime === 'number' && !Number.isNaN(safe.currentTime)
    ? safe.currentTime
    : null;

  const paused = !!safe.paused;
  const updatedAt = Number(safe.updatedAt || Date.now()) || Date.now();

  if (ct !== null && !paused) {
    ct += (Date.now() - updatedAt) / 1000;
  }

  return {
    paused,
    currentTime: ct,
    updatedAt: Date.now()
  };
}

function getCurrentRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return null;

  return {
    embedUrl: room.videoState.embedUrl,
    title: room.videoState.title,
    hostId: room.creatorSocketId,
    animeId: room.videoState.animeId,
    animeUrl: room.videoState.animeUrl,
    episodeNumber: room.videoState.episodeNumber,
    playback: getEffectivePlayback(room.videoState.playback)
  };
}

function getUsersWithMeta(roomId) {
  const room = rooms[roomId];
  if (!room) return [];

  return room.users.map(u => ({
    ...u,
    isHost: !!room.creatorSocketId && u.id === room.creatorSocketId
  }));
}

function formatMoscowTime() {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
}

function sanitizeRoomUsername(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 30);

  return cleaned || 'Guest';
}

function pauseRoomPlayback(room) {
  if (!room?.videoState?.playback) return;

  room.videoState.playback.paused = true;
  room.videoState.playback.updatedAt = Date.now();
  touchRoom(room);
}

function cleanupRooms() {
  const now = Date.now();

  for (const [roomId, room] of Object.entries(rooms)) {
    if (!room) continue;

    if (!Array.isArray(room.users)) {
      delete rooms[roomId];
      continue;
    }

    if (room.users.length === 0) {
      if (!room.emptySince) {
        room.emptySince = now;
      }

      const emptyFor = now - room.emptySince;
      const staleFor = now - (room.lastActivityAt || room.createdAt || now);

      if (emptyFor >= EMPTY_ROOM_TTL_MS || staleFor >= STALE_ROOM_TTL_MS) {
        delete rooms[roomId];
      }
    }
  }
}

setInterval(cleanupRooms, ROOM_CLEANUP_INTERVAL_MS);

io.on('connection', (socket) => {
  socket.data.lastSeekEmitAt = 0;
  socket.data.lastUserTimeEmitAt = 0;

  socket.on('join-room', ({ roomId, username, userKey, accessToken }) => {
    const safeRoomId = sanitizeRoomId(roomId);
    const safeAccessToken = sanitizeAccessToken(accessToken);
    const socketIp = getClientIp({ headers: socket.handshake.headers, ip: socket.handshake.address, socket: { remoteAddress: socket.handshake.address } });

    if (!safeRoomId || !userKey) {
      socket.emit('join-error', { message: 'Некорректные данные для входа в комнату' });
      return;
    }

    const roomExists = !!rooms[safeRoomId];

    if (!roomExists) {
      if (!canCreateRoomForIp(socketIp)) {
        socket.emit('join-error', { message: 'Слишком много созданий комнат с вашего IP. Попробуйте позже.' });
        return;
      }
      registerRoomCreationForIp(socketIp);
    }

    const room = roomExists
      ? rooms[safeRoomId]
      : ensureRoom(safeRoomId, safeAccessToken);

    socket.data.roomId = safeRoomId;
    socket.data.username = sanitizeRoomUsername(username);
    socket.data.userKey = userKey;
    socket.data.accessToken = safeAccessToken;

    if (!room.creatorUserKey) {
      room.creatorUserKey = userKey;
      room.creatorSocketId = socket.id;
      if (safeAccessToken) {
        room.accessToken = safeAccessToken;
      }
    } else {
      attachCreatorSocketIfOwner(room, socket);
    }

    const isHostNow = isRoomHost(room, socket);

    if (!isHostNow && !canJoinRoom(room, safeAccessToken, socket)) {
      socket.emit('join-error', { message: 'Доступ в комнату запрещён. Используйте правильную ссылку-приглашение.' });
      return;
    }

    socket.join(safeRoomId);

    room.users = room.users.filter(u => u.id !== socket.id);

    room.users.push({
      id: socket.id,
      userKey,
      username: socket.data.username,
      currentTime: null,
      timeUpdatedAt: 0
    });

    touchRoom(room);

    if (isHostNow) {
      socket.emit('you-are-host');
    }

    socket.emit('sync-state', {
      ...getCurrentRoomState(safeRoomId),
      isHost: isHostNow
    });

    io.to(safeRoomId).emit('room-users', getUsersWithMeta(safeRoomId));
    socket.to(safeRoomId).emit('system-message', {
      text: `${socket.data.username} вошёл в комнату`
    });
  });

  socket.on('change-username', ({ roomId, username }) => {
    const safeRoomId = sanitizeRoomId(roomId);
    const room = rooms[safeRoomId];
    if (!room) return;

    const newUsername = sanitizeRoomUsername(username);
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;

    const oldUsername = user.username;
    if (oldUsername === newUsername) return;

    user.username = newUsername;
    socket.data.username = newUsername;
    touchRoom(room);

    io.to(safeRoomId).emit('room-users', getUsersWithMeta(safeRoomId));
    io.to(safeRoomId).emit('system-message', {
      text: `${oldUsername} теперь ${newUsername}`
    });
  });

  socket.on('change-video', ({ roomId, embedUrl, title, animeId, animeUrl, episodeNumber }) => {
    const safeRoomId = sanitizeRoomId(roomId);
    const room = rooms[safeRoomId];
    if (!room || !isRoomHost(room, socket)) return;

    room.videoState.embedUrl = embedUrl || null;
    room.videoState.title = title || 'Без названия';
    room.videoState.animeId = animeId ?? null;
    room.videoState.animeUrl = animeUrl ?? null;
    room.videoState.episodeNumber = episodeNumber ?? null;
    room.videoState.playback = {
      paused: true,
      currentTime: 0,
      updatedAt: Date.now()
    };

    room.users = room.users.map(user => ({
      ...user,
      currentTime: null,
      timeUpdatedAt: 0
    }));

    touchRoom(room);

    const state = getCurrentRoomState(safeRoomId);
    io.to(safeRoomId).emit('video-changed', state);
    io.to(safeRoomId).emit('room-users', getUsersWithMeta(safeRoomId));
    io.to(safeRoomId).emit('system-message', { text: `Хост выбрал: ${title}` });
  });

  socket.on('player-control', ({ roomId, action, currentTime }) => {
    const safeRoomId = sanitizeRoomId(roomId);
    const room = rooms[safeRoomId];
    if (!room || !isRoomHost(room, socket)) return;

    const safeTime = typeof currentTime === 'number' && !Number.isNaN(currentTime)
      ? currentTime
      : null;

    if (!room.videoState.playback) {
      room.videoState.playback = {
        paused: true,
        currentTime: null,
        updatedAt: Date.now()
      };
    }

    if (action === 'seek') {
      const now = Date.now();
      if (now - socket.data.lastSeekEmitAt < 250) return;
      socket.data.lastSeekEmitAt = now;
    }

    if (action === 'play') {
      room.videoState.playback.paused = false;
      room.videoState.playback.currentTime = safeTime !== null ? safeTime : room.videoState.playback.currentTime;
      room.videoState.playback.updatedAt = Date.now();
    } else if (action === 'pause') {
      room.videoState.playback.paused = true;
      room.videoState.playback.currentTime = safeTime !== null ? safeTime : room.videoState.playback.currentTime;
      room.videoState.playback.updatedAt = Date.now();
    } else if (action === 'seek') {
      if (safeTime !== null) {
        room.videoState.playback.currentTime = safeTime;
        room.videoState.playback.updatedAt = Date.now();
      }
    } else if (action === 'timeupdate') {
      if (safeTime !== null && safeTime >= 0) {
        room.videoState.playback.currentTime = safeTime;
        room.videoState.playback.updatedAt = Date.now();
      }
    }

    touchRoom(room);

    socket.to(safeRoomId).emit('player-control', {
      action,
      currentTime: room.videoState.playback.currentTime,
      paused: room.videoState.playback.paused,
      updatedAt: room.videoState.playback.updatedAt
    });
  });

  socket.on('update-user-time', ({ roomId, currentTime }) => {
    const safeRoomId = sanitizeRoomId(roomId);
    const room = rooms[safeRoomId];
    if (!room) return;

    const now = Date.now();
    if (now - socket.data.lastUserTimeEmitAt < 1000) return;
    socket.data.lastUserTimeEmitAt = now;

    const safeTime = typeof currentTime === 'number' && !Number.isNaN(currentTime) && currentTime >= 0
      ? currentTime
      : null;

    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;

    user.currentTime = safeTime;
    user.timeUpdatedAt = now;
    touchRoom(room);

    io.to(safeRoomId).emit('room-users', getUsersWithMeta(safeRoomId));
  });

  socket.on('chat-message', ({ roomId, username, message }) => {
    const safeRoomId = sanitizeRoomId(roomId);
    if (!safeRoomId || !message?.trim()) return;

    const room = rooms[safeRoomId];
    if (!room) return;

    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;

    const safeMessage = String(message).trim().slice(0, 300);
    const safeUsername = sanitizeRoomUsername(username || socket.data.username || user.username || 'Guest');

    touchRoom(room);

    io.to(safeRoomId).emit('chat-message', {
      username: safeUsername,
      message: safeMessage,
      time: formatMoscowTime()
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const username = socket.data.username || 'User';
    const wasHost = room.creatorSocketId === socket.id;

    room.users = room.users.filter(u => u.id !== socket.id);

    if (wasHost) {
      room.creatorSocketId = null;
      pauseRoomPlayback(room);
    }

    if (room.users.length > 0) {
      touchRoom(room);

      io.to(roomId).emit('system-message', {
        text: `${username} вышел из комнаты`
      });
      io.to(roomId).emit('room-users', getUsersWithMeta(roomId));

      if (wasHost) {
        io.to(roomId).emit('player-control', {
          action: 'pause',
          currentTime: room.videoState.playback.currentTime,
          paused: true,
          updatedAt: room.videoState.playback.updatedAt
        });

        io.to(roomId).emit('system-message', {
          text: 'Хост вышел из комнаты. Воспроизведение поставлено на паузу.'
        });
      }
    } else {
      room.emptySince = Date.now();
      room.lastActivityAt = Date.now();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});