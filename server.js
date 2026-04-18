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
app.set('trust proxy', 1);

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

const SEARCH_ALIASES_FILE = path.join(__dirname, 'search-aliases.json');
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 300;
const searchResponseCache = new Map();
const dnsAvailabilityCache = new Map();

const SHIKI_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SHIKI_SEARCH_CACHE_MAX_ENTRIES = 250;
const shikimoriSearchCache = new Map();

const BUILTIN_SEARCH_ALIASES = {
  'хантер': [
    'хантер х хантер',
    'хантер x хантер',
    'охотник х охотник',
    'охотник x охотник',
    'hunter x hunter',
    'hunter x hunter 2011',
    'hunter x hunter 1999'
  ],
  'хантер х хантер': [
    'охотник х охотник',
    'hunter x hunter',
    'hunter × hunter',
    'hunter x hunter 2011',
    'hunter x hunter 1999'
  ],
  'хантер x хантер': [
    'охотник x охотник',
    'охотник х охотник',
    'hunter x hunter',
    'hunter × hunter',
    'hunter x hunter 2011',
    'hunter x hunter 1999'
  ],
  'охотник х охотник': [
    'хантер х хантер',
    'хантер x хантер',
    'hunter x hunter',
    'hunter × hunter',
    'hunter x hunter 2011',
    'hunter x hunter 1999'
  ],
  'охотник x охотник': [
    'хантер x хантер',
    'хантер х хантер',
    'hunter x hunter',
    'hunter × hunter',
    'hunter x hunter 2011',
    'hunter x hunter 1999'
  ],
  'hunter x hunter': [
    'hunter × hunter',
    'хантер х хантер',
    'охотник х охотник',
    'охотник x охотник',
    'hunter x hunter 2011',
    'hunter x hunter 1999'
  ],
  'hunter × hunter': [
    'hunter x hunter',
    'хантер х хантер',
    'охотник х охотник'
  ]
};

const TRANSLIT_MAP = new Map([
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['е', 'e'], ['ё', 'e'],
  ['ж', 'zh'], ['з', 'z'], ['и', 'i'], ['й', 'y'], ['к', 'k'], ['л', 'l'], ['м', 'm'],
  ['н', 'n'], ['о', 'o'], ['п', 'p'], ['р', 'r'], ['с', 's'], ['т', 't'], ['у', 'u'],
  ['ф', 'f'], ['х', 'h'], ['ц', 'ts'], ['ч', 'ch'], ['ш', 'sh'], ['щ', 'sch'],
  ['ъ', ''], ['ы', 'y'], ['ь', ''], ['э', 'e'], ['ю', 'yu'], ['я', 'ya']
]);

let SEARCH_ALIASES_MAP = new Map();

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const origin = req.headers.origin;

    if (origin && !isAllowedOrigin(origin)) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
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
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'", 'data:', 'https:'],
      connectSrc: [
        "'self'",
        'wss:',
        'ws:',
        'https://anivmeste.ru',
        'https://www.anivmeste.ru',
        'https://anivmeste.onrender.com'
      ],
      frameSrc: ["'self'", 'https:', 'http:'],
      mediaSrc: ["'self'", 'https:', 'http:'],
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
  legacyHeaders: false,
  validate: { trustProxy: false }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false }
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

const KODIK_TOKEN = String(process.env.KODIK_TOKEN || '').trim();
const KODIK_API_BASE = 'https://kodik-api.com';
const SHIKIMORI_API_BASE = 'https://shikimori.one/api';
const BLOCKED_ANIME_FILE = path.join(__dirname, 'blocked-anime.json');

console.log(KODIK_TOKEN ? '✅ KODIK TOKEN загружен из env' : '❌ KODIK TOKEN не найден (нужен env KODIK_TOKEN)');

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.ico'), {
    headers: {
      'Content-Type': 'image/x-icon',
      'Cache-Control': 'public, max-age=86400'
    }
  });
});

app.get('/favicon.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.png'), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400'
    }
  });
});

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
    .replace(/[×х]/g, ' x ')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(' ')
    .map(item => item.trim())
    .filter(Boolean);
}

function transliterateRuToLat(value) {
  return normalizeSearchText(value)
    .split('')
    .map(ch => TRANSLIT_MAP.get(ch) ?? ch)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function transliterateLatToRuApprox(value) {
  return normalizeSearchText(value)
    .replace(/hunter/g, 'хантер')
    .replace(/x/g, ' х ')
    .replace(/shch/g, 'щ')
    .replace(/sch/g, 'щ')
    .replace(/yo/g, 'е')
    .replace(/yu/g, 'ю')
    .replace(/ya/g, 'я')
    .replace(/zh/g, 'ж')
    .replace(/kh/g, 'х')
    .replace(/ts/g, 'ц')
    .replace(/ch/g, 'ч')
    .replace(/sh/g, 'ш')
    .replace(/ye/g, 'е')
    .replace(/a/g, 'а')
    .replace(/b/g, 'б')
    .replace(/v/g, 'в')
    .replace(/g/g, 'г')
    .replace(/d/g, 'д')
    .replace(/e/g, 'е')
    .replace(/z/g, 'з')
    .replace(/i/g, 'и')
    .replace(/y/g, 'й')
    .replace(/k/g, 'к')
    .replace(/l/g, 'л')
    .replace(/m/g, 'м')
    .replace(/n/g, 'н')
    .replace(/o/g, 'о')
    .replace(/p/g, 'п')
    .replace(/r/g, 'р')
    .replace(/s/g, 'с')
    .replace(/t/g, 'т')
    .replace(/u/g, 'у')
    .replace(/f/g, 'ф')
    .replace(/h/g, 'х')
    .replace(/w/g, 'в')
    .replace(/q/g, 'к')
    .replace(/c/g, 'к')
    .replace(/j/g, 'дж')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeArray(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function createBuiltinAliasesMap() {
  const aliases = new Map();

  for (const [key, values] of Object.entries(BUILTIN_SEARCH_ALIASES)) {
    const normalizedKey = normalizeSearchText(key);
    const normalizedValues = dedupeArray(
      (values || []).map(item => normalizeSearchText(item)).filter(Boolean)
    );

    if (normalizedKey) {
      aliases.set(normalizedKey, normalizedValues);
    }
  }

  return aliases;
}

function mergeAliasMaps(primary, fallback) {
  const result = new Map();

  for (const [key, values] of fallback.entries()) {
    result.set(key, [...values]);
  }

  for (const [key, values] of primary.entries()) {
    const existing = result.get(key) || [];
    result.set(key, dedupeArray([...existing, ...values]));
  }

  return result;
}

function loadSearchAliases() {
  try {
    const builtin = createBuiltinAliasesMap();

    if (!fs.existsSync(SEARCH_ALIASES_FILE)) {
      return builtin;
    }

    const raw = fs.readFileSync(SEARCH_ALIASES_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      return builtin;
    }

    const fileAliases = new Map();

    for (const [key, values] of Object.entries(parsed)) {
      const normalizedKey = normalizeSearchText(key);
      if (!normalizedKey) continue;

      const normalizedValues = Array.isArray(values)
        ? dedupeArray(values.map(item => normalizeSearchText(item)))
        : [];

      fileAliases.set(normalizedKey, normalizedValues);
    }

    return mergeAliasMaps(fileAliases, builtin);
  } catch (error) {
    console.error('SEARCH ALIASES LOAD ERROR:', error.message);
    return createBuiltinAliasesMap();
  }
}

function refreshSearchAliases() {
  SEARCH_ALIASES_MAP = loadSearchAliases();
  console.log(`✅ Search aliases loaded: ${SEARCH_ALIASES_MAP.size}`);
}

refreshSearchAliases();

try {
  fs.watchFile(SEARCH_ALIASES_FILE, { interval: 2000 }, () => {
    console.log('ℹ️ search-aliases.json changed, reloading aliases');
    refreshSearchAliases();
    searchResponseCache.clear();
    shikimoriSearchCache.clear();
  });
} catch (error) {
  console.error('SEARCH ALIASES WATCH ERROR:', error.message);
}

function expandQueryVariants(query) {
  const normalized = normalizeSearchText(query);
  const variants = new Set();

  if (!normalized) return [];

  variants.add(normalized);
  variants.add(normalized.replace(/\s+/g, ''));

  const translitRuToLat = transliterateRuToLat(normalized);
  const translitLatToRu = transliterateLatToRuApprox(normalized);

  if (translitRuToLat) {
    variants.add(translitRuToLat);
    variants.add(translitRuToLat.replace(/\s+/g, ''));
  }

  if (translitLatToRu) {
    variants.add(translitLatToRu);
    variants.add(translitLatToRu.replace(/\s+/g, ''));
  }

  const aliasDirect = SEARCH_ALIASES_MAP.get(normalized);
  if (aliasDirect) {
    for (const alias of aliasDirect) {
      variants.add(alias);
      variants.add(alias.replace(/\s+/g, ''));
    }
  }

  for (const token of tokenizeSearchText(normalized)) {
    const alias = SEARCH_ALIASES_MAP.get(token);
    if (alias) {
      for (const item of alias) {
        variants.add(item);
        variants.add(item.replace(/\s+/g, ''));
      }
    }
  }

  return [...variants].filter(Boolean).slice(0, 12);
}

function getSearchCacheKey(query) {
  return normalizeSearchText(query);
}

function pruneSearchCache() {
  const now = Date.now();

  for (const [key, value] of searchResponseCache.entries()) {
    if (!value || now - value.createdAt > SEARCH_CACHE_TTL_MS) {
      searchResponseCache.delete(key);
    }
  }

  if (searchResponseCache.size <= SEARCH_CACHE_MAX_ENTRIES) return;

  const entries = [...searchResponseCache.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt);

  while (entries.length && searchResponseCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const [oldestKey] = entries.shift();
    searchResponseCache.delete(oldestKey);
  }
}

function getCachedSearch(query) {
  pruneSearchCache();
  const key = getSearchCacheKey(query);
  const cached = searchResponseCache.get(key);

  if (!cached) return null;
  if (Date.now() - cached.createdAt > SEARCH_CACHE_TTL_MS) {
    searchResponseCache.delete(key);
    return null;
  }

  return cached.data;
}

function setCachedSearch(query, data) {
  pruneSearchCache();
  const key = getSearchCacheKey(query);
  searchResponseCache.set(key, {
    createdAt: Date.now(),
    data
  });
}

function pruneShikimoriSearchCache() {
  const now = Date.now();

  for (const [key, value] of shikimoriSearchCache.entries()) {
    if (!value || now - value.createdAt > SHIKI_SEARCH_CACHE_TTL_MS) {
      shikimoriSearchCache.delete(key);
    }
  }

  if (shikimoriSearchCache.size <= SHIKI_SEARCH_CACHE_MAX_ENTRIES) return;

  const entries = [...shikimoriSearchCache.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt);

  while (entries.length && shikimoriSearchCache.size > SHIKI_SEARCH_CACHE_MAX_ENTRIES) {
    const [oldestKey] = entries.shift();
    shikimoriSearchCache.delete(oldestKey);
  }
}

function getCachedShikimoriSearch(query) {
  pruneShikimoriSearchCache();
  const key = normalizeSearchText(query);
  const cached = shikimoriSearchCache.get(key);

  if (!cached) return null;
  if (Date.now() - cached.createdAt > SHIKI_SEARCH_CACHE_TTL_MS) {
    shikimoriSearchCache.delete(key);
    return null;
  }

  return cached.data;
}

function setCachedShikimoriSearch(query, data) {
  pruneShikimoriSearchCache();
  const key = normalizeSearchText(query);
  shikimoriSearchCache.set(key, {
    createdAt: Date.now(),
    data
  });
}

function levenshteinDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');

  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const matrix = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));

  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[left.length][right.length];
}

function sanitizeRoomId(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 120);
}

function isValidNewRoomId(roomId) {
  const safe = sanitizeRoomId(roomId);
  if (!safe || safe !== roomId) return false;
  if (safe === 'solo') return false;
  return /^r_[a-z0-9]{24}$/i.test(safe);
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
  const now = Date.now();
  const cached = dnsAvailabilityCache.get(hostname);

  if (cached && now - cached.checkedAt < 60 * 1000) {
    return cached.ok;
  }

  try {
    const r = await dns.lookup(hostname);
    const ok = !!r?.address;
    dnsAvailabilityCache.set(hostname, { ok, checkedAt: now });
    return ok;
  } catch {
    dnsAvailabilityCache.set(hostname, { ok: false, checkedAt: now });
    return false;
  }
}

async function kodikGet(endpoint, params = {}) {
  if (!await checkHostAvailable('kodik-api.com')) {
    throw new Error('DNS failed for kodik-api.com');
  }

  const queryParams = {
    token: KODIK_TOKEN,
    limit: '60',
    ...params
  };

  Object.keys(queryParams).forEach(key => {
    if (queryParams[key] === undefined || queryParams[key] === null || queryParams[key] === '') {
      delete queryParams[key];
    }
  });

  const url = `${KODIK_API_BASE}${endpoint}?${new URLSearchParams(queryParams).toString()}`;

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

async function shikimoriSearchAnimes(searchQuery) {
  const normalized = normalizeSearchText(searchQuery);
  if (!normalized || normalized.length < 2) return [];

  const cached = getCachedShikimoriSearch(normalized);
  if (cached) return cached;

  const params = new URLSearchParams({
    search: searchQuery,
    limit: '12',
    order: 'ranked'
  });

  const data = await shikimoriGet(`/animes?${params.toString()}`);
  const list = Array.isArray(data) ? data : [];

  setCachedShikimoriSearch(normalized, list);
  return list;
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

function getAllTitles(item) {
  return [
    item?.title,
    item?.ru_title,
    item?.material_data?.title,
    item?.material_data?.ru_title,
    item?.material_data?.anime_title,
    item?.material_data?.full_title
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);
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

function hasFullTokenMatch(title, queryTokens) {
  const titleTokens = tokenizeSearchText(title);
  if (!queryTokens.length || !titleTokens.length) return false;

  return queryTokens.every(qToken =>
    titleTokens.some(tToken =>
      tToken === qToken ||
      tToken.startsWith(qToken) ||
      qToken.startsWith(tToken)
    )
  );
}

function calcSingleTitleScore(normalizedTitle, queryVariants, normalizedQuery) {
  let score = 0;
  const title = normalizeSearchText(normalizedTitle);
  const titleLat = transliterateRuToLat(title);
  const queryTokens = tokenizeSearchText(normalizedQuery);

  if (!title) return 0;

  const titleForms = new Set([title, titleLat].filter(Boolean));

  for (const query of queryVariants) {
    const q = normalizeSearchText(query);
    if (!q) continue;

    const qLat = transliterateRuToLat(q);
    const qRu = transliterateLatToRuApprox(q);
    const queryForms = new Set([q, qLat, qRu].filter(Boolean));

    for (const qForm of queryForms) {
      for (const titleForm of titleForms) {
        if (!qForm || !titleForm) continue;

        if (titleForm === qForm) score = Math.max(score, 25000);
        else if (titleForm.startsWith(qForm)) score = Math.max(score, 16000);
        else if (titleForm.includes(qForm)) score = Math.max(score, 8000);

        const qTokens = tokenizeSearchText(qForm);
        const titleTokens = tokenizeSearchText(titleForm);

        let tokenScore = 0;

        for (const qToken of qTokens) {
          if (!qToken) continue;

          if (titleTokens.includes(qToken)) {
            tokenScore += qToken.length <= 3 ? 2200 : 3400;
          }

          for (const titleToken of titleTokens) {
            if (!titleToken) continue;

            if (titleToken === qToken) {
              tokenScore += 3600;
            } else if (titleToken.startsWith(qToken)) {
              tokenScore += qToken.length <= 2 ? 1300 : 2600;
            } else if (titleToken.includes(qToken)) {
              tokenScore += qToken.length <= 2 ? 250 : 700;
            }

            const lenDiff = Math.abs(titleToken.length - qToken.length);
            if (qToken.length >= 4 && titleToken.length >= 4 && lenDiff <= 2) {
              const dist = levenshteinDistance(qToken, titleToken);
              if (dist === 1) tokenScore += 1400;
              else if (dist === 2) tokenScore += 500;
            }
          }
        }

        if (hasFullTokenMatch(titleForm, queryTokens)) {
          tokenScore += 10000;
        }

        if (qForm.length >= 4 && titleForm.length >= 4) {
          const distWhole = levenshteinDistance(qForm, titleForm);
          if (distWhole === 1) tokenScore += 1400;
          else if (distWhole === 2) tokenScore += 600;
        }

        score = Math.max(score, tokenScore);
      }
    }
  }

  return score;
}

function scoreShikimoriAnimeCandidate(anime, queryVariants, normalizedQuery) {
  const titles = [
    anime?.russian,
    anime?.name
  ].filter(Boolean);

  let score = 0;
  for (const title of titles) {
    score = Math.max(score, calcSingleTitleScore(title, queryVariants, normalizedQuery));
  }
  return score;
}

function isLatinText(value) {
  return /[a-z]/i.test(String(value || ''));
}

function pickShikimoriSearchTerm(expandedQueries, normalizedQuery) {
  const pool = dedupeArray([normalizedQuery, ...(expandedQueries || [])])
    .map(q => String(q || '').trim())
    .filter(q => q.length >= 2);

  if (!pool.length) return null;

  const latinCandidates = pool.filter(isLatinText);
  if (latinCandidates.length) {
    latinCandidates.sort((a, b) => b.length - a.length);
    return latinCandidates[0] || null;
  }

  pool.sort((a, b) => b.length - a.length);
  return pool[0] || null;
}

function primaryQueryPriority(q, normalizedQuery) {
  const n = normalizeSearchText(q);
  if (!n) return -999;

  let score = 0;

  if (n === normalizedQuery) score += 10000;
  if (isLatinText(n)) score += 2600;
  if (/[а-я]/i.test(n)) score += 1800;

  if (n.includes(' ')) score += 1200;
  if (!n.includes(' ') && n.length >= 8) score -= 250;

  score += Math.min(1600, n.length * 45);

  const qYear = normalizedQuery.match(/\b(19|20)\d{2}\b/)?.[0];
  if (qYear && n.includes(qYear)) score += 450;

  return score;
}

function selectPrimaryKodikQueries(rawQuery, expandedQueries, normalizedQuery) {
  const candidates = dedupeArray([
    rawQuery,
    normalizedQuery,
    ...(expandedQueries || [])
  ])
    .map(q => normalizeSearchText(q))
    .filter(Boolean);

  const scored = candidates
    .map(q => ({ q, score: primaryQueryPriority(q, normalizedQuery) }))
    .sort((a, b) => b.score - a.score)
    .map(item => item.q);

  let primary = scored.slice(0, 5);

  const latinBest = scored.find(q => isLatinText(q));
  if (latinBest && !primary.includes(latinBest)) {
    primary = [latinBest, ...primary].slice(0, 5);
  }

  primary = primary.filter(q => q.length >= 2);

  return dedupeArray(primary).slice(0, 5);
}

function titleScore(item, queryVariants, normalizedQuery) {
  if (!isAllowedAnimeType(item)) return -1000;
  if (!queryVariants.length) return 0;

  const titles = getAllTitles(item);
  let score = 0;

  for (const title of titles) {
    score = Math.max(score, calcSingleTitleScore(title, queryVariants, normalizedQuery));
  }

  const qYear = normalizedQuery.match(/\b(19|20)\d{2}\b/)?.[0];
  const y = String(normalizeYear(item) || '');
  if (qYear && y === qYear) score += 1000;

  if (isSerial(item)) score += 700;
  if (getShikimoriId(item)) score += 200;
  if (normalizePoster(item)) score += 60;
  if (normalizeDescription(item)) score += 30;

  return score;
}

function makeSearchItem(item, queryVariants, normalizedQuery) {
  const allTitles = getAllTitles(item);

  return {
    animeId: getStableAnimeId(item) || `kodik:${getKodikId(item) || 'unknown'}`,
    animeUrl: String(getStableAnimeId(item) || `kodik:${getKodikId(item) || 'unknown'}`),
    title: normalizeTitle(item),
    altTitles: allTitles,
    titleKey: normalizeTitleKey(normalizeTitle(item)),
    year: normalizeYear(item),
    description: normalizeDescription(item),
    poster: normalizePoster(item),
    status: normalizeStatus(item),
    type: normalizeType(item),
    shikimoriId: getShikimoriId(item),
    kodikId: getKodikId(item),
    score: titleScore(item, queryVariants, normalizedQuery),
    serialPriority: isSerial(item) ? 1 : 0
  };
}

function dedupeSearchResults(items, queryVariants) {
  const queryVariantKeys = queryVariants.map(normalizeTitleKey).filter(Boolean);
  const strictMap = new Map();

  for (const item of items) {
    const titleCandidates = [item.title, ...(item.altTitles || [])]
      .map(value => normalizeTitleKey(value))
      .filter(Boolean);

    const itemKey = item.titleKey || normalizeTitleKey(item.title);
    const year = String(item.year || '');
    const groupKey = `${itemKey}|${year}`;

    const goodMatch = titleCandidates.some(candidate =>
      queryVariantKeys.some(queryKey =>
        candidate === queryKey ||
        candidate.startsWith(queryKey) ||
        candidate.includes(queryKey) ||
        queryKey.startsWith(candidate)
      )
    );

    if (!goodMatch && item.score < 1200) continue;

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

function extractTvOrderIndexFromTitle(title) {
  const t = String(title || '');
  const m = t.match(/\[(?:tb|тв|tv)[- ]?(\d+)\]/i) || t.match(/\b(?:tb|тв|tv)[- ]?(\d+)\b/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

function getMatchPriority(item, normalizedQuery, expandedQueries = []) {
  const variants = dedupeArray([normalizedQuery, ...(expandedQueries || [])])
    .map(v => normalizeSearchText(v))
    .filter(Boolean);

  const titles = [item?.title, ...(item?.altTitles || [])]
    .map(v => normalizeSearchText(v))
    .filter(Boolean);

  let best = 9;

  for (const title of titles) {
    for (const q of variants) {
      if (!q || !title) continue;

      if (title === q) {
        best = Math.min(best, 0);
      } else if (title.startsWith(q)) {
        best = Math.min(best, 1);
      } else if (title.includes(q) || q.includes(title)) {
        best = Math.min(best, 2);
      } else {
        const qTokens = tokenizeSearchText(q);
        const tTokens = tokenizeSearchText(title);
        const allMatch = qTokens.length > 0 && qTokens.every(qt => tTokens.some(tt => tt === qt || tt.startsWith(qt)));
        if (allMatch) best = Math.min(best, 3);
      }
    }
  }

  return best;
}

function compareSearchItemsStrictOrder(a, b) {
  if ((a.matchPriority || 9) !== (b.matchPriority || 9)) {
    return (a.matchPriority || 9) - (b.matchPriority || 9);
  }

  if ((b.serialPriority || 0) !== (a.serialPriority || 0)) {
    return (b.serialPriority || 0) - (a.serialPriority || 0);
  }

  const yearA = Number(a.year) || 0;
  const yearB = Number(b.year) || 0;
  if (yearA !== yearB) return yearB - yearA;

  const tvA = extractTvOrderIndexFromTitle(a.title);
  const tvB = extractTvOrderIndexFromTitle(b.title);
  if (tvA !== tvB) {
    if (!tvA) return 1;
    if (!tvB) return -1;
    return tvA - tvB;
  }

  if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);

  return String(a.title || '').localeCompare(String(b.title || ''), 'ru');
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
  const selectedVariants = expandQueryVariants(selectedTitle);

  let filtered = items.filter(item => {
    if (!isAllowedAnimeType(item)) return false;

    const itemTitles = getAllTitles(item).map(normalizeSearchText);
    const itemYear = String(normalizeYear(item) || '');
    const itemShikimori = String(getShikimoriId(item) || '');
    const itemKodik = String(getKodikId(item) || '');

    const idMatch =
      (selectedShikimori && itemShikimori === selectedShikimori) ||
      (selectedKodik && itemKodik === selectedKodik);

    const titleMatch =
      selectedVariants.length &&
      itemTitles.some(itemTitle =>
        selectedVariants.some(selectedVariant =>
          itemTitle === selectedVariant ||
          itemTitle.includes(selectedVariant) ||
          selectedVariant.includes(itemTitle)
        )
      );

    const yearMatch = !selectedYear || itemYear === selectedYear;

    return (idMatch || titleMatch) && yearMatch;
  });

  if (filtered.length > 0) return filtered;

  filtered = items.filter(item => {
    const itemTitles = getAllTitles(item).map(normalizeSearchText);
    return selectedVariants.length && itemTitles.some(itemTitle =>
      selectedVariants.some(selectedVariant =>
        itemTitle === selectedVariant ||
        itemTitle.includes(selectedVariant) ||
        selectedVariant.includes(itemTitle)
      )
    );
  });

  return filtered;
}

async function fetchFullEpisodesForLongAnime(results) {
  const first = results[0];
  if (!first) return results;

  const currentEpisodesCount = mergeEpisodes(results).length;
  const maxKnownEpisode = getLastEpisode(first);

  if (currentEpisodesCount >= 10 || maxKnownEpisode < 20) {
    return results;
  }

  console.log(`[Long Anime Detected] ${normalizeTitle(first)} | episodes found: ${currentEpisodesCount}, last known: ${maxKnownEpisode}`);
  console.log('Запрашиваю полный список серий по material_id');

  const materialId = getMaterialId(first);
  if (!materialId) return results;

  try {
    const fullData = await kodikGet('/list', {
      material_id: materialId,
      with_material_data: 'true',
      with_episodes: 'true',
      types: 'anime-serial,anime'
    });

    const fullResults = Array.isArray(fullData?.results) ? fullData.results : [];
    return [...results, ...fullResults];
  } catch (error) {
    console.log('Не удалось получить полный список серий:', error.message);
    return results;
  }
}

async function fetchAnimeBySelection(selected) {
  if (selected?.shikimoriId) {
    const [searchData, listData] = await Promise.all([
      kodikGet('/search', {
        shikimori_id: selected.shikimoriId,
        with_material_data: 'true',
        with_episodes: 'true',
        types: 'anime-serial,anime'
      }),
      kodikGet('/list', {
        shikimori_id: selected.shikimoriId,
        with_material_data: 'true',
        with_episodes: 'true',
        types: 'anime-serial,anime'
      })
    ]);

    let results = [
      ...(Array.isArray(searchData?.results) ? searchData.results : []),
      ...(Array.isArray(listData?.results) ? listData.results : [])
    ];

    return await fetchFullEpisodesForLongAnime(results);
  }

  if (selected?.kodikId) {
    const [searchData, listData] = await Promise.all([
      kodikGet('/search', {
        id: selected.kodikId,
        with_material_data: 'true',
        with_episodes: 'true',
        types: 'anime-serial,anime'
      }),
      kodikGet('/list', {
        id: selected.kodikId,
        with_material_data: 'true',
        with_episodes: 'true',
        types: 'anime-serial,anime'
      })
    ]);

    let results = [
      ...(Array.isArray(searchData?.results) ? searchData.results : []),
      ...(Array.isArray(listData?.results) ? listData.results : [])
    ];

    return await fetchFullEpisodesForLongAnime(results);
  }

  if (selected?.title) {
    const searchVariants = expandQueryVariants(selected.title).slice(0, 3);
    const requests = [];

    for (const variant of searchVariants) {
      requests.push(
        kodikGet('/search', {
          title: variant,
          with_material_data: 'true',
          with_episodes: 'true',
          types: 'anime-serial,anime'
        })
      );
    }

    const responses = await Promise.all(requests);
    const results = [];

    for (const response of responses) {
      if (Array.isArray(response?.results)) {
        results.push(...response.results);
      }
    }

    return await fetchFullEpisodesForLongAnime(results);
  }

  return [];
}

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

async function handleKodikSearch(req, res) {
  try {
    if (!KODIK_TOKEN) {
      return res.status(500).json({ error: 'Нет токена' });
    }

    const query = (req.query.q || '').trim();
    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Введите минимум 2 символа для поиска' });
    }

    const normalizedQuery = normalizeSearchText(query);
    const cached = getCachedSearch(normalizedQuery);
    if (cached) return res.json(cached);

    const expandedQueries = expandQueryVariants(query);

    const primaryQueries = selectPrimaryKodikQueries(
      query,
      expandedQueries,
      normalizedQuery
    );

    const requests = primaryQueries.map(q =>
      kodikGet('/search', {
        title: q,
        with_material_data: 'true',
        with_episodes: 'false',
        types: 'anime-serial,anime'
      })
    );

    const responses = await Promise.all(requests);

    let rawResults = [];
    for (const response of responses) {
      if (Array.isArray(response?.results)) {
        rawResults.push(...response.results);
      }
    }

    rawResults = rawResults.filter(item => {
      const type = String(normalizeType(item) || '').toLowerCase();
      if (!type.includes('anime')) return false;
      if (type.includes('ova')) return false;
      if (type.includes('ona')) return false;
      if (type.includes('special')) return false;
      return true;
    });

    const mapped = rawResults
      .map(item => makeSearchItem(item, expandedQueries, normalizedQuery))
      .filter(item => item.score > 0);

    const deduped = dedupeSearchResults(mapped, expandedQueries)
      .map(item => ({
        ...item,
        matchPriority: getMatchPriority(item, normalizedQuery, expandedQueries)
      }));

    deduped.sort(compareSearchItemsStrictOrder);

    const finalResults = deduped
      .filter(item => item.score >= 1400 || item.matchPriority <= 2)
      .slice(0, 24);

    setCachedSearch(normalizedQuery, finalResults);
    return res.json(finalResults);
  } catch (error) {
    console.error('KODIK SEARCH ERROR:', error.message);
    return res.status(500).json({ error: 'Ошибка поиска', details: error.message });
  }
}

async function handleKodikAnimeBySelection(req, res) {
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

    const selectedVariants = expandQueryVariants(selected.title);
    const first = results.find(item =>
      getAllTitles(item).some(title =>
        selectedVariants.some(variant => normalizeSearchText(title) === normalizeSearchText(variant))
      )
    ) || results[0];

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
    console.error('KODIK ANIME BY SELECTION ERROR:', error.message);
    res.status(500).json({ error: 'Не удалось загрузить аниме', details: error.message });
  }
}

app.get('/api/kodik/search', handleKodikSearch);
app.post('/api/kodik/anime/by-selection', handleKodikAnimeBySelection);

app.get('/api/yummy/search', handleKodikSearch);
app.post('/api/yummy/anime/by-selection', handleKodikAnimeBySelection);

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

function ensureRoom(roomId) {
  const safeRoomId = sanitizeRoomId(roomId);
  const now = Date.now();

  if (!rooms[safeRoomId]) {
    rooms[safeRoomId] = {
      creatorUserKey: null,
      creatorSocketId: null,
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

  socket.on('join-room', ({ roomId, username, userKey }) => {
    const safeRoomId = sanitizeRoomId(roomId);
    const socketIp = getClientIp({
      headers: socket.handshake.headers,
      ip: socket.handshake.address,
      socket: { remoteAddress: socket.handshake.address }
    });

    if (!safeRoomId || !userKey) {
      socket.emit('join-error', { message: 'Некорректные данные для входа в комнату' });
      return;
    }

    const roomExists = !!rooms[safeRoomId];

    if (!roomExists) {
      if (!isValidNewRoomId(safeRoomId)) {
        socket.emit('join-error', { message: 'Некорректная ссылка комнаты' });
        return;
      }

      if (!canCreateRoomForIp(socketIp)) {
        socket.emit('join-error', { message: 'Слишком много созданий комнат с вашего IP. Попробуйте позже.' });
        return;
      }
      registerRoomCreationForIp(socketIp);
    }

    const room = roomExists ? rooms[safeRoomId] : ensureRoom(safeRoomId);

    socket.data.roomId = safeRoomId;
    socket.data.username = sanitizeRoomUsername(username);
    socket.data.userKey = userKey;

    if (!room.creatorUserKey) {
      room.creatorUserKey = userKey;
      room.creatorSocketId = socket.id;
    } else {
      attachCreatorSocketIfOwner(room, socket);
    }

    const isHostNow = isRoomHost(room, socket);

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