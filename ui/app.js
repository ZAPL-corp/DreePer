/* Dreeper — UI-логика */

const T = window.__TAURI__ || {};
const invoke = T.core?.invoke;
const convertFileSrc = T.core?.convertFileSrc;
const dialogApi = T.dialog;
const appWindow = T.window?.getCurrentWindow?.();

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtTotal(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function hueOf(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

const DEFAULT_SETTINGS = {
  provider: 'none',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b',
  gigachatKey: '',
  allowGenerated: true,
  seekStep: 5,
  autoplayLyrics: true,
  volume: 0.8,
  shuffle: false,
  repeat: 'off',
  lyricsOpen: true,
  muted: false,
};

const store = {
  folders: [],
  tracks: {},
  playlists: [],
  favorites: [],
  settings: { ...DEFAULT_SETTINGS },
  lyricsCache: {},
  view: 'all',
  search: '',
  lastTrack: null,
};

const audio = $('#audio');
const coverCache = new Map();
let queue = [];
let qIndex = -1;
let current = null;
let history = [];
let historyIdx = -1;
let isSeeking = false;
let lyricLines = [];
let lyricIndex = -1;
let lyricsLoading = false;
let lyricsShownFor = null;
let saveTimer = null;
let rafId = null;

/* ============ базовое состояние ============ */

function trackIndex() {
  const map = new Map();
  for (const list of Object.values(store.tracks)) {
    for (const t of list) if (!map.has(t.path)) map.set(t.path, t);
  }
  return map;
}

function allTracks() {
  return Array.from(trackIndex().values()).sort((a, b) => {
    const aa = (a.artist || '').toLowerCase();
    const bb = (b.artist || '').toLowerCase();
    if (aa !== bb) return aa < bb ? -1 : 1;
    const al = (a.album || '').toLowerCase();
    const bl = (b.album || '').toLowerCase();
    if (al !== bl) return al < bl ? -1 : 1;
    if (a.discNo !== b.discNo) return (a.discNo || 0) - (b.discNo || 0);
    if (a.trackNo !== b.trackNo) return (a.trackNo || 0) - (b.trackNo || 0);
    return (a.title || '').localeCompare(b.title || '');
  });
}

function favoriteSet() {
  return new Set(store.favorites);
}

function playlistTracks(id) {
  const pl = store.playlists.find((p) => p.id === id);
  if (!pl) return [];
  const idx = trackIndex();
  return pl.tracks.map((p) => idx.get(p)).filter(Boolean);
}

function viewTracks() {
  const v = store.view;
  if (v === 'all') return allTracks();
  if (v === 'favorites') {
  const fav = favoriteSet();
  const hasAlbum = list.some((t) => (t.album || '').trim());
  document.body.dataset.noAlbum = hasAlbum ? '0' : '1';
    return allTracks().filter((t) => fav.has(t.path));
  }
  if (v.startsWith('folder:')) return store.tracks[v.slice(7)] || [];
  if (v.startsWith('playlist:')) return playlistTracks(v.slice(9));
  return [];
}

function filteredTracks() {
  const list = viewTracks();
  const q = store.search.trim().toLowerCase();
  if (!q) return list;
  return list.filter((t) =>
    `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)
  );
}

function aiConfig() {
  const s = store.settings;
  return {
    provider: s.provider,
    ollamaUrl: s.ollamaUrl,
    ollamaModel: s.ollamaModel,
    gigachatKey: s.gigachatKey,
    allowGenerated: !!s.allowGenerated,
  };
}

function snapshot() {
  return {
    folders: store.folders,
    tracks: store.tracks,
    playlists: store.playlists,
    favorites: store.favorites,
    settings: store.settings,
    lyricsCache: trimCache(store.lyricsCache),
    view: store.view,
    lastTrack: store.lastTrack,
  };
}

function trimCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= 240) return cache;
  const keep = keys.slice(-240);
  const out = {};
  for (const k of keep) out[k] = cache[k];
  return out;
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}

async function saveNow() {
  if (!invoke) return;
  try {
    await invoke('save_state', { state: snapshot() });
  } catch (e) {
    console.warn('save_state', e);
  }
}

/* ============ уведомления ============ */

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ============ инициализация ============ */

async function boot() {
  if (invoke) {
    try {
      const saved = await invoke('load_state');
      if (saved && typeof saved === 'object') {
        store.folders = Array.isArray(saved.folders) ? saved.folders : [];
        store.tracks = saved.tracks && typeof saved.tracks === 'object' ? saved.tracks : {};
        store.playlists = Array.isArray(saved.playlists) ? saved.playlists : [];
        store.favorites = Array.isArray(saved.favorites) ? saved.favorites : [];
        store.settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
        store.lyricsCache = saved.lyricsCache && typeof saved.lyricsCache === 'object' ? saved.lyricsCache : {};
        store.view = typeof saved.view === 'string' ? saved.view : 'all';
        store.lastTrack = saved.lastTrack || null;
      }
    } catch (e) {
      console.warn('load_state', e);
    }
  }

  // чистим ссылки на несуществующие папки/плейлисты
  store.playlists = store.playlists.map((p) => ({ ...p, tracks: Array.isArray(p.tracks) ? p.tracks : [] }));

  audio.volume = clamp(Number(store.settings.volume) || 0.8, 0, 1);
  audio.muted = !!store.settings.muted;
  document.body.classList.toggle('no-lyrics', !store.settings.lyricsOpen);

  if (!isValidView(store.view)) store.view = 'all';

  bindUi();
  bindAudio();
  bindHotkeys();
  bindDrop();
  render();
  updateVolumeUi();

  if (store.settings.lyricsOpen === false) $('#btnLyricsToggle')?.classList.remove('active');

  if (!store.folders.length) {
    setLyricsPlaceholder();
  }
  if (store.lastTrack) {
    const t = trackIndex().get(store.lastTrack);
    if (t) {
      loadTrack(t, false);
      toast('Готово. Нажмите Space, чтобы продолжить');
    }
  }
}

function isValidView(v) {
  if (v === 'all' || v === 'favorites') return true;
  if (v.startsWith('folder:')) return store.folders.some((f) => f.id === v.slice(7));
  if (v.startsWith('playlist:')) return store.playlists.some((p) => p.id === v.slice(9));
  return false;
}

/* ============ сайдбар ============ */

function renderSidebar() {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === store.view));

  const folders = $('#folderList');
  if (!store.folders.length) {
    folders.innerHTML = `<div class="side-empty">Папок пока нет. Нажмите «Добавить папку» или перетащите папку в окно.</div>`;
  } else {
    folders.innerHTML = store.folders
      .map((f) => {
        const n = (store.tracks[f.id] || []).length;
        const active = store.view === `folder:${f.id}` ? ' active' : '';
        return `<div class="side-item${active}" data-folder="${esc(f.id)}" title="${esc(f.path)}">
          <div class="si-ico"><svg><use href="#i-folder"/></svg></div>
          <div class="si-text"><div class="si-name">${esc(f.name)}</div><div class="si-sub">${n} трек${plural(n, '', 'а', 'ов')}</div></div>
          <button class="si-more" data-folder-menu="${esc(f.id)}" title="Ещё"><svg><use href="#i-dots"/></svg></button>
        </div>`;
      })
      .join('');
  }

  const pls = $('#playlistList');
  if (!store.playlists.length) {
    pls.innerHTML = `<div class="side-empty">Создайте плейлист кнопкой «+» и складывайте в него треки.</div>`;
  } else {
    pls.innerHTML = store.playlists
      .map((p) => {
        const active = store.view === `playlist:${p.id}` ? ' active' : '';
        return `<div class="side-item${active}" data-playlist="${esc(p.id)}">
          <div class="si-ico"><svg><use href="#i-list"/></svg></div>
          <div class="si-text"><div class="si-name">${esc(p.name)}</div><div class="si-sub">${p.tracks.length} трек${plural(p.tracks.length, '', 'а', 'ов')}</div></div>
          <button class="si-more" data-playlist-menu="${esc(p.id)}" title="Ещё"><svg><use href="#i-dots"/></svg></button>
        </div>`;
      })
      .join('');
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ============ главная область ============ */

function viewInfo() {
  const v = store.view;
  if (v === 'all') return { kind: 'Библиотека', title: 'Все треки', icon: '#i-music', kindKey: 'all' };
  if (v === 'favorites') return { kind: 'Коллекция', title: 'Избранное', icon: '#i-heart', kindKey: 'favorites' };
  if (v.startsWith('folder:')) {
    const f = store.folders.find((x) => x.id === v.slice(7));
    return { kind: 'Папка', title: f ? f.name : 'Папка', icon: '#i-folder', kindKey: 'folder', folder: f };
  }
  if (v.startsWith('playlist:')) {
    const p = store.playlists.find((x) => x.id === v.slice(9));
    return { kind: 'Плейлист', title: p ? p.name : 'Плейлист', icon: '#i-list', kindKey: 'playlist', playlist: p };
  }
  return { kind: 'Библиотека', title: 'Все треки', icon: '#i-music', kindKey: 'all' };
}

function renderMain() {
  const info = viewInfo();
  const list = filteredTracks();
  const total = list.reduce((s, t) => s + (t.duration || 0), 0);

  document.body.dataset.viewKind = info.kindKey;
  $('#vhKind').textContent = info.kind;
  $('#vhTitle').textContent = info.title;
  $('#vhArt').innerHTML = `<svg><use href="${info.icon}"/></svg>`;

  const metaParts = [];
  metaParts.push(`<b>${list.length}</b> трек${plural(list.length, '', 'а', 'ов')}`);
  if (total > 0) metaParts.push(`<span class="dot"></span><span>${fmtTotal(total)}</span>`);
  if (store.search.trim()) metaParts.push(`<span class="dot"></span><span>фильтр: «${esc(store.search.trim())}»</span>`);
  $('#vhMeta').innerHTML = metaParts.join(' ');

  $('#btnRescan').classList.toggle('hidden', !info.folder);
  $('#btnRenamePl').classList.toggle('hidden', !info.playlist);
  $('#btnDeletePl').classList.toggle('hidden', !info.playlist);
  $('#btnPlayView').disabled = list.length === 0;

  const tableHead = $('#tableHead');
  const empty = $('#emptyState');
  const rows = $('#trackList');

  if (!list.length) {
    tableHead.classList.add('hidden');
    rows.innerHTML = '';
    empty.classList.remove('hidden');
    empty.innerHTML = emptyMarkup(info);
    return;
  }

  tableHead.classList.remove('hidden');
  empty.classList.add('hidden');

  const fav = favoriteSet();
  const isPlayingList = queue.length && current;
  rows.innerHTML = list
    .map((t, i) => {
      const active = current && t.path === current.path;
      const playingCls = active ? ` playing${audio.paused ? ' paused' : ''}` : '';
      const favCls = fav.has(t.path) ? ' active' : '';
      return `<div class="track-row${playingCls}" data-path="${esc(t.path)}" data-idx="${i}" style="animation-delay:${Math.min(i, 20) * 8}ms">
        <div class="tr-idx">
          <span class="idx-num">${i + 1}</span>
          <span class="idx-play"><svg><use href="#i-play"/></svg></span>
          <div class="eq"><i></i><i></i><i></i><i></i></div>
        </div>
        <div class="tr-main">
          <div class="row-art" style="--h:${hueOf(t.path)}" data-cover="${esc(t.path)}"><svg><use href="#i-music"/></svg></div>
          <div class="tr-text">
            <div class="tr-title" title="${esc(t.title)}">${esc(t.title)}</div>
            <div class="tr-sub">${esc(t.ext.toUpperCase())}${t.size ? ' · ' + (t.size / 1048576).toFixed(1) + ' МБ' : ''}</div>
          </div>
        </div>
        <div class="tr-artist" title="${esc(t.artist)}">${esc(t.artist || '—')}</div>
        <div class="tr-album" title="${esc(t.album)}">${esc(t.album || '—')}</div>
        <button class="tr-fav${favCls}" data-fav="${esc(t.path)}" title="В избранное"><svg><use href="#i-heart"/></svg></button>
        <div class="tr-dur">${fmtTime(t.duration)}</div>
        <button class="tr-more" data-menu="${esc(t.path)}" title="Ещё"><svg><use href="#i-dots"/></svg></button>
      </div>`;
    })
    .join('');

  void isPlayingList;
  hydrateCovers(rows);
}

function emptyMarkup(info) {
  if (store.search.trim()) {
    return `<h3>Ничего не нашлось</h3><p>По запросу «${esc(store.search.trim())}» в этом разделе пусто. Попробуйте другое слово.</p>
      <button class="ghost-btn" id="emptyClearSearch">Сбросить поиск</button>`;
  }
  if (!store.folders.length) {
    return `<h3>Здесь будет музыка</h3>
      <p>Добавьте папку с треками — Dreeper прочитает теги, обложки и длительность. Поддерживаются MP3, FLAC, WAV, M4A, OGG, OPUS и другие форматы.</p>
      <button class="primary-btn" id="emptyAddFolder">Добавить папку</button>`;
  }
  if (info.kindKey === 'favorites') {
    return `<h3>В избранном пусто</h3><p>Нажмите ♥ у трека в списке — он появится здесь.</p>`;
  }
  if (info.kindKey === 'playlist') {
    return `<h3>Плейлист пуст</h3><p>Откройте «Все треки», нажмите «⋯» у нужного трека и добавьте его в этот плейлист.</p>`;
  }
  return `<h3>В этой папке нет аудиофайлов</h3><p>Проверьте содержимое папки или добавьте другую.</p>`;
}

/* ---- ленивые обложки ---- */
let coverQueue = [];
let coverWorkers = 0;

function hydrateCovers(root) {
  const els = $$('[data-cover]', root);
  for (const el of els) {
    const path = el.dataset.cover;
    if (coverCache.has(path)) {
      applyCover(el, coverCache.get(path));
    } else {
      coverQueue.push(el);
    }
  }
  pumpCovers();
}

function pumpCovers() {
  while (coverWorkers < 4 && coverQueue.length) {
    const el = coverQueue.shift();
    if (!el.isConnected) continue;
    if (coverCache.has(el.dataset.cover)) {
      applyCover(el, coverCache.get(el.dataset.cover));
      continue;
    }
    coverWorkers++;
    getCover(el.dataset.cover).finally(() => {
      coverWorkers--;
      pumpCovers();
    });
  }
}

async function getCover(path) {
  if (coverCache.has(path)) return coverCache.get(path);
  let url = '';
  if (invoke) {
    try {
      url = (await invoke('cover', { path })) || '';
    } catch (_) {
      url = '';
    }
  }
  coverCache.set(path, url);
  for (const el of $$(`[data-cover="${cssEscape(path)}"]`)) applyCover(el, url);
  if (current && current.path === path) applyCover($('#plArt'), url);
  return url;
}

function applyCover(el, url) {
  if (!el || !url || el.dataset.done === '1') return;
  el.dataset.done = '1';
  el.innerHTML = `<img src="${url}" alt="">`;
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

/* ============ плеер ============ */

function setQueue(list, index, { play = true } = {}) {
  queue = list.slice();
  qIndex = index;
  const t = queue[qIndex];
  if (t) loadTrack(t, play);
}

function loadTrack(track, play = true) {
  const same = current && current.path === track.path;
  current = track;
  store.lastTrack = track.path;

  if (!same) {
    audio.src = convertFileSrc ? convertFileSrc(track.path) : '';
    audio.load();
    lyricsShownFor = null;
    renderLyricsFor(track);
    if (store.settings.autoplayLyrics) loadLyrics(track);
  }

  updatePlayerUi();
  markPlayingRow();
  if (play) {
    audio.play().catch((e) => console.warn('play', e));
  }
  saveSoon();
}

function updatePlayerUi() {
  const t = current;
  $('#plTitle').textContent = t ? t.title : 'Ничего не играет';
  $('#plArtist').textContent = t ? t.artist || '—' : 'Добавьте папку с музыкой';
  $('#lyTrack').textContent = t ? `${t.title} — ${t.artist || 'неизвестный исполнитель'}` : 'Ничего не играет';

  const art = $('#plArt');
  art.innerHTML = `<svg><use href="#i-music"/></svg>`;
  if (t) {
    art.style.setProperty('--h', hueOf(t.path));
    getCover(t.path);
  }

  const isFav = t && favoriteSet().has(t.path);
  $('#btnFav').classList.toggle('active', !!isFav);
  $('#btnFav').classList.toggle('off', !t);

  const playing = !audio.paused && current;
  $('#btnPlay').innerHTML = `<svg><use href="#i-${playing ? 'pause' : 'play'}"/></svg>`;
  $('#btnShuffle').classList.toggle('active', !!store.settings.shuffle);
  $('#btnRepeat').classList.toggle('active', store.settings.repeat !== 'off');
  $('#btnRepeat').title = `Повтор: ${repeatLabel(store.settings.repeat)} (R)`;
  $('#btnRepeat').innerHTML = `<svg><use href="#i-repeat"/></svg>`;
  document.title = t ? `${t.title} · Dreeper` : 'Dreeper';
}

function repeatLabel(mode) {
  return mode === 'one' ? 'трек' : mode === 'all' ? 'весь список' : 'выключен';
}

function markPlayingRow() {
  $$('.track-row').forEach((row) => {
    const on = current && row.dataset.path === current.path;
    row.classList.toggle('playing', !!on);
    row.classList.toggle('paused', !on || audio.paused);
  });
}

function playView(shuffle = false) {
  const list = filteredTracks();
  if (!list.length) return;
  const items = list.slice();
  if (shuffle || store.settings.shuffle) shuffleArray(items);
  setQueue(items, 0);
}

function shuffleArray(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextTrack(user = false) {
  if (!queue.length) {
    if (user) {
      const list = filteredTracks();
      if (list.length) {
        queue = list.slice();
        qIndex = 0;
        loadTrack(queue[0]);
      }
    }
    return;
  }
  if (store.settings.repeat === 'one' && !user) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (store.settings.shuffle && queue.length > 1) {
    let idx = qIndex;
    while (idx === qIndex) idx = Math.floor(Math.random() * queue.length);
    qIndex = idx;
  } else {
    qIndex++;
    if (qIndex >= queue.length) qIndex = 0;
  }
  loadTrack(queue[qIndex]);
}

function prevTrack() {
  if (!queue.length) return;
  if (audio.currentTime > 3.5) {
    audio.currentTime = 0;
    return;
  }
  qIndex = (qIndex - 1 + queue.length) % queue.length;
  loadTrack(queue[qIndex]);
}

function togglePlay() {
  if (!current) {
    playView();
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

/* ============ обновление прогресса ============ */

function updateProgress() {
  const dur = audio.duration || (current?.duration ?? 0);
  const cur = audio.currentTime || 0;
  const ratio = dur > 0 ? clamp(cur / dur, 0, 1) : 0;
  $('#seekFill').style.width = `${ratio * 100}%`;
  $('#seekKnob').style.left = `${ratio * 100}%`;
  $('#curTime').textContent = fmtTime(cur);
  $('#durTime').textContent = dur > 0 ? fmtTime(dur) : '0:00';

  try {
    const buf = audio.buffered;
    if (buf.length && dur > 0) {
      $('#seekBuffer').style.width = `${clamp(buf.end(buf.length - 1) / dur, 0, 1) * 100}%`;
    }
  } catch (_) {}

  syncLyrics(cur);
}

function tick() {
  updateProgress();
  rafId = audio.paused ? null : requestAnimationFrame(tick);
}

function startTick() {
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function updateVolumeUi() {
  const v = audio.muted ? 0 : audio.volume;
  $('#volFill').style.width = `${v * 100}%`;
  $('#volKnob').style.left = `${v * 100}%`;
  $('#btnMute').innerHTML = `<svg><use href="#i-${audio.muted || v === 0 ? 'mute' : 'volume'}"/></svg>`;
}

/* ============ текст песни ============ */

function setLyricsPlaceholder() {
  $('#lyBadges').innerHTML = '';
  $('#lyBody').innerHTML = `<div class="ly-state"><b>Ничего не играет</b>
    <span>Включите трек — Dreeper найдёт текст в открытых базах, а ИИ-агент поможет уточнить название.</span></div>`;
  $('#lyFoot').innerHTML = '';
}

function renderLyricsFor(track) {
  if (!track) {
    setLyricsPlaceholder();
    return;
  }
  if (lyricsShownFor === track.path) return;
  const cached = store.lyricsCache[track.path];
  if (cached) {
    lyricsShownFor = track.path;
    renderLyrics(track, cached);
  } else if (!lyricsLoading) {
    $('#lyBadges').innerHTML = '';
    $('#lyTrack').textContent = `${track.title} — ${track.artist || 'неизвестный исполнитель'}`;
    $('#lyBody').innerHTML = `<div class="skeleton"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>`;
    $('#lyFoot').innerHTML = '';
  }
}

async function loadLyrics(track, force = false) {
  if (!track || !invoke) {
    if (track) {
      $('#lyBody').innerHTML = `<div class="ly-state"><b>Тексты недоступны</b><span>Приложение запущено без доступа к бэкенду.</span></div>`;
    }
    return;
  }
  if (!force && store.lyricsCache[track.path]) {
    renderLyrics(track, store.lyricsCache[track.path]);
    return;
  }

  lyricsLoading = true;
  lyricsShownFor = track.path;
  $('#lyBadges').innerHTML = '';
  $('#lyTrack').textContent = `${track.title} — ${track.artist || 'неизвестный исполнитель'}`;
  $('#lyBody').innerHTML = `<div class="skeleton"><span></span><span></span><span></span><span></span><span></span><span></span></div>`;
  $('#lyFoot').innerHTML = `<span>Ищу текст…</span>`;

  let result;
  try {
    result = await invoke('lyrics_lookup', {
      query: {
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        duration: Number(track.duration) || 0,
      },
      ai: aiConfig(),
      force,
    });
  } catch (e) {
    result = { status: 'error', source: '', plain: '', synced: '', matched: '', note: String(e), instrumental: false, provider: '' };
  }

  lyricsLoading = false;
  if (result && result.status === 'ok') {
    store.lyricsCache[track.path] = result;
    saveSoon();
  }
  if (current && current.path === track.path) renderLyrics(track, result || {});
}

function renderLyrics(track, data) {
  const badges = [];
  const sourceName = { lrclib: 'LRCLIB', lyricsovh: 'Lyrics.ovh', ai: 'ИИ' }[data.source] || '';
  if (sourceName) {
    const cls = data.source === 'ai' ? 'badge ai' : 'badge acc';
    badges.push(`<span class="${cls}">${esc(sourceName)}</span>`);
  }
  if (data.synced && data.synced.trim()) badges.push(`<span class="badge"><svg><use href="#i-clock"/></svg>синхронизировано</span>`);
  if (data.instrumental) badges.push(`<span class="badge warn">инструментал</span>`);
  if (data.provider) badges.push(`<span class="badge ai">${esc(data.provider)}</span>`);
  $('#lyBadges').innerHTML = badges.join('');

  const body = $('#lyBody');
  lyricLines = [];
  lyricIndex = -1;

  if (!data || data.status !== 'ok') {
    const notFound = !data || data.status === 'notfound';
    body.innerHTML = `<div class="ly-state">
      <b>${notFound ? 'Текст не найден' : 'Не удалось получить текст'}</b>
      <span>${esc(data?.note || 'Проверьте подключение к интернету и попробуйте ещё раз.')}</span>
      <div class="btn-row">
        <button class="ghost-btn" data-lyr-retry>Попробовать снова</button>
        ${store.settings.provider !== 'none' ? `<button class="ghost-btn" data-lyr-ai><svg><use href="#i-sparkles"/></svg>Спросить ${esc(providerLabel())}</button>` : `<button class="ghost-btn" data-lyr-settings><svg><use href="#i-settings"/></svg>Подключить ИИ</button>`}
      </div>
    </div>`;
    $('#lyFoot').innerHTML = data?.note ? `<span>${esc(data.note)}</span>` : '';
    return;
  }

  if (data.instrumental) {
    body.innerHTML = `<div class="ly-state"><b>Инструментальная композиция</b><span>Текста у этого трека нет — только музыка.</span></div>`;
    $('#lyFoot').innerHTML = `<span>${esc(data.matched || '')}</span>`;
    return;
  }

  const synced = parseLrc(data.synced || '');
  if (synced.length) {
    lyricLines = synced;
    body.innerHTML = synced
      .map((l, i) => `<div class="ly-line" data-i="${i}" data-t="${l.t}">${esc(l.text)}</div>`)
      .join('');
  } else {
    const plain = (data.plain || '').trim();
    body.innerHTML = `<div class="ly-plain">${esc(plain)}</div>`;
  }

  const sourceLine = data.matched
    ? `Найдено: ${data.matched}`
    : data.source === 'ai'
      ? 'Справка от ИИ'
      : 'Текст без синхронизации';
  $('#lyFoot').innerHTML = `
    <span title="${esc(data.note || '')}">${esc(sourceLine)}</span>
    ${syncAvailable() ? `<button class="autoscroll on" data-lyr-autoscroll title="Автопрокрутка"><svg><use href="#i-check"/></svg>Авто</button>` : ''}`;

  body.scrollTop = 0;
  syncLyrics(audio.currentTime || 0);
}

function providerLabel() {
  const s = store.settings;
  if (s.provider === 'ollama') return s.ollamaModel || 'Ollama';
  if (s.provider === 'gigachat') return 'GigaChat';
  return 'ИИ';
}

function syncAvailable() {
  return lyricLines.length > 0;
}

function parseLrc(text) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const times = [];
    const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
      times.push(min * 60 + sec + frac);
    }
    const label = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!times.length) continue;
    for (const t of times) out.push({ t, text: label });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function syncLyrics(time) {
  if (!lyricLines.length) return;
  let idx = -1;
  for (let i = 0; i < lyricLines.length; i++) {
    if (lyricLines[i].t <= time + 0.15) idx = i;
    else break;
  }
  if (idx === lyricIndex) return;
  lyricIndex = idx;

  const els = $$('.ly-line', $('#lyBody'));
  els.forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.classList.toggle('passed', i < idx);
  });

  const el = els[idx];
  if (el) {
    const body = $('#lyBody');
    const target = el.offsetTop - body.clientHeight / 2 + el.clientHeight / 2;
    body.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
}

/* ============ импорт ============ */

async function addFolders() {
  if (!dialogApi) {
    toast('Выбор папок доступен только в приложении');
    return;
  }
  let picked;
  try {
    picked = await dialogApi.open({ directory: true, multiple: true, title: 'Выберите папку с музыкой' });
  } catch (e) {
    toast('Не удалось открыть диалог: ' + e);
    return;
  }
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  for (const p of paths) await importFolder(p);
}

async function importFolder(path, opts = {}) {
  const name = path.split(/[\\/]/).filter(Boolean).pop() || 'Папка';
  const existing = store.folders.find((f) => f.path.toLowerCase() === path.toLowerCase());

  if (!invoke) {
    toast('Сканирование доступно только в приложении');
    return;
  }

  toast(`Сканирую «${name}»…`);
  let tracks;
  try {
    tracks = await invoke('scan_folder', { path });
  } catch (e) {
    toast(`Не удалось прочитать папку: ${e}`);
    return;
  }

  let folder = existing;
  if (!folder) {
    folder = { id: uid(), name, path, addedAt: Date.now() };
    store.folders.push(folder);
  }
  store.tracks[folder.id] = tracks;
  saveSoon();
  renderSidebar();
  renderMain();

  if (opts.open !== false) go(`folder:${folder.id}`);
  toast(tracks.length ? `«${name}»: ${tracks.length} трек${plural(tracks.length, '', 'а', 'ов')}` : `В «${name}» не нашлось аудиофайлов`);
}

async function rescanFolder(folder) {
  if (!folder) return;
  toast(`Обновляю «${folder.name}»…`);
  try {
    const tracks = await invoke('scan_folder', { path: folder.path });
    store.tracks[folder.id] = tracks;
    saveSoon();
    renderMain();
    renderSidebar();
    toast(`Готово: ${tracks.length} трек${plural(tracks.length, '', 'а', 'ов')}`);
  } catch (e) {
    toast('Ошибка: ' + e);
  }
}

function removeFolder(id) {
  const f = store.folders.find((x) => x.id === id);
  if (!f) return;
  store.folders = store.folders.filter((x) => x.id !== id);
  delete store.tracks[id];
  if (store.view === `folder:${id}`) go('all');
  saveSoon();
  render();
  toast(`«${f.name}» убрана из библиотеки`);
}

/* ============ плейлисты ============ */

async function createPlaylist(name, paths = []) {
  const pl = { id: uid(), name: name || 'Новый плейлист', tracks: paths.slice(), createdAt: Date.now() };
  store.playlists.push(pl);
  saveSoon();
  renderSidebar();
  go(`playlist:${pl.id}`);
  return pl;
}

async function addToPlaylist(plId, path) {
  const pl = store.playlists.find((p) => p.id === plId);
  if (!pl) return;
  if (pl.tracks.includes(path)) {
    toast('Трек уже в плейлисте');
    return;
  }
  pl.tracks.push(path);
  saveSoon();
  renderSidebar();
  if (store.view === `playlist:${plId}`) renderMain();
  toast(`Добавлено в «${pl.name}»`);
}

function removeFromPlaylist(plId, path) {
  const pl = store.playlists.find((p) => p.id === plId);
  if (!pl) return;
  pl.tracks = pl.tracks.filter((p) => p !== path);
  saveSoon();
  renderMain();
  renderSidebar();
}

/* ============ навигация ============ */

function go(view, { push = true } = {}) {
  if (!isValidView(view)) view = 'all';
  store.view = view;
  if (push) {
    history = history.slice(0, historyIdx + 1);
    history.push(view);
    historyIdx = history.length - 1;
  }
  saveSoon();
  renderSidebar();
  renderMain();
  $('#mainScroll').scrollTop = 0;
  updateNavButtons();
}

function updateNavButtons() {
  $('#navBack').disabled = historyIdx <= 0;
  $('#navFwd').disabled = historyIdx >= history.length - 1;
  $('#navBack').style.opacity = historyIdx <= 0 ? 0.4 : 1;
  $('#navFwd').style.opacity = historyIdx >= history.length - 1 ? 0.4 : 1;
}

/* ============ меню ============ */

function closeCtx() {
  const m = $('#ctxMenu');
  m.classList.add('hidden');
  m.innerHTML = '';
}

function openCtx(x, y, html) {
  const m = $('#ctxMenu');
  m.innerHTML = html;
  m.classList.remove('hidden');
  const rect = m.getBoundingClientRect();
  m.style.left = `${clamp(x, 8, window.innerWidth - rect.width - 8)}px`;
  m.style.top = `${clamp(y, 8, window.innerHeight - rect.height - 8)}px`;
}

function trackMenu(path) {
  const t = trackIndex().get(path);
  if (!t) return;
  const isFav = favoriteSet().has(path);
  const inPlaylist = store.view.startsWith('playlist:') ? store.view.slice(9) : null;
  const playlists = store.playlists
    .map((p) => `<button data-add-to="${esc(p.id)}" data-add-path="${esc(path)}"><svg><use href="#i-list"/></svg>${esc(p.name)}</button>`)
    .join('');

  return `<button data-act="play" data-p="${esc(path)}"><svg><use href="#i-play"/></svg>Воспроизвести</button>
    <button data-act="lyrics" data-p="${esc(path)}"><svg><use href="#i-list"/></svg>Показать текст</button>
    <button data-act="fav" data-p="${esc(path)}"><svg><use href="#i-heart"/></svg>${isFav ? 'Убрать из избранного' : 'В избранное'}</button>
    <div class="ctx-sep"></div>
    <div class="ctx-label">Добавить в плейлист</div>
    <div class="ctx-scroll">${playlists || '<div class="side-empty">Плейлистов пока нет</div>'}</div>
    <button data-act="newpl" data-p="${esc(path)}"><svg><use href="#i-plus"/></svg>Новый плейлист…</button>
    ${inPlaylist ? `<div class="ctx-sep"></div><button class="danger" data-act="unpl" data-p="${esc(path)}" data-pl="${esc(inPlaylist)}"><svg><use href="#i-trash"/></svg>Убрать из плейлиста</button>` : ''}`;
}

function folderMenu(id) {
  return `<button data-act="open-folder" data-p="${esc(id)}"><svg><use href="#i-list"/></svg>Открыть</button>
    <button data-act="rescan-folder" data-p="${esc(id)}"><svg><use href="#i-refresh"/></svg>Обновить</button>
    <div class="ctx-sep"></div>
    <button class="danger" data-act="remove-folder" data-p="${esc(id)}"><svg><use href="#i-trash"/></svg>Убрать из библиотеки</button>`;
}

function playlistMenu(id) {
  return `<button data-act="open-playlist" data-p="${esc(id)}"><svg><use href="#i-list"/></svg>Открыть</button>
    <button data-act="rename-playlist" data-p="${esc(id)}"><svg><use href="#i-pencil"/></svg>Переименовать</button>
    <div class="ctx-sep"></div>
    <button class="danger" data-act="delete-playlist" data-p="${esc(id)}"><svg><use href="#i-trash"/></svg>Удалить плейлист</button>`;
}

function handleCtxAction(btn) {
  const act = btn.dataset.act;
  const path = btn.dataset.p;
  const plId = btn.dataset.pl;
  const addTo = btn.dataset.addTo;
  const addPath = btn.dataset.addPath;

  if (addTo && addPath) {
    addToPlaylist(addTo, addPath);
    closeCtx();
    return;
  }

  switch (act) {
    case 'play': {
      const list = filteredTracks();
      const idx = list.findIndex((t) => t.path === path);
      if (idx >= 0) setQueue(list, idx);
      else {
        const t = trackIndex().get(path);
        if (t) setQueue([t], 0);
      }
      break;
    }
    case 'lyrics': {
      const t = trackIndex().get(path);
      if (t) {
        const list = filteredTracks();
        const idx = list.findIndex((x) => x.path === path);
        setQueue(idx >= 0 ? list : [t], Math.max(0, idx));
        setLyricsOpen(true);
        if (store.settings.autoplayLyrics === false) loadLyrics(t, true);
      }
      break;
    }
    case 'fav':
      toggleFavorite(path);
      break;
    case 'newpl': {
      const name = awaitText('Новый плейлист', '').then(async (n) => {
        if (n === null) return;
        const pl = await createPlaylist(n || 'Новый плейлист');
        if (path) addToPlaylist(pl.id, path);
        go(store.view);
      });
      void name;
      break;
    }
    case 'unpl':
      removeFromPlaylist(plId, path);
      break;
    case 'open-folder':
      go(`folder:${path}`);
      break;
    case 'rescan-folder':
      rescanFolder(store.folders.find((f) => f.id === path));
      break;
    case 'remove-folder':
      removeFolder(path);
      break;
    case 'open-playlist':
      go(`playlist:${path}`);
      break;
    case 'rename-playlist': {
      const pl = store.playlists.find((p) => p.id === path);
      if (!pl) break;
      awaitText('Название плейлиста', pl.name).then((v) => {
        if (v === null) return;
        pl.name = v.trim() || pl.name;
        saveSoon();
        renderSidebar();
        renderMain();
      });
      break;
    }
    case 'delete-playlist': {
      const pl = store.playlists.find((p) => p.id === path);
      if (!pl) break;
      store.playlists = store.playlists.filter((p) => p.id !== path);
      if (store.view === `playlist:${path}`) go('all');
      saveSoon();
      renderSidebar();
      renderMain();
      toast(`Плейлист «${pl.name}» удалён`);
      break;
    }
  }
  closeCtx();
}

/* ============ избранное ============ */

function toggleFavorite(path) {
  const set = new Set(store.favorites);
  if (set.has(path)) {
    set.delete(path);
    toast('Убрано из избранного');
  } else {
    set.add(path);
    toast('Добавлено в избранное');
  }
  store.favorites = Array.from(set);
  saveSoon();
  const isFav = set.has(path);
  $$(`[data-fav="${cssEscape(path)}"]`).forEach((b) => b.classList.toggle('active', isFav));
  if (current && current.path === path) {
    $('#btnFav').classList.toggle('active', isFav);
    $('#btnFav').classList.remove('off');
  }
  if (store.view === 'favorites') renderMain();
}

/* ============ текст: панель ============ */

function setLyricsOpen(open) {
  store.settings.lyricsOpen = open;
  document.body.classList.toggle('no-lyrics', !open);
  $('#btnLyricsToggle').classList.toggle('active', open);
  saveSoon();
}

/* ============ модалки ============ */

function showModal(id) {
  $(id).classList.remove('hidden');
}
function hideModal(id) {
  $(id).classList.add('hidden');
}
function hideAllModals() {
  $$('.modal').forEach((m) => m.classList.add('hidden'));
}

function awaitText(title, initial) {
  return new Promise((resolve) => {
    $('#promptTitle').textContent = title;
    const input = $('#promptInput');
    input.value = initial || '';
    showModal('#promptModal');
    setTimeout(() => {
      input.focus();
      input.select();
    }, 40);

    const done = (v) => {
      hideModal('#promptModal');
      $('#promptOk').removeEventListener('click', onOk);
      input.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onOk = () => done(input.value);
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      }
      e.stopPropagation();
    };
    $('#promptOk').addEventListener('click', onOk);
    input.addEventListener('keydown', onKey);
  });
}

function openSettings() {
  const s = store.settings;
  $('#setProvider').value = s.provider;
  $('#setOllamaUrl').value = s.ollamaUrl || '';
  $('#setOllamaModel').value = s.ollamaModel || '';
  $('#setGigaKey').value = s.gigachatKey || '';
  $('#setAllowGen').checked = !!s.allowGenerated;
  $('#setSeekStep').value = s.seekStep || 5;
  $('#setAutoplayLyrics').checked = !!s.autoplayLyrics;
  $('#aiTestResult').textContent = '';
  syncProviderFields();
  $('#infoFolders').textContent = store.folders.length;
  $('#infoTracks').textContent = allTracks().length;
  $('#infoPlaylists').textContent = store.playlists.length;
  if (invoke) {
    invoke('state_dir').then((p) => {
      $('#infoStateDir').textContent = p || '—';
    }).catch(() => {});
  }
  showModal('#settingsModal');
}

function syncProviderFields() {
  const p = $('#setProvider').value;
  $('#ollamaFields').classList.toggle('hidden', p !== 'ollama');
  $('#gigaFields').classList.toggle('hidden', p !== 'gigachat');
}

function saveSettings() {
  const s = store.settings;
  s.provider = $('#setProvider').value;
  s.ollamaUrl = $('#setOllamaUrl').value.trim() || DEFAULT_SETTINGS.ollamaUrl;
  s.ollamaModel = $('#setOllamaModel').value.trim();
  s.gigachatKey = $('#setGigaKey').value.trim();
  s.allowGenerated = $('#setAllowGen').checked;
  s.seekStep = clamp(parseInt($('#setSeekStep').value, 10) || 5, 1, 60);
  s.autoplayLyrics = $('#setAutoplayLyrics').checked;
  saveSoon();
  hideModal('#settingsModal');
  toast('Настройки сохранены');
  if (current && s.autoplayLyrics && !store.lyricsCache[current.path]) loadLyrics(current);
}

/* ============ события интерфейса ============ */

function bindUi() {
  // окно
  $('#winMin')?.addEventListener('click', () => appWindow?.minimize());
  $('#winMax')?.addEventListener('click', () => appWindow?.toggleMaximize());
  $('#winClose')?.addEventListener('click', () => appWindow?.close());
  $('#titlebar')?.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input')) return;
    appWindow?.toggleMaximize();
  });

  // навигация
  $('#navBack').addEventListener('click', () => {
    if (historyIdx > 0) {
      historyIdx--;
      go(history[historyIdx], { push: false });
    }
  });
  $('#navFwd').addEventListener('click', () => {
    if (historyIdx < history.length - 1) {
      historyIdx++;
      go(history[historyIdx], { push: false });
    }
  });

  // поиск
  const search = $('#searchInput');
  search.addEventListener('input', () => {
    store.search = search.value;
    $('#searchClear').classList.toggle('hidden', !search.value);
    renderMain();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      store.search = '';
      $('#searchClear').classList.add('hidden');
      search.blur();
      renderMain();
    }
    e.stopPropagation();
  });
  $('#searchClear').addEventListener('click', () => {
    search.value = '';
    store.search = '';
    $('#searchClear').classList.add('hidden');
    renderMain();
    search.focus();
  });
  $('#searchBox').addEventListener('click', () => search.focus());

  // папки и плейлисты
  $('#btnAddFolder').addEventListener('click', addFolders);
  $('#btnAddFolderMini').addEventListener('click', addFolders);
  $('#btnNewPlaylist').addEventListener('click', async () => {
    const name = await awaitText('Новый плейлист', 'Мой плейлист');
    if (name === null) return;
    await createPlaylist(name.trim() || 'Новый плейлист');
  });

  // сайдбар: клики
  $('#sidebar').addEventListener('click', (e) => {
    const folderMenuBtn = e.target.closest('[data-folder-menu]');
    if (folderMenuBtn) {
      e.stopPropagation();
      const r = folderMenuBtn.getBoundingClientRect();
      openCtx(r.left, r.bottom + 4, folderMenu(folderMenuBtn.dataset.folderMenu));
      return;
    }
    const plMenuBtn = e.target.closest('[data-playlist-menu]');
    if (plMenuBtn) {
      e.stopPropagation();
      const r = plMenuBtn.getBoundingClientRect();
      openCtx(r.left, r.bottom + 4, playlistMenu(plMenuBtn.dataset.playlistMenu));
      return;
    }
    const folder = e.target.closest('[data-folder]');
    if (folder) {
      go(`folder:${folder.dataset.folder}`);
      return;
    }
    const pl = e.target.closest('[data-playlist]');
    if (pl) {
      go(`playlist:${pl.dataset.playlist}`);
      return;
    }
    const nav = e.target.closest('.nav-item');
    if (nav) go(nav.dataset.view);
  });

  $('#sidebar').addEventListener('contextmenu', (e) => {
    const folder = e.target.closest('[data-folder]');
    const pl = e.target.closest('[data-playlist]');
    if (folder) {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, folderMenu(folder.dataset.folder));
    } else if (pl) {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, playlistMenu(pl.dataset.playlist));
    }
  });

  // список треков
  const list = $('#trackList');
  list.addEventListener('click', (e) => {
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      e.stopPropagation();
      toggleFavorite(favBtn.dataset.fav);
      return;
    }
    const moreBtn = e.target.closest('[data-menu]');
    if (moreBtn) {
      e.stopPropagation();
      const r = moreBtn.getBoundingClientRect();
      openCtx(r.left - 180, r.bottom + 4, trackMenu(moreBtn.dataset.menu));
      return;
    }
    const row = e.target.closest('.track-row');
    if (row) {
      const items = filteredTracks();
      const idx = parseInt(row.dataset.idx, 10);
      if (items[idx]) setQueue(items, idx);
    }
  });

  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.track-row');
    if (!row) return;
    e.preventDefault();
    openCtx(e.clientX, e.clientY, trackMenu(row.dataset.path));
  });

  // empty state
  $('#main').addEventListener('click', (e) => {
    if (e.target.closest('#emptyAddFolder')) addFolders();
    if (e.target.closest('#emptyClearSearch')) {
      store.search = '';
      $('#searchInput').value = '';
      $('#searchClear').classList.add('hidden');
      renderMain();
    }
  });

  // заголовок
  $('#btnPlayView').addEventListener('click', () => playView(false));
  $('#btnShuffleView').addEventListener('click', () => playView(true));
  $('#btnRescan').addEventListener('click', () => {
    const v = store.view;
    if (v.startsWith('folder:')) rescanFolder(store.folders.find((f) => f.id === v.slice(7)));
  });
  $('#btnRenamePl').addEventListener('click', async () => {
    if (!store.view.startsWith('playlist:')) return;
    const pl = store.playlists.find((p) => p.id === store.view.slice(9));
    if (!pl) return;
    const v = await awaitText('Название плейлиста', pl.name);
    if (v === null) return;
    pl.name = v.trim() || pl.name;
    saveSoon();
    render();
  });
  $('#btnDeletePl').addEventListener('click', () => {
    if (!store.view.startsWith('playlist:')) return;
    const id = store.view.slice(9);
    const pl = store.playlists.find((p) => p.id === id);
    store.playlists = store.playlists.filter((p) => p.id !== id);
    go('all');
    renderSidebar();
    toast(`Плейлист «${pl?.name || ''}» удалён`);
  });

  // плеер
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnNext').addEventListener('click', () => nextTrack(true));
  $('#btnPrev').addEventListener('click', prevTrack);
  $('#btnShuffle').addEventListener('click', () => {
    store.settings.shuffle = !store.settings.shuffle;
    saveSoon();
    updatePlayerUi();
    toast(store.settings.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено');
  });
  $('#btnRepeat').addEventListener('click', cycleRepeat);
  $('#btnMute').addEventListener('click', toggleMute);
  $('#btnFav').addEventListener('click', () => {
    if (current) toggleFavorite(current.path);
  });
  $('#btnLyricsToggle').addEventListener('click', () => setLyricsOpen(document.body.classList.contains('no-lyrics')));
  $('#btnLyricsHide').addEventListener('click', () => setLyricsOpen(false));
  $('#btnLyricsRefresh').addEventListener('click', () => {
    if (current) loadLyrics(current, true);
  });
  $('#btnLyricsAi').addEventListener('click', () => askAiLyrics());

  // модалки
  $('#btnOpenSettings').addEventListener('click', openSettings);
  $('#btnHotkeysHelp').addEventListener('click', () => showModal('#hotkeysModal'));
  $('#setProvider').addEventListener('change', syncProviderFields);
  $('#btnSettingsSave').addEventListener('click', saveSettings);
  $('#btnAiTest').addEventListener('click', testAi);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) {
      hideAllModals();
      return;
    }
    if (e.target.classList.contains('modal')) hideAllModals();
    if (!e.target.closest('#ctxMenu')) closeCtx();
  });

  // панель текста: действия
  $('#lyBody').addEventListener('click', (e) => {
    const line = e.target.closest('.ly-line');
    if (line && line.dataset.t) {
      const t = parseFloat(line.dataset.t);
      if (isFinite(t)) {
        audio.currentTime = t;
        syncLyrics(t);
      }
      return;
    }
    if (e.target.closest('[data-lyr-retry]')) {
      if (current) loadLyrics(current, true);
    }
    if (e.target.closest('[data-lyr-ai]')) askAiLyrics();
    if (e.target.closest('[data-lyr-settings]')) openSettings();
    if (e.target.closest('[data-lyr-autoscroll]')) {
      const btn = e.target.closest('[data-lyr-autoscroll]');
      btn.classList.toggle('on');
      btn.innerHTML = btn.classList.contains('on')
        ? '<svg><use href="#i-check"/></svg>Авто'
        : 'Авто';
    }
  });

  // перемотка и громкость
  bindBar($('#seekBar'), (r) => {
    const dur = audio.duration || current?.duration || 0;
    if (dur > 0) audio.currentTime = r * dur;
    updateProgress();
  }, () => {
    isSeeking = true;
  }, () => {
    isSeeking = false;
  });

  bindBar($('#volBar'), (r) => {
    audio.volume = clamp(r, 0, 1);
    audio.muted = false;
    store.settings.volume = audio.volume;
    store.settings.muted = false;
    updateVolumeUi();
    saveSoon();
  });
}

function bindBar(el, onChange, onDown, onUp) {
  if (!el) return;
  const ratioOf = (e) => {
    const r = el.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    onDown && onDown();
    onChange(ratioOf(e));
    const move = (ev) => onChange(ratioOf(ev));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      onUp && onUp();
      updateProgress();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

function cycleRepeat() {
  const order = ['off', 'all', 'one'];
  const i = order.indexOf(store.settings.repeat);
  store.settings.repeat = order[(i + 1) % order.length];
  saveSoon();
  updatePlayerUi();
  toast(`Повтор: ${repeatLabel(store.settings.repeat)}`);
}

function toggleMute() {
  audio.muted = !audio.muted;
  store.settings.muted = audio.muted;
  store.settings.volume = audio.volume;
  updateVolumeUi();
  saveSoon();
}

async function testAi() {
  const cfg = {
    provider: $('#setProvider').value,
    ollamaUrl: $('#setOllamaUrl').value.trim(),
    ollamaModel: $('#setOllamaModel').value.trim(),
    gigachatKey: $('#setGigaKey').value.trim(),
    allowGenerated: $('#setAllowGen').checked,
  };
  const out = $('#aiTestResult');
  out.textContent = 'Проверяю…';
  try {
    const res = await invoke('ai_probe', { ai: cfg });
    out.textContent = res.ok ? `Связь есть · ${res.detail}` : `Не отвечает: ${res.detail}`;
    out.style.color = res.ok ? '#6ee7a8' : '#ff9b9b';
  } catch (e) {
    out.textContent = String(e);
    out.style.color = '#ff9b9b';
  }
}

async function askAiLyrics() {
  if (!current) {
    toast('Сначала включите трек');
    return;
  }
  if (store.settings.provider === 'none') {
    openSettings();
    toast('Подключите ИИ-агента в настройках');
    return;
  }
  toast('Спрашиваю ' + providerLabel() + '…');
  await loadLyrics(current, true);
}

/* ============ аудио ============ */

function bindAudio() {
  audio.addEventListener('play', () => {
    updatePlayerUi();
    markPlayingRow();
    startTick();
  });
  audio.addEventListener('pause', () => {
    updatePlayerUi();
    markPlayingRow();
  });
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('loadedmetadata', updateProgress);
  audio.addEventListener('ended', () => nextTrack(false));
  audio.addEventListener('error', () => {
    if (!current) return;
    toast(`Не удалось воспроизвести «${current.title}» — формат может не поддерживаться`);
  });
  audio.addEventListener('volumechange', updateVolumeUi);
  updateVolumeUi();

  // медиа-клавиши / системный оверлей Windows
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
      navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(true));
    } catch (_) {}
  }
}

/* ============ drag & drop ============ */

function bindDrop() {
  if (!appWindow?.onDragDropEvent) return;
  try {
    appWindow.onDragDropEvent(async (event) => {
      const payload = event.payload || {};
      if (payload.type !== 'drop') return;
      const paths = payload.paths || [];
      const audioExt = /\.(mp3|flac|wav|m4a|aac|ogg|opus|wma|aiff?|alac)$/i;
      const files = paths.filter((p) => audioExt.test(p));
      const dirs = paths.filter((p) => !audioExt.test(p));

      for (const d of dirs) await importFolder(d);

      if (files.length) {
        try {
          const tracks = await invoke('scan_files', { paths: files });
          if (!tracks.length) {
            toast('Аудиофайлы не прочитались');
            return;
          }
          const name = `Импорт ${new Date().toLocaleDateString('ru-RU')}`;
          const idx = {};
          for (const t of tracks) idx[t.path] = t;
          // временно кладём треки в «виртуальную» папку, чтобы они были в индексе
          const folderId = 'dropped';
          store.folders = store.folders.filter((f) => f.id !== folderId);
          store.folders.push({ id: folderId, name: 'Перетащенные файлы', path: '', addedAt: Date.now() });
          store.tracks[folderId] = (store.tracks[folderId] || []).filter((t) => !idx[t.path]).concat(tracks);
          const pl = await createPlaylist(name, tracks.map((t) => t.path));
          toast(`Добавлено ${tracks.length} трек${plural(tracks.length, '', 'а', 'ов')}`);
          go(`playlist:${pl.id}`);
        } catch (e) {
          toast('Не удалось прочитать файлы: ' + e);
        }
      }
    });
  } catch (e) {
    console.warn('drag-drop', e);
  }
}

/* ============ горячие клавиши ============ */

function isTyping(e) {
  const el = e.target;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function bindHotkeys() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Escape') {
      hideAllModals();
      closeCtx();
      return;
    }
    if (e.key === 'F12') return; // devtools

    if (mod && e.code === 'KeyO') {
      e.preventDefault();
      addFolders();
      return;
    }
    if (mod && e.code === 'KeyN') {
      e.preventDefault();
      $('#btnNewPlaylist').click();
      return;
    }
    if (mod && e.code === 'Comma') {
      e.preventDefault();
      openSettings();
      return;
    }
    if (mod && e.code === 'ArrowRight') {
      e.preventDefault();
      nextTrack(true);
      return;
    }
    if (mod && e.code === 'ArrowLeft') {
      e.preventDefault();
      prevTrack();
      return;
    }
    if (mod && e.code === 'KeyF') {
      e.preventDefault();
      $('#searchInput').focus();
      return;
    }

    if (isTyping(e) || mod || e.altKey) return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowRight':
        e.preventDefault();
        audio.currentTime = clamp(audio.currentTime + (store.settings.seekStep || 5), 0, audio.duration || 1e9);
        updateProgress();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        audio.currentTime = clamp(audio.currentTime - (store.settings.seekStep || 5), 0, audio.duration || 1e9);
        updateProgress();
        break;
      case 'ArrowUp':
        e.preventDefault();
        audio.volume = clamp(audio.volume + 0.05, 0, 1);
        store.settings.volume = audio.volume;
        updateVolumeUi();
        saveSoon();
        break;
      case 'ArrowDown':
        e.preventDefault();
        audio.volume = clamp(audio.volume - 0.05, 0, 1);
        store.settings.volume = audio.volume;
        updateVolumeUi();
        saveSoon();
        break;
      case 'KeyM':
        toggleMute();
        break;
      case 'KeyS':
        $('#btnShuffle').click();
        break;
      case 'KeyR':
        cycleRepeat();
        break;
      case 'KeyL':
        setLyricsOpen(document.body.classList.contains('no-lyrics'));
        break;
      case 'KeyF':
        if (current) toggleFavorite(current.path);
        break;
      case 'Slash':
        e.preventDefault();
        $('#searchInput').focus();
        $('#searchInput').select();
        break;
      case 'Equal':
      case 'NumpadAdd':
        if (current) loadLyrics(current, true);
        break;
      case 'Question':
        showModal('#hotkeysModal');
        break;
      default:
        break;
    }
  });

  // пробел в диалоге ввода не должен переключать трек — уже отсекается isTyping

  if (T.globalShortcut) {
    const reg = (keys, fn) => {
      try {
        T.globalShortcut.register(keys, fn).catch(() => {});
      } catch (_) {}
    };
    reg('Alt+Space', () => togglePlay());
    reg('Alt+Control+ArrowRight', () => nextTrack(true));
    reg('Alt+Control+ArrowLeft', () => prevTrack());
    reg('Alt+ArrowUp', () => {
      audio.volume = clamp(audio.volume + 0.05, 0, 1);
      updateVolumeUi();
    });
    reg('Alt+ArrowDown', () => {
      audio.volume = clamp(audio.volume - 0.05, 0, 1);
      updateVolumeUi();
    });
  }
}

/* ============ рендер целиком ============ */

function render() {
  renderSidebar();
  renderMain();
  updatePlayerUi();
  markPlayingRow();
  updateNavButtons();
}

boot();
