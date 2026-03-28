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

if (KODIK_TOKEN) {
  console.log('✅ KODIK API TOKEN загружен');
} else {
  console.log('❌ KODIK API TOKEN не найден');
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

async function checkHostAvailable(hostname) {
  try {
    const result = await dns.lookup(hostname);
    return !!result?.address;
  } catch {
    return false;
  }
}

async function kodikGet(endpoint, params = {}) {
  const hostOk = await checkHostAvailable('kodik-api.com');
  if (!hostOk) {
    throw new Error('DNS lookup failed for kodik-api.com');
  }

  const searchParams = new URLSearchParams({
    token: KODIK_TOKEN,
    ...params
  });

  const url = `${KODIK_API_BASE}${endpoint}?${searchParams.toString()}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Kodik HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Kodik returned invalid JSON: ${text.slice(0, 300)}`);
  }

  if (data?.failed) {
    throw new Error(data.failed);
  }

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
  if (poster.startsWith('//')) return `https:${poster}`;
  return poster;
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

function ensureKodikToken(res) {
  if (!KODIK_TOKEN) {
    res.status(500).json({ error: 'Не указан KODIK API TOKEN' });
    return false;
  }
  return true;
}

function makeAnimeKey(item) {
  const shikimoriId = item?.shikimori_id || item?.material_data?.shikimori_id;
  const kinopoiskId = item?.kinopoisk_id || item?.material_data?.kinopoisk_id;
  const imdbId = item?.imdb_id || item?.material_data?.imdb_id;
  const title = normalizeTitle(item);
  const year = normalizeYear(item);

  if (shikimoriId) return `shikimori:${shikimoriId}`;
  if (kinopoiskId) return `kinopoisk:${kinopoiskId}`;
  if (imdbId) return `imdb:${imdbId}`;
  return `title:${String(title).toLowerCase()}::${year}`;
}

function mapSearchResults(results) {
  const grouped = new Map();

  for (const item of results || []) {
    const key = makeAnimeKey(item);

    if (!grouped.has(key)) {
      grouped.set(key, {
        animeId: key,
        animeUrl: key,
        title: normalizeTitle(item),
        year: normalizeYear(item),
        season: '',
        description: normalizeDescription(item),
        poster: normalizePoster(item),
        status: normalizeStatus(item),
        type: normalizeType(item),
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
  if (link.startsWith('//')) return `https:${link}`;
  return link;
}

function extractEpisodesFromItem(item) {
  const episodes = [];
  const seasons = item?.seasons || {};

  for (const [seasonNumber, seasonData] of Object.entries(seasons)) {
    if (!seasonData || typeof seasonData !== 'object') continue;

    const episodesObj = seasonData?.episodes || seasonData;
    if (typeof episodesObj !== 'object') continue;

    for (const [episodeNumber, link] of Object.entries(episodesObj)) {
      const iframeUrl = buildEpisodeIframe(
        typeof link === 'string' ? link : link?.link || link?.url || null
      );

      if (!iframeUrl) continue;

      episodes.push({
        videoId: `${seasonNumber}-${episodeNumber}`,
        number: Number(episodeNumber) || 0,
        season: Number(seasonNumber) || 1,
        index: Number(episodeNumber) || 0,
        iframeUrl,
        dubbing: item?.translation?.title || item?.translation?.name || '',
        player: item?.translation?.title || item?.translation?.name || 'kodik',
        playerId: item?.translation?.id || null,
        translationId: item?.translation?.id || null,
        translationTitle: item?.translation?.title || item?.translation?.name || '',
        views: 0,
        duration: 0
      });
    }
  }

  if (episodes.length > 0) {
    return episodes.sort((a, b) => {
      if (a.season !== b.season) return a.season - b.season;
      return a.number - b.number;
    });
  }

  const link = buildEpisodeIframe(item?.link);
  if (link) {
    episodes.push({
      videoId: `${item?.id || 'movie'}`,
      number: 1,
      season: 1,
      index: 1,
      iframeUrl: link,
      dubbing: item?.translation?.title || item?.translation?.name || '',
      player: item?.translation?.title || item?.translation?.name || 'kodik',
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

async function fetchAnimeByKey(animeKey) {
  let params = {
    with_material_data: 'true',
    with_episodes: 'true'
  };

  const colonIndex = animeKey.indexOf(':');
  const kind = colonIndex > -1 ? animeKey.slice(0, colonIndex) : '';
  const value = colonIndex > -1 ? animeKey.slice(colonIndex + 1) : animeKey;

  if (kind === 'shikimori' && value) {
    params.shikimori_id = value;
  } else if (kind === 'kinopoisk' && value) {
    params.kinopoisk_id = value;
  } else if (kind === 'imdb' && value) {
    params.imdb_id = value;
  } else if (kind === 'title' && value) {
    const [titlePart, yearPart] = value.split('::');
    params.title = titlePart || '';
    if (yearPart) params.year = yearPart;
  } else {
    params.title = animeKey;
  }

  let data = await kodikGet('/search', params);
  let results = Array.isArray(data?.results) ? data.results : [];

  if (!results.length) {
    const listParams = {
      ...params,
      types: 'anime-serial,anime'
    };
    data = await kodikGet('/list', listParams);
    results = Array.isArray(data?.results) ? data.results : [];
  }

  return results;
}

app.get('/api/health/kodik', async (req, res) => {
  try {
    const dnsOk = await checkHostAvailable('kodik-api.com');
    if (!dnsOk) {
      return res.status(500).json({
        ok: false,
        error: 'DNS lookup failed for kodik-api.com'
      });
    }

    const data = await kodikGet('/search', {
      title: 'Naruto',
      with_material_data: 'true'
    });

    return res.json({
      ok: true,
      results: Array.isArray(data?.results) ? data.results.length : 0
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get('/api/yummy/search', async (req, res) => {
  try {
    if (!ensureKodikToken(res)) return;

    const query = (req.query.q || req.query.query || req.query.title || '').trim();

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Введите минимум 2 символа для поиска' });
    }

    console.log(`[SEARCH] Запрос: "${query}"`);

    let data = await kodikGet('/search', {
      title: query,
      with_material_data: 'true'
    });

    let results = Array.isArray(data?.results) ? data.results : [];

    if (!results.length) {
      data = await kodikGet('/list', {
        title: query,
        with_material_data: 'true',
        types: 'anime-serial,anime'
      });
      results = Array.isArray(data?.results) ? data.results : [];
    }

    const mapped = mapSearchResults(results);

    console.log(`[SEARCH] Kodik results: ${results.length}, grouped: ${mapped.length}`);

    return res.json(mapped);
  } catch (error) {
    console.error('KODIK SEARCH ERROR:', error.message);
    return res.status(500).json({
      error: 'Не удалось выполнить поиск',
      details: error.message
    });
  }
});

app.get('/api/yummy/anime/:animeUrl', async (req, res) => {
  try {
    if (!ensureKodikToken(res)) return;

    const animeUrl = decodeURIComponent(req.params.animeUrl);
    const results = await fetchAnimeByKey(animeUrl);

    if (!results.length) {
      return res.status(404).json({ error: 'Аниме не найдено' });
    }

    const first = results[0];
    const animeId = makeAnimeKey(first);
    const videos = mergeEpisodes(results);

    return res.json({
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
    console.error('KODIK ANIME LOAD ERROR:', error.message);
    return res.status(500).json({
      error: 'Не удалось загрузить аниме',
      details: error.message
    });
  }
});

app.get('/api/yummy/anime-id/:animeId/videos', async (req, res) => {
  try {
    if (!ensureKodikToken(res)) return;

    const animeId = decodeURIComponent(req.params.animeId);
    const results = await fetchAnimeByKey(animeId);
    const videos = mergeEpisodes(results);

    return res.json(videos);
  } catch (error) {
    console.error('KODIK VIDEOS ONLY ERROR:', error.message);
    return res.status(500).json({
      error: 'Не удалось загрузить серии',
      details: error.message
    });
  }
});

function ensureRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      users: [],
      videoState: {
        src: null,
        embedUrl: null,
        title: 'Ничего не выбрано',
        hostId: null,
        animeId: null,
        animeUrl: null,
        episodeNumber: null,
        playback: {
          paused: true,
          currentTime: 0,
          updatedAt: Date.now()
        }
      }
    };
  }

  return rooms[roomId];
}

function getEffectivePlayback(playback) {
  const safe = playback || {
    paused: true,
    currentTime: 0,
    updatedAt: Date.now()
  };

  let currentTime = Number(safe.currentTime || 0) || 0;
  const paused = !!safe.paused;
  const updatedAt = Number(safe.updatedAt || Date.now()) || Date.now();

  if (!paused) {
    currentTime += (Date.now() - updatedAt) / 1000;
  }

  return {
    paused,
    currentTime,
    updatedAt: Date.now()
  };
}

function getCurrentRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return null;

  return {
    src: room.videoState.src,
    embedUrl: room.videoState.embedUrl,
    title: room.videoState.title,
    hostId: room.videoState.hostId,
    animeId: room.videoState.animeId,
    animeUrl: room.videoState.animeUrl,
    episodeNumber: room.videoState.episodeNumber,
    playback: getEffectivePlayback(room.videoState.playback)
  };
}

function switchToVideo(roomId, payload) {
  const room = rooms[roomId];
  if (!room) return null;

  room.videoState.src = payload.videoSrc || null;
  room.videoState.embedUrl = payload.embedUrl || null;
  room.videoState.title = payload.title || 'Без названия';
  room.videoState.animeId = payload.animeId ?? null;
  room.videoState.animeUrl = payload.animeUrl ?? null;
  room.videoState.episodeNumber = payload.episodeNumber ?? null;
  room.videoState.playback = {
    paused: true,
    currentTime: 0,
    updatedAt: Date.now()
  };

  return getCurrentRoomState(roomId);
}

function getUsersWithMeta(roomId) {
  const room = rooms[roomId];
  if (!room) return [];

  return room.users.map(user => ({
    ...user,
    isHost: user.id === room.videoState.hostId
  }));
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, username }) => {
    if (!roomId) return;

    const room = ensureRoom(roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username || 'Гость';

    if (!room.videoState.hostId) {
      room.videoState.hostId = socket.id;
    }

    if (!room.users.some(user => user.id === socket.id)) {
      room.users.push({
        id: socket.id,
        username: socket.data.username,
        watchStatus: 'Не начал'
      });
    }

    const isHostNow = room.videoState.hostId === socket.id;

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

  socket.on('change-video', ({ roomId, videoSrc, embedUrl, title, animeId, animeUrl, episodeNumber }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.videoState.hostId !== socket.id) return;

    const state = switchToVideo(roomId, {
      videoSrc,
      embedUrl,
      title,
      animeId,
      animeUrl,
      episodeNumber
    });

    if (!state) return;

    room.users = room.users.map(user => ({
      ...user,
      watchStatus: user.id === socket.id ? 'Смотрю' : 'Ожидает запуск'
    }));

    io.to(roomId).emit('video-changed', state);
    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
    io.to(roomId).emit('system-message', {
      text: `Хост выбрал: ${title}`
    });
  });

  socket.on('player-control', ({ roomId, action, currentTime }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.videoState.hostId !== socket.id) return;

    if (!room.videoState.playback) {
      room.videoState.playback = {
        paused: true,
        currentTime: 0,
        updatedAt: Date.now()
      };
    }

    if (typeof currentTime === 'number' && !Number.isNaN(currentTime)) {
      room.videoState.playback.currentTime = currentTime;
    }

    if (action === 'play') {
      room.videoState.playback.paused = false;
    } else if (action === 'pause') {
      room.videoState.playback.paused = true;
    }

    room.videoState.playback.updatedAt = Date.now();

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

    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;

    user.watchStatus = status || 'Неизвестно';
    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
  });

  socket.on('sync-request', ({ roomId }) => {
    const state = getCurrentRoomState(roomId);
    if (!state) return;

    socket.emit('sync-state', {
      ...state,
      isHost: state.hostId === socket.id
    });

    socket.emit('system-message', {
      text: 'Контент в комнате синхронизирован'
    });
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
    const wasHost = room.videoState.hostId === socket.id;

    room.users = room.users.filter(user => user.id !== socket.id);

    if (wasHost && room.users.length > 0) {
      room.videoState.hostId = room.users[0].id;
      io.to(room.videoState.hostId).emit('you-are-host');
      io.to(roomId).emit('system-message', {
        text: `${username} вышел. Новый хост назначен автоматически`
      });
    } else if (room.users.length > 0) {
      io.to(roomId).emit('system-message', {
        text: `${username} покинул комнату`
      });
    }

    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));

    if (room.users.length === 0) {
      delete rooms[roomId];
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});