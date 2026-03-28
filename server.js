const express = require('express');
const http = require('http');
const path = require('path');
const dns = require('dns').promises;
const { Server } = require('socket.io');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = {};

const KODIK_TOKEN = process.env.KODIK_TOKEN || 'ea55976b6acc94f41f173e2c702ebf6b';
const KODIK_API_BASE = 'https://kodik-api.com';

console.log(KODIK_TOKEN ? '✅ KODIK TOKEN загружен' : '❌ KODIK TOKEN не найден');

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/room/:roomId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));
app.get('/room/:roomId/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'room.html')));

async function checkHostAvailable(hostname) {
  try {
    const r = await dns.lookup(hostname);
    return !!r?.address;
  } catch { return false; }
}

async function kodikGet(endpoint, params = {}) {
  if (!await checkHostAvailable('kodik-api.com')) throw new Error('DNS failed for kodik-api.com');

  const url = `${KODIK_API_BASE}${endpoint}?${new URLSearchParams({ token: KODIK_TOKEN, ...params })}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();

  if (!response.ok) throw new Error(`Kodik HTTP ${response.status}: ${text.slice(0, 200)}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${text.slice(0, 200)}`); }
  if (data?.failed) throw new Error(data.failed);
  return data;
}

function normalizePoster(item) {
  const p = item?.poster_url || item?.poster || item?.material_data?.poster_url || item?.material_data?.poster || item?.material_data?.screenshots?.[0] || '';
  if (!p) return '';
  return p.startsWith('//') ? `https:${p}` : p;
}

function normalizeTitle(item) {
  return item?.title || item?.ru_title || item?.material_data?.title || item?.material_data?.ru_title || item?.material_data?.anime_title || 'Без названия';
}

function normalizeDescription(item) { return item?.material_data?.description || item?.description || ''; }
function normalizeYear(item) { return item?.year || item?.material_data?.year || ''; }
function normalizeType(item) { return item?.type || item?.material_data?.type || item?.material_data?.anime_kind || ''; }
function normalizeStatus(item) { return item?.material_data?.anime_status || item?.status || ''; }

function makeAnimeKey(item) {
  const sid = item?.shikimori_id || item?.material_data?.shikimori_id;
  const kid = item?.kinopoisk_id || item?.material_data?.kinopoisk_id;
  const iid = item?.imdb_id || item?.material_data?.imdb_id;
  if (sid) return `shikimori:${sid}`;
  if (kid) return `kinopoisk:${kid}`;
  if (iid) return `imdb:${iid}`;
  return `title:${String(normalizeTitle(item)).toLowerCase()}::${normalizeYear(item)}`;
}

function mapSearchResults(results) {
  const grouped = new Map();
  for (const item of results || []) {
    const key = makeAnimeKey(item);
    if (!grouped.has(key)) {
      grouped.set(key, {
        animeId: key, animeUrl: key,
        title: normalizeTitle(item), year: normalizeYear(item),
        description: normalizeDescription(item), poster: normalizePoster(item),
        status: normalizeStatus(item), type: normalizeType(item),
        shikimoriId: item?.shikimori_id || item?.material_data?.shikimori_id || null,
        kinopoiskId: item?.kinopoisk_id || item?.material_data?.kinopoisk_id || null,
        imdbId: item?.imdb_id || item?.material_data?.imdb_id || null
      });
    }
  }
  return [...grouped.values()];
}

function buildEpisodeIframe(link) {
  if (!link) return null;
  return link.startsWith('//') ? `https:${link}` : link;
}

function extractEpisodesFromItem(item) {
  const episodes = [];
  const seasons = item?.seasons || {};

  for (const [sn, sd] of Object.entries(seasons)) {
    if (!sd || typeof sd !== 'object') continue;
    const eps = sd?.episodes || sd;
    if (typeof eps !== 'object') continue;

    for (const [en, link] of Object.entries(eps)) {
      const iframeUrl = buildEpisodeIframe(typeof link === 'string' ? link : link?.link || link?.url || null);
      if (!iframeUrl) continue;

      episodes.push({
        videoId: `${sn}-${en}`,
        number: Number(en) || 0,
        season: Number(sn) || 1,
        index: Number(en) || 0,
        iframeUrl,
        dubbing: item?.translation?.title || '',
        player: item?.translation?.title || 'kodik',
        playerId: item?.translation?.id || null,
        translationId: item?.translation?.id || null,
        translationTitle: item?.translation?.title || '',
        views: 0, duration: 0
      });
    }
  }

  if (episodes.length > 0) {
    return episodes.sort((a, b) => a.season !== b.season ? a.season - b.season : a.number - b.number);
  }

  const link = buildEpisodeIframe(item?.link);
  if (link) {
    episodes.push({
      videoId: `${item?.id || 'movie'}`,
      number: 1, season: 1, index: 1, iframeUrl: link,
      dubbing: item?.translation?.title || '',
      player: item?.translation?.title || 'kodik',
      playerId: item?.translation?.id || null,
      translationId: item?.translation?.id || null,
      translationTitle: item?.translation?.title || '',
      views: 0, duration: 0
    });
  }

  return episodes;
}

function mergeEpisodes(items) {
  const map = new Map();
  for (const item of items || []) {
    for (const ep of extractEpisodesFromItem(item)) {
      const key = `${ep.season}:${ep.number}:${ep.translationId || ep.translationTitle || ''}`;
      if (!map.has(key)) map.set(key, ep);
    }
  }
  return [...map.values()].sort((a, b) => {
    if ((a.season || 1) !== (b.season || 1)) return (a.season || 1) - (b.season || 1);
    return (a.number || 0) - (b.number || 0);
  });
}

async function fetchAnimeByKey(animeKey) {
  const params = { with_material_data: 'true', with_episodes: 'true' };
  const colonIndex = animeKey.indexOf(':');
  const kind = colonIndex > -1 ? animeKey.slice(0, colonIndex) : '';
  const value = colonIndex > -1 ? animeKey.slice(colonIndex + 1) : animeKey;

  if (kind === 'shikimori') params.shikimori_id = value;
  else if (kind === 'kinopoisk') params.kinopoisk_id = value;
  else if (kind === 'imdb') params.imdb_id = value;
  else if (kind === 'title') {
    const [t, y] = value.split('::');
    params.title = t || '';
    if (y) params.year = y;
  } else params.title = animeKey;

  let data = await kodikGet('/search', params);
  let results = Array.isArray(data?.results) ? data.results : [];

  if (!results.length) {
    data = await kodikGet('/list', { ...params, types: 'anime-serial,anime' });
    results = Array.isArray(data?.results) ? data.results : [];
  }

  return results;
}

app.get('/api/health/kodik', async (req, res) => {
  try {
    const data = await kodikGet('/search', { title: 'Naruto', with_material_data: 'true' });
    res.json({ ok: true, results: Array.isArray(data?.results) ? data.results.length : 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/yummy/search', async (req, res) => {
  try {
    if (!KODIK_TOKEN) return res.status(500).json({ error: 'Нет токена' });
    const query = (req.query.q || req.query.query || req.query.title || '').trim();
    if (!query || query.length < 2) return res.status(400).json({ error: 'Мин. 2 символа' });

    console.log(`[SEARCH] "${query}"`);
    let data = await kodikGet('/search', { title: query, with_material_data: 'true' });
    let results = Array.isArray(data?.results) ? data.results : [];

    if (!results.length) {
      data = await kodikGet('/list', { title: query, with_material_data: 'true', types: 'anime-serial,anime' });
      results = Array.isArray(data?.results) ? data.results : [];
    }

    const mapped = mapSearchResults(results);
    console.log(`[SEARCH] results: ${results.length}, grouped: ${mapped.length}`);
    res.json(mapped);
  } catch (e) {
    console.error('SEARCH ERROR:', e.message);
    res.status(500).json({ error: 'Не удалось выполнить поиск', details: e.message });
  }
});

app.get('/api/yummy/anime/:animeUrl', async (req, res) => {
  try {
    if (!KODIK_TOKEN) return res.status(500).json({ error: 'Нет токена' });
    const animeUrl = decodeURIComponent(req.params.animeUrl);
    const results = await fetchAnimeByKey(animeUrl);
    if (!results.length) return res.status(404).json({ error: 'Аниме не найдено' });

    const first = results[0];
    const animeId = makeAnimeKey(first);
    const videos = mergeEpisodes(results);

    res.json({
      animeId, animeUrl: animeId,
      title: normalizeTitle(first), description: normalizeDescription(first),
      poster: normalizePoster(first), year: normalizeYear(first),
      type: normalizeType(first), status: normalizeStatus(first),
      episodes: videos.length || null, videos
    });
  } catch (e) {
    console.error('ANIME ERROR:', e.message);
    res.status(500).json({ error: 'Не удалось загрузить аниме', details: e.message });
  }
});

app.get('/api/yummy/anime-id/:animeId/videos', async (req, res) => {
  try {
    if (!KODIK_TOKEN) return res.status(500).json({ error: 'Нет токена' });
    const animeId = decodeURIComponent(req.params.animeId);
    const results = await fetchAnimeByKey(animeId);
    res.json(mergeEpisodes(results));
  } catch (e) {
    res.status(500).json({ error: 'Не удалось загрузить серии', details: e.message });
  }
});

function ensureRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      creatorUserKey: null,
      hostUserKey: null,
      hostSocketId: null,
      users: [],
      videoState: {
        embedUrl: null,
        title: 'Ничего не выбрано',
        animeId: null,
        animeUrl: null,
        episodeNumber: null,
        playback: { paused: true, currentTime: null, updatedAt: Date.now() }
      }
    };
  }
  return rooms[roomId];
}

function getEffectivePlayback(pb) {
  const safe = pb || { paused: true, currentTime: null, updatedAt: Date.now() };
  let ct = typeof safe.currentTime === 'number' && !Number.isNaN(safe.currentTime) ? safe.currentTime : null;
  const paused = !!safe.paused;
  const updatedAt = Number(safe.updatedAt || Date.now()) || Date.now();
  if (ct !== null && !paused) ct += (Date.now() - updatedAt) / 1000;
  return { paused, currentTime: ct, updatedAt: Date.now() };
}

function getCurrentRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return null;
  return {
    embedUrl: room.videoState.embedUrl,
    title: room.videoState.title,
    hostId: room.hostSocketId,
    animeId: room.videoState.animeId,
    animeUrl: room.videoState.animeUrl,
    episodeNumber: room.videoState.episodeNumber,
    playback: getEffectivePlayback(room.videoState.playback)
  };
}

function getUsersWithMeta(roomId) {
  const room = rooms[roomId];
  if (!room) return [];
  return room.users.map(u => ({ ...u, isHost: u.userKey === room.hostUserKey }));
}

function resolveHost(room) {
  if (!room) return;

  if (room.creatorUserKey) {
    const creatorOnline = room.users.find(u => u.userKey === room.creatorUserKey);
    if (creatorOnline) {
      room.hostUserKey = room.creatorUserKey;
      room.hostSocketId = creatorOnline.id;
      return;
    }
  }

  if (room.hostUserKey) {
    const hostOnline = room.users.find(u => u.userKey === room.hostUserKey);
    if (hostOnline) {
      room.hostSocketId = hostOnline.id;
      return;
    }
  }

  if (room.users.length > 0) {
    room.hostUserKey = room.users[0].userKey;
    room.hostSocketId = room.users[0].id;
  } else {
    room.hostUserKey = null;
    room.hostSocketId = null;
  }
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, username, userKey }) => {
    if (!roomId || !userKey) return;

    const room = ensureRoom(roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username || 'Гость';
    socket.data.userKey = userKey;

    room.users = room.users.filter(u => u.userKey !== userKey);
    room.users.push({ id: socket.id, userKey, username: socket.data.username, watchStatus: 'Не начал' });

    if (!room.creatorUserKey) room.creatorUserKey = userKey;

    resolveHost(room);

    const isHostNow = room.hostUserKey === userKey;
    if (isHostNow) socket.emit('you-are-host');

    socket.emit('sync-state', { ...getCurrentRoomState(roomId), isHost: isHostNow });
    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
    socket.to(roomId).emit('system-message', { text: `${socket.data.username} присоединился к комнате` });
  });

  socket.on('change-video', ({ roomId, videoSrc, embedUrl, title, animeId, animeUrl, episodeNumber }) => {
    const room = rooms[roomId];
    if (!room || room.hostUserKey !== socket.data.userKey) return;

    room.videoState.embedUrl = embedUrl || null;
    room.videoState.title = title || 'Без названия';
    room.videoState.animeId = animeId ?? null;
    room.videoState.animeUrl = animeUrl ?? null;
    room.videoState.episodeNumber = episodeNumber ?? null;
    room.videoState.playback = { paused: true, currentTime: null, updatedAt: Date.now() };

    room.users = room.users.map(u => ({
      ...u,
      watchStatus: u.userKey === socket.data.userKey ? 'Смотрю' : 'Ожидает запуск'
    }));

    const state = getCurrentRoomState(roomId);
    io.to(roomId).emit('video-changed', state);
    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
    io.to(roomId).emit('system-message', { text: `Хост выбрал: ${title}` });
  });

  socket.on('player-control', ({ roomId, action, currentTime }) => {
    const room = rooms[roomId];
    if (!room || room.hostUserKey !== socket.data.userKey) return;

    const safeTime = typeof currentTime === 'number' && !Number.isNaN(currentTime) ? currentTime : null;

    if (!room.videoState.playback) {
      room.videoState.playback = { paused: true, currentTime: null, updatedAt: Date.now() };
    }

    if (action === 'play') {
      room.videoState.playback.paused = false;
      if (safeTime !== null && safeTime > 0.5) room.videoState.playback.currentTime = safeTime;
      room.videoState.playback.updatedAt = Date.now();
    } else if (action === 'pause') {
      room.videoState.playback.paused = true;
      if (safeTime !== null && safeTime > 0.5) room.videoState.playback.currentTime = safeTime;
      room.videoState.playback.updatedAt = Date.now();
    } else if (action === 'seek') {
      if (safeTime !== null) {
        room.videoState.playback.currentTime = safeTime;
        room.videoState.playback.updatedAt = Date.now();
      }
    } else if (action === 'timeupdate') {
      if (safeTime !== null && safeTime > 0.5) {
        room.videoState.playback.currentTime = safeTime;
        room.videoState.playback.updatedAt = Date.now();
      }
    }

    socket.to(roomId).emit('player-control', {
      action,
      currentTime: room.videoState.playback.currentTime,
      paused: room.videoState.playback.paused,
      updatedAt: room.videoState.playback.updatedAt
    });
  });

  socket.on('update-watch-status', ({ roomId, status }) => {
    const room = rooms[roomId];
    if (!room) return;
    const user = room.users.find(u => u.userKey === socket.data.userKey);
    if (user) user.watchStatus = status || 'Неизвестно';
    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
  });

  socket.on('sync-request', ({ roomId }) => {
    const room = rooms[roomId];
    const state = getCurrentRoomState(roomId);
    if (!room || !state) return;
    const isHostNow = room.hostUserKey === socket.data.userKey;
    socket.emit('sync-state', { ...state, isHost: isHostNow });
  });

  socket.on('chat-message', ({ roomId, username, message }) => {
    if (!roomId || !message?.trim()) return;
    io.to(roomId).emit('chat-message', {
      username: username || 'Гость',
      message: message.trim(),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const username = socket.data.username || 'Пользователь';

    room.users = room.users.filter(u => u.id !== socket.id);

    resolveHost(room);

    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('you-are-host');
    }

    if (room.users.length > 0) {
      io.to(roomId).emit('system-message', { text: `${username} покинул комнату` });
      io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
    } else {
      delete rooms[roomId];
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});