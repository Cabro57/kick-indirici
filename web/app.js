"use strict";

const $ = (id) => document.getElementById(id);
const STATUS = {
  queued: "Sırada",
  preparing: "Hazırlanıyor…",
  downloading: "İniyor",
  merging: "Birleştiriliyor…",
  recording: "Kaydediliyor",
  done: "Tamamlandı",
  stopped: "Durduruldu",
  error: "Hata",
};
const ACTIVE = ["preparing", "downloading", "merging", "recording"];

const state = {
  api: null,
  cfg: null,
  settings: {},
  view: "home",              // home | channel | library | settings
  channel: null,
  vods: [],
  liveVod: null,             // suren yayinin VOD'u: canlidan kesit almak icin
  clips: [],
  clipCursor: null,
  clipSort: "date",
  clipsLoading: false,
  tab: "vods",               // vods | clips | live
  seenBefore: "",
  favorite: false,
  filters: { q: "", cat: "", len: "", sort: "new" },
  selected: new Set(),       // secili videolarin url'leri (toplu indirme)
  anchor: null,
  focus: null,               // incelemede acik ogenin anahtari
  downloads: [],
  byUrl: new Map(),          // url -> tam video indirmesi
  favorites: [],
  favStatus: {},             // slug -> favorites_refresh sonucu
  liveFavs: new Set(),
  library: [],
  libQuery: "",
  libFocus: null,            // incelemede oynayan dosya
  cuts: new Map(),           // vod url -> kesit listesi (kesit secici)
  lastClip: "",              // panodan en son onerilen link: ayni link ikinci kez sorulmaz
  notices: new Map(),        // ust seritteki bildirimler: anahtar -> eleman
};

/* ---------- bicimlendirme ---------- */
function fmtDuration(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
function fmtEta(s) {
  if (s == null) return "";
  s = Math.round(s);
  if (s < 60) return `${s} sn kaldı`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} sa ${m} dk kaldı` : `${m} dk kaldı`;
}
function fmtBytes(n) {
  if (n == null) return "";
  if (n === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 1 ? 1 : 0).replace(".", ",")} ${u[i]}`;
}
function fmtSpeed(n) {
  return n ? `${fmtBytes(n)}/s` : "";
}
function fmtCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(".", ",")} Mn`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(".", ",")} B`;
  return String(n || 0);
}
function parseDate(iso) {
  if (!iso) return NaN;
  return Date.parse(iso.replace(" ", "T") + (iso.includes("Z") || iso.includes("+") ? "" : "Z"));
}
function fmtAgo(iso) {
  const t = parseDate(iso);
  if (isNaN(t)) return "";
  const d = (Date.now() - t) / 1000;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} dakika önce`;
  if (d < 86400) return `${Math.round(d / 3600)} saat önce`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)} gün önce`;
  return new Date(t).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" });
}
function fmtDate(iso) {
  const t = parseDate(iso);
  if (isNaN(t)) return "";
  return new Date(t).toLocaleString("tr-TR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function cleanTitle(t) {
  t = t || "";
  return t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, " ")
    .replace(/\s*[|•·]+\s*/g, " · ").replace(/\s+/g, " ").replace(/^[\s·]+|[\s·]+$/g, "") || t;
}
function icon(name) {
  return `<svg class="ic"><use href="#i-${name}"/></svg>`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fold = (s) => (s || "").toLocaleLowerCase("tr-TR");
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/* ---------- gorunumler ---------- */
function showView(view) {
  state.view = view;
  $("homeView").hidden = view !== "home";
  $("channelView").hidden = view !== "channel";
  $("libraryView").hidden = view !== "library";
  $("settingsView").hidden = view !== "settings";
  $("main").classList.toggle("noins", view === "home" || view === "settings");
  $("homeBtn").classList.toggle("on", view === "home");
  $("settingsBtn").classList.toggle("on", view === "settings");
  $("libBtn").classList.toggle("on", view === "library");
  if (view === "home" || view === "settings") player.stop();
  if (view === "home") renderHome();
  if (view === "library") { refreshLibrary(); renderInspector(); }
  if (view === "channel") renderInspector();
  if (view === "settings") renderSettings();
  renderRail();
}

/* ---------- link / kanal ---------- */
async function listLink(text) {
  text = (text || "").trim();
  if (!text) return;
  showError("");
  $("linkForm").classList.add("loading");
  try {
    const res = await state.api.list_link(text);
    if (!res.ok) { showError(res.error); return; }
    if (res.kind === "clip") {
      const n = await state.api.enqueue([{ url: res.url, title: "Klip", thumb: "" }]);
      toast(n ? "Klip indirmeye eklendi" : "Bu klip zaten listede");
      $("linkInput").value = "";
      return;
    }
    openChannelData(res);
    $("linkInput").value = "";
    $("linkInput").blur();
  } catch (e) {
    showError("Beklenmeyen bir hata oldu: " + e);
  } finally {
    $("linkForm").classList.remove("loading");
  }
}

function openChannelData(res) {
  player.stop();
  state.channel = res.channel;
  state.vods = res.vods.filter((v) => !v.live);   // suren yayin Canli sekmesinde
  state.liveVod = res.vods.find((v) => v.live) || null;
  state.clips = [];
  state.clipCursor = null;
  state.selected.clear();
  state.anchor = null;
  state.seenBefore = res.seenBefore || "";
  state.favorite = !!res.favorite;
  state.filters = { q: "", cat: "", len: "", sort: "new" };
  $("fQuery").value = "";
  const fav = state.favStatus[res.channel.slug];
  if (fav && fav.ok) fav.newVods = 0;   // acildi: yeniler goruldu
  const focusVod = res.focus && state.vods.find((v) => v.uuid === res.focus);
  setTab(res.channel.live && !focusVod ? "live" : "vods", true);
  loadClips(true);
  showView("channel");
  renderChannel();
  renderGrid();
  state.focus = null;
  if (focusVod) focusItem(focusVod.url);
  else if (state.tab === "live") focusItem(liveItem().url);
  else renderInspector();
  $("gridWrap").scrollTop = 0;
  if (focusVod) {
    const el = cardEl(focusVod.url);
    el && el.scrollIntoView({ block: "center" });
  }
}

async function openChannel(slug) {
  if (state.channel && state.channel.slug === slug && state.view === "channel") return;
  $("linkForm").classList.add("loading");
  if (state.view !== "channel" || !state.channel || state.channel.slug !== slug) renderSkeletonChannel(slug);
  try {
    const res = await state.api.list_link(slug);
    if (!res.ok) { showError(res.error); return; }
    showError("");
    openChannelData(res);
  } finally {
    $("linkForm").classList.remove("loading");
  }
}

function renderSkeletonChannel(slug) {
  const f = state.favorites.find((x) => x.slug === slug);
  state.channel = null;
  showView("channel");
  $("chAvatar").src = f ? f.avatar : "";
  $("chName").textContent = f ? f.name : slug;
  $("chMeta").textContent = "Yükleniyor…";
  $("liveTab").hidden = true;
  renderSkeleton();
  renderInspector();
}

function showError(msg) {
  const el = $("formError");
  el.hidden = !msg;
  el.innerHTML = msg ? `${icon("alert")}<span></span>` : "";
  if (msg) el.querySelector("span").textContent = msg;
}

function liveItem() {
  const ch = state.channel, l = ch && ch.live;
  if (!l) return null;
  return {
    kind: "live", url: `https://kick.com/${ch.slug}`, key: `live:${ch.slug}`, title: l.title || `${ch.name} canlı yayında`,
    thumb: l.thumb, avatar: ch.avatar, source: l.source, start: l.start, views: l.viewers, category: l.category,
    categories: l.category ? [l.category] : [],
  };
}

/* canlidan kesit: Kick suren yayini VOD olarak da yayinlar, listesi yayinin birkac sn gerisine
   kadar uzar. Kesit editoru onu acar; indirme normal VOD kesiti gibi gider. */
function liveCutVod() {
  const l = liveItem(), v = state.liveVod;
  return l && v ? { ...v, title: l.title, thumb: l.thumb || v.thumb, start: l.start, duration: 0, live: true } : null;
}
const cutTarget = (v) => (v && v.kind === "live" ? liveCutVod() : v);

function renderChannel() {
  const ch = state.channel;
  if (!ch) return;
  $("chAvatar").src = ch.avatar || "";
  $("chAvWrap").classList.toggle("live", !!ch.live);
  const h = $("chName");
  h.innerHTML = "";
  h.append(ch.name);
  if (ch.verified) h.insertAdjacentHTML("beforeend", icon("verified"));
  if (ch.live) h.insertAdjacentHTML("beforeend", `<span class="livechip"><i></i>CANLI</span>`);
  const total = state.vods.reduce((a, v) => a + v.duration, 0);
  const newN = state.seenBefore ? state.vods.filter((v) => v.start > state.seenBefore).length : 0;
  $("chMeta").textContent = [
    `${fmtCount(ch.followers)} takipçi`, `${state.vods.length} yayın`, `toplam ${Math.round(total / 3600)} saat`,
    ch.live ? `${fmtCount(ch.live.viewers)} kişi izliyor` : "", newN ? `${newN} yeni yayın` : "",
  ].filter(Boolean).join(" · ");
  $("vodCount").textContent = state.vods.length;
  $("liveTab").hidden = !ch.live;
  const ft = $("favToggle");
  ft.setAttribute("aria-pressed", state.favorite);
  ft.querySelector("span").textContent = state.favorite ? "Favorilerde" : "Favorilere ekle";
  ft.title = state.favorite ? "Favorilerden çıkar" : "Soldaki şeride ekle; canlıya geçince ve yeni yayında haber verir";
  renderAuto();
  renderRail();
}

/* favori yayincinin otomatik isleri: yeni yayinlari indir, canliyi kaydet */
function renderAuto() {
  const f = state.channel && state.favorite && state.favorites.find((x) => x.slug === state.channel.slug);
  $("autoBox").hidden = !f;
  if (!f) return;
  $("autoDl").setAttribute("aria-pressed", !!f.autoDownload);
  $("autoRec").setAttribute("aria-pressed", !!f.autoRecord);
}

async function toggleAuto(key, btn) {
  const ch = state.channel;
  const f = ch && state.favorites.find((x) => x.slug === ch.slug);
  if (!f) return;
  const on = !f[key];
  btn.classList.add("busy");
  try {
    const res = await state.api.favorite_set(ch.slug, { [key]: on });
    if (!res.ok) { toast(res.error); return; }
    state.favorites = res.favorites;
    toast(key === "autoDownload"
      ? (on ? `${ch.name}: bundan sonraki yayınlar bitince kendiliğinden iner` : "Otomatik indirme kapandı")
      : (on ? `${ch.name} canlıya geçince kayıt kendiliğinden başlar` : "Otomatik kayıt kapandı"));
  } finally {
    btn.classList.remove("busy");
  }
  renderAuto();
  renderRail();
}

/* ---------- filtre ---------- */
const LEN_OPTS = {
  vods: [["", "Hepsi"], ["0-3600", "1 saatten kısa"], ["3600-10800", "1–3 saat"], ["10800-", "3 saatten uzun"]],
  clips: [["", "Hepsi"], ["0-30", "30 sn'den kısa"], ["30-60", "30–60 sn"], ["60-", "1 dk'dan uzun"]],
};
const SORT_OPTS = {
  vods: [["new", "En yeni"], ["old", "En eski"], ["long", "En uzun"], ["view", "En çok izlenen"]],
  clips: [["date", "En yeni"], ["view", "En çok izlenen"]],
};

function fillSelect(sel, opts, value) {
  sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
  sel.value = opts.some(([v]) => v === value) ? value : opts[0][0];
  syncSelect(sel);
  sel.parentElement.classList.toggle("set", sel.selectedIndex > 0 && sel.id !== "fSort");
}

function renderFilters() {
  const list = state.tab === "clips" ? state.clips : state.vods;
  $("filters").hidden = state.tab === "live";
  const cats = [...new Set(list.flatMap((v) => v.categories && v.categories.length ? v.categories : v.category ? [v.category] : []))].sort();
  fillSelect($("fCat"), [["", "Hepsi"], ...cats.map((c) => [c, c])], state.filters.cat);
  fillSelect($("fLen"), LEN_OPTS[state.tab === "clips" ? "clips" : "vods"], state.filters.len);
  fillSelect($("fSort"), SORT_OPTS[state.tab === "clips" ? "clips" : "vods"], state.tab === "clips" ? state.clipSort : state.filters.sort);
  $("fCat").parentElement.hidden = cats.length < 2 && !state.filters.cat;
}

function filtered() {
  if (state.tab === "live") { const l = liveItem(); return l ? [l] : []; }
  const f = state.filters;
  let list = state.tab === "clips" ? state.clips : state.vods;
  if (f.q) { const q = fold(f.q); list = list.filter((v) => fold(v.title).includes(q) || fold(v.creator).includes(q)); }
  if (f.cat) list = list.filter((v) => (v.categories || [v.category]).includes(f.cat));
  if (f.len) {
    const [a, b] = f.len.split("-").map((x) => (x === "" ? Infinity : Number(x)));
    list = list.filter((v) => v.duration >= a && v.duration < b);
  }
  if (state.tab === "vods") {
    const by = { new: (x, y) => (y.start > x.start ? 1 : -1), old: (x, y) => (x.start > y.start ? 1 : -1),
      long: (x, y) => y.duration - x.duration, view: (x, y) => y.views - x.views }[f.sort];
    list = [...list].sort(by);
  }
  return list;
}
const filtering = () => state.tab !== "live" && !!(state.filters.q || state.filters.cat || state.filters.len);

/* ---------- izgara ---------- */
const cardEl = (url) => $("grid").querySelector(`.card[data-url="${CSS.escape(url)}"]`);

function renderSkeleton() {
  $("gridNote").hidden = true;
  $("moreBox").hidden = true;
  const g = $("grid");
  g.innerHTML = "";
  for (let i = 0; i < 12; i++) {
    const c = $("cardTpl").content.firstElementChild.cloneNode(true);
    c.classList.add("skeleton");
    c.querySelector("img").remove();
    c.querySelector(".dur").remove();
    g.append(c);
  }
}

function itemByUrl(url) {
  const l = liveItem();
  if (l && l.url === url) return l;
  return state.vods.find((v) => v.url === url) || state.clips.find((v) => v.url === url);
}
const kindOf = (v) => (v.kind ? v.kind : state.clips.includes(v) ? "clip" : "vod");

function renderGrid() {
  hover.stop();
  renderFilters();
  const g = $("grid");
  g.innerHTML = "";
  const all = state.tab === "clips" ? state.clips : state.tab === "live" ? filtered() : state.vods;
  const list = filtered();
  const note = $("gridNote");
  if (state.tab === "clips" && state.clipsLoading && !state.clips.length) { renderSkeleton(); return; }
  note.hidden = list.length > 0;
  note.textContent = all.length ? "Filtreye uyan video yok." : state.tab === "clips" ? "Bu kanalın klibi yok." : "Bu kanalın kayıtlı yayını yok. Klipler sekmesine bak.";
  $("moreBox").hidden = !(state.tab === "clips" && state.clipCursor && state.clips.length);
  $("fClear").hidden = !filtering();
  $("filters").classList.toggle("filtering", filtering());
  $("fCount").textContent = state.tab === "live" ? "" : filtering()
    ? `${list.length} / ${all.length}${state.tab === "clips" && state.clipCursor ? "+" : ""}`
    : `${all.length}${state.tab === "clips" && state.clipCursor ? "+" : ""} ${state.tab === "clips" ? "klip" : "yayın"}`;
  const frag = document.createDocumentFragment();
  for (const v of list) {
    const c = $("cardTpl").content.firstElementChild.cloneNode(true);
    c.dataset.url = v.url;
    const img = c.querySelector("img");
    img.src = v.thumb || (v.kind === "live" && v.avatar) || BLANK;
    img.classList.toggle("avfb", !v.thumb && v.kind === "live");
    img.addEventListener("error", () => {   // canli kapagi henuz yoksa kanal resmi
      const fb = v.kind === "live" && v.avatar && img.src !== v.avatar;
      img.src = fb ? v.avatar : BLANK;
      img.classList.toggle("avfb", !!fb);
    });
    const dur = c.querySelector(".dur");
    if (v.kind === "live") { dur.textContent = "CANLI"; dur.classList.add("live"); }
    else dur.textContent = fmtDuration(v.duration);
    c.querySelector(".cutbtn").hidden = state.tab === "clips" || (v.kind === "live" && !state.liveVod);
    c.querySelector(".check").hidden = v.kind === "live";
    c.querySelector(".title").textContent = cleanTitle(v.title);
    c.title = v.title;
    const bits = v.kind === "live"
      ? [`${fmtCount(v.views)} izleyici`, v.category]
      : [fmtAgo(v.start), v.creator ? `kırpan ${v.creator}` : "", `${fmtCount(v.views)} izlenme`, v.category];
    const sub = c.querySelector(".sub");
    sub.textContent = bits.filter(Boolean).join(" · ");
    if (state.tab === "vods" && state.seenBefore && v.start > state.seenBefore) sub.insertAdjacentHTML("afterbegin", `<span class="newpill">YENİ</span>`);
    frag.append(c);
  }
  g.append(frag);
  paintCards();
}

function paintCards() {
  $("grid").classList.toggle("picking", state.selected.size > 0);
  for (const c of $("grid").querySelectorAll(".card[data-url]")) {
    const url = c.dataset.url;
    c.setAttribute("aria-selected", state.selected.has(url));
    c.classList.toggle("focus", state.focus === url);
    const d = state.byUrl.get(url);
    const st = c.querySelector(".state");
    const tp = c.querySelector(".tprog");
    st.className = "state";
    tp.hidden = !d || !["downloading", "merging", "done"].includes(d.status);
    if (d) tp.style.transform = `scaleX(${(d.pct || 0) / 100})`;
    if (!d) continue;
    st.classList.add("on");
    if (d.status === "downloading") { st.classList.add("active"); st.textContent = `İniyor %${Math.floor(d.pct)}`; }
    else if (d.status === "recording") { st.classList.add("active"); st.textContent = "Kaydediliyor"; }
    else if (d.status === "preparing" || d.status === "merging") { st.classList.add("active"); st.textContent = STATUS[d.status]; }
    else if (d.status === "done") { st.classList.add("done"); st.textContent = "İndirildi"; }
    else if (d.status === "error") { st.classList.add("bad"); st.textContent = "Hata"; }
    else if (d.status === "stopped") { st.classList.add("stopped"); st.textContent = "Durduruldu"; }
    else { st.classList.add("queued"); st.textContent = "Sırada"; }
  }
}

function toggleSel(url, on) {
  const want = on ?? !state.selected.has(url);
  want ? state.selected.add(url) : state.selected.delete(url);
}

function selectionChanged() {
  paintCards();
  renderInspector();
}

async function enqueueItems(items) {
  items = items.filter(Boolean).map((v) => ({ url: v.url, title: cleanTitle(v.title), thumb: v.thumb }));
  if (!items.length) return 0;
  const n = await state.api.enqueue(items);
  if (n < items.length) toast(n ? `${n} video eklendi, ${items.length - n} tanesi zaten listede` : "Zaten listede");
  else toast(n === 1 ? "İndirmeye eklendi" : `${n} video indirmeye eklendi`);
  return n;
}

async function downloadSelected(urls) {
  await enqueueItems(urls.map(itemByUrl));
  urls.forEach((u) => state.selected.delete(u));
  selectionChanged();
}

/* ---------- sekmeler / klipler ---------- */
function setTab(tab, silent) {
  state.tab = tab;
  for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", t.dataset.tab === tab);
  state.selected.clear();
  if (!silent) { renderGrid(); renderInspector(); $("gridWrap").scrollTop = 0; }
}

async function loadClips(reset) {
  if (!state.channel || state.clipsLoading) return;
  const slug = state.channel.slug;
  state.clipsLoading = true;
  if (reset) { state.clips = []; state.clipCursor = null; }
  $("moreBtn").disabled = true;
  $("moreBtn").textContent = "Yükleniyor…";
  if (state.tab === "clips" && reset) renderGrid();
  try {
    const res = await state.api.list_clips(slug, state.clipSort, reset ? null : state.clipCursor);
    if (!state.channel || state.channel.slug !== slug) return;
    if (!res.ok) { toast(res.error); return; }
    const known = new Set(state.clips.map((c) => c.url));
    state.clips.push(...res.clips.filter((c) => !known.has(c.url)));
    state.clipCursor = res.cursor;
  } finally {
    state.clipsLoading = false;
    $("moreBtn").disabled = false;
    $("moreBtn").textContent = "Daha fazla klip yükle";
    $("clipCount").textContent = state.clips.length ? `${state.clips.length}${state.clipCursor ? "+" : ""}` : "0";
    if (state.tab === "clips" && state.view === "channel") renderGrid();
  }
}

/* ---------- oynatici ----------
   Tek oynatici: incelemede secilen video, klip, canli yayin ya da indirilen dosya. HLS ise hls.js,
   yerel dosyaysa dogrudan. Ses ayari kalici (ayarlar: volume, previewMuted). */
const player = {
  hls: null, key: null, live: false, volTimer: 0,
  el: () => $("insVideo"),
  load(key, { source, file, poster, start = 0, live = false, autoplay = true }) {
    const v = this.el();
    if (this.key === key && (this.hls || v.src)) return;
    this.stop();
    this.key = key;
    this.live = live;
    $("player").classList.remove("empty", "playing");
    $("insPoster").src = poster || "";
    $("insPoster").classList.remove("avfb");
    this.msg("");
    v.muted = !!state.settings.previewMuted;
    v.volume = clamp((state.settings.volume ?? 50) / 100, 0, 1);
    paintVolume();
    $("pSeek").disabled = live;
    const go = () => {
      if (start && !live) v.currentTime = start;
      if (autoplay) v.play().catch(() => {});
    };
    if (file) {
      v.src = file;
      v.addEventListener("loadedmetadata", go, { once: true });
    } else if (source && window.Hls && Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 20, capLevelToPlayerSize: true, startPosition: live ? -1 : start || -1 });
      this.hls = hls;
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal && this.hls === hls) this.msg(live ? "Canlı yayın oynatılamadı." : "Video oynatılamadı.");
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (autoplay) v.play().catch(() => {}); });
      hls.loadSource(source);
      hls.attachMedia(v);
    } else if (source) {
      v.src = source;
      v.addEventListener("loadedmetadata", go, { once: true });
    } else {
      this.msg("Bu videonun oynatılabilir kaynağı yok.");
    }
  },
  stop() {
    const v = this.el();
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    v.pause();
    v.removeAttribute("src");
    v.load();
    this.key = null;
    $("player").classList.remove("playing");
    paintPlayer();
  },
  empty(text) {
    this.stop();
    $("insPoster").src = "";
    $("player").classList.add("empty");
    this.msg(text, "film");
  },
  poster(src, text) {
    this.stop();
    $("player").classList.add("empty");
    $("insPoster").src = src || "";
    this.msg(text || "");
  },
  msg(text, ic) {
    const m = $("pMsg");
    m.hidden = !text;
    m.innerHTML = text ? `${ic ? icon(ic) : ""}<span></span>` : "";
    if (text) m.querySelector("span").textContent = text;
  },
  saveVolume() {
    const v = this.el();
    clearTimeout(this.volTimer);
    this.volTimer = setTimeout(() => {
      const vol = Math.round(v.volume * 100);
      if (vol !== state.settings.volume) { state.settings.volume = vol; state.api.set_settings({ volume: vol }); }
    }, 400);
  },
};

function paintPlayer() {
  const v = player.el();
  const p = $("player");
  p.classList.toggle("paused", v.paused);
  const ic = v.paused ? "play" : "pause";
  if ($("pPlay").dataset.ic !== ic) { $("pPlay").dataset.ic = ic; $("pPlay").innerHTML = icon(ic); }
  const dur = isFinite(v.duration) ? v.duration : 0;
  if (player.live) $("pTime").textContent = "Canlı";
  else $("pTime").textContent = dur ? `${fmtDuration(v.currentTime)} / ${fmtDuration(dur)}` : "0:00";
  if (!$("pSeek").matches(":active")) {
    const pct = dur ? (1000 * v.currentTime) / dur : 0;
    $("pSeek").value = pct;
    $("pSeek").style.setProperty("--v", `${pct / 10}%`);
  }
}

function paintVolume() {
  const v = player.el();
  const vol = v.muted ? 0 : Math.round(v.volume * 100);
  $("pVol").value = vol;
  $("pVol").style.setProperty("--v", `${vol}%`);
  const ic = vol === 0 ? "mute" : "volume";
  if ($("pMute").dataset.ic !== ic) { $("pMute").dataset.ic = ic; $("pMute").innerHTML = icon(ic); }
}

function bindPlayer() {
  const v = player.el();
  for (const ev of ["play", "pause", "timeupdate", "durationchange", "seeked"]) v.addEventListener(ev, paintPlayer);
  v.addEventListener("playing", () => $("player").classList.add("playing"));
  v.addEventListener("volumechange", () => { paintVolume(); player.saveVolume(); });
  v.addEventListener("error", () => { if (player.key) player.msg("Video oynatılamadı."); });
  const toggle = () => { if (player.key) v.paused ? v.play().catch(() => {}) : v.pause(); };
  v.addEventListener("click", toggle);
  v.addEventListener("dblclick", () => fullscreen());
  $("pPlay").addEventListener("click", toggle);
  $("pSeek").addEventListener("input", (e) => {
    const dur = isFinite(v.duration) ? v.duration : 0;
    e.target.style.setProperty("--v", `${e.target.value / 10}%`);
    if (dur) v.currentTime = (e.target.value / 1000) * dur;
  });
  $("pVol").addEventListener("input", (e) => {
    v.volume = e.target.value / 100;
    v.muted = Number(e.target.value) === 0;
  });
  $("pMute").addEventListener("click", () => {
    if (v.muted || v.volume === 0) { v.muted = false; if (v.volume === 0) v.volume = 0.5; }
    else v.muted = true;
  });
  $("pFull").addEventListener("click", () => fullscreen());
}
function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("player").requestFullscreen().catch(() => {});
}

/* ---------- uzerine gelince onizleme ---------- */
const hover = {
  timer: 0, hls: null, card: null, video: null, url: null,
  start(card) {
    if (!state.settings.hoverPreview || this.card === card || card.dataset.url === state.focus) return;
    this.stop();
    const v = itemByUrl(card.dataset.url);
    if (!v || !v.source || !(window.Hls && Hls.isSupported())) return;
    this.card = card;
    this.timer = setTimeout(() => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.loop = v.kind !== "live";
      const img = card.querySelector(".thumb img");
      img.after(video);
      const kind = kindOf(v);
      const start = kind === "live" ? -1 : kind === "vod" ? Math.floor((v.duration || 0) * 0.2) : 0;
      const hls = new Hls({ maxBufferLength: 6, startPosition: start, capLevelToPlayerSize: true, autoStartLoad: true });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        let lo = 0;
        hls.levels.forEach((l, i) => { if (l.bitrate < hls.levels[lo].bitrate) lo = i; });
        hls.currentLevel = lo;
        video.play().catch(() => {});
      });
      video.addEventListener("playing", () => video.classList.add("on"), { once: true });
      hls.loadSource(v.source);
      hls.attachMedia(video);
      this.hls = hls;
      this.video = video;
      this.url = v.url;
    }, 450);
  },
  /* tiklaninca inceleme ayni andan devam etsin */
  time(url) {
    return this.url === url && this.video && this.video.currentTime > 0.5 ? this.video.currentTime : null;
  },
  stop() {
    clearTimeout(this.timer);
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (this.video) { this.video.pause(); this.video.remove(); this.video = null; }
    this.card = null;
    this.url = null;
  },
};

/* ---------- inceleme paneli ---------- */
function focusItem(url, start) {
  state.focus = url;
  paintCards();
  renderInspector(start);
}

function renderInspector(start) {
  const body = $("insBody"), btns = $("insBtns");
  $("qualityBox").hidden = false;
  if (state.view === "library") return renderLibraryInspector();
  if (state.view !== "channel") return;
  if (!state.channel) {
    player.empty("Yükleniyor…");
    body.innerHTML = "";
    btns.innerHTML = "";
    return;
  }
  // coklu secim
  if (state.selected.size >= 2) {
    const items = [...state.selected].map(itemByUrl).filter(Boolean);
    const total = items.reduce((a, v) => a + (v.duration || 0), 0);
    if (!player.key) player.empty(`${items.length} video seçili`);
    body.innerHTML = `<h2>${items.length} video seçili</h2>
      <dl class="facts"><dt>Toplam süre</dt><dd>${fmtDuration(total)}</dd></dl>
      <ul class="selist">${items.map((v) => `<li><img src="${esc(v.thumb || BLANK)}" alt=""><span title="${esc(v.title)}">${esc(cleanTitle(v.title))}</span><small class="num">${fmtDuration(v.duration)}</small></li>`).join("")}</ul>
      <p class="insnote">Ctrl+tık ya da kartın köşesindeki kutu: seçime ekle / çıkar · Esc: seçimi bırak</p>`;
    btns.innerHTML = `<button class="btn primary span" data-ins="dlsel">${icon("download")}İndir (${items.length})</button>
      <button class="btn ghost span" data-ins="clearsel">Seçimi bırak</button>`;
    return;
  }
  const v = state.focus && itemByUrl(state.focus);
  if (!v) {
    player.empty("Bir videoya tıkla, burada oynasın.");
    body.innerHTML = `<div class="insempty">
      <p><b>Bir videoya tıkla:</b> burada oynar, bilgileri görünür.</p>
      <p>Oradan tamamını indir, klibi al ya da <b>Kesit al</b> ile yayının içinden parçalar seç.</p>
      <div class="keys"><span>Ctrl+tık: birden çok seç · Ctrl+A: tümünü seç</span><span>Çift tık: hemen indir · Esc: seçimi bırak</span></div>
    </div>`;
    btns.innerHTML = "";
    return;
  }
  const kind = kindOf(v);
  if (kind === "live") {
    player.load(`live:${state.channel.slug}`, { source: v.source, poster: v.thumb || v.avatar, live: true });
    $("insPoster").classList.toggle("avfb", !v.thumb);
  } else {
    player.load(v.url, { source: v.source, poster: v.thumb, start: start ?? hover.time(v.url) ?? 0 });
  }
  const facts = [];
  if (kind === "live") {
    facts.push(["Başladı", `${fmtAgo(v.start)}`], ["İzleyen", fmtCount(v.views)]);
  } else {
    facts.push([kind === "clip" ? "Kırpıldı" : "Yayın", fmtDate(v.start)], ["Süre", fmtDuration(v.duration)], ["İzlenme", fmtCount(v.views)]);
    if (v.creator) facts.push(["Kırpan", esc(v.creator)]);
  }
  const cats = v.categories && v.categories.length ? v.categories : v.category ? [v.category] : [];
  if (cats.length) facts.push([cats.length > 1 ? "Kategoriler" : "Kategori", `<span class="chips">${cats.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</span>`]);
  const d = kind === "live" ? state.downloads.find((x) => x.live && x.url === v.url && ACTIVE.concat("queued").includes(x.status)) : state.byUrl.get(v.url);
  body.innerHTML = `<h2>${esc(cleanTitle(v.title))}${kind === "live" ? `<span class="beta">CANLI</span>` : ""}</h2>
    <dl class="facts">${facts.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join("")}</dl>
    ${d ? stateBlock(d) : ""}
    ${kind === "live" ? `<p class="insnote"><b>Canlı kayıt (beta):</b> yayın şu andan itibaren kaydedilir. Durdurunca ya da yayın bitince mp4 olur ve İndirilenler'e düşer.</p>` : ""}
    ${kind === "live" && state.liveVod ? `<p class="insnote"><b>Kesit al:</b> yayının başından şu ana kadar istediğin anı seç; yayın sürerken iner.</p>` : ""}`;
  if (kind === "live") {
    const rec = d && ACTIVE.concat("queued").includes(d.status);
    btns.innerHTML = (rec
      ? `<button class="btn span" data-ins="stoprec" data-id="${d.id}">${icon("stop")}Kaydı durdur</button>`
      : `<button class="btn primary span" data-ins="record">${icon("record")}Kaydı başlat</button>`)
      + (state.liveVod ? `<button class="btn span" data-ins="cut">${icon("scissors")}Kesit al</button>` : "");
  } else if (kind === "clip") {
    btns.innerHTML = `<button class="btn primary span" data-ins="dl">${icon("download")}Klibi indir</button>`;
  } else {
    btns.innerHTML = `<button class="btn primary" data-ins="dl">${icon("download")}Tamamını indir</button>
      <button class="btn" data-ins="cut">${icon("scissors")}Kesit al</button>
      ${chatButton(v)}`;
  }
}

/* VOD'un sohbeti: videoyla ayni adla .ass + .json; durum dugmenin uzerinde */
function chatButton(v) {
  const c = state.downloads.find((x) => x.chat && x.url === v.url);
  const busy = c && ["queued", ...ACTIVE].includes(c.status);
  const label = busy ? `Sohbet iniyor %${Math.floor(c.pct)}` : c && c.status === "done" ? "Sohbet indirildi" : c && c.status === "error" ? "Sohbet alınamadı · tekrar dene" : "Sohbeti indir";
  return `<button class="btn ghost span" data-ins="chat" data-k="${c ? `${c.status}:${Math.floor(c.pct)}` : ""}"${busy ? " disabled" : ""}
    title="Sohbeti videoyla aynı adla .ass altyazı ve .json olarak kaydeder. VLC ya da MPC videoyu açınca sohbet ekranda akar.">${icon("chat")}${label}</button>`;
}

function stateBlock(d) {
  let line = STATUS[d.status];
  if (d.status === "downloading") line += ` %${Math.floor(d.pct)}`;
  let sub = "";
  if (d.status === "downloading") sub = [d.size ? `${fmtBytes(d.size * d.pct / 100)} / ${d.exact ? "" : "~"}${fmtBytes(d.size)}` : "", fmtSpeed(d.speed), fmtEta(d.eta)].filter(Boolean).join(" · ");
  if (d.status === "recording") sub = [d.started ? `${fmtDuration(Date.now() / 1000 - d.started)} kaydedildi` : "", fmtBytes(d.size)].filter(Boolean).join(" · ");
  if (d.status === "done") sub = fmtBytes(d.size);
  if (d.status === "error") sub = humanError(d.error);
  if (d.status === "stopped" && d.pct > 0) sub = "Tekrar başlatınca kaldığı yerden devam eder.";
  const showBar = ["downloading", "merging", "preparing", "recording", "queued"].includes(d.status);
  const acts = d.status === "done"
    ? `<div class="btnrow"><button class="btn sm" data-ins="playfile" data-file="${esc(d.filename)}">${icon("play")}Oynat</button><button class="btn ghost sm" data-ins="reveal" data-id="${d.id}">${icon("reveal")}Klasörde göster</button></div>`
    : ["stopped", "error"].includes(d.status) ? `<div class="btnrow"><button class="btn sm" data-ins="retry" data-id="${d.id}">${icon("retry")}Tekrar dene</button></div>`
    : `<div class="btnrow"><button class="btn ghost sm danger" data-ins="cancel" data-id="${d.id}">${icon("stop")}Durdur</button></div>`;
  return `<div class="insstate ${d.status}" data-k="${d.id}:${d.status}"><p>${line}</p>${showBar ? `<div class="bar"><i style="transform:scaleX(${d.status === "queued" ? 0 : d.pct / 100})"></i></div>` : ""}${sub ? `<p class="num">${esc(sub)}</p>` : ""}${acts}</div>`;
}

async function onInspectorAction(b) {
  const act = b.dataset.ins;
  const v = state.focus && itemByUrl(state.focus);
  if (act === "dl" && v) await enqueueItems([v]);
  else if (act === "cut" && v) { player.el().pause(); openCutter(cutTarget(v)); }
  else if (act === "chat" && v) {
    const n = await state.api.enqueue([{ url: v.url, chat: true, title: cleanTitle(v.title), thumb: v.thumb, duration: Math.round(v.duration || 0) }]);
    toast(n ? "Sohbet indiriliyor" : "Bu yayının sohbeti zaten iniyor");
  }
  else if (act === "record" && v) {
    const n = await state.api.enqueue([{ url: v.url, title: cleanTitle(v.title), thumb: v.thumb || v.avatar, live: true }]);
    toast(n ? "Canlı kayıt başladı" : "Bu kanal zaten kaydediliyor");
  }
  else if (act === "stoprec" || act === "cancel") state.api.cancel(Number(b.dataset.id));
  else if (act === "retry") state.api.retry(Number(b.dataset.id));
  else if (act === "reveal") state.api.reveal(Number(b.dataset.id));
  else if (act === "playfile") { showView("library"); playFile(b.dataset.file); }
  else if (act === "dlsel") await downloadSelected([...state.selected]);
  else if (act === "clearsel") { state.selected.clear(); selectionChanged(); }
  else if (act === "lplay") playFile(b.dataset.file, true);
  else if (act === "lopen") { player.el().pause(); state.api.open_file(b.dataset.file); }   // ayni anda iki yerde calmasin
  else if (act === "lreveal") state.api.reveal_file(b.dataset.file);
  else if (act === "ldel") deleteFile(b.dataset.file);
}

/* ---------- favoriler ---------- */
function renderRail() {
  const box = $("favs");
  const cur = state.view === "channel" && state.channel ? state.channel.slug : null;
  box.innerHTML = state.favorites.map((f) => {
    const st = state.favStatus[f.slug] || {};
    const live = state.liveFavs.has(f.slug) || (st.ok && st.live);
    const nv = st.ok && st.newVods && cur !== f.slug ? st.newVods : 0;
    const tip = [f.name, live ? "canlı yayında" : "", nv ? `${nv} yeni yayın` : "",
      f.autoDownload ? "yeni yayınlar kendiliğinden iner" : "", f.autoRecord ? "canlı kendiliğinden kaydedilir" : ""].filter(Boolean).join(" · ");
    return `<button class="fav${live ? " live" : ""}${cur === f.slug ? " on" : ""}" type="button" role="listitem" data-slug="${esc(f.slug)}" title="${esc(tip)}" aria-label="${esc(tip)}">
      <img src="${esc(f.avatar || BLANK)}" alt="">${f.autoDownload || f.autoRecord ? `<i class="fauto"></i>` : ""}${live ? `<span class="flive">CANLI</span>` : nv ? `<span class="fnew">${nv > 9 ? "9+" : nv}</span>` : ""}</button>`;
  }).join("");
}

async function refreshFavorites() {
  if (!state.favorites.length) return;
  const st = await state.api.favorites_refresh();
  state.favStatus = st || {};
  for (const f of state.favorites) {
    const s = state.favStatus[f.slug];
    if (s && s.ok) { f.name = s.name; f.avatar = s.avatar; s.live ? state.liveFavs.add(f.slug) : state.liveFavs.delete(f.slug); }
  }
  renderRail();
  if (state.view === "home") renderHome();
}

async function toggleFavorite() {
  const ch = state.channel;
  if (!ch) return;
  if (state.favorite) {
    state.favorites = await state.api.favorite_remove(ch.slug);
    state.favorite = false;
    toast(`${ch.name} favorilerden çıkarıldı`);
  } else {
    const res = await state.api.favorite_add(ch.slug);
    if (!res.ok) { toast(res.error); return; }
    state.favorites = res.favorites;
    state.favorite = true;
    state.favStatus[ch.slug] = { ok: true, name: ch.name, avatar: ch.avatar, live: ch.live, newVods: 0 };
    toast(`${ch.name} favorilere eklendi`);
  }
  renderChannel();
}

function openFavPop() {
  const pop = $("favPop");
  const r = $("favAddBtn").getBoundingClientRect();
  pop.hidden = false;
  pop.style.left = `${r.right + 10}px`;
  pop.style.top = `${Math.min(r.top - 8, window.innerHeight - pop.offsetHeight - 12)}px`;
  $("favPopInput").value = "";
  $("favPopInput").focus();
}

async function submitFavPop(e) {
  e.preventDefault();
  const text = $("favPopInput").value.trim();
  if (!text) return;
  const res = await state.api.favorite_add(text);
  if (!res.ok) { toast(res.error); return; }
  state.favorites = res.favorites;
  $("favPop").hidden = true;
  toast(`${res.favorite.name} favorilere eklendi`);
  if (state.channel && state.channel.slug === res.favorite.slug) { state.favorite = true; renderChannel(); }
  renderRail();
  refreshFavorites();
}

/* ---------- ana sayfa ---------- */
function renderHome() {
  const favs = state.favorites;
  $("homeEmpty").hidden = favs.length > 0;
  $("favGrid").hidden = !favs.length;
  $("homeView").querySelector(".homehead").hidden = !favs.length;
  const live = favs.filter((f) => state.liveFavs.has(f.slug)).length;
  const fresh = favs.reduce((a, f) => a + ((state.favStatus[f.slug] || {}).newVods || 0), 0);
  $("homeMeta").textContent = [live ? `${live} canlı` : "", fresh ? `${fresh} yeni yayın` : ""].filter(Boolean).join(" · ");
  // canlilar once, sonra yenisi olanlar
  const order = [...favs].sort((a, b) => {
    const sa = state.favStatus[a.slug] || {}, sb = state.favStatus[b.slug] || {};
    return (state.liveFavs.has(b.slug) - state.liveFavs.has(a.slug)) || ((sb.newVods || 0) - (sa.newVods || 0));
  });
  $("favGrid").innerHTML = order.map((f) => {
    const st = state.favStatus[f.slug];
    if (!st) return `<div class="ftile skeleton"></div>`;
    const live = state.liveFavs.has(f.slug) || (st.ok && st.live);
    const lt = st.ok && st.latest;
    const stat = !st.ok ? "Bilgi alınamadı"
      : live ? `<em>Canlı</em> · ${esc(cleanTitle((st.live && st.live.title) || ""))}`
      : st.newVods ? `<strong>${st.newVods} yeni yayın</strong>` : lt ? `Son yayın ${fmtAgo(lt.start)}` : "Kayıtlı yayın yok";
    return `<button class="ftile${live ? " live" : ""}" type="button" data-slug="${esc(f.slug)}">
      <img class="av" src="${esc(f.avatar || BLANK)}" alt=""><b>${esc(f.name)}</b><span class="fstat">${stat}</span>
      ${lt ? `<span class="latest"><img src="${esc(lt.thumb || BLANK)}" alt=""><span>${esc(cleanTitle(lt.title))}</span></span>` : ""}</button>`;
  }).join("");
  const rec = state.library.filter((e) => e.exists && !e.chat).slice(0, 6);
  $("recentBox").hidden = !rec.length;
  $("recentRow").innerHTML = rec.map((e) => `<button class="rtile" type="button" data-file="${esc(e.file)}">
    <img src="${esc(e.thumb || BLANK)}" alt=""><p>${esc(cleanTitle(e.title))}</p><span class="num">${esc(e.channel)} · ${fmtBytes(e.size)}</span></button>`).join("");
}

/* ---------- indirmeler ---------- */
function sync(data) {
  state.downloads = data.downloads;
  state.byUrl = new Map(data.downloads.filter((d) => !d.section && !d.live && !d.chat).map((d) => [d.url, d]));
  const newLive = new Set(data.liveFavorites || []);
  const liveChanged = [...newLive].some((s) => !state.liveFavs.has(s)) || [...state.liveFavs].some((s) => !newLive.has(s));
  if (liveChanged) { state.liveFavs = newLive; renderRail(); if (state.view === "home") renderHome(); }
  const doneBefore = state.doneIds || new Set();
  const doneNow = new Set(data.downloads.filter((d) => d.status === "done").map((d) => d.id));
  state.doneIds = doneNow;
  if ([...doneNow].some((id) => !doneBefore.has(id)) && state.started) refreshLibrary();
  state.started = true;
  renderStatus(data);
  renderRows();
  paintCards();
  if (state.view === "channel" && state.focus) refreshStateBlock();
  renderShutdown(data);
}

/* inceleme panelindeki indirme durumu: oynaticiyi yeniden kurmadan yalnizca o blogu guncelle */
function refreshStateBlock() {
  const v = itemByUrl(state.focus);
  if (!v || state.selected.size >= 2) return;
  const kind = kindOf(v);
  const d = kind === "live" ? state.downloads.find((x) => x.live && x.url === v.url && ACTIVE.concat("queued").includes(x.status)) : state.byUrl.get(v.url);
  const chatBtn = $("insBtns").querySelector('[data-ins="chat"]');
  if (chatBtn) {
    const tmpBtn = document.createElement("div");
    tmpBtn.innerHTML = chatButton(v);
    if (tmpBtn.firstElementChild.dataset.k !== chatBtn.dataset.k) chatBtn.replaceWith(tmpBtn.firstElementChild);
  }
  const old = $("insBody").querySelector(".insstate");
  const key = d ? `${d.id}:${d.status}` : "";
  if ((old ? old.dataset.k : "") !== key && kind === "live") { renderInspector(); return; }
  if (!d) { if (old) old.remove(); return; }
  const tmp = document.createElement("div");
  tmp.innerHTML = stateBlock(d);
  const blk = tmp.firstElementChild;
  blk.dataset.k = key;
  if (old) old.replaceWith(blk);
  else $("insBody").querySelector(".facts").after(blk);
}

function renderStatus(data) {
  const dl = data.downloads;
  const active = dl.filter((d) => ACTIVE.includes(d.status) && !d.live).length;
  const rec = dl.filter((d) => d.live && ACTIVE.includes(d.status)).length;
  const queued = dl.filter((d) => d.status === "queued").length;
  const running = active + queued + rec > 0;
  const errs = dl.filter((d) => d.status === "error").length;
  $("statusBar").classList.toggle("live", running);
  $("statusBar").classList.toggle("err", errs > 0);
  $("sbText").innerHTML = downloadSummary(dl) || (dl.some((d) => d.status === "done") ? "İndirmeler bitti" : "İndirme yok");
  const work = dl.filter((d) => ["downloading", "merging", "preparing", "queued"].includes(d.status) && !d.live && d.size);
  const total = work.reduce((a, d) => a + d.size, 0);
  const got = work.reduce((a, d) => a + d.size * d.pct / 100, 0);
  const pct = total ? got / total : 0;
  $("sbTrack").hidden = !active;
  $("sbFill").style.transform = `scaleX(${pct})`;
  const eta = Math.max(0, ...dl.filter((d) => d.status === "downloading" && d.eta != null).map((d) => d.eta));
  $("sbNums").textContent = active ? [`%${Math.floor(pct * 100)}`, eta ? fmtEta(eta) : ""].filter(Boolean).join(" · ") : "";
  const sp = data.totalSpeed ? fmtBytes(data.totalSpeed).split(" ") : null;
  $("sbSpeed").innerHTML = sp ? `${sp[0]}<small>${sp[1]}/s</small>` : "";
  const badge = active + queued + rec;
  $("libBadge").hidden = !badge;
  $("libBadge").textContent = badge;
  $("libRing").hidden = !active;
  $("libRing").style.setProperty("--p", pct);
  $("stopAllBtn").disabled = !running;
  $("clearBtn").hidden = !dl.some((d) => d.status === "done");
  const free = data.free;
  const fe = $("sbFree");
  fe.hidden = free == null;
  if (free != null) {
    fe.innerHTML = `${icon("hdd")}${esc(fmtBytes(free))} boş`;
    fe.classList.toggle("bad", free < 2 * 1024 ** 3);
    fe.classList.toggle("low", free >= 2 * 1024 ** 3 && free < 15 * 1024 ** 3);
  }
  $("sbSpeed").title = data.speedLimit ? `Hız sınırı ${data.speedLimit} MB/s (Ayarlar → Hız)` : "";
  if (data.speedLimit && sp) $("sbSpeed").insertAdjacentHTML("beforeend", `<small>/ ${data.speedLimit} sınır</small>`);
  const after = data.afterDone || "none";
  $("afterBox").hidden = !running && after === "none";
  if ($("afterDone").value !== after) { $("afterDone").value = after; syncSelect($("afterDone")); }
  $("afterBox").classList.toggle("set", after !== "none");
}

/* kuyruk bittiyse ve bilgisayar kapanacaksa: geri sayim ve iptal */
function renderShutdown(data) {
  if (!data.shutdownAt || data.shutdownAt < Date.now() / 1000) { closeNotice("shutdown"); return; }
  if (state.notices.has("shutdown")) return;
  notice("shutdown", {
    icon: "power", warn: true, sticky: true, text: "İndirmeler bitti. Bilgisayar <b>1 dakika içinde</b> kapanacak.",
    actions: [["Kapatmayı iptal et", () => { state.api.cancel_shutdown(); closeNotice("shutdown"); toast("Kapatma iptal edildi"); }, "primary"]],
  });
}

function renderRows() {
  const box = $("rows");
  const list = state.downloads.filter((d) => d.status !== "done");
  $("activeGroup").hidden = !state.downloads.length;
  const dl = state.downloads;
  $("activeMeta").innerHTML = list.length ? downloadSummary(dl) : "Hepsi bitti";
  const seen = new Set();
  const rank = { recording: 0, downloading: 0, preparing: 0, merging: 0, queued: 1, stopped: 2, error: 2 };
  const ordered = [...list].sort((a, b) => rank[a.status] - rank[b.status] || a.id - b.id);
  ordered.forEach((d, i) => {
    seen.add(String(d.id));
    let row = box.querySelector(`.row[data-id="${d.id}"]`);
    if (!row) {
      row = $("rowTpl").content.firstElementChild.cloneNode(true);
      row.dataset.id = d.id;
      row.classList.add("new");
      row.addEventListener("animationend", () => row.classList.remove("new"), { once: true });
      const im = row.querySelector(".rthumb");
      im.src = BLANK;
      im.addEventListener("error", () => {   // kapak yuklenemezse kanalin resmi
        const a = avatarFor(d.url);
        const fb = a && im.getAttribute("src") !== a;
        im.src = fb ? a : BLANK;
        im.classList.toggle("avfb", !!fb);
      });
    }
    const at = box.querySelectorAll(".row")[i];
    if (at !== row) box.insertBefore(row, at || null);
    row.className = `row ${d.status}`;
    const img = row.querySelector(".rthumb");
    const th = d.thumb || avatarFor(d.url);
    if (th && img.getAttribute("src") !== th) img.src = th;
    img.classList.toggle("avfb", !d.thumb && !!th);
    row.querySelector(".rtitle").innerHTML = (d.chat ? `<span class="kind">SOHBET</span>` : "") + esc(cleanTitle(d.title));
    row.querySelector(".rtitle").title = d.title;
    row.querySelector(".bar i").style.transform = `scaleX(${d.status === "queued" ? 0 : d.pct / 100})`;
    let status = d.chat && d.status === "merging" ? "Altyazı yazılıyor…" : d.chat && d.status === "downloading" ? "Sohbet iniyor" : d.sections && d.status === "merging" && d.pct >= 100 ? "Birleştiriliyor…" : d.section && d.status === "merging" ? "Kırpılıyor…" : d.live && d.status === "merging" ? "mp4'e çevriliyor…" : STATUS[d.status];
    if (d.status === "downloading" && d.size) status += ` · ${fmtBytes(d.size * d.pct / 100)} / ${d.exact ? "" : "~"}${fmtBytes(d.size)}`;
    if (d.status === "recording") status += ` · ${d.started ? fmtDuration(Date.now() / 1000 - d.started) : ""} · ${fmtBytes(d.size)}`;
    if (d.status === "stopped" && d.pct > 0) status += " · tekrar başlatınca kaldığı yerden devam eder";
    if (d.status === "error") status += `: ${humanError(d.error)}`;
    row.querySelector(".rstatus").textContent = status;
    row.querySelector(".rstatus").title = d.status === "error" ? d.error : "";
    const nums = row.querySelector(".rnums");
    nums.innerHTML = "";
    if (d.status === "recording") nums.textContent = fmtSpeed(d.speed);
    else if (d.status !== "queued") {
      const pct = document.createElement("b");
      pct.className = "pct";
      pct.textContent = `%${Math.floor(d.pct)}`;
      nums.append(pct);
      if (d.status === "downloading") nums.append([fmtSpeed(d.speed), fmtEta(d.eta)].filter(Boolean).map((x) => ` · ${x}`).join(""));
    }
    const acts = actionsFor(d);
    const box2 = row.querySelector(".ractions");
    if (box2.dataset.k !== acts.key) { box2.dataset.k = acts.key; box2.innerHTML = acts.html; }
  });
  for (const row of box.querySelectorAll(".row")) if (!seen.has(row.dataset.id)) row.remove();
}

function actionsFor(d) {
  const b = (act, ic, label, cls = "") =>
    `<button class="iconbtn ${cls}" data-act="${act}" data-id="${d.id}" title="${label}" aria-label="${label}">${icon(ic)}</button>`;
  switch (d.status) {
    case "queued": case "preparing": case "downloading": case "merging": case "recording":
      return { key: "run", html: b("cancel", "stop", d.live ? "Kaydı durdur" : "Durdur", "danger") };
    default:
      return { key: "bad", html: b("retry", "retry", "Tekrar dene") + b("remove", "x", "Listeden kaldır") };
  }
}

/* kapagi olmayan indirme (or. canli kayit) icin kanalin resmi: favorilerden ya da acik kanaldan */
function avatarFor(url) {
  const slug = (String(url || "").match(/kick\.com\/([^/?#]+)/) || [])[1];
  if (!slug) return "";
  const f = state.favorites.find((x) => x.slug === slug.toLowerCase());
  if (f && f.avatar) return f.avatar;
  return state.channel && state.channel.slug === slug.toLowerCase() ? state.channel.avatar : "";
}

/* durum cubugu ve Indirilenler basligi ayni sozcuklerle: iniyor / sirada / canli kayit / hata */
function downloadSummary(dl) {
  const n = (f) => dl.filter(f).length;
  const parts = [
    [n((d) => ACTIVE.includes(d.status) && !d.live), "iniyor"],
    [n((d) => d.status === "queued"), "sırada"],
    [n((d) => d.live && ACTIVE.includes(d.status)), "canlı kayıt"],
    [n((d) => d.status === "stopped"), "durduruldu", "amber"],
    [n((d) => d.status === "error"), "hata", "red"],
  ].filter(([x]) => x);
  return parts.map(([x, w, c]) => (c ? `<span class="${c}">${x} ${w}</span>` : `${x} ${w}`)).join(" · ");
}

/* arka ucun ham hata metni yerine neden + ne yapilacagi; ham metin title'da kalir */
function humanError(e) {
  e = String(e || "");
  if (/^(Diskte yer yok|Yayın hâlâ sürüyor|Sohbet yalnızca)/.test(e)) return e;   // arka uc ne yapilacagini zaten soyluyor
  if (/403|forbidden/i.test(e)) return "Kick erişimi reddetti (403). Tekrar dene; sürerse video silinmiş ya da abonelere özel olabilir.";
  if (/404|not found|bulunamad/i.test(e)) return "Video bulunamadı. Silinmiş ya da gizlenmiş olabilir.";
  if (/canlı değil/i.test(e)) return "Yayıncı şu an canlı değil. Yayın başlayınca tekrar dene.";
  if (/ffmpeg/i.test(e)) return "ffmpeg bulunamadı. ffmpeg.exe'yi programın yanına koyup tekrar dene.";
  if (/disk|space|no space|errno 28/i.test(e)) return "Diskte yer kalmadı. Yer açıp tekrar dene; kaldığı yerden devam eder.";
  if (/timed? ?out|connection|network|resolve|ulaşılamadı/i.test(e)) return "Bağlantı koptu. İnterneti kontrol edip tekrar dene; kaldığı yerden devam eder.";
  if (/kesit|aralık/i.test(e)) return e;
  return `İndirme başarısız oldu. Tekrar dene. (${e.slice(0, 80)})`;
}

/* ---------- indirilenler (gecmis) ---------- */
async function refreshLibrary() {
  state.library = await state.api.library();
  if (state.view === "library") renderLibrary();
  if (state.view === "home") renderHome();
}

function dayLabel(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return "Bugün";
  if (diff === 1) return "Dün";
  return d.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: now.getFullYear() === d.getFullYear() ? undefined : "numeric" });
}

function renderLibrary() {
  const q = fold(state.libQuery);
  const items = state.library.filter((e) => !q || fold(e.title).includes(q) || fold(e.channel).includes(q));
  const groups = new Map();
  for (const e of items) {
    const k = dayLabel(e.done);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  $("libEmpty").hidden = state.library.length > 0 || state.downloads.length > 0;
  $("histGroups").innerHTML = [...groups].map(([label, list]) => `<section class="histgroup"><h2>${esc(label)}</h2>${list.map((e) => {
    const sec = e.chat ? " · sohbet altyazısı" : e.sections ? ` · ${e.sections.length} kesit birleşik` : e.section ? ` · kesit ${fmtDuration(e.section[0])}–${fmtDuration(e.section[1])}` : e.live ? " · canlı kayıt" : "";
    const time = new Date(e.done * 1000).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    const b = (act, ic, label, cls = "") => `<button class="iconbtn ${cls}" type="button" data-ins="${act}" data-file="${esc(e.file)}" title="${label}" aria-label="${label}">${icon(ic)}</button>`;
    return `<div class="hrow${e.exists ? "" : " gone"}${state.libFocus === e.file ? " on" : ""}" data-file="${esc(e.file)}" tabindex="0">
      <img class="rthumb${!e.thumb && avatarFor(e.url) ? " avfb" : ""}" src="${esc(e.thumb || avatarFor(e.url) || BLANK)}" alt="">
      <div class="rmain"><p class="rtitle" title="${esc(e.title)}">${e.chat ? `<span class="kind">SOHBET</span>` : ""}${esc(cleanTitle(e.title))}</p>
        <p class="hsub num">${esc(e.channel)}${sec} · ${fmtBytes(e.size)} · ${time}${e.exists ? "" : ` · <em>dosya yok</em>`}</p></div>
      <div class="ractions">${e.exists && !e.chat ? b("lplay", "play", "Burada oynat") + b("lopen", "external", "Windows oynatıcısında aç") : ""}${e.exists ? b("lreveal", "reveal", "Klasörde göster") : ""}
        ${b("ldel", "trash", e.exists ? "Sil (Geri Dönüşüm Kutusu'na)" : "Listeden kaldır", "danger")}</div></div>`;
  }).join("")}</section>`).join("") || (q && state.library.length ? `<p class="gridnote">Aramaya uyan dosya yok.</p>` : "");
}

function libEntry(file) {
  return state.library.find((e) => e.file === file);
}

async function playFile(file, keep) {
  const e = libEntry(file);
  state.libFocus = file;
  if (state.view !== "library") showView("library");
  renderLibrary();
  renderLibraryInspector();
  if (!e || !e.exists) return;
  if (e.chat) { player.poster(e.thumb, "Sohbet kaydı. Videoyu aynı klasörden VLC ya da MPC ile açınca sohbet ekranda akar."); return; }
  const r = await state.api.media_url(file);
  if (state.libFocus !== file) return;
  if (!r.ok) { player.poster(e.thumb, r.error); return; }
  if (!r.playable) { player.poster(e.thumb, "Bu dosya (.ts) uygulamada oynatılamıyor. Windows oynatıcısında aç."); return; }
  player.load(`file:${file}`, { file: r.url, poster: e.thumb });
}

function renderLibraryInspector() {
  const body = $("insBody"), btns = $("insBtns");
  $("qualityBox").hidden = true;
  const e = state.libFocus && libEntry(state.libFocus);
  if (!e) {
    if (!player.key || !player.key.startsWith("file:")) player.empty("Bir dosyaya tıkla, burada oynasın.");
    body.innerHTML = `<div class="insempty"><p><b>İndirdiğin bir dosyaya tıkla:</b> burada oynar.</p><p>Dosyayı Windows oynatıcısında açabilir, klasörde gösterebilir ya da silebilirsin. Silinen dosya Geri Dönüşüm Kutusu'na gider.</p></div>`;
    btns.innerHTML = "";
    return;
  }
  const facts = [["Kanal", esc(e.channel)], ["Boyut", fmtBytes(e.size)], ["İndirildi", new Date(e.done * 1000).toLocaleString("tr-TR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })]];
  if (e.sections) facts.push(["Kesitler", e.sections.map((x) => `${fmtDuration(x[0])}–${fmtDuration(x[1])}`).join(", ")]);
  else if (e.section) facts.push(["Kesit", `${fmtDuration(e.section[0])} – ${fmtDuration(e.section[1])}`]);
  facts.push(["Dosya", `<span class="num">${esc(e.file.split(/[\\/]/).pop())}</span>`]);
  body.innerHTML = `<h2>${esc(cleanTitle(e.title))}</h2><dl class="facts">${facts.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join("")}</dl>
    ${e.exists ? "" : `<p class="insnote">Dosya artık bu yolda yok. Taşınmış ya da silinmiş olabilir.</p>`}`;
  btns.innerHTML = e.exists && e.chat
    ? `<button class="btn span" data-ins="lreveal" data-file="${esc(e.file)}">${icon("reveal")}Klasörde göster</button>
       <button class="btn ghost danger span" data-ins="ldel" data-file="${esc(e.file)}">${icon("trash")}Dosyayı sil</button>`
    : e.exists
    ? `<button class="btn" data-ins="lreveal" data-file="${esc(e.file)}">${icon("reveal")}Klasörde göster</button>
       <button class="btn" data-ins="lopen" data-file="${esc(e.file)}">${icon("external")}Dışarıda aç</button>
       <button class="btn ghost danger span" data-ins="ldel" data-file="${esc(e.file)}">${icon("trash")}Dosyayı sil</button>`
    : `<button class="btn ghost span" data-ins="ldel" data-file="${esc(e.file)}">${icon("x")}Listeden kaldır</button>`;
}

async function deleteFile(file) {
  const e = libEntry(file);
  if (!e) return;
  if (e.exists && !confirm(`"${cleanTitle(e.title)}" silinsin mi?\n\nDosya Geri Dönüşüm Kutusu'na taşınır.`)) return;
  if (player.key === `file:${file}`) player.stop();     // acik dosya silinemez
  await new Promise((r) => setTimeout(r, 150));
  const res = await state.api.library_remove(file, e.exists);
  if (!res.ok) { toast(res.error); return; }
  if (state.libFocus === file) state.libFocus = null;
  toast(res.trashed ? "Dosya Geri Dönüşüm Kutusu'na taşındı" : "Listeden kaldırıldı");
  await refreshLibrary();
  renderLibraryInspector();
}

/* ---------- ayarlar ---------- */
function renderSettings() {
  const s = state.settings;
  $("setFolder").textContent = s.folder;
  fillSelect($("setQuality"), s.qualities.map((q) => [q, q]), s.quality);
  fillSelect($("setParallel"), [["auto", "Otomatik"], ...Array.from({ length: s.maxParallel }, (_, i) => [String(i + 1), String(i + 1)])], String(s.parallel));
  const th = [4, 8, 16, 24, 32, 48, 64].filter((x) => x <= s.maxFragThreads);
  fillSelect($("setThreads"), [["auto", `Otomatik (${s.autoFragThreads})`], ...th.map((x) => [String(x), String(x)])], String(s.fragThreads));
  fillSelect($("setSection"), [...$("setSection").options].map((o) => [o.value, o.textContent]), String(s.sectionLength === "auto" ? 30 : s.sectionLength));
  for (const [id, key] of SWITCHES) $(id).setAttribute("aria-checked", !!s[key]);
  fillSelect($("setLimit"), [["0", "Sınırsız"], ...[1, 2, 5, 10, 20, 50, 100].map((x) => [String(x), `${x} MB/s`])], String(s.speedLimit || 0));
  $("setVersion").textContent = `Sürüm ${state.cfg.version}.`;
  $("setVolume").value = s.volume;
  $("setVolume").style.setProperty("--v", `${s.volume}%`);
  $("setVolumeTxt").textContent = `%${s.volume}`;
  $("setName").value = s.nameTemplate;
  $("nameTokens").innerHTML = "Kullanılabilir: " + s.nameTokens.map((t) => `<button class="tok" type="button" data-tok="${t}">{${t}}</button>`).join("");
  previewName();
}

function previewName() {
  const t = $("setName").value;
  const ok = /\{(baslik|id)\}/.test(t) && !/[\\/:*?"<>|]/.test(t.replace(/\{[a-z]+\}/g, "")) &&
    (t.match(/\{([^}]*)\}/g) || []).every((x) => state.settings.nameTokens.includes(x.slice(1, -1)));
  const sample = { kanal: "xqc", baslik: "Örnek yayın başlığı", tarih: "2026-10-03", id: "dbed3e05-917" };
  $("setName").classList.toggle("bad", !ok);
  $("namePrev").classList.toggle("bad", !ok);
  $("namePrev").textContent = ok
    ? "Örnek: " + t.replace(/\{([a-z]+)\}/g, (_, k) => sample[k] ?? "") + ".mp4"
    : "Geçersiz: {baslik} ya da {id} olmalı; \\ / : * ? \" < > | kullanılamaz.";
  return ok;
}

async function saveSetting(patch, quiet) {
  const res = await state.api.set_settings(patch);
  const rejected = res.rejected || [];
  delete res.rejected;
  state.settings = res;
  if (rejected.length) toast("Bu değer kaydedilemedi");
  else if (!quiet) toast("Kaydedildi");
  return !rejected.length;
}

const SWITCHES = [["setHover", "hoverPreview"], ["setMuted", "previewMuted"], ["setNotifyDone", "notifyDone"], ["setNotifyLive", "notifyLive"],
  ["setRemux", "liveRemux"], ["setClip", "clipboardWatch"], ["setUpdate", "updateCheck"]];

function bindSettings() {
  for (const [id, key] of SWITCHES) {
    $(id).addEventListener("click", async () => {
      const on = $(id).getAttribute("aria-checked") !== "true";
      $(id).setAttribute("aria-checked", on);
      await saveSetting({ [key]: on });
      if (key === "hoverPreview" && !on) hover.stop();
    });
  }
  $("setQuality").addEventListener("change", async (e) => { await saveSetting({ quality: e.target.value }); $("quality").value = e.target.value; syncSelect($("quality")); });
  const num = (v) => (v === "auto" ? "auto" : Number(v));
  $("setParallel").addEventListener("change", (e) => saveSetting({ parallel: num(e.target.value) }));
  $("setThreads").addEventListener("change", (e) => saveSetting({ fragThreads: num(e.target.value) }));
  $("setLimit").addEventListener("change", (e) => saveSetting({ speedLimit: Number(e.target.value) }));
  $("checkUpdBtn").addEventListener("click", () => checkUpdate(true));
  $("setSection").addEventListener("change", async (e) => {
    await saveSetting({ sectionLength: Number(e.target.value) });
    applySectionLength();
  });
  $("setVolume").addEventListener("input", (e) => {
    e.target.style.setProperty("--v", `${e.target.value}%`);
    $("setVolumeTxt").textContent = `%${e.target.value}`;
  });
  $("setVolume").addEventListener("change", (e) => saveSetting({ volume: Number(e.target.value) }));
  $("setFolderBtn").addEventListener("click", async () => {
    state.settings.folder = await state.api.pick_folder();
    $("setFolder").textContent = state.settings.folder;
  });
  let nameTimer;
  $("setName").addEventListener("input", () => {
    clearTimeout(nameTimer);
    if (previewName()) nameTimer = setTimeout(() => saveSetting({ nameTemplate: $("setName").value.trim() }), 600);
  });
  $("setNameReset").addEventListener("click", () => {
    $("setName").value = state.settings.nameDefault;
    previewName();
    saveSetting({ nameTemplate: state.settings.nameDefault });
  });
  $("nameTokens").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tok]");
    if (!b) return;
    const inp = $("setName");
    const at = inp.selectionStart ?? inp.value.length;
    inp.value = inp.value.slice(0, at) + `{${b.dataset.tok}}` + inp.value.slice(inp.selectionEnd ?? at);
    inp.dispatchEvent(new Event("input"));
    inp.focus();
  });
}

function applySectionLength() {
  const s = state.settings.sectionLength;
  cut.len = s === "auto" ? 30 : s;
  $("cutLen").value = String(cut.len);
  if (!$("cutLen").value) { cut.len = 30; $("cutLen").value = "30"; }
  syncSelect($("cutLen"));
}


/* ---------- acilir menu ----------
   Yerel <select> acilinca Windows'un kendi listesini cizer ve tasarima uymaz. Her .select kutusu
   bir dugmeye ve uygulamanin kendi listesine donusur; <select> gizli kalir, deger ve change
   olayi onun uzerinden akar, boylece geri kalan kod degismez. */
const dd = { sel: null, btn: null, i: 0 };

function enhanceSelects() {
  for (const box of document.querySelectorAll(".select[data-label]")) {
    const sel = box.querySelector("select");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ddbtn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = `<span class="ddlbl"></span><span class="ddval"></span>${icon("chevron")}`;
    btn.querySelector(".ddlbl").textContent = box.dataset.label;
    sel.hidden = true;
    sel.tabIndex = -1;
    box.prepend(btn);
    btn.addEventListener("click", () => (dd.sel === sel ? closeDD(true) : openDD(sel, btn)));
    btn.addEventListener("keydown", (e) => {
      if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); openDD(sel, btn); }
    });
    sel.addEventListener("change", () => syncSelect(sel));
    syncSelect(sel);
  }
  const menu = $("ddMenu");
  menu.addEventListener("pointerdown", (e) => e.preventDefault());   // odak dugmede kalsin
  menu.addEventListener("click", (e) => {
    const li = e.target.closest("[data-i]");
    if (li) chooseDD(Number(li.dataset.i));
  });
  menu.addEventListener("pointermove", (e) => {
    const li = e.target.closest("[data-i]");
    if (li && Number(li.dataset.i) !== dd.i) { dd.i = Number(li.dataset.i); paintDD(); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (dd.sel && !e.target.closest(".ddmenu") && e.target.closest(".ddbtn") !== dd.btn) closeDD(false);
  });
  document.addEventListener("keydown", (e) => {
    if (!dd.sel) return;
    const n = dd.sel.options.length;
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp") dd.i = (dd.i + (k === "ArrowDown" ? 1 : n - 1)) % n;
    else if (k === "Home") dd.i = 0;
    else if (k === "End") dd.i = n - 1;
    else if (k === "Enter" || k === " ") { chooseDD(dd.i); }
    else if (k === "Escape") closeDD(true);
    else if (k === "Tab") { closeDD(false); return; }
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();   // modalin Esc'i ve kisayollar bu tusu gormesin
    paintDD();
  }, true);
  window.addEventListener("resize", () => closeDD(false));
}

function syncSelect(sel) {
  const btn = sel.parentElement.querySelector(".ddbtn");
  if (!btn) return;   // menuler henuz kurulmadi
  const opt = sel.options[sel.selectedIndex];
  btn.querySelector(".ddval").textContent = opt ? opt.textContent : "";
}
const syncSelects = () => document.querySelectorAll(".select[data-label] select").forEach(syncSelect);

function openDD(sel, btn) {
  closeDD(false);
  dd.sel = sel;
  dd.btn = btn;
  dd.i = Math.max(0, sel.selectedIndex);
  const menu = $("ddMenu");
  const host = btn.closest("dialog") || document.body;   // modal acikken ust katmanda kalsin
  if (menu.parentElement !== host) host.append(menu);
  menu.setAttribute("aria-label", sel.parentElement.dataset.label);
  menu.innerHTML = [...sel.options].map((o, i) =>
    `<li role="option" data-i="${i}" aria-selected="${i === sel.selectedIndex}">${icon("check")}<span></span></li>`).join("");
  [...sel.options].forEach((o, i) => { menu.children[i].querySelector("span").textContent = o.textContent; });
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  menu.style.minWidth = `${r.width}px`;
  const h = menu.offsetHeight;
  const below = window.innerHeight - r.bottom - 8;
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${below >= h || below > r.top ? r.bottom + 4 : r.top - h - 4}px`;
  menu.classList.toggle("up", !(below >= h || below > r.top));
  btn.setAttribute("aria-expanded", "true");
  btn.parentElement.classList.add("open");
  paintDD();
}

function paintDD() {
  [...$("ddMenu").children].forEach((li, i) => li.classList.toggle("active", i === dd.i));
}

function chooseDD(i) {
  const sel = dd.sel;
  closeDD(true);
  if (sel.selectedIndex !== i) {
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function closeDD(focusBtn) {
  if (!dd.sel) return;
  $("ddMenu").hidden = true;
  dd.btn.setAttribute("aria-expanded", "false");
  dd.btn.parentElement.classList.remove("open");
  if (focusBtn) dd.btn.focus();
  dd.sel = dd.btn = null;
}

/* ---------- kesit editoru ---------- */
const MIN_CUT = 5;          // bir kesit en az bu kadar saniye
const MIN_VIEW = 20;        // en fazla yakinlasinca cizelgede gorunen saniye
const TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const cut = {
  vod: null, hls: null, peekHls: null,
  sel: null,                 // secili kesitin id'si
  view: [0, 0],              // cizelgede gorunen aralik (sn)
  drag: null,                // suren surukleme
  stopAt: null,              // "kesiti oynat": bu saniyede dur
  chain: null,               // "sirayla oynat": siradaki kesitlerin id'leri
  markIn: null,              // I ile konan giris; O ile kesit olur
  mode: "split",             // indirme: her kesit ayri dosya ("split") ya da tek video ("merge")
  len: 30,
  seq: 1,
  raf: 0,
  main: null, peek: null,    // seyrek seek yapan yardimcilar
  strip: null,               // cizelgenin kare/ses seridi: { uuid, segs, pps, fe, data, busy, note }
  src: "",                   // onizlemenin HLS adresi (canlida "Canliya git" yeniden yukler)
  stripTimer: 0,
};
const LIVE_BACK = 60;       // canlidan kesitte oynatici yayinin ucundan bu kadar once acilir
const RATES = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];
const WAVE_MAX = 900;       // ses dalgasi bu kadar saniye ve alti gorunumde cizilir
const frameW = (el) => Math.round((el.clientHeight || 52) * 16 / 9);   // seritteki bir karenin genisligi

function parseTime(text) {
  const t = (text || "").trim().replace(/[.,]/g, ":");
  if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
  return t.split(":").reduce((a, x) => a * 60 + Number(x), 0);
}
const cutClips = () => state.cuts.get(cut.vod.url) || [];
const selClip = () => cutClips().find((c) => c.id === cut.sel) || null;
const cutDuration = () => {
  const v = $("cutVideo");
  const d = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  // canlida "Canliya git" sonrasi video bir an eski (kisa) suresini tasir: yeni uzunluk gecsin
  return cut.vod.live ? Math.max(d, cut.vod.duration || 0) : d || cut.vod.duration || 0;
};

/* Kaydirirken her harekette seek atmak oynaticiyi bogar: yalnizca son istenen ana,
   onceki seek bitince git. */
function makeSeeker(video) {
  let want = null, busy = false, guard = 0;
  const step = () => {
    if (want == null) { busy = false; return; }
    busy = true;
    video.currentTime = want;
    want = null;
    clearTimeout(guard);
    guard = setTimeout(step, 1500);
  };
  video.addEventListener("seeked", () => { clearTimeout(guard); step(); });
  return {
    to(t) { want = t; if (!busy) step(); },
    get pending() { return want; },
    reset() { want = null; busy = false; clearTimeout(guard); },
  };
}

function lowestLevel(hls) {
  let best = 0;
  hls.levels.forEach((l, i) => { if (l.bitrate < hls.levels[best].bitrate) best = i; });
  return best;
}

async function openCutter(vod) {
  if (!vod) return;
  cut.vod = vod;
  cut.sel = null;
  cut.stopAt = null;
  cut.chain = null;
  cut.markIn = null;
  if (!state.cuts.has(vod.url)) state.cuts.set(vod.url, []);
  $("cutTitle").textContent = cleanTitle(vod.title);
  $("cutTitle").title = vod.title;
  const ch = state.channel;
  $("cutMeta").textContent = [ch && (ch.name || ch.slug), vod.live ? `canlı · ${fmtAgo(vod.start)} başladı` : vod.start && fmtDate(vod.start),
    vod.duration && fmtDuration(vod.duration)].filter(Boolean).join(" · ");
  $("cutLive").hidden = !vod.live;
  const video = $("cutVideo");
  video.poster = vod.thumb || "";
  video.muted = false;
  cut.view = [0, Math.min(WAVE_MAX, vod.duration || WAVE_MAX)];   // 15 dk'lik yakin gorunumle ac
  cut.strip = { uuid: vod.uuid, segs: null, data: new Map(), thumbs: new Map(), busy: 0, tbusy: 0, note: "" };
  loadStrip(cut.strip);
  setRate(Number($("cutRate").value));
  cutterMsg("Video yükleniyor…");
  $("cutter").showModal();
  renderCutter();   // dialog acikken: serit genislikleri olculebilsin
  $("cutter").focus();   // ilk dugme odak almasin; klavye kisayollari dogrudan calissin
  cut.raf = requestAnimationFrame(tick);
  const res = await state.api.vod_source(vod.uuid, !!vod.live);
  if (cut.vod !== vod || !$("cutter").open) return;
  if (!res.ok) { cutterMsg(res.error + " Kesit yine eklenebilir; saatlerini sağdan yazarsın."); return; }
  cut.src = res.source;
  attachCut(res.duration);
}

/* onizlemeyi baglar. Canlida "dur" o anki yayin uzunlugu: oynatici ve cizelge sondan acilir. */
function attachCut(dur) {
  const video = $("cutVideo");
  for (const k of ["hls", "peekHls"]) if (cut[k]) { cut[k].destroy(); cut[k] = null; }
  const live = cut.vod.live && dur;
  if (live) {
    cut.vod.duration = dur;    // video suresi gelene kadar cizelge bunu kullansin
    setView(dur - WAVE_MAX, dur);
    drawTimeline();
  }
  if (!(window.Hls && Hls.isSupported())) { video.src = cut.src; cutterMsg(""); return; }
  cut.hls = new Hls({ maxBufferLength: 20, startPosition: live ? Math.max(0, dur - LIVE_BACK) : -1 });
  cut.hls.on(Hls.Events.ERROR, (_, d) => {
    if (d.fatal) cutterMsg("Önizleme oynatılamadı. Kesit yine eklenebilir; saatlerini sağdan yazarsın.");
  });
  cut.hls.on(Hls.Events.MANIFEST_PARSED, () => cutterMsg(""));
  cut.hls.loadSource(cut.src);
  cut.hls.attachMedia(video);
  // cizelgenin ustundeki kucuk onizleme: ayni yayin, en dusuk kalite, yalnizca kare gostermek icin
  const pv = $("peekVideo");
  cut.peekHls = new Hls({ maxBufferLength: 4, maxMaxBufferLength: 8, startFragPrefetch: false });
  cut.peekHls.on(Hls.Events.MANIFEST_PARSED, () => {
    const lo = lowestLevel(cut.peekHls);
    cut.peekHls.startLevel = lo;
    cut.peekHls.currentLevel = lo;
  });
  cut.peekHls.loadSource(cut.src);
  cut.peekHls.attachMedia(pv);
}

/* canlidan kesit: yayinin son anini yukler (liste her istekte uzar), oraya gider; kesitler kalir */
async function cutToLive() {
  const vod = cut.vod;
  if (!vod || !vod.live || !cut.src) return;
  $("cutLive").disabled = true;
  cutterMsg("Son an yükleniyor…");
  const playing = !$("cutVideo").paused;
  const res = await state.api.vod_source(vod.uuid, true);
  $("cutLive").disabled = false;
  if (cut.vod !== vod) return;
  if (!res.ok || !res.duration) { cutterMsg(""); toast("Yayının son anı alınamadı"); return; }
  cut.main.reset();
  cut.peek.reset();
  attachCut(res.duration);
  if (playing) $("cutVideo").addEventListener("canplay", () => $("cutVideo").play().catch(() => {}), { once: true });
  if (cut.strip) loadStrip(cut.strip, true);
}

function closeCutter() {
  cancelAnimationFrame(cut.raf);
  for (const k of ["hls", "peekHls"]) if (cut[k]) { cut[k].destroy(); cut[k] = null; }
  for (const id of ["cutVideo", "peekVideo"]) {
    const v = $(id);
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
  cut.main.reset();
  cut.peek.reset();
  cut.drag = null;
  cut.chain = null;
  cut.markIn = null;
  cut.strip = null;
  cut.src = "";
  clearTimeout(cut.stripTimer);
  closeDD(false);
  showKeys(false);
  if ($("cutter").open) $("cutter").close();
  if (cut.vod && !cutClips().length) state.cuts.delete(cut.vod.url);
  cut.vod = null;
}

function cutterMsg(msg) {
  $("cutMsg").hidden = !msg;
  $("cutMsg").textContent = msg;
}

function showKeys(on) {
  $("keysPop").hidden = !on;
  $("cutKeys").setAttribute("aria-expanded", String(on));
}

/* zaman: oynatici seek beklerken istenen ani goster, yoksa gercek ani */
const nowTime = () => cut.main.pending ?? $("cutVideo").currentTime;

function seekTo(t) {
  const dur = cutDuration();
  t = clamp(t, 0, dur || Infinity);
  cut.stopAt = null;
  if (cut.chain) { cut.chain = null; renderCutter(); }
  cut.main.to(t);
  followView(t, true);
}

/* ---------- kesitler ---------- */
function normalize(c) {
  const dur = cutDuration() || Infinity;
  c.a = Math.round(clamp(c.a, 0, dur));
  c.b = Math.round(clamp(c.b, 0, dur));
  if (c.b - c.a < MIN_CUT) {
    c.b = Math.min(dur, c.a + MIN_CUT);
    if (c.b - c.a < MIN_CUT) c.a = Math.max(0, c.b - MIN_CUT);
  }
  return c;
}

function sortClips() {
  cutClips().sort((x, y) => x.a - y.a || x.b - y.b);
}

function pushClip(c) {
  const list = cutClips();
  if (list.some((x) => x.a === c.a && x.b === c.b)) { toast("Bu kesit zaten listede"); return; }
  list.push(c);
  sortClips();
  cut.sel = c.id;
  followView(c.a, false);
  followView(c.b, false);
  renderCutter();
  const li = $("cutList").querySelector(`[data-id="${c.id}"]`);
  li && li.scrollIntoView({ block: "nearest" });
}

function addClipHere() {
  const dur = cutDuration();
  if (dur && dur < MIN_CUT) { toast("Video kesit için çok kısa"); return; }
  const t = nowTime();
  // genelde bir sey olduktan hemen sonra basilir: uzunlugun 2/3'u oncesinden, 1/3'u sonrasindan
  let a = t - (cut.len * 2) / 3;
  if (a < 0) a = 0;
  let b = a + cut.len;
  if (dur && b > dur) { b = dur; a = Math.max(0, b - cut.len); }
  pushClip(normalize({ id: cut.seq++, a, b }));
}

/* I: giris isareti. Ayni saniyede ikinci kez basmak isareti kaldirir. */
function markIn() {
  const t = Math.round(nowTime());
  cut.markIn = cut.markIn === t ? null : t;
  paintMarks();
}

/* O: girisle bu an arasini kesit yapar; giris yoksa buradan geriye hazir uzunlukta */
function markOut() {
  const dur = cutDuration();
  if (dur && dur < MIN_CUT) { toast("Video kesit için çok kısa"); return; }
  const t = nowTime();
  const c = cut.markIn != null
    ? { id: cut.seq++, a: Math.min(cut.markIn, t), b: Math.max(cut.markIn, t) }
    : { id: cut.seq++, a: Math.max(0, t - cut.len), b: t };
  if (cut.markIn != null && c.b - c.a < MIN_CUT) toast(`Kesit en az ${MIN_CUT} sn; çıkış uzatıldı`);
  cut.markIn = null;
  pushClip(normalize(c));
}

function setEdge(c, edge, t) {
  const dur = cutDuration() || Infinity;
  t = Math.round(clamp(t, 0, dur));
  if (edge === "a") { c.a = t; if (c.b - c.a < MIN_CUT) c.b = Math.min(dur, c.a + MIN_CUT); }
  else { c.b = t; if (c.b - c.a < MIN_CUT) c.a = Math.max(0, c.b - MIN_CUT); }
  normalize(c);
}

function removeClip(id) {
  const list = cutClips();
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return;
  list.splice(i, 1);
  if (cut.sel === id) cut.sel = (list[i] || list[i - 1] || {}).id ?? null;
  renderCutter();
}

function playClip(c) {
  cut.chain = null;
  cut.sel = c.id;
  cut.main.to(c.a);
  cut.stopAt = c.b;
  followView(c.a, false);
  followView(c.b, false);
  $("cutVideo").play();
  renderCutter();
}

/* sirayla oynat: kesitleri aralarini atlayarak arka arkaya oynatir; calarken basmak durdurur */
function toggleChain() {
  if (cut.chain) {
    cut.chain = null;
    cut.stopAt = null;
    $("cutVideo").pause();
    renderCutter();
    return;
  }
  if (!cutClips().length) return;
  cut.chain = cutClips().map((c) => c.id);
  nextInChain();
}

function nextInChain() {
  const c = cutClips().find((x) => x.id === cut.chain.shift());
  if (!c) {
    if (cut.chain.length) { nextInChain(); return; }
    cut.chain = null;
    renderCutter();
    return;
  }
  cut.sel = c.id;
  cut.main.to(c.a);
  cut.stopAt = c.b;
  followView(c.a, false);
  followView(c.b, false);
  $("cutVideo").play();
  renderCutter();
}

/* yukari/asagi: bir onceki/sonraki kesit kenarina (ve giris isaretine) atla */
function jumpEdge(dir) {
  const edges = new Set(cutClips().flatMap((c) => [c.a, c.b]));
  if (cut.markIn != null) edges.add(cut.markIn);
  const sorted = [...edges].sort((x, y) => x - y);
  const t = nowTime();
  const to = dir < 0 ? sorted.filter((x) => x < t - 0.25).pop() : sorted.find((x) => x > t + 0.25);
  if (to == null) { toast(sorted.length ? (dir < 0 ? "Daha önce kenar yok" : "Daha sonra kenar yok") : "Henüz kesit yok"); return; }
  seekTo(to);
}

/* ---------- cizelge ---------- */
function setView(s, e) {
  const dur = cutDuration();
  if (!dur) { cut.view = [0, 0]; return; }
  let span = clamp(e - s, Math.min(MIN_VIEW, dur), dur);
  s = clamp(s, 0, dur - span);
  cut.view = [s, s + span];
}

function zoomSpan(span, anchor) {
  const [s, e] = cut.view;
  const dur = cutDuration();
  if (!dur) return;
  span = clamp(span, Math.min(MIN_VIEW, dur), dur);
  const k = (anchor - s) / (e - s || 1);
  setView(anchor - k * span, anchor - k * span + span);
  drawTimeline();
}
const zoomAt = (factor, anchor) => zoomSpan((cut.view[1] - cut.view[0]) * factor, anchor);

/* yakinlik kaydiricisi logaritmik: 0 = tum yayin, 1000 = en yakin */
function zoomLevel() {
  const dur = cutDuration(), lo = Math.min(MIN_VIEW, dur);
  return dur > lo ? (1000 * Math.log(dur / (cut.view[1] - cut.view[0]))) / Math.log(dur / lo) : 0;
}
function zoomAnchor() {
  const t = nowTime();
  const [s, e] = cut.view;
  return t >= s && t <= e ? t : (s + e) / 2;
}

/* oynatma cizgisi gorunen aralik disina cikinca cizelgeyi kaydir */
function followView(t, center) {
  const [s, e] = cut.view;
  const span = e - s;
  if (!span || (t >= s && t <= e)) return;
  const ns = center ? t - span / 2 : t < s ? t - span * 0.1 : t - span * 0.9;
  setView(ns, ns + span);
}

const xOf = (t) => {
  const [s, e] = cut.view;
  return e > s ? ((t - s) / (e - s)) * 100 : 0;
};
function timeAt(clientX) {
  const r = $("tlLane").getBoundingClientRect();
  const [s, e] = cut.view;
  return s + clamp((clientX - r.left) / r.width, 0, 1) * (e - s);
}

function fmtSpan(sec) {
  if (sec < 90) return `${Math.round(sec)} sn`;
  if (sec < 5400) return `${Math.round(sec / 60)} dk`;
  return `${(sec / 3600).toFixed(1).replace(".", ",").replace(",0", "")} sa`;
}

function drawTimeline() {
  if (!cut.vod) return;
  const dur = cutDuration();
  if (dur && !(cut.view[1] > cut.view[0])) setView(0, Math.min(WAVE_MAX, dur));
  const [s, e] = cut.view;
  const span = e - s;
  const width = $("tlLane").clientWidth || 800;

  // cetvel: etiketler en az ~90px aralikla
  const step = TICKS.find((x) => (x / span) * width >= 90) || 7200;
  const minor = step / ([1, 10, 60, 600, 3600].includes(step) ? 2 : step % 3 === 0 ? 3 : 5);
  let html = "";
  if (span > 0) {
    for (let t = Math.ceil(s / minor) * minor; t <= e; t += minor) {
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      html += `<i class="${major ? "maj" : "min"}" style="left:${xOf(t)}%"></i>`;
      if (major && xOf(t) < 96) html += `<span style="left:${xOf(t)}%">${fmtDuration(t)}</span>`;
    }
  }
  $("tlRuler").innerHTML = html;

  // kesit bloklari
  const lane = $("tlLane");
  lane.innerHTML = "";
  cutClips().forEach((c, i) => {
    if (c.b < s || c.a > e) return;
    const el = document.createElement("div");
    el.className = "clip" + (c.id === cut.sel ? " sel" : "");
    el.dataset.id = c.id;
    const l = xOf(c.a), w = xOf(c.b) - l;
    el.style.left = `${l}%`;
    el.style.width = `${w}%`;
    const px = (w / 100) * width;
    el.classList.toggle("tiny", px < 40);   // dar blokta tutamac yok; once yakinlas
    el.innerHTML = `${px >= 22 ? `<b class="num">${i + 1}</b>` : ""}${px > 76 ? `<span class="num">${fmtDuration(c.b - c.a)}</span>` : ""}` +
      (c.id === cut.sel && px >= 40 ? `<i class="grip" data-edge="a" title="Başlangıcı sürükle"></i><i class="grip" data-edge="b" title="Bitişi sürükle"></i>` : "");
    el.title = `${i + 1}. kesit · ${fmtDuration(c.a)} – ${fmtDuration(c.b)} · çift tık: oynat`;
    lane.append(el);
  });

  // kesitlerin kare ve ses seridi uzerindeki izi
  $("tlBands").innerHTML = cutClips().filter((c) => c.b >= s && c.a <= e).map((c) =>
    `<i class="${c.id === cut.sel ? "sel" : ""}" style="left:${xOf(c.a)}%;width:${xOf(c.b) - xOf(c.a)}%"></i>`).join("");

  // genel bakis; gorunen bolum kutusu cok yakinlasinca 28px'in altina inmez
  const pct = (t) => (dur ? `${(100 * t) / dur}%` : "0");
  $("ovClips").innerHTML = cutClips().map((c) =>
    `<i class="${c.id === cut.sel ? "sel" : ""}" style="left:${pct(c.a)};width:${pct(c.b - c.a)}"></i>`).join("");
  const ovW = $("ovBar").clientWidth;
  if (dur && ovW) {
    let w = (span / dur) * ovW, l = (s / dur) * ovW;
    if (w < 28) { l += w / 2 - 14; w = 28; }
    $("ovView").style.left = `${clamp(l, 0, ovW - w)}px`;
    $("ovView").style.width = `${w}px`;
  }
  $("ovBar").classList.toggle("full", !dur || span >= dur - 0.5);
  $("tlSpan").textContent = !dur ? "Süre bilinmiyor" : span >= dur - 0.5
    ? `Tüm yayın · ${fmtDuration(dur)}`
    : `${fmtDuration(s)} – ${fmtDuration(e)} · ${fmtSpan(span)}`;
  const zr = $("zoomRange");
  zr.disabled = !dur || dur <= MIN_VIEW;
  zr.value = String(Math.round(zoomLevel()));
  zr.style.setProperty("--v", `${zr.value / 10}%`);
  $("zoomIn").disabled = !dur || span <= Math.min(MIN_VIEW, dur) + 0.5;
  $("zoomOut").disabled = $("zoomFit").disabled = !dur || span >= dur - 0.5;
  drawStrip();
  scheduleStrip();
  paintHeads();
}

/* ---------- kare ve ses seridi ---------- */
async function loadStrip(st, fresh) {
  const res = await state.api.strip_index(st.uuid, !!fresh);
  if (cut.strip !== st) return;
  if (!res.ok) { st.note = res.error; state.api.client_log(`strip_index: ${res.error}`); drawStrip(); return; }
  st.segs = res.segments;
  st.pps = res.peaksPerSec;
  st.fe = res.frameEvery;
  drawTimeline();
}

function segAt(segs, t) {
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/* t anindaki kare: tam veri varsa 2 sn'lik kare, yoksa parcanin ilk karesi */
function frameAt(st, t) {
  if (!st || !st.segs) return "";
  const k = segAt(st.segs, t);
  const d = st.data.get(k);
  if (d && d.frames.length) return d.frames[clamp(Math.floor((t - st.segs[k][0]) / st.fe), 0, d.frames.length - 1)];
  return st.thumbs.get(k) || "";
}

/* bir seridin karelerinin ortasina dusen anlar */
function tileTimes(el, s, span) {
  const w = el.clientWidth, fw = frameW(el);
  if (!w || !span) return [];
  return Array.from({ length: Math.ceil(w / fw) }, (_, i) => s + ((i + 0.5) * fw * span) / w);
}

/* hizli ilk kareler: once gorunen serit, sonra kesit kartlari, sonra tum yayin seridi */
function wantedThumbs(st) {
  if (!st.segs) return [];
  const [s, e] = cut.view;
  const times = [
    ...tileTimes($("tlFilm"), s, e - s),
    ...cutClips().map((c) => c.a + 0.5),
    ...tileTimes($("ovFilm"), 0, cutDuration()),
  ];
  const out = [...new Set(times.map((t) => segAt(st.segs, t)))];
  return out.filter((i) => !st.data.get(i) && !st.thumbs.has(i));
}

/* tam veri (ses + 2 sn'de bir kare) yalnizca ses dalgasi cizilecekse: oynatma cizgisine
   en yakindan baslayarak araliktaki tum parcalar */
function wantedSegs(st) {
  const [s, e] = cut.view;
  if (!st.segs || !(e > s) || e - s > WAVE_MAX) return [];
  const a = segAt(st.segs, s), b = segAt(st.segs, e), mid = segAt(st.segs, clamp(nowTime(), s, e));
  const want = [];
  for (let i = a; i <= b; i++) if (!st.data.has(i)) want.push(i);
  return want.sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid));
}

function scheduleStrip() {
  clearTimeout(cut.stripTimer);
  cut.stripTimer = setTimeout(pumpStrip, 120);
}

async function pumpStrip() {
  const st = cut.strip;
  if (!st || !st.segs) return;
  while (st.tbusy < 2) {
    const batch = wantedThumbs(st).slice(0, 16);
    if (!batch.length) break;
    batch.forEach((i) => st.thumbs.set(i, null));   // yolda
    st.tbusy++;
    const done = (res) => {
      if (cut.strip !== st) return;
      st.tbusy--;
      const failed = batch.filter((i) => !(res && res[i]));
      for (const i of batch) st.thumbs.set(i, (res && res[i]) || "");   // "": denendi, alinamadi
      drawStrip();
      if (failed.length) setTimeout(() => {   // alinamayanlar biraz sonra yeniden denensin
        if (cut.strip !== st) return;
        failed.forEach((i) => { if (st.thumbs.get(i) === "") st.thumbs.delete(i); });
        pumpStrip();
      }, 3000);
      if (res) pumpStrip();
    };
    state.api.strip_thumbs(st.uuid, batch).then(done, (err) => {
      state.api.client_log(`strip_thumbs hatasi: ${err && (err.message || err)}`);
      done(null);
    });
  }
  if (st.tbusy) return;   // once kareler: ses istekleriyle ayni anda hat paylasilinca ilk kareler 2 kat gec geliyor
  while (st.busy < 2) {
    const batch = wantedSegs(st).slice(0, 8);
    if (!batch.length) return;
    batch.forEach((i) => st.data.set(i, null));   // yolda
    st.busy++;
    // bir istek hata verse de kuyruk kilitlenmesin; basarisiz parcalar bir sure sonra yeniden istenir
    const done = (res) => {
      if (cut.strip !== st) return;
      st.busy--;
      let failed = false;
      for (const i of batch) {
        const d = res && res[i];
        if (d && !d.failed) st.data.set(i, d);
        else { st.data.delete(i); failed = true; }
      }
      drawStrip();
      if (failed) { clearTimeout(cut.stripTimer); cut.stripTimer = setTimeout(pumpStrip, 3000); }
      else pumpStrip();
    };
    state.api.strip_data(st.uuid, batch).then(done, (err) => {
      state.api.client_log(`strip_data hatasi: ${err && (err.message || err)}`);
      done(null);
    });
  }
}

/* bir kare seridini (yakin gorunum ya da tum yayin) karelerle doldurur */
function paintFilm(el, s, span, st) {
  const times = st.segs ? tileTimes(el, s, span) : [];
  const fw = frameW(el);
  while (el.children.length < times.length) el.append(document.createElement("i"));
  while (el.children.length > times.length) el.lastChild.remove();
  times.forEach((t, i) => {
    const tile = el.children[i];
    const src = frameAt(st, t);
    const k = segAt(st.segs, t);
    tile.style.left = `${i * fw}px`;
    tile.style.width = `${fw}px`;
    tile.classList.toggle("wait", !src && !st.data.get(k) && st.thumbs.get(k) !== "");   // alinamayan bos kalir, yanip sonmez
    if (tile.dataset.src !== src) { tile.dataset.src = src; tile.style.backgroundImage = src ? `url("${src}")` : ""; }
  });
}

function paintCutThumbs() {   // kesit listesindeki kucuk kareler (izgaradaki paintCards ayri)
  const st = cut.strip;
  for (const li of $("cutList").children) {
    const c = cutClips().find((x) => x.id === Number(li.dataset.id));
    const el = li.querySelector(".cthumb");
    if (!c || !el) continue;
    const src = frameAt(st, c.a + 0.5);
    if (el.dataset.src !== src) { el.dataset.src = src; el.style.backgroundImage = src ? `url("${src}")` : ""; }
  }
}

function drawStrip() {
  const st = cut.strip;
  if (!st) return;
  const [s, e] = cut.view;
  const span = e - s;
  paintFilm($("tlFilm"), s, span, st);
  paintFilm($("ovFilm"), 0, cutDuration(), st);
  paintCutThumbs();

  // ses dalgasi
  const cv = $("tlWave");
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  const waiting = st.segs && span <= WAVE_MAX && !st.data.get(segAt(st.segs, s + span / 2));
  const note = st.note || (!st.segs ? "Kareler ve ses yükleniyor…" : span > WAVE_MAX
    ? `Ses dalgası için yakınlaş (${WAVE_MAX / 60} dk ve altı)` : waiting ? "Ses yükleniyor…" : "");
  $("waveNote").hidden = !note;
  $("waveNote").textContent = note;
  if ((note && !waiting) || !span) return;   // yuklenirken gelen parcalar yine cizilsin
  const mid = ch / 2;
  g.fillStyle = "#2a2a2a";
  g.fillRect(0, mid - 0.5, cw, 1);
  const clips = cutClips();
  const css = getComputedStyle(document.documentElement);
  const on = css.getPropertyValue("--accent").trim(), off = "#6b737d";
  const per = span / cw;
  for (let x = 0; x < cw; x++) {
    const t0 = s + x * per, t1 = t0 + per;
    let peak = -1;
    for (let t = t0; t < t1 || peak < 0; t += 1 / st.pps) {
      const k = segAt(st.segs, t);
      const d = st.data.get(k);
      if (!d) { if (t >= t1) break; continue; }
      const v = d.peaks[Math.floor((t - st.segs[k][0]) * st.pps)];
      if (v != null && v > peak) peak = v;
      if (t >= t1) break;
    }
    if (peak < 0) continue;
    const tm = t0 + per / 2;
    g.fillStyle = clips.some((c) => tm >= c.a && tm <= c.b) ? on : off;
    const hh = Math.max(1, (peak / 255) * (mid - 2));
    g.fillRect(x, mid - hh, 1, hh * 2);
  }
}

/* giris isareti: cetveldeki bayrak, giristen oynatma cizgisine kadar bekleyen kesit ve videodaki not */
function paintMarks() {
  const m = cut.markIn;
  const on = m != null && !!cut.vod;
  $("markIn").classList.toggle("on", on);
  $("markIn").setAttribute("aria-pressed", String(on));
  const t = on ? nowTime() : 0;
  const xi = on ? xOf(m) : 0;
  $("tlIn").hidden = !on || xi < 0 || xi > 100;
  if (on) $("tlIn").style.left = `${xi}%`;
  const l = on ? clamp(Math.min(xi, xOf(t)), 0, 100) : 0, r = on ? clamp(Math.max(xi, xOf(t)), 0, 100) : 0;
  $("tlPending").hidden = !on || r - l <= 0;
  if (on) { $("tlPending").style.left = `${l}%`; $("tlPending").style.width = `${r - l}%`; }
  const flag = on ? `Giriş ${fmtDuration(m)} · ${fmtDuration(Math.abs(t - m))} · bitirmek için O` : "";
  $("markFlag").hidden = !on;
  if ($("markFlag").textContent !== flag) $("markFlag").textContent = flag;
}

function paintHeads() {
  const v = $("cutVideo");
  const dur = cutDuration();
  const t = nowTime();
  $("cutNow").textContent = fmtDuration(t);
  $("cutDur").textContent = dur ? fmtDuration(dur) : "–";
  const x = xOf(t);
  $("tlHead").hidden = !dur || x < 0 || x > 100;
  $("tlHead").style.left = `${x}%`;
  $("ovHead").style.left = dur ? `${(100 * t) / dur}%` : "0";
  const icon_ = v.paused ? "play" : "pause";
  if ($("cutPlay").dataset.ic !== icon_) { $("cutPlay").dataset.ic = icon_; $("cutPlay").innerHTML = icon(icon_); }
  const mute = v.muted ? "mute" : "volume";
  if ($("cutMute").dataset.ic !== mute) { $("cutMute").dataset.ic = mute; $("cutMute").innerHTML = icon(mute); }
  paintMarks();
}

function tick() {
  if (!cut.vod) return;
  const v = $("cutVideo");
  if (cut.stopAt != null && cut.main.pending == null && v.currentTime >= cut.stopAt) {
    cut.stopAt = null;
    if (cut.chain && cut.chain.length) nextInChain();
    else {
      v.pause();
      if (cut.chain) { cut.chain = null; renderCutter(); }
    }
  }
  if (!v.paused && !cut.drag) {
    const [s, e] = cut.view;
    if (v.currentTime > e || v.currentTime < s) { followView(v.currentTime, false); drawTimeline(); }
  }
  paintHeads();
  cut.raf = requestAnimationFrame(tick);
}

function showPeek(clientX) {
  const dur = cutDuration();
  if (!dur) return;
  const t = timeAt(clientX);
  const track = $("tlTrack").getBoundingClientRect();
  const lane = $("tlLane").getBoundingClientRect();
  const x = clientX - track.left;
  $("tlHover").hidden = false;
  $("tlHover").style.left = `${x}px`;
  const peek = $("tlPeek");
  peek.hidden = false;
  const half = peek.offsetWidth / 2;
  peek.style.left = `${clamp(x, lane.left - track.left + half, lane.right - track.left - half)}px`;
  $("peekTime").textContent = fmtDuration(t);
  if (cut.peekHls) cut.peek.to(t);
}
function hidePeek() {
  $("tlHover").hidden = true;
  $("tlPeek").hidden = true;
}

/* ---------- yan panel ---------- */
function renderCutter() {
  if (!cut.vod) return;
  const list = cutClips();
  const ol = $("cutList");
  ol.innerHTML = "";
  list.forEach((c, i) => {
    const li = document.createElement("li");
    const sel = c.id === cut.sel;
    li.className = "cutrow" + (sel ? " sel" : "");
    li.dataset.id = c.id;
    li.innerHTML = `
      <div class="cuttop">
        <button class="cutpick" type="button" data-act="select" aria-pressed="${sel}">
          <span class="cthumb"><b class="no num">${i + 1}</b></span>
          <span class="ctext">
            <span class="rng num">${fmtDuration(c.a)} – ${fmtDuration(c.b)}</span>
            <span class="len num">${fmtDuration(c.b - c.a)}</span>
          </span>
        </button>
        <div class="cacts">
          <button class="iconbtn" data-act="play" type="button" title="Bu kesiti oynat" aria-label="Bu kesiti oynat">${icon("play")}</button>
          <button class="iconbtn danger" data-act="del" type="button" title="Kesiti sil (Del)" aria-label="Kesiti sil">${icon("trash")}</button>
        </div>
      </div>` + (sel ? `
      <div class="cutedit">
        ${["a", "b"].map((k) => `
        <div class="edgerow">
          <span class="edgelbl">${k === "a" ? "Başlangıç" : "Bitiş"}</span>
          <div class="stepper">
            <button type="button" data-act="nudge" data-edge="${k}" data-d="-1" title="1 sn geri" aria-label="${k === "a" ? "Başlangıç" : "Bitiş"} 1 sn geri">${icon("minus")}</button>
            <input class="num" data-edge="${k}" aria-label="${k === "a" ? "Başlangıç" : "Bitiş"}" spellcheck="false" value="${fmtDuration(c[k])}">
            <button type="button" data-act="nudge" data-edge="${k}" data-d="1" title="1 sn ileri" aria-label="${k === "a" ? "Başlangıç" : "Bitiş"} 1 sn ileri">${icon("plus")}</button>
          </div>
          <button class="iconbtn" type="button" data-act="here" data-edge="${k}" title="${k === "a" ? "Başlangıcı" : "Bitişi"} oynatma çizgisine çek (Shift+${k === "a" ? "I" : "O"})" aria-label="${k === "a" ? "Başlangıcı" : "Bitişi"} oynatma çizgisine çek">${icon("here")}</button>
        </div>`).join("")}
      </div>` : "");
    ol.append(li);
  });
  $("cutEmpty").hidden = list.length > 0;
  $("cutCount").textContent = list.length || "";
  const total = list.reduce((s, c) => s + c.b - c.a, 0);
  const merge = cut.mode === "merge" && list.length > 1;
  for (const b of document.querySelectorAll(".outmode [data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === cut.mode));
  $("cutInfo").textContent = !list.length ? `Kalite ${$("quality").value} · kesit en az ${MIN_CUT} sn`
    : merge ? `${list.length} kesit tek dosyada · ${fmtDuration(total)} · ${$("quality").value}`
    : `${list.length} dosya · toplam ${fmtDuration(total)} · ${$("quality").value}`;
  $("cutDownload").disabled = !list.length;
  $("cutDownloadLabel").textContent = merge ? "Birleştirip indir" : list.length > 1 ? `${list.length} kesiti indir` : "Kesiti indir";
  $("cutDel").disabled = cut.sel == null;
  $("cutChain").disabled = !list.length;
  $("cutChain").innerHTML = cut.chain ? `${icon("pause")}<span>Durdur</span>` : `${icon("play")}<span>Sırayla oynat</span>`;
  $("cutAdd").title = `Bulunduğun anın etrafına ${fmtSpan(cut.len)} kesit ekle (K): ` +
    `${fmtSpan((cut.len * 2) / 3)} öncesi, ${fmtSpan(cut.len / 3)} sonrası`;
  drawTimeline();
}

async function downloadCuts() {
  const vod = cut.vod;
  const list = cutClips();
  if (!list.length) return;
  const title = cleanTitle(vod.title);
  const merge = cut.mode === "merge" && list.length > 1;
  const items = merge
    ? [{ url: vod.url, thumb: vod.thumb, sections: list.map((c) => [c.a, c.b]), title: `${list.length} kesit · ${title}` }]
    : list.map((c) => ({
      url: vod.url, thumb: vod.thumb, start: c.a, end: c.b,
      title: `${fmtDuration(c.a)}–${fmtDuration(c.b)} · ${title}`,
    }));
  const n = await state.api.enqueue(items);
  state.cuts.delete(vod.url);
  closeCutter();
  if (merge) toast(n ? `${list.length} kesit tek video olarak indirmeye eklendi` : "Bu birleşik video zaten listede");
  else toast(n === items.length ? `${n} kesit indirmeye eklendi`
    : n ? `${n} kesit eklendi, ${items.length - n} tanesi zaten listede` : "Bu kesitler zaten listede");
}

function setRate(r) {
  const v = $("cutVideo");
  v.playbackRate = v.defaultPlaybackRate = r;
  $("cutRate").value = String(r);
  syncSelect($("cutRate"));
}

function cutterKey(e) {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const v = $("cutVideo");
  const k = e.key.toLowerCase();
  const c = selClip();
  if (k === " ") { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  else if (k === "arrowleft") { e.preventDefault(); seekTo(nowTime() - (e.shiftKey ? 30 : 5)); }
  else if (k === "arrowright") { e.preventDefault(); seekTo(nowTime() + (e.shiftKey ? 30 : 5)); }
  else if (k === "arrowup") { e.preventDefault(); jumpEdge(-1); }
  else if (k === "arrowdown") { e.preventDefault(); jumpEdge(1); }
  else if (k === "k") addClipHere();
  else if ((k === "i" || k === "o") && e.shiftKey) {
    if (!c) { toast("Önce bir kesit seç"); return; }
    setEdge(c, k === "i" ? "a" : "b", nowTime());
    sortClips();
    renderCutter();
  }
  else if (k === "i") markIn();
  else if (k === "o") markOut();
  else if ((k === "delete" || k === "backspace") && c) { e.preventDefault(); removeClip(c.id); }
  else if (k === "+" || k === "=") zoomAt(0.5, zoomAnchor());
  else if (k === "-") zoomAt(2, zoomAnchor());
  else if (k === "0") { setView(0, cutDuration()); drawTimeline(); }
  else if (k === "," || k === ".") {
    const i = RATES.indexOf(Number($("cutRate").value));
    setRate(RATES[clamp((i < 0 ? 3 : i) + (k === "." ? 1 : -1), 0, RATES.length - 1)]);
    toast(`Hız ${String(v.playbackRate).replace(".", ",")}×`);
  }
}

/* panel boyutlari: cizelge yuksekligi (--tlx, ek piksel) ve kesit paneli genisligi (--sidew) */
const cutUi = { tlx: 0, side: 0 };   // 0: varsayilan

function applyCutUi() {
  const d = $("cutter");
  d.style.setProperty("--tlx", `${cutUi.tlx}px`);
  if (cutUi.side) d.style.setProperty("--sidew", `${cutUi.side}px`);
  else d.style.removeProperty("--sidew");
}

function bindSplitters() {
  try { Object.assign(cutUi, JSON.parse(localStorage.getItem("cutUi") || "{}")); } catch { /* depolama kapali */ }
  applyCutUi();
  const save = () => { try { localStorage.setItem("cutUi", JSON.stringify(cutUi)); } catch { /* depolama kapali */ } };
  const drag = (el, cls, begin, move) => {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const st = begin(e);
      el.setPointerCapture(e.pointerId);
      el.classList.add("drag");
      $("cutter").classList.add("resizing", cls);
      const onMove = (ev) => { move(st, ev); applyCutUi(); drawTimeline(); };
      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.classList.remove("drag");
        $("cutter").classList.remove("resizing", cls);
        save();
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp, { once: true });
      el.addEventListener("pointercancel", onUp, { once: true });
      e.preventDefault();
    });
  };
  // cizelge: yukari cekince kare ve ses seritleri buyur, video kuculur (en az 160px kalir)
  drag($("splitTl"), "rows", (e) => ({ y0: e.clientY, x0: cutUi.tlx, room: $("cutVideo").parentElement.clientHeight - 160 }),
    (st, e) => { cutUi.tlx = Math.round(clamp(st.x0 + st.y0 - e.clientY, -10, st.x0 + Math.max(0, st.room))); });
  // kesit paneli: sola cekince genisler
  drag($("splitSide"), "cols", (e) => ({ x0: e.clientX, w0: $("splitSide").parentElement.offsetWidth }),
    (st, e) => { cutUi.side = Math.round(clamp(st.w0 + st.x0 - e.clientX, 260, Math.min(560, window.innerWidth * 0.45))); });
  for (const [id, key] of [["splitTl", "tlx"], ["splitSide", "side"]]) $(id).addEventListener("dblclick", () => {
    cutUi[key] = 0;
    applyCutUi();
    drawTimeline();
    save();
  });
}

function bindCutter() {
  bindSplitters();
  const v = $("cutVideo");
  cut.main = makeSeeker(v);
  cut.peek = makeSeeker($("peekVideo"));
  try { cut.len = Number(localStorage.getItem("cutLen")) || 30; } catch { /* depolama kapali */ }
  try { cut.mode = localStorage.getItem("cutMode") === "merge" ? "merge" : "split"; } catch { /* depolama kapali */ }
  $("cutLen").value = String(cut.len);
  if (!$("cutLen").value) { cut.len = 30; $("cutLen").value = "30"; }
  syncSelect($("cutLen"));
  $("cutRate").addEventListener("change", (e) => setRate(Number(e.target.value)));
  v.addEventListener("loadedmetadata", () => setRate(Number($("cutRate").value)));

  v.addEventListener("durationchange", () => {
    const dur = cutDuration();
    if (cut.view[1] <= cut.view[0] || cut.view[1] > dur) setView(0, Math.min(WAVE_MAX, dur));
    renderCutter();
  });
  v.addEventListener("click", () => (v.paused ? v.play() : v.pause()));
  $("cutter").addEventListener("cancel", (e) => {   // Esc: once kisayollar, giris isareti, secim; sonra kapat
    if (!$("keysPop").hidden) { e.preventDefault(); showKeys(false); }
    else if (cut.markIn != null) { e.preventDefault(); cut.markIn = null; paintMarks(); }
    else if (cut.sel != null) { e.preventDefault(); cut.sel = null; renderCutter(); }
  });
  $("cutter").addEventListener("close", closeCutter);
  $("cutClose").addEventListener("click", closeCutter);
  $("cutKeys").addEventListener("click", () => showKeys($("keysPop").hidden));
  $("cutLive").addEventListener("click", cutToLive);
  $("cutter").addEventListener("pointerdown", (e) => {
    if (!$("keysPop").hidden && !e.target.closest(".keyshelp")) showKeys(false);
  });
  $("cutPlay").addEventListener("click", () => (v.paused ? v.play() : v.pause()));
  $("cutMute").addEventListener("click", () => { v.muted = !v.muted; });
  $("edgePrev").addEventListener("click", () => jumpEdge(-1));
  $("edgeNext").addEventListener("click", () => jumpEdge(1));
  $("cutAdd").addEventListener("click", addClipHere);
  $("markIn").addEventListener("click", markIn);
  $("markOut").addEventListener("click", markOut);
  $("cutDel").addEventListener("click", () => cut.sel != null && removeClip(cut.sel));
  $("cutChain").addEventListener("click", toggleChain);
  $("cutDownload").addEventListener("click", downloadCuts);
  for (const b of document.querySelectorAll(".outmode [data-mode]")) b.addEventListener("click", () => {
    cut.mode = b.dataset.mode;
    try { localStorage.setItem("cutMode", cut.mode); } catch { /* depolama kapali */ }
    renderCutter();
  });
  $("cutLen").addEventListener("change", (e) => {
    cut.len = Number(e.target.value);
    try { localStorage.setItem("cutLen", e.target.value); } catch { /* depolama kapali */ }
    renderCutter();
  });
  for (const b of document.querySelectorAll("[data-seek]")) b.addEventListener("click", () => seekTo(nowTime() + Number(b.dataset.seek)));
  $("zoomIn").addEventListener("click", () => zoomAt(0.5, zoomAnchor()));
  $("zoomOut").addEventListener("click", () => zoomAt(2, zoomAnchor()));
  $("zoomFit").addEventListener("click", () => { setView(0, cutDuration()); drawTimeline(); });
  $("zoomRange").addEventListener("input", (e) => {
    const dur = cutDuration(), lo = Math.min(MIN_VIEW, dur);
    if (dur) zoomSpan(dur * Math.pow(lo / dur, Number(e.target.value) / 1000), zoomAnchor());
  });

  /* ana serit: bos yerde surukle = gezin; kesit = sec / tasi; tutamac = kenari uzat */
  const track = $("tlTrack");
  track.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !cutDuration()) return;
    const t = timeAt(e.clientX);
    const grip = e.target.closest(".grip");
    const block = e.target.closest(".clip");
    const c = block && cutClips().find((x) => x.id === Number(block.dataset.id));
    if (grip && c) cut.drag = { mode: grip.dataset.edge, c, x0: e.clientX };
    else if (c) {
      const changed = cut.sel !== c.id;
      cut.sel = c.id;
      cut.drag = { mode: "move", c, off: t - c.a, x0: e.clientX, moved: false };
      if (changed) renderCutter();
    } else {
      cut.drag = { mode: "scrub" };
      seekTo(t);
    }
    track.setPointerCapture(e.pointerId);
    track.classList.add("dragging");
    e.preventDefault();
  });
  track.addEventListener("pointermove", (e) => {
    showPeek(e.clientX);
    const d = cut.drag;
    if (!d) return;
    const t = timeAt(e.clientX);
    if (d.mode === "scrub") { seekTo(t); return; }
    if (d.mode === "move") {
      if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
      d.moved = true;
      const len = d.c.b - d.c.a;
      const a = Math.round(clamp(t - d.off, 0, (cutDuration() || Infinity) - len));
      d.c.a = a;
      d.c.b = a + len;
    } else setEdge(d.c, d.mode, t);
    drawTimeline();
  });
  const endDrag = () => {
    const d = cut.drag;
    if (!d) return;
    cut.drag = null;
    track.classList.remove("dragging");
    if (d.mode === "a" || d.mode === "b") seekTo(d.c[d.mode]);   // birakinca o kareyi goster
    if (d.mode !== "scrub") { sortClips(); renderCutter(); }
  };
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);
  track.addEventListener("pointerleave", () => { if (!cut.drag) hidePeek(); });
  track.addEventListener("dblclick", (e) => {
    const block = e.target.closest(".clip");
    const c = block && cutClips().find((x) => x.id === Number(block.dataset.id));
    if (c && !e.target.closest(".grip")) playClip(c);
  });
  track.addEventListener("wheel", (e) => {
    if (!cutDuration()) return;
    e.preventDefault();
    const [s, en] = cut.view;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (e.shiftKey ? e.deltaY : e.deltaX) || e.deltaX;
      const shift = (d / $("tlLane").clientWidth) * (en - s);
      setView(s + shift, en + shift);
      drawTimeline();
    } else zoomAt(Math.exp(e.deltaY * 0.0015), timeAt(e.clientX));
    showPeek(e.clientX);
  }, { passive: false });

  /* genel bakis: tikla/surukle = gorunen bolumu oraya tasi */
  const ov = $("ovBar");
  const ovMove = (e) => {
    const dur = cutDuration();
    if (!dur) return;
    const r = ov.getBoundingClientRect();
    const t = clamp((e.clientX - r.left) / r.width, 0, 1) * dur;
    const span = cut.view[1] - cut.view[0];
    if (span >= dur - 0.5) { seekTo(t); return; }
    setView(t - span / 2, t + span / 2);
    drawTimeline();
  };
  ov.addEventListener("pointerdown", (e) => { ov.setPointerCapture(e.pointerId); ov.dataset.drag = "1"; ovMove(e); });
  ov.addEventListener("pointermove", (e) => { if (ov.dataset.drag) ovMove(e); });
  ov.addEventListener("pointerup", () => delete ov.dataset.drag);
  ov.addEventListener("dblclick", (e) => {   // cift tik: o ana git
    const dur = cutDuration();
    if (!dur) return;
    const r = ov.getBoundingClientRect();
    seekTo(clamp((e.clientX - r.left) / r.width, 0, 1) * dur);
  });

  /* yan panel */
  const list = $("cutList");
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const c = cutClips().find((x) => x.id === Number(b.closest("li").dataset.id));
    if (!c) return;
    const act = b.dataset.act;
    if (act === "del") { removeClip(c.id); return; }
    if (act === "play") { playClip(c); return; }
    if (act === "select") {
      cut.sel = cut.sel === c.id ? null : c.id;
      if (cut.sel != null) { seekTo(c.a); followView(c.b, false); }
    } else if (act === "nudge") {
      setEdge(c, b.dataset.edge, c[b.dataset.edge] + Number(b.dataset.d));
      seekTo(c[b.dataset.edge]);
    } else if (act === "here") setEdge(c, b.dataset.edge, nowTime());
    sortClips();
    renderCutter();
    const again = list.querySelector(`li[data-id="${c.id}"] [data-act="${act}"]${b.dataset.edge ? `[data-edge="${b.dataset.edge}"]` : ""}${b.dataset.d ? `[data-d="${b.dataset.d}"]` : ""}`);
    again && again.focus();
  });
  list.addEventListener("change", (e) => {
    const inp = e.target.closest("input[data-edge]");
    if (!inp) return;
    const c = cutClips().find((x) => x.id === Number(inp.closest("li").dataset.id));
    const t = parseTime(inp.value);
    if (t == null) toast("Saati 1:02:30 ya da 62:30 gibi yaz");
    else { setEdge(c, inp.dataset.edge, t); sortClips(); seekTo(c[inp.dataset.edge]); }
    renderCutter();
  });
  list.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input[data-edge]")) e.target.blur();
  });
  window.addEventListener("resize", () => cut.vod && drawTimeline());
}


/* ---------- ust bildirim seridi ----------
   Kalici bilgiler icin (toast birkac saniyede kaybolur): pano linki, yarim kalan indirmeler,
   yeni surum, bilgisayar kapanacak. Ayni anahtar bir kez gosterilir. */
function notice(key, { icon: ic = "alert", text, actions = [], warn = false, sticky = false }) {
  closeNotice(key);
  const el = document.createElement("div");
  el.className = `notice${warn ? " warn" : ""}`;
  el.setAttribute("role", "status");
  el.innerHTML = `${icon(ic)}<p>${text}</p>`;
  for (const [label, fn, cls = ""] of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn sm ${cls || "ghost"}`;
    b.textContent = label;
    b.addEventListener("click", () => { closeNotice(key); fn(); });
    el.append(b);
  }
  if (!sticky) {
    el.insertAdjacentHTML("beforeend", `<button class="iconbtn" type="button" title="Kapat" aria-label="Kapat">${icon("x")}</button>`);
    el.lastElementChild.addEventListener("click", () => closeNotice(key));
  }
  $("notices").append(el);
  state.notices.set(key, el);
}

function closeNotice(key) {
  const el = state.notices.get(key);
  if (el) { el.remove(); state.notices.delete(key); }
}

/* pencereye donulunce panoda Kick linki varsa acmayi oner (ayni link bir kez) */
async function checkClipboard() {
  if (!state.settings.clipboardWatch || $("cutter").open) return;
  const link = await state.api.clipboard_link();
  if (!link || link === state.lastClip) return;
  state.lastClip = link;
  if ($("linkInput").value.trim() === link) return;
  const short = link.replace(/^https?:\/\/(www\.)?/, "");
  notice("clip", {
    icon: "clipboard", text: `Panoda Kick linki var: <span class="num">${esc(short.length > 70 ? short.slice(0, 70) + "…" : short)}</span>`,
    actions: [["Aç", () => listLink(link), "primary"]],
  });
}

async function checkUpdate(manual) {
  const r = await state.api.check_update();
  if (r.update) {
    notice("update", {
      icon: "gift", text: `Yeni sürüm çıktı: <b>${esc(r.version)}</b> <span class="num">(şu an ${esc(r.current)})</span>`,
      actions: [["İndirme sayfasını aç", () => state.api.open_url(r.url), "primary"]],
    });
  } else if (manual) toast(r.ok ? `Güncel sürümü kullanıyorsun (${r.current})` : "Güncelleme denetlenemedi. İnterneti kontrol et.");
}

/* onceki oturumdan yarim kalan indirmeler: kendiliginden baslamaz, kullaniciya sorulur */
function offerRestored(n) {
  notice("restored", {
    icon: "retry", text: `Önceki oturumdan <b>${n} indirme</b> yarım kaldı. Kaldığı yerden devam edebilir.`,
    actions: [
      ["Devam et", () => { state.api.resume_all(); toast("Yarım kalanlar sıraya alındı"); }, "primary"],
      ["Listeyi temizle", () => state.downloads.filter((d) => d.status === "stopped").forEach((d) => state.api.remove(d.id))],
    ],
  });
}

/* tarayicidan link surukleyip birakma */
function bindDrop() {
  let depth = 0;
  const hasLink = (e) => [...(e.dataTransfer && e.dataTransfer.types || [])].some((t) => t === "text/uri-list" || t === "text/plain");
  document.addEventListener("dragenter", (e) => {
    if (!hasLink(e) || $("cutter").open) return;
    depth++;
    $("dropZone").hidden = false;
  });
  document.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("dropZone").hidden = true; } });
  document.addEventListener("dragover", (e) => {
    e.preventDefault();   // dosya birakilinca pencere o dosyaya gitmesin
    if (e.dataTransfer) e.dataTransfer.dropEffect = hasLink(e) ? "copy" : "none";
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    $("dropZone").hidden = true;
    const text = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "").split(/\r?\n/).find((x) => x && !x.startsWith("#")) || "";
    if (/kick\.com\//i.test(text)) listLink(text.trim());
    else if (text) toast("Bu bir Kick linki değil");
  });
}

/* ---------- kucuk yardimcilar ---------- */
let toastTimer;
function toast(msg) {
  const t = $("toast");
  const host = $("cutter").open ? $("cutter") : document.body;   // modal acikken ustte gorunsun
  if (t.parentElement !== host) host.append(t);
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ---------- olaylar ---------- */
function bind() {
  $("linkForm").addEventListener("submit", (e) => { e.preventDefault(); listLink($("linkInput").value); });
  $("linkInput").addEventListener("paste", () => setTimeout(() => {
    const v = $("linkInput").value;
    if (/kick\.com\//i.test(v)) listLink(v);   // link yapistirildiysa hemen ac; ad yaziliyorsa Enter beklenir
  }, 0));
  // bir kutuya yazmiyorken Ctrl+V: yapistirilan link dogrudan acilir
  document.addEventListener("paste", (e) => {
    if (["INPUT", "TEXTAREA"].includes(e.target.tagName) || $("cutter").open) return;
    const text = (e.clipboardData && e.clipboardData.getData("text") || "").trim();
    if (/kick\.com\//i.test(text)) { e.preventDefault(); listLink(text); }
  });
  bindDrop();
  window.addEventListener("focus", () => checkClipboard());
  $("keysBtn").addEventListener("click", () => $("keysDlg").showModal());
  $("keysClose").addEventListener("click", () => $("keysDlg").close());
  $("keysDlg").addEventListener("click", (e) => { if (e.target === $("keysDlg")) $("keysDlg").close(); });   // disari tiklayinca
  $("afterDone").addEventListener("change", async (e) => {
    const mode = await state.api.set_after_done(e.target.value);
    toast({ none: "Bitince bir şey yapılmayacak", sleep: "İndirmeler bitince bilgisayar uykuya alınacak", shutdown: "İndirmeler bitince bilgisayar kapanacak (1 dk içinde iptal edebilirsin)" }[mode]);
  });
  $("autoDl").addEventListener("click", (e) => toggleAuto("autoDownload", e.currentTarget));
  $("autoRec").addEventListener("click", (e) => toggleAuto("autoRecord", e.currentTarget));

  // favori seridi
  $("homeBtn").addEventListener("click", () => showView("home"));
  $("settingsBtn").addEventListener("click", () => showView(state.view === "settings" ? (state.channel ? "channel" : "home") : "settings"));
  $("favs").addEventListener("click", (e) => {
    const b = e.target.closest(".fav");
    if (b) openChannel(b.dataset.slug);
  });
  $("favAddBtn").addEventListener("click", openFavPop);
  $("favPop").addEventListener("submit", submitFavPop);
  $("favPop").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); $("favPop").hidden = true; } });
  document.addEventListener("pointerdown", (e) => {
    if (!$("favPop").hidden && !e.target.closest("#favPop, #favAddBtn")) $("favPop").hidden = true;
  });
  $("favGrid").addEventListener("click", (e) => {
    const t = e.target.closest(".ftile[data-slug]");
    if (t) openChannel(t.dataset.slug);
  });
  $("recentRow").addEventListener("click", (e) => {
    const t = e.target.closest("[data-file]");
    if (t) playFile(t.dataset.file);
  });
  $("recentAll").addEventListener("click", () => showView("library"));

  // kanal
  $("favToggle").addEventListener("click", toggleFavorite);
  $("tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t || t.dataset.tab === state.tab) return;
    setTab(t.dataset.tab);
    if (t.dataset.tab === "live") focusItem(liveItem().url);
  });
  let qTimer;
  $("fQuery").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); renderGrid(); }, 120);
  });
  $("fCat").addEventListener("change", (e) => { state.filters.cat = e.target.value; renderGrid(); });
  $("fLen").addEventListener("change", (e) => { state.filters.len = e.target.value; renderGrid(); });
  $("fSort").addEventListener("change", (e) => {
    if (state.tab === "clips") { state.clipSort = e.target.value; loadClips(true); }
    else { state.filters.sort = e.target.value; renderGrid(); }
  });
  $("fClear").addEventListener("click", () => {
    state.filters = { ...state.filters, q: "", cat: "", len: "" };
    $("fQuery").value = "";
    renderGrid();
  });
  $("moreBtn").addEventListener("click", () => loadClips(false));

  const grid = $("grid");
  grid.addEventListener("click", (e) => {
    const c = e.target.closest(".card[data-url]");
    if (!c) return;
    const url = c.dataset.url;
    if (e.target.closest(".cutbtn")) { hover.stop(); player.el().pause(); openCutter(cutTarget(itemByUrl(url))); return; }
    if (e.target.closest(".check") || e.ctrlKey || e.metaKey) {
      if ((itemByUrl(url) || {}).kind === "live") return;
      if (!state.selected.size && state.focus && state.focus !== url && !e.target.closest(".check")) toggleSel(state.focus, true);
      toggleSel(url);
      state.anchor = url;
      selectionChanged();
      return;
    }
    if (e.shiftKey && state.anchor) {
      const urls = filtered().map((v) => v.url);
      const [a, b] = [urls.indexOf(state.anchor), urls.indexOf(url)].sort((x, y) => x - y);
      if (a >= 0) urls.slice(a, b + 1).forEach((u) => toggleSel(u, true));
      selectionChanged();
      return;
    }
    const t = hover.time(url);
    hover.stop();
    state.selected.clear();
    state.anchor = url;
    focusItem(url, t ?? undefined);
  });
  grid.addEventListener("dblclick", (e) => {
    if (e.target.closest(".cutbtn, .check")) return;
    const c = e.target.closest(".card[data-url]");
    if (c && itemByUrl(c.dataset.url).kind !== "live") downloadSelected([c.dataset.url]);
  });
  grid.addEventListener("keydown", (e) => {
    const c = e.target.closest(".card[data-url]");
    if (!c) return;
    if (e.key === " ") { e.preventDefault(); toggleSel(c.dataset.url); selectionChanged(); }
    if (e.key === "Enter") focusItem(c.dataset.url);
  });
  grid.addEventListener("pointerover", (e) => {
    const c = e.target.closest(".card[data-url]");
    if (c) hover.start(c);
  });
  grid.addEventListener("pointerleave", () => hover.stop());
  grid.addEventListener("pointerout", (e) => {
    const c = e.target.closest(".card[data-url]");
    if (c && !c.contains(e.relatedTarget)) hover.stop();
  });

  // inceleme
  $("inspector").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ins]");
    if (b) onInspectorAction(b);
  });
  $("quality").addEventListener("change", async (e) => {
    await saveSetting({ quality: e.target.value }, true);
    toast(`Kalite: ${e.target.value}`);
  });
  bindPlayer();
  $("insPoster").addEventListener("error", (e) => {
    const l = player.live && liveItem();
    const fb = l && l.avatar && e.target.src !== l.avatar;
    e.target.src = fb ? l.avatar : "";
    e.target.classList.toggle("avfb", !!fb);
  });

  // indirilenler
  $("libBtn").addEventListener("click", () => showView(state.view === "library" ? (state.channel ? "channel" : "home") : "library"));
  $("sbMain").addEventListener("click", () => showView("library"));
  $("openFolderBtn").addEventListener("click", () => state.api.open_folder());
  $("clearBtn").addEventListener("click", () => state.api.clear_done());
  $("stopAllBtn").addEventListener("click", () => state.api.cancel_all());
  $("rows").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) state.api[b.dataset.act](Number(b.dataset.id));
  });
  let lqTimer;
  $("libQuery").addEventListener("input", (e) => {
    clearTimeout(lqTimer);
    lqTimer = setTimeout(() => { state.libQuery = e.target.value.trim(); renderLibrary(); }, 120);
  });
  $("histGroups").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ins]");
    if (b) { onInspectorAction(b); return; }
    const r = e.target.closest(".hrow");
    if (r) playFile(r.dataset.file);
  });
  $("histGroups").addEventListener("dblclick", (e) => {
    const r = e.target.closest(".hrow");
    if (r && !e.target.closest("[data-ins]") && !r.classList.contains("gone")) { player.el().requestFullscreen && $("player").requestFullscreen().catch(() => {}); }
  });
  $("histGroups").addEventListener("keydown", (e) => {
    const r = e.target.closest(".hrow");
    if (r && e.key === "Enter") playFile(r.dataset.file);
    if (r && e.key === "Delete") deleteFile(r.dataset.file);
  });

  // klavye
  document.addEventListener("keydown", (e) => {
    if ($("cutter").open) return cutterKey(e);
    if ($("keysDlg").open) return;
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName);
    if (e.ctrlKey && e.key.toLowerCase() === "l") { e.preventDefault(); $("linkInput").focus(); $("linkInput").select(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "j") { e.preventDefault(); showView("library"); return; }
    if (typing) { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "?") { e.preventDefault(); $("keysDlg").showModal(); return; }
    const v = player.el();
    if (e.key === "m" && player.key) { v.muted = !v.muted; return; }
    if (e.key === "f" && player.key) { fullscreen(); return; }
    if (e.key === "k" && player.key) { v.paused ? v.play().catch(() => {}) : v.pause(); return; }
    if (state.view !== "channel") return;
    if (e.key === "a" && e.ctrlKey) {
      e.preventDefault();
      filtered().filter((x) => x.kind !== "live").forEach((x) => state.selected.add(x.url));
      selectionChanged();
    }
    if (e.key === "Escape") { state.selected.clear(); selectionChanged(); }
  });
  window.addEventListener("resize", () => { if (!$("favPop").hidden) $("favPop").hidden = true; });

  enhanceSelects();
  bindCutter();
  bindSettings();
  // kesit editorundeki "Uzunluk" degisince ayar da degissin
  $("cutLen").addEventListener("change", (e) => saveSetting({ sectionLength: Number(e.target.value) }, true));
  $("cutter").addEventListener("close", () => { if (state.focus) refreshStateBlock(); });
}

async function start(api) {
  state.api = api;
  const cfg = await api.init();
  state.cfg = cfg;
  state.settings = cfg.settings;
  state.favorites = cfg.favorites || [];
  $("quality").innerHTML = cfg.qualities.map((q) => `<option>${q}</option>`).join("");
  $("quality").value = cfg.quality;
  bind();
  syncSelects();
  applySectionLength();
  if (!cfg.ffmpeg) showError("ffmpeg bulunamadı. Videolar iner ama son mp4 düzeltmesi yapılamaz. ffmpeg.exe'yi programın yanına koy.");
  showView("home");
  renderRail();
  refreshLibrary();
  refreshFavorites();
  setInterval(refreshFavorites, 10 * 60 * 1000);
  if (!state.favorites.length) $("linkInput").focus();   // ilk acilista nereden baslanacagi belli olsun
  if (cfg.restored) offerRestored(cfg.restored);
  if (state.settings.updateCheck) setTimeout(() => checkUpdate(false), 3000);
  checkClipboard();
}

window.app = { sync };
window.addEventListener("error", (e) => state.api && state.api.client_log(`${e.message} @${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => state.api && state.api.client_log(`promise: ${e.reason && (e.reason.message || e.reason)}`));
if (window.pywebview && window.pywebview.api) start(window.pywebview.api);
else window.addEventListener("pywebviewready", () => start(window.pywebview.api));
