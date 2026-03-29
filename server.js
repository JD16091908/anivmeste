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

function getStableAnimeId(item) {
  const shikimoriId = getShikimoriId(item);
  const kodikId = getKodikId(item);

  if (shikimoriId) return `shikimori:${shikimoriId}`;
  if (kodikId) return `kodik:${kodikId}`;
  return null;
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAllowedAnimeType(item) {
  const type = String(normalizeType(item) || '').toLowerCase();
  return type === 'anime' || type === 'anime-serial';
}

function scoreSearchItem(item, query) {
  const q = normalizeSearchText(query);
  const title = normalizeSearchText(normalizeTitle(item));
  const type = String(normalizeType(item) || '').toLowerCase();

  if (!q || !title) return 0;
  if (!isAllowedAnimeType(item)) return -10000;

  let score = 0;

  if (title === q) score += 5000;
  else if (title.startsWith(q)) score += 2500;
  else if (title.includes(q)) score += 1200;

  const words = q.split(' ').filter(Boolean);
  for (const word of words) {
    if (title.startsWith(word)) score += 250;
    else if (title.includes(word)) score += 120;
  }

  if (type === 'anime-serial') score += 300;
  if (type === 'anime') score += 150;

  return score;
}

function mapSearchResults(results, query = '') {
  const grouped = new Map();

  for (const item of results || []) {
    if (!isAllowedAnimeType(item)) continue;

    const animeId = getStableAnimeId(item);
    if (!animeId) continue;

    const score = scoreSearchItem(item, query);
    if (score <= 0) continue;

    if (!grouped.has(animeId)) {
      grouped.set(animeId, {
        animeId,
        animeUrl: animeId,
        title: normalizeTitle(item),
        year: normalizeYear(item),
        description: normalizeDescription(item),
        poster: normalizePoster(item),
        status: normalizeStatus(item),
        type: normalizeType(item),
        _score: score
      });
    } else {
      const existing = grouped.get(animeId);
      if (score > existing._score) {
        grouped.set(animeId, {
          animeId,
          animeUrl: animeId,
          title: normalizeTitle(item),
          year: normalizeYear(item),
          description: normalizeDescription(item),
          poster: normalizePoster(item),
          status: normalizeStatus(item),
          type: normalizeType(item),
          _score: score
        });
      }
    }
  }

  return [...grouped.values()]
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return String(a.title).localeCompare(String(b.title), 'ru');
    })
    .map(({ _score, ...item }) => item);
}

function buildEpisodeIframe(link) {
  if (!link) return null;
  return String(link).startsWith('//') ? `https:${link}` : link;
}

function extractEpisodesFromResults(items) {
  const episodeMap = new Map();

  for (const item of items || []) {
    const link = buildEpisodeIframe(item?.link);
    if (!link) continue;

    const episodeNumber =
      Number(item?.episode) ||
      Number(item?.sort_episode) ||
      Number(item?.last_episode) ||
      Number(item?.material_data?.episode) ||
      Number(item?.material_data?.last_episode) ||
      1;

    const seasonNumber =
      Number(item?.season) ||
      Number(item?.material_data?.season) ||
      1;

    const translationId = item?.translation?.id || null;
    const translationTitle = item?.translation?.title || item?.translation?.name || '';

    const key = `${seasonNumber}:${episodeNumber}:${translationId || translationTitle}`;

    if (!episodeMap.has(key)) {
      episodeMap.set(key, {
        videoId: `${seasonNumber}-${episodeNumber}-${translationId || 't'}`,
        number: episodeNumber,
        season: seasonNumber,
        index: episodeNumber,
        iframeUrl: link,
        dubbing: translationTitle,
        player: translationTitle || 'kodik',
        playerId: translationId,
        translationId,
        translationTitle,
        views: 0,
        duration: 0
      });
    }
  }

  return [...episodeMap.values()].sort((a, b) => {
    if ((a.season || 1) !== (b.season || 1)) return (a.season || 1) - (b.season || 1);
    return (a.number || 0) - (b.number || 0);
  });
}

function debugLogAnimeResults(label, results) {
  console.log(`\n========== DEBUG: ${label} ==========`);
  console.log(`Всего результатов: ${results.length}`);

  results.slice(0, 30).forEach((item, index) => {
    console.log({
      index,
      id: item?.id,
      title: normalizeTitle(item),
      type: normalizeType(item),
      year: normalizeYear(item),
      shikimori_id: getShikimoriId(item),
      episode: item?.episode,
      sort_episode: item?.sort_episode,
      last_episode: item?.last_episode,
      season: item?.season,
      translation_id: item?.translation?.id,
      translation_title: item?.translation?.title || item?.translation?.name,
      has_link: !!item?.link,
      link_preview: String(item?.link || '').slice(0, 90)
    });
  });

  console.log('=====================================\n');
}

async function fetchAnimeByStableId(animeId) {
  const [kind, rawValue] = String(animeId || '').split(':');
  const value = String(rawValue || '').trim();

  if (!kind || !value) return [];

  if (kind === 'shikimori') {
    const data = await kodikGet('/list', {
      shikimori_id: value,
      with_material_data: 'true',
      types: 'anime-serial,anime'
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    return results.filter(item => String(getShikimoriId(item) || '') === value);
  }

  if (kind === 'kodik') {
    const firstData = await kodikGet('/list', {
      id: value,
      with_material_data: 'true',
      types: 'anime-serial,anime'
    });

    const firstResults = Array.isArray(firstData?.results) ? firstData.results : [];
    const exact = firstResults.find(item => String(getKodikId(item) || '') === value) || firstResults[0];

    if (!exact) return [];

    const shikimoriId = getShikimoriId(exact);

    if (shikimoriId) {
      const byShiki = await kodikGet('/list', {
        shikimori_id: shikimoriId,
        with_material_data: 'true',
        types: 'anime-serial,anime'
      });

      const results = Array.isArray(byShiki?.results) ? byShiki.results : [];
      return results.filter(item => String(getShikimoriId(item) || '') === String(shikimoriId));
    }

    return [exact];
  }

  return [];
}

app.get('/api/yummy/search', async (req, res) => {
  try {
    if (!KODIK_TOKEN) return res.status(500).json({ error: 'Нет токена' });

    const query = (req.query.q || req.query.query || req.query.title || '').trim();
    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Введите минимум 2 символа для поиска' });
    }

    const data = await kodikGet('/search', {
      title: query,
      with_material_data: 'true',
      types: 'anime-serial,anime'
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    const mapped = mapSearchResults(results, query);

    if (query.toLowerCase().includes('ван') || query.toLowerCase().includes('one piece')) {
      debugLogAnimeResults(`SEARCH ${query}`, results);
      console.log('Mapped search results:', mapped.slice(0, 10));
    }

    res.json(mapped);
  } catch (error) {
    console.error('SEARCH ERROR:', error.message);
    res.status(500).json({ error: 'Не удалось выполнить поиск', details: error.message });
  }
});

app.get('/api/yummy/anime/:animeUrl', async (req, res) => {
  try {
    if (!KODIK_TOKEN) return res.status(500).json({ error: 'Нет токена' });

    const animeUrl = decodeURIComponent(req.params.animeUrl);
    const results = await fetchAnimeByStableId(animeUrl);

    if (animeUrl.toLowerCase().includes('one') || animeUrl.toLowerCase().includes('ван') || animeUrl.toLowerCase().includes('shikimori') || animeUrl.toLowerCase().includes('kodik')) {
      debugLogAnimeResults(`ANIME ${animeUrl}`, results);
    }

    if (!results.length) {
      return res.status(404).json({ error: 'Аниме не найдено' });
    }

    const first = results[0];
    const animeId = getStableAnimeId(first) || animeUrl;
    const videos = extractEpisodesFromResults(results);

    console.log(`DEBUG videos count for ${animeUrl}:`, videos.length);
    console.log('DEBUG first videos:', videos.slice(0, 20));

    res.json({
      animeId,
      animeUrl: animeId,
      title: normalizeTitle(first),
      description: normalizeDescription(first),
      poster: normalizePoster(first),
      year: normalizeYear(first),
      type: normalizeType(first),
      status: normalizeStatus(first),
      episodes: videos.length || null,
      videos
    });
  } catch (error) {
    console.error('ANIME ERROR:', error.message);
    res.status(500).json({ error: 'Не удалось загрузить аниме', details: error.message });
  }
});

function ensureRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      creatorUserKey: null,
      creatorSocketId: null,
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
          updatedAt: Date.now()
        }
      }
    };
  }

  return rooms[roomId];
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

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, username, userKey }) => {
    if (!roomId || !userKey) return;

    const room = ensureRoom(roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username || 'Гость';
    socket.data.userKey = userKey;

    room.users = room.users.filter(u => u.id !== socket.id);

    room.users.push({
      id: socket.id,
      userKey,
      username: socket.data.username,
      watchStatus: 'Не начал',
      currentTime: null,
      timeUpdatedAt: 0
    });

    if (!room.creatorUserKey) {
      room.creatorUserKey = userKey;
      room.creatorSocketId = socket.id;
    } else {
      attachCreatorSocketIfOwner(room, socket);
    }

    const isHostNow = isRoomHost(room, socket);

    if (isHostNow) {
      socket.emit('you-are-host');
    }

    socket.emit('sync-state', {
      ...getCurrentRoomState(roomId),
      isHost: isHostNow
    });

    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
    socket.to(roomId).emit('system-message', {
      text: `${socket.data.username} присоединился к комнате`
    });
  });

  socket.on('change-video', ({ roomId, embedUrl, title, animeId, animeUrl, episodeNumber }) => {
    const room = rooms[roomId];
    if (!room || !isRoomHost(room, socket)) return;

    room.videoState.embedUrl = embedUrl || null;
    room.videoState.title = title || 'Без названия';
    room.videoState.animeId = animeId ?? null;
    room.videoState.animeUrl = animeUrl ?? null;
    room.videoState.episodeNumber = episodeNumber ?? null;
    room.videoState.playback = {
      paused: true,
      currentTime: null,
      updatedAt: Date.now()
    };

    room.users = room.users.map(user => ({
      ...user,
      currentTime: null,
      timeUpdatedAt: 0
    }));

    const state = getCurrentRoomState(roomId);
    io.to(roomId).emit('video-changed', state);
    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
    io.to(roomId).emit('system-message', { text: `Хост выбрал: ${title}` });
  });

  socket.on('player-control', ({ roomId, action, currentTime }) => {
    const room = rooms[roomId];
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

  socket.on('update-user-time', ({ roomId, currentTime }) => {
    const room = rooms[roomId];
    if (!room) return;

    const safeTime = typeof currentTime === 'number' && !Number.isNaN(currentTime) && currentTime >= 0
      ? currentTime
      : null;

    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;

    user.currentTime = safeTime;
    user.timeUpdatedAt = Date.now();

    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
  });

  socket.on('update-watch-status', ({ roomId, status }) => {
    const room = rooms[roomId];
    if (!room) return;

    const user = room.users.find(u => u.id === socket.id);
    if (user) {
      user.watchStatus = status || 'Неизвестно';
    }

    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
  });

  socket.on('chat-message', ({ roomId, username, message }) => {
    if (!roomId || !message?.trim()) return;

    io.to(roomId).emit('chat-message', {
      username: username || 'Гость',
      message: message.trim(),
      time: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const username = socket.data.username || 'Пользователь';

    room.users = room.users.filter(u => u.id !== socket.id);

    if (room.creatorSocketId === socket.id) {
      room.creatorSocketId = null;
    }

    if (room.users.length > 0) {
      io.to(roomId).emit('system-message', {
        text: `${username} покинул комнату`
      });
      io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
    } else {
      delete rooms[roomId];
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});