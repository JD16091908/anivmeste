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

function getWorldArtId(item) {
  return item?.worldart_id || item?.material_data?.worldart_id || null;
}

function getKinopoiskId(item) {
  return item?.kinopoisk_id || item?.material_data?.kinopoisk_id || null;
}

function getImdbId(item) {
  return item?.imdb_id || item?.material_data?.imdb_id || null;
}

function getStableAnimeId(item) {
  const shikimoriId = getShikimoriId(item);
  const kodikId = getKodikId(item);

  if (shikimoriId) return `shikimori:${shikimoriId}`;
  if (kodikId) return `kodik:${kodikId}`;
  return null;
}

function makeAnimeKey(item) {
  const shikimoriId = getShikimoriId(item);
  if (shikimoriId) return `shikimori:${shikimoriId}`;

  const kodikId = getKodikId(item);
  if (kodikId) return `kodik:${kodikId}`;

  const kinopoiskId = getKinopoiskId(item);
  if (kinopoiskId) return `kinopoisk:${kinopoiskId}`;

  const imdbId = getImdbId(item);
  if (imdbId) return `imdb:${imdbId}`;

  const title = normalizeTitle(item);
  const year = normalizeYear(item);
  if (title) return `title:${title}${year ? `::${year}` : ''}`;

  return `title:unknown::${Date.now()}`;
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
  return type === 'anime' || type === 'anime-serial' || type.includes('anime');
}

function scoreSearchItem(item, query) {
  const q = normalizeSearchText(query);
  const title = normalizeSearchText(normalizeTitle(item));

  if (!q || !title) return 0;
  if (!isAllowedAnimeType(item)) return -1000;

  let score = 0;

  if (title === q) score += 5000;
  else if (title.startsWith(q)) score += 2500;
  else if (title.includes(q)) score += 1200;

  const words = q.split(' ').filter(Boolean);
  for (const word of words) {
    if (title.startsWith(word)) score += 250;
    else if (title.includes(word)) score += 120;
  }

  const queryYear = q.match(/\b(19|20)\d{2}\b/)?.[0];
  const itemYear = String(normalizeYear(item) || '');
  if (queryYear && queryYear === itemYear) score += 600;

  if (getShikimoriId(item)) score += 100;
  if (item?.translation?.title) score += 20;

  return score;
}

function mapSearchResults(results, query = '') {
  const grouped = new Map();

  for (const item of results || []) {
    if (!isAllowedAnimeType(item)) continue;

    const animeId = getStableAnimeId(item) || makeAnimeKey(item);
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

function extractEpisodesFromEpisodesObject(item) {
  const episodes = [];
  const episodesObj = item?.episodes;

  if (!episodesObj || typeof episodesObj !== 'object') return episodes;

  for (const [episodeNumber, link] of Object.entries(episodesObj)) {
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

function extractEpisodesFromSeasons(item) {
  const episodes = [];
  const seasons = item?.seasons || {};

  for (const [seasonNumber, seasonData] of Object.entries(seasons)) {
    if (!seasonData || typeof seasonData !== 'object') continue;

    const episodesObj = seasonData?.episodes || seasonData;
    if (!episodesObj || typeof episodesObj !== 'object') continue;

    for (const [episodeNumber, link] of Object.entries(episodesObj)) {
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
        player: item?.translation?.title || item?.translation?.name || 'kodik',
        playerId: item?.translation?.id || null,
        translationId: item?.translation?.id || null,
        translationTitle: item?.translation?.title || item?.translation?.name || '',
        views: 0,
        duration: 0
      });
    }
  }

  return episodes;
}

function extractEpisodesFromItem(item) {
  const fromEpisodes = extractEpisodesFromEpisodesObject(item);
  if (fromEpisodes.length > 0) return fromEpisodes;

  const fromSeasons = extractEpisodesFromSeasons(item);
  if (fromSeasons.length > 0) return fromSeasons;

  const episodes = [];
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
      const key = `${episode.season || 1}:${episode.number || 0}:${episode.translationId || episode.translationTitle || ''}`;
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

function filterAnimeResults(results) {
  return (results || []).filter(item => String(normalizeType(item) || '').toLowerCase().includes('anime'));
}

async function fetchAnimeByKey(animeKey) {
  const colonIndex = animeKey.indexOf(':');
  const kind = colonIndex > -1 ? animeKey.slice(0, colonIndex) : '';
  const value = colonIndex > -1 ? animeKey.slice(colonIndex + 1) : animeKey;

  if (kind === 'shikimori') {
    const bySearch = await kodikGet('/search', {
      shikimori_id: value,
      with_material_data: 'true',
      with_episodes: 'true',
      types: 'anime-serial,anime'
    });

    const byList = await kodikGet('/list', {
      shikimori_id: value,
      with_material_data: 'true',
      with_episodes: 'true',
      types: 'anime-serial,anime'
    });

    return filterAnimeResults([
      ...(Array.isArray(bySearch?.results) ? bySearch.results : []),
      ...(Array.isArray(byList?.results) ? byList.results : [])
    ]);
  }

  if (kind === 'kodik') {
    const bySearch = await kodikGet('/search', {
      id: value,
      with_material_data: 'true',
      with_episodes: 'true',
      types: 'anime-serial,anime'
    });

    const byList = await kodikGet('/list', {
      id: value,
      with_material_data: 'true',
      with_episodes: 'true',
      types: 'anime-serial,anime'
    });

    let combined = [
      ...(Array.isArray(bySearch?.results) ? bySearch.results : []),
      ...(Array.isArray(byList?.results) ? byList.results : [])
    ];

    const first = combined[0];
    const shikimoriId = getShikimoriId(first);

    if (shikimoriId) {
      const related = await kodikGet('/list', {
        shikimori_id: shikimoriId,
        with_material_data: 'true',
        with_episodes: 'true',
        types: 'anime-serial,anime'
      });

      combined = [
        ...combined,
        ...(Array.isArray(related?.results) ? related.results : [])
      ];
    }

    return filterAnimeResults(combined);
  }

  const params = {
    with_material_data: 'true',
    with_episodes: 'true'
  };

  if (kind === 'kinopoisk') {
    params.kinopoisk_id = value;
  } else if (kind === 'imdb') {
    params.imdb_id = value;
  } else if (kind === 'title') {
    const [titlePart, yearPart] = value.split('::');
    params.title = titlePart || '';
    if (yearPart) params.year = yearPart;
  } else {
    params.title = animeKey;
  }

  let data = await kodikGet('/search', {
    ...params,
    types: 'anime-serial,anime'
  });

  let results = Array.isArray(data?.results) ? data.results : [];

  const listData = await kodikGet('/list', {
    ...params,
    with_material_data: 'true',
    with_episodes: 'true',
    types: 'anime-serial,anime'
  });

  results = [
    ...results,
    ...(Array.isArray(listData?.results) ? listData.results : [])
  ];

  const first = results[0];
  const shikimoriId = getShikimoriId(first);

  if (shikimoriId) {
    const related = await kodikGet('/list', {
      shikimori_id: shikimoriId,
      with_material_data: 'true',
      with_episodes: 'true',
      types: 'anime-serial,anime'
    });

    results = [
      ...results,
      ...(Array.isArray(related?.results) ? related.results : [])
    ];
  }

  return filterAnimeResults(results);
}

function dedupeResults(items) {
  const map = new Map();

  for (const item of items || []) {
    const key = [
      getKodikId(item) || '',
      getShikimoriId(item) || '',
      item?.translation?.id || '',
      normalizeTitle(item),
      normalizeYear(item),
      item?.episode || item?.last_episode || ''
    ].join('|');

    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

function selectBestAnimeCard(items) {
  if (!items.length) return null;

  const sorted = [...items].sort((a, b) => {
    const aEpisodes = extractEpisodesFromItem(a).length;
    const bEpisodes = extractEpisodesFromItem(b).length;
    if (bEpisodes !== aEpisodes) return bEpisodes - aEpisodes;

    const aHasPoster = normalizePoster(a) ? 1 : 0;
    const bHasPoster = normalizePoster(b) ? 1 : 0;
    if (bHasPoster !== aHasPoster) return bHasPoster - aHasPoster;

    return String(normalizeTitle(a)).localeCompare(String(normalizeTitle(b)), 'ru');
  });

  return sorted[0];
}

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

    let data = await kodikGet('/search', {
      title: query,
      with_material_data: 'true',
      with_episodes: 'true',
      types: 'anime-serial,anime'
    });

    let results = Array.isArray(data?.results) ? data.results : [];

    const listData = await kodikGet('/list', {
      title: query,
      with_material_data: 'true',
      with_episodes: 'true',
      types: 'anime-serial,anime'
    });

    results = [
      ...results,
      ...(Array.isArray(listData?.results) ? listData.results : [])
    ];

    res.json(mapSearchResults(dedupeResults(results), query));
  } catch (error) {
    console.error('SEARCH ERROR:', error.message);
    res.status(500).json({ error: 'Не удалось выполнить поиск', details: error.message });
  }
});

app.get('/api/yummy/anime/:animeUrl', async (req, res) => {
  try {
    if (!KODIK_TOKEN) return res.status(500).json({ error: 'Нет токена' });

    const animeUrl = decodeURIComponent(req.params.animeUrl);
    let results = await fetchAnimeByKey(animeUrl);
    results = dedupeResults(results);

    if (!results.length) {
      return res.status(404).json({ error: 'Аниме не найдено' });
    }

    const first = selectBestAnimeCard(results) || results[0];
    const animeId = getStableAnimeId(first) || makeAnimeKey(first);
    const videos = mergeEpisodes(results);

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