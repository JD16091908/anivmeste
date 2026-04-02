const express = require('express');
const http = require('http');
const path = require('path');
const dns = require('dns').promises;
const { Server } = require('socket.io');

const app = express();
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3000;
const rooms = {};

const KODIK_TOKEN = process.env.KODIK_TOKEN || 'ea55976b6acc94f41f173e2c702ebf6b';
const KODIK_API_BASE = 'https://kodik-api.com';

console.log(KODIK_TOKEN ? '✅ KODIK TOKEN загружен' : '❌ KODIK TOKEN не найден');

app.use(express.static(path.join(__dirname, 'public')));

function isApiRequest(req) {
  return req.path.startsWith('/api/');
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

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
        player: item?.translation?.title || item?.translation?.name || 'kodik',
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
        player: item?.translation?.title || item?.translation?.name || 'kodik',
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
    const [searchData, listData] = await Promise.all([
      kodikGet('/search', {
        title: selected.title,
        with_material_data: 'true',
        with_episodes: 'true',
        types: 'anime-serial,anime'
      }),
      kodikGet('/list', {
        title: selected.title,
        with_material_data: 'true',
        with_episodes: 'true',
        year: selected.year || undefined,
        types: 'anime-serial,anime'
      })
    ]);

    let results = [
      ...(Array.isArray(searchData?.results) ? searchData.results : []),
      ...(Array.isArray(listData?.results) ? listData.results : [])
    ];

    return await fetchFullEpisodesForLongAnime(results);
  }

  return [];
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

io.on('connection', (socket) => {
  socket.data.lastSeekEmitAt = 0;
  socket.data.lastUserTimeEmitAt = 0;

  socket.on('join-room', ({ roomId, username, userKey }) => {
    if (!roomId || !userKey) return;

    const room = ensureRoom(roomId);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = sanitizeRoomUsername(username);
    socket.data.userKey = userKey;

    room.users = room.users.filter(u => u.id !== socket.id);

    room.users.push({
      id: socket.id,
      userKey,
      username: socket.data.username,
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
      text: `${socket.data.username} joined the room`
    });
  });

  socket.on('change-username', ({ roomId, username }) => {
    const room = rooms[roomId];
    if (!room) return;

    const newUsername = sanitizeRoomUsername(username);
    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;

    const oldUsername = user.username;
    if (oldUsername === newUsername) return;

    user.username = newUsername;
    socket.data.username = newUsername;

    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
    io.to(roomId).emit('system-message', {
      text: `${oldUsername} is now ${newUsername}`
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
      currentTime: 0,
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
    io.to(roomId).emit('system-message', { text: `Host selected: ${title}` });
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

    if (action === 'seek') {
      const now = Date.now();
      if (now - socket.data.lastSeekEmitAt < 400) return;
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

    const now = Date.now();
    if (now - socket.data.lastUserTimeEmitAt < 3500) return;
    socket.data.lastUserTimeEmitAt = now;

    const safeTime = typeof currentTime === 'number' && !Number.isNaN(currentTime) && currentTime >= 0
      ? currentTime
      : null;

    const user = room.users.find(u => u.id === socket.id);
    if (!user) return;

    user.currentTime = safeTime;
    user.timeUpdatedAt = now;

    io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
  });

  socket.on('chat-message', ({ roomId, username, message }) => {
    if (!roomId || !message?.trim()) return;

    const safeMessage = String(message).trim().slice(0, 300);
    const safeUsername = sanitizeRoomUsername(username || socket.data.username || 'Guest');

    io.to(roomId).emit('chat-message', {
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

    room.users = room.users.filter(u => u.id !== socket.id);

    if (room.creatorSocketId === socket.id) {
      room.creatorSocketId = null;
    }

    if (room.users.length > 0) {
      io.to(roomId).emit('system-message', {
        text: `${username} left the room`
      });
      io.to(roomId).emit('room-users', getUsersWithMeta(roomId));
      io.to(roomId).emit('sync-state', {
        ...getCurrentRoomState(roomId),
        isHost: false
      });
    } else {
      delete rooms[roomId];
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});