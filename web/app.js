"use strict";

const $ = (id) => document.getElementById(id);
const statusName = (s) => t(`status.${s}`);
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
  focus: null,               // oynatici penceresinde acik ogenin adresi
  downloads: [],
  byUrl: new Map(),          // url -> tam video indirmesi
  favorites: [],
  favStatus: {},             // slug -> favorites_refresh sonucu
  liveFavs: new Set(),
  library: [],
  libQuery: "",
  libFocus: null,            // oynatici penceresinde oynayan dosya
  cuts: new Map(),           // vod url -> kesit listesi (kesit secici)
  cutSets: [],               // diskte kayitli kesit kumeleri (ana sayfadaki liste); cutSet(url) ile aranir
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
  if (s < 60) return t("eta.sec", { s });
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? t("eta.hourMin", { h, m }) : t("eta.min", { m });
}
function fmtNum(n, digits = 0) {
  return n.toLocaleString(i18n.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtBytes(n) {
  if (n == null) return "";
  if (n === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${fmtNum(n, n < 10 && i > 1 ? 1 : 0)} ${u[i]}`;
}
function fmtSpeed(n) {
  return n ? `${fmtBytes(n)}/s` : "";
}
function fmtCount(n) {
  return new Intl.NumberFormat(i18n.locale, { notation: "compact", maximumFractionDigits: n >= 1e3 && n < 1e4 || n >= 1e6 ? 1 : 0 }).format(n || 0);
}
function parseDate(iso) {
  if (!iso) return NaN;
  return Date.parse(iso.replace(" ", "T") + (iso.includes("Z") || iso.includes("+") ? "" : "Z"));
}
function fmtAgo(iso) {
  const ms = parseDate(iso);
  if (isNaN(ms)) return "";
  const d = (Date.now() - ms) / 1000;
  const rel = new Intl.RelativeTimeFormat(i18n.locale);
  if (d < 3600) return rel.format(-Math.max(1, Math.round(d / 60)), "minute");
  if (d < 86400) return rel.format(-Math.round(d / 3600), "hour");
  if (d < 86400 * 7) return rel.format(-Math.round(d / 86400), "day");
  return new Date(ms).toLocaleDateString(i18n.locale, { day: "numeric", month: "short", year: "numeric" });
}
function fmtDate(iso) {
  const ms = parseDate(iso);
  if (isNaN(ms)) return "";
  return new Date(ms).toLocaleString(i18n.locale, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
const qualityName = (q) => (q === "best" ? t("quality.best") : q);
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
/* dugme bekleme durumu: islem bitene kadar etiket gizli + halka, tekrar tiklanamaz */
async function withBusy(btn, fn) {
  if (btn.classList.contains("is-busy")) return;
  btn.classList.add("is-busy");
  btn.setAttribute("aria-busy", "true");
  try { return await fn(); } finally { btn.classList.remove("is-busy"); btn.removeAttribute("aria-busy"); }
}
const MINI = `<i class="mini" aria-hidden="true"></i>`;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fold = (s) => (s || "").toLocaleLowerCase(i18n.locale);
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/* ---------- gorunumler ---------- */
function showView(view) {
  if (view === "settings" && state.view !== "settings") { track("settings_open"); $("setSearch").value = ""; }
  state.view = view;
  closeWatch();
  $("homeView").hidden = view !== "home";
  $("channelView").hidden = view !== "channel";
  $("libraryView").hidden = view !== "library";
  $("settingsView").hidden = view !== "settings";
  $("homeBtn").classList.toggle("on", view === "home");
  $("settingsBtn").classList.toggle("on", view === "settings");
  $("libBtn").classList.toggle("on", view === "library");
  if (view === "home" || view === "settings") player.stop();
  if (view === "home") renderHome();
  if (view === "library") { if (!state.libLoaded) renderLibrary(); refreshLibrary(); }
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
      const n = await state.api.enqueue([{ url: res.url, title: t("kind.clip"), thumb: "" }]);
      toast(n ? t("toast.clipQueued") : t("toast.clipExists"));
      $("linkInput").value = "";
      return;
    }
    openChannelData(res);
    $("linkInput").value = "";
    $("linkInput").blur();
  } catch (e) {
    showError(t("err.unexpected", { e }));
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
  setTab("vods", true);
  loadClips(true);
  showView("channel");
  renderChannel();
  renderGrid();
  state.focus = null;
  renderSelBar();
  if (focusVod) focusItem(focusVod.url);   // VOD linki yapistirildi: dogrudan o oynasin
  $("gridWrap").scrollTop = 0;
  if (focusVod) {
    const el = cardEl(focusVod.url);
    el && el.scrollIntoView({ block: "center" });
  }
}

async function openChannel(slug) {
  if (state.channel && state.channel.slug === slug && state.view === "channel") return;
  track("channel_open", { channel: slug });
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
  $("chMeta").innerHTML = `${MINI}${esc(t("common.loading"))}`;
  renderSkeleton();
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
    kind: "live", url: `https://kick.com/${ch.slug}`, key: `live:${ch.slug}`, title: l.title || t("live.isLive", { name: ch.name }),
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
/* Kick sitesi VOD sayfalarini artik API'nin verdigi kimlikle acmiyor ("Oops, something went wrong"
   ve bu kimligi sitenin kendi kimligine ceviren acik bir yol yok); klip ve canli linkleri calisiyor.
   VOD icin yayincinin Yayinlar sayfasi acilir. */
const kickPage = (v) => (kindOf(v) === "vod" && state.channel ? `https://kick.com/${state.channel.slug}/videos` : v.url);
const cutTarget = (v) => (v && v.kind === "live" ? liveCutVod() : v);
/* kanalin suren ya da sirada bekleyen canli kaydi */
const liveRec = (url) => state.downloads.find((x) => x.live && x.url === url && ACTIVE.concat("queued").includes(x.status));

function renderChannel() {
  const ch = state.channel;
  if (!ch) return;
  $("chAvatar").src = ch.avatar || "";
  $("chAvWrap").classList.toggle("live", !!ch.live);
  const h = $("chName");
  h.innerHTML = "";
  h.append(ch.name);
  if (ch.verified) h.insertAdjacentHTML("beforeend", icon("verified"));
  if (ch.live) h.insertAdjacentHTML("beforeend", `<span class="livechip"><i></i>${t("live.chip")}</span>`);
  const total = state.vods.reduce((a, v) => a + v.duration, 0);
  const newN = state.seenBefore ? state.vods.filter((v) => v.start > state.seenBefore).length : 0;
  $("chMeta").textContent = [
    t("ch.followers", { n: ch.followers, c: fmtCount(ch.followers) }), t("ch.vodCount", { n: state.vods.length }),
    t("ch.totalHours", { n: Math.round(total / 3600) }),
    ch.live ? t("ch.watching", { n: ch.live.viewers, c: fmtCount(ch.live.viewers) }) : "", newN ? t("ch.newVods", { n: newN }) : "",
  ].filter(Boolean).join(" · ");
  $("vodCount").textContent = state.vods.length;
  const ft = $("favToggle");
  ft.setAttribute("aria-pressed", state.favorite);
  ft.querySelector("span").textContent = state.favorite ? t("ch.inFav") : t("ch.addFav");
  ft.title = state.favorite ? t("ch.removeFav") : t("ch.addFavTip");
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
      ? (on ? t("toast.autoDlOn", { name: ch.name }) : t("toast.autoDlOff"))
      : (on ? t("toast.autoRecOn", { name: ch.name }) : t("toast.autoRecOff")));
  } finally {
    btn.classList.remove("busy");
  }
  renderAuto();
  renderRail();
}

/* ---------- filtre ---------- */
const LEN_OPTS = {
  vods: [["", "filter.all"], ["0-3600", "filter.under1h"], ["3600-10800", "filter.1to3h"], ["10800-", "filter.over3h"]],
  clips: [["", "filter.all"], ["0-30", "filter.under30s"], ["30-60", "filter.30to60s"], ["60-", "filter.over1m"]],
};
const SORT_OPTS = {
  vods: [["new", "sort.new"], ["old", "sort.old"], ["long", "sort.long"], ["view", "sort.views"]],
  clips: [["date", "sort.new"], ["view", "sort.views"]],
};
const tOpts = (opts) => opts.map(([v, key]) => [v, t(key)]);

function fillSelect(sel, opts, value) {
  sel.innerHTML = opts.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("");
  sel.value = opts.some(([v]) => v === value) ? value : opts[0][0];
  syncSelect(sel);
  sel.parentElement.classList.toggle("set", sel.selectedIndex > 0 && sel.id !== "fSort");
}

function renderFilters() {
  const list = state.tab === "clips" ? state.clips : state.vods;
  const cats = [...new Set(list.flatMap((v) => v.categories && v.categories.length ? v.categories : v.category ? [v.category] : []))].sort();
  fillSelect($("fCat"), [["", t("filter.all")], ...cats.map((c) => [c, c])], state.filters.cat);
  fillSelect($("fLen"), tOpts(LEN_OPTS[state.tab === "clips" ? "clips" : "vods"]), state.filters.len);
  fillSelect($("fSort"), tOpts(SORT_OPTS[state.tab === "clips" ? "clips" : "vods"]), state.tab === "clips" ? state.clipSort : state.filters.sort);
  $("fCat").parentElement.hidden = cats.length < 2 && !state.filters.cat;
}

function filtered() {
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
const filtering = () => !!(state.filters.q || state.filters.cat || state.filters.len);

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
  const all = state.tab === "clips" ? state.clips : state.vods;
  const list = filtered();
  const note = $("gridNote");
  if (state.tab === "clips" && state.clipsLoading && !state.clips.length) { renderSkeleton(); return; }
  note.hidden = list.length > 0;
  note.textContent = all.length ? t("grid.noMatch") : state.tab === "clips" ? t("grid.noClips") : t("grid.noVods");
  $("moreBox").hidden = !(state.tab === "clips" && state.clipCursor && state.clips.length);
  $("fClear").hidden = !filtering();
  $("filters").classList.toggle("filtering", filtering());
  $("fCount").textContent = filtering()
    ? `${list.length} / ${all.length}${state.tab === "clips" && state.clipCursor ? "+" : ""}`
    : t(state.tab === "clips" ? "grid.clipCount" : "grid.vodCount", { n: all.length, c: `${all.length}${state.tab === "clips" && state.clipCursor ? "+" : ""}` });
  const frag = document.createDocumentFragment();
  // suren yayin Yayinlar'in basinda, arsivin ustunde tam genislikte; filtre arsivi aradigi icin gizler
  const live = state.tab === "vods" && !filtering() && liveItem();
  if (live) frag.append(liveCard(live));
  for (const v of list) {
    const c = $("cardTpl").content.firstElementChild.cloneNode(true);
    c.dataset.url = v.url;
    bindThumb(c.querySelector(".thumb"), v);
    c.querySelector(".dur").textContent = fmtDuration(v.duration);
    c.querySelector(".cutbtn").hidden = state.tab === "clips";
    c.querySelector(".title").textContent = cleanTitle(v.title);
    c.title = v.title;
    const bits = [fmtAgo(v.start), v.creator ? t("card.clippedBy", { name: v.creator }) : "", t("card.views", { n: v.views, c: fmtCount(v.views) }), v.category];
    const sub = c.querySelector(".sub");
    sub.textContent = bits.filter(Boolean).join(" · ");
    if (state.tab === "vods" && state.seenBefore && v.start > state.seenBefore) sub.insertAdjacentHTML("afterbegin", `<span class="newpill">${t("card.new")}</span>`);
    frag.append(c);
  }
  g.append(frag);
  paintCards();
}

/* suren yayin: kapak (uzerine gelince canli onizleme), baslik, sure, izleyici ve dogrudan islemler */
function liveCard(v) {
  const c = $("liveTpl").content.firstElementChild.cloneNode(true);
  c.dataset.url = v.url;
  const img = c.querySelector("img");
  img.src = v.thumb || v.avatar || BLANK;
  img.classList.toggle("avfb", !v.thumb);
  img.addEventListener("error", () => {   // canli kapagi henuz yoksa kanal resmi
    const fb = v.avatar && img.src !== v.avatar;
    img.src = fb ? v.avatar : BLANK;
    img.classList.toggle("avfb", !!fb);
  });
  c.querySelector(".lsince").textContent = v.start ? t("live.started", { ago: fmtAgo(v.start) }) : "";
  c.querySelector(".ltitle").textContent = cleanTitle(v.title);
  c.querySelector(".ltitle").title = v.title;
  c.querySelector(".sub").textContent = [t("live.viewers", { n: v.views, c: fmtCount(v.views) }), v.category].filter(Boolean).join(" · ");
  c.querySelector('[data-live="cut"]').hidden = !state.liveVod;
  return c;
}

function paintLive(c) {
  const d = liveRec(c.dataset.url);
  const k = d ? `${d.id}:${d.status}` : "";
  c.classList.toggle("focus", state.focus === c.dataset.url);
  c.classList.toggle("rec", !!d);
  const st = c.querySelector(".state");
  st.className = d ? "state on active" : "state";
  st.textContent = d ? (d.status === "queued" ? statusName("queued") : d.status === "merging" ? t("live.remuxing") : statusName("recording")) : "";
  const b = c.querySelector(".lrec");
  if (b.dataset.k === k) return;
  b.dataset.k = k;
  b.dataset.live = d ? "stoprec" : "record";
  b.dataset.id = d ? d.id : "";
  b.className = d ? "btn lrec" : "btn primary lrec";
  b.innerHTML = d ? `${icon("stop")}${esc(t("live.stopRec"))}` : `${icon("record")}${esc(t("live.startRec"))}`;
}

async function onLiveAction(b) {
  const v = liveItem();
  if (!v) return;
  const act = b.dataset.live;
  if (act === "record") {
    const n = await state.api.enqueue([{ url: v.url, title: cleanTitle(v.title), thumb: v.thumb || v.avatar, live: true }]);
    toast(n ? t("toast.recStarted") : t("toast.recExists"));
    if (n) track("live_record", { channel: state.channel ? state.channel.slug : "" });
  } else if (act === "stoprec") state.api.cancel(Number(b.dataset.id));
  else if (act === "cut") { hover.stop(); player.el().pause(); openCutter(liveCutVod()); }
}

function paintCards() {
  $("grid").classList.toggle("picking", state.selected.size > 0);
  for (const c of $("grid").querySelectorAll(".card[data-url]")) {
    if (c.classList.contains("livecard")) { paintLive(c); continue; }
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
    const [cls, text] = cardState(d);
    st.classList.add("on", cls);
    st.textContent = text;
  }
  hcard.paint();
}

/* indirme durumu -> [sinif, metin] (kart rozeti ve buyuyen kartin bilgi alani ayni kaynagi kullanir) */
function cardState(d) {
  if (d.status === "downloading") return ["active", t("card.downloadingPct", { p: Math.floor(d.pct) })];
  if (d.status === "recording") return ["active", statusName("recording")];
  if (d.status === "preparing" || d.status === "merging") return ["active", statusName(d.status)];
  if (d.status === "done") return ["done", t("card.downloaded")];
  if (d.status === "error") return ["bad", statusName("error")];
  if (d.status === "stopped") return ["stopped", statusName("stopped")];
  return ["queued", statusName("queued")];
}

function toggleSel(url, on) {
  const want = on ?? !state.selected.has(url);
  want ? state.selected.add(url) : state.selected.delete(url);
}

function selectionChanged() {
  if (hcard.el) hover.stop();
  paintCards();
  renderSelBar();
}

/* ---------- secim cubugu ---------- */
function renderSelBar() {
  const items = [...state.selected].map(itemByUrl).filter(Boolean);
  const list = $("selList");
  $("selBar").hidden = !items.length;
  if (!items.length) { list.hidden = true; $("selCount").setAttribute("aria-expanded", "false"); return; }
  $("selN").textContent = t("sel.count", { n: items.length });
  const total = items.reduce((a, v) => a + (v.duration || 0), 0);
  $("selDur").textContent = total ? t("sel.total", { d: fmtDuration(total) }) : "";
  $("selDl").querySelector("span").textContent = t("sel.download", { n: items.length });
  if (list.hidden) return;
  list.innerHTML = items.map((v) => `<li><img src="${esc(v.thumb || BLANK)}" alt=""><span title="${esc(v.title)}">${esc(cleanTitle(v.title))}</span>
    <small class="num">${fmtDuration(v.duration)}</small>
    <button class="iconbtn" type="button" data-unsel="${esc(v.url)}" title="${esc(t("sel.remove"))}" aria-label="${esc(t("sel.remove"))}">${icon("x")}</button></li>`).join("");
}

function toggleSelList() {
  const list = $("selList");
  list.hidden = !list.hidden;
  $("selCount").setAttribute("aria-expanded", String(!list.hidden));
  renderSelBar();
}

async function enqueueItems(items) {
  items = items.filter(Boolean).map((v) => ({ url: v.url, title: cleanTitle(v.title), thumb: v.thumb }));
  if (!items.length) return 0;
  const n = await state.api.enqueue(items);
  if (n < items.length) toast(n ? t("toast.addedSomeExist", { n, m: items.length - n }) : t("toast.alreadyListed"));
  else toast(t("toast.added", { n }));
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
  for (const el of document.querySelectorAll(".tab")) el.setAttribute("aria-selected", el.dataset.tab === tab);
  state.selected.clear();
  if (!silent) { renderGrid(); renderSelBar(); $("gridWrap").scrollTop = 0; }
}

async function loadClips(reset) {
  if (!state.channel || state.clipsLoading) return;
  const slug = state.channel.slug;
  state.clipsLoading = true;
  if (reset) { state.clips = []; state.clipCursor = null; }
  $("moreBtn").disabled = true;
  $("moreBtn").classList.add("is-busy");
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
    $("moreBtn").classList.remove("is-busy");
    $("clipCount").textContent = state.clips.length ? `${state.clips.length}${state.clipCursor ? "+" : ""}` : "0";
    if (state.tab === "clips" && state.view === "channel") renderGrid();
  }
}

/* Kick'in canli ana listesi CORS'u yalniz kick.com'a acar: metnini Python ceker, hls.js'e blob
   olarak verilir. Alt listeler ve parcalar tam adresli ve herkese acik; hls.js onlari kendisi ceker. */
const liveBlobs = new Map();   // ana liste adresi -> blob adresi
async function hlsUrl(v) {
  if (v.kind !== "live") return v.source;
  if (!liveBlobs.has(v.source)) {
    const res = await state.api.live_master(v.source);
    if (!res.ok) throw new Error(res.error);
    liveBlobs.set(v.source, URL.createObjectURL(new Blob([res.text], { type: "application/vnd.apple.mpegurl" })));
  }
  return liveBlobs.get(v.source);
}

/* ---------- oynatici ----------
   Tek oynatici (ortadaki pencere): secilen video, klip, canli yayin ya da indirilen dosya. HLS ise hls.js,
   yerel dosyaysa dogrudan. Ses ayari kalici (ayarlar: volume, previewMuted). */
const player = {
  hls: null, key: null, live: false, volTimer: 0,
  rate: 1, qual: "auto",   // oturum boyunca hatirlanir: sonraki videolarda da gecerli
  el: () => $("insVideo"),
  /* kapak: yoksa / bozuksa markali yedek (yayincinin resmi) */
  setPoster(src, avatar) {
    const p = $("player"), img = $("insPoster");
    img.classList.remove("avfb");
    clearFallback(p);
    img.dataset.av = avatar || "";
    if (src) img.src = src;
    else { img.removeAttribute("src"); showFallback(p, avatar || ""); }
  },
  load(key, { source, file, poster, avatar, start = 0, live = false, autoplay = true }) {
    const v = this.el();
    if (this.key === key && (this.hls || v.src)) return;
    this.stop();
    this.key = key;
    this.live = live;
    $("player").classList.remove("empty", "playing");
    $("player").classList.toggle("loading", !!(file || source));
    this.setPoster(poster, avatar);
    this.msg("");
    v.muted = !!state.settings.previewMuted;
    v.volume = clamp((state.settings.volume ?? 50) / 100, 0, 1);
    paintVolume();
    $("pSeek").disabled = live;
    v.defaultPlaybackRate = v.playbackRate = live ? 1 : this.rate;
    $("pRate").parentElement.hidden = live;
    paintRate();
    const go = () => {
      if (start && !live) v.currentTime = start;
      if (autoplay) v.play().catch(() => $("player").classList.remove("loading"));
    };
    if (file) {
      v.src = file;
      v.addEventListener("loadedmetadata", go, { once: true });
    } else if (source && window.Hls && Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 20, capLevelToPlayerSize: true, startPosition: live ? -1 : start || -1 });
      this.hls = hls;
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal && this.hls === hls) this.msg(live ? t("player.liveFailed") : t("player.failed"));
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        applyQuality(hls);
        if (autoplay) v.play().catch(() => $("player").classList.remove("loading"));
      });
      Promise.resolve(source).then((src) => {
        if (this.hls !== hls) return;
        hls.loadSource(src);
        hls.attachMedia(v);
      }).catch(() => { if (this.hls === hls) this.msg(live ? t("player.liveFailed") : t("player.failed")); });
    } else if (source) {
      v.src = source;
      v.addEventListener("loadedmetadata", go, { once: true });
    } else {
      this.msg(t("player.noSource"));
    }
  },
  stop() {
    const v = this.el();
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    v.pause();
    v.removeAttribute("src");
    v.load();
    this.key = null;
    closeMenus();
    $("pQualWrap").hidden = true;
    $("player").classList.remove("playing", "loading");
    paintPlayer();
  },
  empty(text) {
    this.stop();
    $("insPoster").src = "";
    $("player").classList.add("empty");
    this.msg(text, "film");
  },
  poster(src, text, avatar) {
    this.stop();
    $("player").classList.add("empty");
    this.setPoster(src, avatar);
    this.msg(text || "");
  },
  msg(text, ic) {
    const m = $("pMsg");
    if (text) $("player").classList.remove("loading");
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
  if (player.live) $("pTime").textContent = t("player.live");
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

/* hiz ve kalite menuleri: oynaticinin alt cubugunda acilir */
const PLAY_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const rateText = (r) => `${r}×`;

function closeMenus() {
  for (const id of ["pRate", "pQual"]) { $(`${id}Menu`).hidden = true; $(id).setAttribute("aria-expanded", "false"); }
}

function openMenu(id, items, current, pick) {
  const menu = $(`${id}Menu`);
  const was = !menu.hidden;
  closeMenus();
  if (was) return;
  menu.innerHTML = "";
  for (const [value, label] of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", String(value === current));
    b.textContent = label;
    b.addEventListener("click", () => { closeMenus(); pick(value); });
    menu.append(b);
  }
  menu.hidden = false;
  $(id).setAttribute("aria-expanded", "true");
}

function paintRate() { $("pRate").textContent = rateText(player.rate); }

function setPlayRate(r) {
  player.rate = r;
  const v = player.el();
  v.defaultPlaybackRate = v.playbackRate = r;
  paintRate();
}

/* hls seviyeleri: yukseklige gore, buyukten kucuge. "auto" = hls.js secer. */
function qualityLevels(hls) {
  const seen = new Set();
  return hls.levels
    .map((l, i) => {
      const fps = Math.round(Number(l.attrs && l.attrs["FRAME-RATE"]) || 0);
      return { i, h: l.height || 0, label: l.height ? `${l.height}p${fps > 30 ? fps : ""}` : `${Math.round(l.bitrate / 1000)} kb/s` };
    })
    .filter((l) => !seen.has(l.label) && seen.add(l.label))
    .sort((a, b) => b.h - a.h || b.i - a.i);
}

function applyQuality(hls) {
  const lv = qualityLevels(hls);
  $("pQualWrap").hidden = lv.length < 2;
  if (lv.length < 2) return;
  let pick = null;
  if (player.qual !== "auto") pick = lv.find((l) => l.label === player.qual) || lv.find((l) => l.h && l.h <= parseInt(player.qual, 10)) || lv[lv.length - 1];
  hls.currentLevel = pick ? pick.i : -1;
  $("pQual").textContent = pick ? pick.label : t("player.auto");
}

function bindPlayer() {
  const v = player.el();
  $("pRate").addEventListener("click", () =>
    openMenu("pRate", PLAY_RATES.map((r) => [r, rateText(r)]), player.rate, setPlayRate));
  $("pQual").addEventListener("click", () => {
    if (!player.hls) return;
    const lv = qualityLevels(player.hls);
    openMenu("pQual", [["auto", t("player.auto")], ...lv.map((l) => [l.label, l.label])], player.qual, (q) => {
      player.qual = q;
      applyQuality(player.hls);
    });
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".pmenuwrap")) closeMenus(); });
  for (const ev of ["play", "pause", "timeupdate", "durationchange", "seeked"]) v.addEventListener(ev, paintPlayer);
  v.addEventListener("playing", () => { $("player").classList.add("playing"); $("player").classList.remove("loading"); });
  v.addEventListener("waiting", () => { if (player.key) $("player").classList.add("loading"); });   // takildi, tampon doluyor
  v.addEventListener("pause", () => $("player").classList.remove("loading"));
  v.addEventListener("volumechange", () => { paintVolume(); player.saveVolume(); });
  v.addEventListener("error", () => { if (player.key) player.msg(t("player.failed")); });
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
/* ---------- kapak yedegi ---------- */
const avatarOf = (v) => (v && v.avatar) || avatarFor(v && v.url) || (state.channel && state.channel.avatar) || "";

function showFallback(host, avatar) {
  host.classList.add("nothumb");
  const old = host.querySelector(":scope > .pfb");
  if (old && old.dataset.av === (avatar || "")) return;
  if (old) old.remove();
  host.insertAdjacentHTML("afterbegin", `<div class="pfb" data-av="${esc(avatar || "")}" aria-hidden="true">${avatar
    ? `<img class="pfbg" src="${esc(avatar)}" alt=""><img class="pfav" src="${esc(avatar)}" alt="">`
    : `<img class="pfk" src="logo.svg" alt="">`}</div>`);
  if (avatar) for (const im of host.querySelectorAll(":scope > .pfb img")) im.addEventListener("error", () => showFallback(host, ""), { once: true });
}
function clearFallback(host) {
  host.classList.remove("nothumb");
  const fb = host.querySelector(":scope > .pfb");
  if (fb) fb.remove();
}

/* kartin kapagi: yoksa / bozuksa / cok kucukse (gercek bir kare degil) yedek + VOD ise gorunince gercek kare istenir */
function bindThumb(host, v) {
  const img = host.querySelector(":scope > img");
  const url = posters.get(v.uuid) || v.thumb;
  const miss = () => { img.removeAttribute("src"); showFallback(host, avatarOf(v)); posters.want(host, v); };
  if (!url) { miss(); return; }
  img.addEventListener("error", miss, { once: true });
  img.addEventListener("load", () => { if (img.naturalWidth < 32) miss(); else verifyThumb(host, kindOf(v) === "clip", miss); }, { once: true });
  img.src = url;
}

/* gorunen kapagin parazit / statik olup olmadigini sunucuya sordurur (sirayla, bir seferde bir tane); parazitse miss() */
function makeVerifier() {
  const q = [];
  let busy = false;
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); q.push(e.target); pump(); } }), { rootMargin: "150px" });
  async function pump() {
    if (busy) return;
    busy = true;
    while (q.length) {
      const host = q.shift(), f = host._vf;
      const src = host.isConnected && f && (host.querySelector(":scope > img").getAttribute("src") || "");
      if (!/^https?:/.test(src)) continue;
      try {
        const r = await state.api.thumb_check(src, f.strict);
        if (r && r.noise && host.isConnected && host.querySelector(":scope > img").getAttribute("src") === src) f.miss();
      } catch { /* kapak kalir */ }
    }
    busy = false;
  }
  return (host, strict, miss) => { host._vf = { strict, miss }; io.observe(host); };
}
const verifyThumb = makeVerifier();

const posters = {
  mem: new Map(), tried: new Set(), q: [], busy: 0, io: null,
  get(uuid) { return (uuid && this.mem.get(uuid)) || ""; },
  want(host, v) {
    if (!v.uuid || kindOf(v) !== "vod" || !state.cfg.ffmpeg || this.tried.has(v.uuid)) return;
    host._pv = v;
    if (!this.io) this.io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { this.io.unobserve(e.target); this.q.push(e.target); this.pump(); } }), { rootMargin: "150px" });
    this.io.observe(host);
  },
  async pump() {
    while (this.busy < 2 && this.q.length) {
      const host = this.q.shift(), v = host._pv;
      if (!host.isConnected || !v || this.mem.has(v.uuid) || this.tried.has(v.uuid)) continue;
      this.tried.add(v.uuid);
      this.busy++;
      try {
        const url = await state.api.vod_poster(v.uuid, v.duration || 0);
        if (url) {
          this.mem.set(v.uuid, url);
          for (const el of $("grid").querySelectorAll(".card .thumb")) {
            const pv = el._pv;
            if (pv && pv.uuid === v.uuid && el.classList.contains("nothumb")) { el.querySelector(":scope > img").src = url; clearFallback(el); }
          }
        }
      } catch { /* yedek kalir */ }
      this.busy--;
    }
  },
};

/* Indirilenler satiri: kapak yoksa yedek; dosya varsa dosyadan bir kare alinip kayda yazilir (bir kez, ag yok) */
const libPosters = {
  tried: new Set(), q: [], busy: false, io: null,
  want(host, e, force) {
    if (!e.exists || !playable(e) || this.tried.has(e.file)) return;
    host._pe = { e, force };
    if (!this.io) this.io = new IntersectionObserver((es) => es.forEach((x) => { if (x.isIntersecting) { this.io.unobserve(x.target); this.q.push(x.target); this.pump(); } }), { rootMargin: "100px" });
    this.io.observe(host);
  },
  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.q.length) {
      const host = this.q.shift(), pe = host._pe;
      if (!host.isConnected || !pe || this.tried.has(pe.e.file)) continue;
      this.tried.add(pe.e.file);
      try {
        const url = await state.api.library_poster(pe.e.file, !!pe.force);
        if (url) { pe.e.thumb = url; const le = libEntry(pe.e.file); if (le) le.thumb = url; if (host.isConnected) { host.querySelector(":scope > img").src = url; clearFallback(host); } }
      } catch { /* yedek kalir */ }
    }
    this.busy = false;
  },
};
function bindLibThumb(host, e) {
  const img = host.querySelector(":scope > img");
  const miss = () => { img.removeAttribute("src"); showFallback(host, avatarFor(e.url) || ""); libPosters.want(host, e, true); };
  if (!e.thumb) { miss(); return; }
  img.addEventListener("error", miss, { once: true });
  img.addEventListener("load", () => { if (img.naturalWidth < 32) miss(); else verifyThumb(host, false, miss); }, { once: true });
  img.src = e.thumb;
}

const SPIN = `<div class="spin" aria-hidden="true"><svg viewBox="0 0 50 50"><circle class="trk" cx="25" cy="25" r="20"/><circle class="arc" cx="25" cy="25" r="20"/></svg></div>`;
const hover = {
  timer: 0, hls: null, card: null, video: null, url: null, zone: null, peekTimer: 0,
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
      const kind = kindOf(v);
      // secim varken ya da canli ogede yerinde onizleme; aksi halde buyuyen kart (video + zaman cubugu onun icinde)
      const floating = !state.selected.size && kind !== "live" && !v.live && !card.classList.contains("livecard");
      const thumb = floating ? hcard.open(card, v) : card.querySelector(".thumb");
      thumb.querySelector(":scope > img").after(video);
      if (!thumb.querySelector(".spin")) thumb.insertAdjacentHTML("beforeend", SPIN);
      thumb.classList.add("loading");
      const start = kind === "live" ? -1 : kind === "vod" ? Math.floor((v.duration || 0) * 0.2) : 0;
      const hls = new Hls({ maxBufferLength: 6, startPosition: start, capLevelToPlayerSize: true, autoStartLoad: true });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        let lo = 0;
        hls.levels.forEach((l, i) => { if (l.bitrate < hls.levels[lo].bitrate) lo = i; });
        hls.currentLevel = lo;
        video.play().catch(() => {});
      });
      video.addEventListener("playing", () => { video.classList.add("on"); thumb.classList.remove("loading"); thumb.classList.add("scrub"); }, { once: true });
      if (kind !== "live" && !v.live) this.scrubber(thumb, video, v);
      hlsUrl(v).then((src) => {
        if (this.hls !== hls) return;
        hls.loadSource(src);
        hls.attachMedia(video);
      }).catch(() => {});
      this.hls = hls;
      this.video = video;
      this.url = v.url;
    }, 450);
  },
  /* altta ince ilerleme cubugu (YouTube gibi); imlecle uzerine gelince kalinlasir, zaman etiketi ve (onbellekteyse)
     o anin karesi cikar, onizleme oraya sarar. Cubuga tiklamak karti acmaz. Canli yayinda cubuk yok. */
  scrubber(thumb, video, v) {
    const zone = document.createElement("div");
    zone.className = "hzone";
    zone.setAttribute("aria-hidden", "true");
    zone.innerHTML = `<div class="hlab" hidden><img alt="" hidden><span class="num"></span></div><div class="hbar"><i class="hseek"></i><i class="hfill"></i></div>`;
    thumb.append(zone);
    this.zone = zone;
    const lab = zone.querySelector(".hlab"), labImg = lab.querySelector("img"), labT = lab.querySelector("span");
    const fill = zone.querySelector(".hfill"), seek = zone.querySelector(".hseek");
    const seeker = makeSeeker(video);
    const dur = () => (isFinite(video.duration) && video.duration > 0 ? video.duration : v.duration || 0);
    video.addEventListener("timeupdate", () => {
      const d = dur();
      if (d) fill.style.transform = `scaleX(${clamp(video.currentTime / d, 0, 1)})`;
    });
    const at = (e) => {
      const r = zone.getBoundingClientRect();
      return { x: e.clientX - r.left, w: r.width, f: clamp((e.clientX - r.left) / r.width, 0, 1) };
    };
    let lastPeek = 0, token = 0;
    const peek = (t) => {     // kare yalnizca onbellekten gelir (kart onisitmasi / editor doldurduysa), ag yok
      lastPeek = performance.now();
      if (!v.uuid || kindOf(v) !== "vod") return;
      const mine = ++token;
      state.api.strip_peek(v.uuid, t).then((src) => {
        if (mine !== token) return;
        labImg.hidden = !src;
        if (src) labImg.src = src;
      }).catch(() => {});
    };
    zone.addEventListener("pointermove", (e) => {
      const d = dur();
      if (!d) return;
      const { x, w, f } = at(e);
      const t = f * d;
      seek.style.transform = `scaleX(${f})`;
      lab.hidden = false;
      labT.textContent = fmtDuration(t);
      const half = lab.offsetWidth / 2;
      lab.style.left = `${clamp(x, half, w - half)}px`;
      seeker.to(t);
      clearTimeout(this.peekTimer);
      if (performance.now() - lastPeek > 80) peek(t);
      else this.peekTimer = setTimeout(() => peek(t), 80);    // son konum da kare alsin
    });
    zone.addEventListener("pointerleave", () => {
      lab.hidden = true;
      clearTimeout(this.peekTimer);
      seek.style.transform = "scaleX(0)";
    });
    zone.addEventListener("click", (e) => {      // sar ve oynamaya devam et; karti acma
      e.stopPropagation();
      const d = dur();
      if (d) seeker.to(at(e).f * d);
    });
    for (const ev of ["dblclick", "pointerdown", "contextmenu"]) zone.addEventListener(ev, (e) => e.stopPropagation());
  },
  /* tiklaninca inceleme ayni andan devam etsin */
  time(url) {
    return this.url === url && this.video && this.video.currentTime > 0.5 ? this.video.currentTime : null;
  },
  stop() {
    clearTimeout(this.timer);
    clearTimeout(this.peekTimer);
    if (this.zone) { this.zone.remove(); this.zone = null; }
    hcard.close();
    if (this.card) this.card.querySelector(".thumb").classList.remove("loading", "scrub");
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (this.video) { this.video.pause(); this.video.remove(); this.video = null; }
    this.card = null;
    this.url = null;
  },
};

/* buyuyen kart (YouTube tarzi): onizleme basladiginda kartin dikdortgeninden ~1.2x'e buyur; gorsel rozetler yok,
   indirme durumu bilgi alaninda metin + ince cubuk. Onizleme videosu ve zaman cubugu bunun icine konur (tek Hls). */
const hcard = {
  el: null, card: null, url: null, key: "",
  open(card, v) {
    const el = $("hCard");
    this.el = el; this.card = card; this.url = v.url; this.key = "";
    const media = el.querySelector(".hcmedia"), cthumb = card.querySelector(".thumb");
    media.querySelector(":scope > img").src = cthumb.querySelector(":scope > img").getAttribute("src") || "";
    if (cthumb.classList.contains("nothumb")) showFallback(media, avatarOf(v)); else clearFallback(media);
    el.querySelector(".hctitle").textContent = cleanTitle(v.title);
    el.querySelector(".hctitle").title = v.title;
    el.querySelector(".hcmeta").textContent = [fmtAgo(v.start), t("card.views", { n: v.views, c: fmtCount(v.views) }), fmtDuration(v.duration)].filter(Boolean).join(" · ");
    el.classList.remove("in");
    el.hidden = false;
    this.paint();
    // kartin kucuk resminin dikdortgeni -> 1.2x; kaydirma alani icine sigdir (kenar kartlar iceri buyur)
    const r = card.querySelector(".thumb").getBoundingClientRect();
    const wrap = $("gridWrap").getBoundingClientRect();
    const W = Math.round(r.width * 1.2);
    el.style.width = `${W}px`;
    const H = el.offsetHeight;
    const x = clamp(r.left + r.width / 2 - W / 2, wrap.left + 4, wrap.right - W - 4);
    const y = clamp(r.top + r.height / 2 - (W * 9 / 16) / 2, wrap.top + 4, Math.max(wrap.top + 4, wrap.bottom - H - 4));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.transition = "none";
    el.style.opacity = "0.6";
    el.style.transform = `translate(${r.left - x}px, ${r.top - y}px) scale(${r.width / W})`;
    void el.offsetWidth;
    el.style.transition = "";
    el.style.opacity = "";
    el.style.transform = "";
    el.classList.add("in");
    return el.querySelector(".hcmedia");
  },
  close() {
    if (!this.el) return;
    this.el.hidden = true;
    this.el.querySelector(".hcmedia").replaceChildren(this.el.querySelector(".hcmedia > img"));
    this.el.querySelector(".hcmedia").classList.remove("loading", "scrub", "nothumb");
    this.el = this.card = this.url = null;
  },
  /* indirme durumu: metin + cubuk her guncellemede, islem dugmeleri yalnizca durum degisince */
  paint() {
    if (!this.el) return;
    const v = itemByUrl(this.url);
    if (!v) return;
    const d = state.byUrl.get(v.url), kind = kindOf(v);
    const box = this.el.querySelector(".hcstate"), bar = box.querySelector(".hcbar");
    box.hidden = !d;
    if (d) {
      const [cls, text] = cardState(d);
      box.className = `hcstate ${cls === "active" || cls === "done" ? "" : cls}`;
      box.firstElementChild.textContent = text;
      const pct = ["downloading", "merging"].includes(d.status);
      bar.hidden = !pct;
      bar.firstElementChild.style.transform = `scaleX(${(d.pct || 0) / 100})`;
    }
    const key = `${d ? d.status : ""}:${d ? d.id : ""}`;
    if (key === this.key) return;
    this.key = key;
    const b = (act, label, ic, cls) => `<button type="button" class="btn sm ${cls || ""}" data-hc="${act}">${icon(ic)}<span>${esc(label)}</span></button>`;
    let main;
    if (!d) main = b("dl", kind === "clip" ? t("act.dlClip") : t("act.download"), "download", "primary");
    else if (d.status === "done") main = b("playfile", t("act.playDownloaded"), "play", "primary");
    else if (["stopped", "error"].includes(d.status)) main = b("retry", d.status === "error" ? t("act.retry") : t("act.resume"), "retry", "primary");
    else main = b("cancel", t("act.stopDl"), "stop", "danger");
    this.el.querySelector(".hcact").innerHTML = main + (kind === "vod" ? b("cut", t("card.cut"), "scissors") : "")
      + `<button type="button" class="btn ghost sm hcmore" data-hc="more" title="${esc(t("card.more"))}" aria-label="${esc(t("card.more"))}" aria-haspopup="menu">${icon("more")}</button>`;
  },
};

/* karta 300 ms'den uzun gelinince editorun ilk 16 karesi arka planda hazirlanir (serit listesi + kareler;
   sunucu bellekte ve diskte tutar). Yalnizca VOD'lar; ayni VOD bir kez; yalnizca son gelinen kart. */
const prewarm = {
  timer: 0, card: null, last: null, done: new Set(),
  over(card) {
    if (this.card === card) return;
    this.cancel();
    const v = itemByUrl(card.dataset.url);
    if (!v || !v.uuid || kindOf(v) !== "vod" || !state.cfg.ffmpeg || this.done.has(v.uuid)) return;
    this.card = card;
    this.timer = setTimeout(() => this.run(v), 300);
  },
  cancel() {
    clearTimeout(this.timer);
    this.card = null;
  },
  async run(v) {
    this.done.add(v.uuid);
    this.last = v.uuid;
    const t0 = performance.now();
    const res = await state.api.strip_index(v.uuid, false);
    if (!res.ok || this.last !== v.uuid) { this.done.delete(v.uuid); return; }   // baska karta gecildiyse kareler atlanir
    const segs = res.segments;
    const end = segs.length ? segs[segs.length - 1][0] + segs[segs.length - 1][1] : 0;
    // editorun ilk istedigi kareler: ayni formul (tilesFor) ve en son olculen serit genislikleri; ilk acilista tahmin
    const view = Math.min(WAVE_MAX, v.duration || end, end);
    const w0 = Math.max(500, window.innerWidth - 114);    // olculen: editor genisligi = pencere - 114 px
    const tl = cut.geom.tlFilm || { w: w0, fw: 69 }, ov = cut.geom.ovFilm || { w: w0, fw: 50 };   // olculen kare genislikleri (film yuksekligi 39 / 28 px)
    const times = [...tilesFor(tl.w, tl.fw, 0, view), ...tilesFor(ov.w, ov.fw, 0, v.duration || end)];
    const idx = [...new Set(times.map((t) => segAt(segs, t)))].slice(0, 64);
    const t1 = performance.now();
    for (let k = 0; k < idx.length; k += 16) {     // 16'lik gruplar: ilk grup (gorunen serit) yavas bir parcaya takilmasin
      if (k && this.last !== v.uuid) break;
      await state.api.strip_thumbs(v.uuid, idx.slice(k, k + 16));
    }
    state.api.client_log(`perf kart onisitma: ${Math.round(performance.now() - t0)} ms (${idx.length} kare, kareler ${Math.round(performance.now() - t1)} ms)`);
  },
};

/* ---------- inceleme paneli ---------- */
function focusItem(url, start) {
  const it = state.channel && itemByUrl(url);
  if (it) track("watch_open", { kind: kindOf(it) });
  state.focus = url;
  state.libFocus = null;
  paintCards();
  openWatch();
  renderInspector(start);
}

/* ---------- oynatici penceresi ----------
   Kanalda tiklanan video / canli yayin ya da Indirilenler'deki dosya. Kapaninca oynatici durur. */
function openWatch() {
  const w = $("watch");
  if (!w.open) w.showModal();
  paintWatchNav();
}

function closeWatch() {
  if ($("watch").open) $("watch").close();
}

function onWatchClosed() {
  player.stop();
  watchChat.stop();
  watchChat.key = null;
  const lib = state.libFocus;
  state.focus = null;
  state.libFocus = null;
  paintCards();
  if (lib && state.view === "library") renderLibrary();
}

/* onceki / sonraki: kanalda izgaradaki sira (canli yayin basta), Indirilenler'de listedeki sira */
function watchList() {
  if (state.libFocus) return libVisible().filter((e) => e.exists && playable(e)).map((e) => e.file);
  const live = state.tab === "vods" && !filtering() && liveItem();
  return [...(live ? [live.url] : []), ...filtered().map((v) => v.url)];
}

function watchStep(d) {
  const list = watchList();
  const i = list.indexOf(state.libFocus || state.focus);
  const next = i < 0 ? null : list[i + d];
  if (!next) return;
  if (state.libFocus) { playFile(next); return; }
  hover.stop();
  focusItem(next);
  const el = cardEl(next);
  el && el.scrollIntoView({ block: "nearest" });
}

function paintWatchNav() {
  const list = watchList();
  const i = list.indexOf(state.libFocus || state.focus);
  $("wPrev").disabled = i <= 0;
  $("wNext").disabled = i < 0 || i >= list.length - 1;
}

function renderInspector(start) {
  const body = $("insBody"), btns = $("insBtns");
  $("qualityBox").hidden = false;
  const v = state.focus && state.channel && itemByUrl(state.focus);
  if (!v) { closeWatch(); return; }
  const kind = kindOf(v);
  if (kind === "live") {
    player.load(`live:${state.channel.slug}`, { source: hlsUrl(v), poster: v.thumb || v.avatar, avatar: v.avatar, live: true });
    $("insPoster").classList.toggle("avfb", !v.thumb);
  } else {
    player.load(v.url, { source: v.source, poster: posters.get(v.uuid) || v.thumb, avatar: avatarOf(v), start: start ?? hover.time(v.url) ?? 0 });
  }
  const facts = [];
  if (kind === "live") {
    facts.push([t("fact.started"), `${fmtAgo(v.start)}`], [t("fact.watching"), fmtCount(v.views)]);
  } else {
    facts.push([kind === "clip" ? t("fact.clipped") : t("fact.stream"), fmtDate(v.start)], [t("fact.length"), fmtDuration(v.duration)], [t("fact.views"), fmtCount(v.views)]);
    if (v.creator) facts.push([t("fact.clippedBy"), esc(v.creator)]);
  }
  const cats = v.categories && v.categories.length ? v.categories : v.category ? [v.category] : [];
  if (cats.length) facts.push([cats.length > 1 ? t("fact.categories") : t("filter.category"), `<span class="chips">${cats.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</span>`]);
  const d = kind === "live" ? liveRec(v.url) : state.byUrl.get(v.url);
  body.innerHTML = `<h2>${esc(cleanTitle(v.title))}${kind === "live" ? `<span class="beta">${t("live.chip")}</span>` : ""}</h2>
    <dl class="facts">${facts.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join("")}</dl>
    ${d ? stateBlock(d) : ""}
    ${kind === "live" ? `<p class="insnote">${t("watch.liveRecNote")}</p>` : ""}
    ${kind === "live" && state.liveVod ? `<p class="insnote">${t("watch.liveCutNote")}</p>` : ""}`;
  if (kind === "live") {
    const rec = d && ACTIVE.concat("queued").includes(d.status);
    btns.innerHTML = (rec
      ? `<button class="btn span" data-ins="stoprec" data-id="${d.id}">${icon("stop")}${t("live.stopRec")}</button>`
      : `<button class="btn primary span" data-ins="record">${icon("record")}${t("live.startRec")}</button>`)
      + (state.liveVod ? `<button class="btn span" data-ins="cut">${icon("scissors")}${t("card.cut")}</button>` : "");
  } else if (kind === "clip") {
    btns.innerHTML = `<button class="btn primary span" data-ins="dl">${icon("download")}${t("act.dlClip")}</button>
      ${chatButton(v)}`;
  } else {
    btns.innerHTML = `<button class="btn primary" data-ins="dl">${icon("download")}${t("act.dlAll")}</button>
      <button class="btn" data-ins="cut">${icon("scissors")}${t("card.cut")}</button>
      ${chatButton(v)}`;
  }
  syncWatchChat();
}

/* izleme penceresinin sohbet paneli: videonun sagindaki sutun; acik / kapali ayarlarda kalir */
let watchChat = null;
function watchChatSpec() {
  if (state.libFocus) {
    const e = libEntry(state.libFocus);
    return e && e.exists && !e.chat ? { file: e.file } : null;
  }
  const v = state.focus && state.channel && itemByUrl(state.focus);
  if (!v) return null;
  const kind = kindOf(v);
  return kind === "live" ? { live: state.channel.slug } : kind === "clip" ? { clip: v.uuid } : v.uuid ? { vod: v.uuid } : null;
}

function syncWatchChat() {
  const spec = watchChatSpec(), on = !!(spec && state.settings.chatPanel);
  $("inspector").classList.toggle("chat", on);
  $("wChat").hidden = !on;
  $("pChat").hidden = !spec;
  $("pChat").setAttribute("aria-pressed", String(on));
  const key = on ? JSON.stringify(spec) : null;
  if (key === watchChat.key) return;
  watchChat.key = key;
  if (on) watchChat.start(spec); else watchChat.stop();
}

/* sohbet videosunun adi ve kapagi: izlenen video ya da dosya */
function watchChatInfo() {
  const e = state.libFocus && libEntry(state.libFocus);
  const v = !e && state.focus && itemByUrl(state.focus);
  const x = e || v || {};
  return { url: x.url || "", title: cleanTitle(x.title || ""), thumb: x.thumb || "" };
}

/* oynatilan an: VOD'da videodaki saniye; canlida ekrandaki karenin gercek zamani (epoch sn) */
function watchChatNow() {
  const v = player.el();
  if (!player.key || v.readyState < 1) return null;
  if (!player.live) return v.currentTime;
  const h = player.hls;
  if (h && h.playingDate) return h.playingDate.getTime() / 1000;
  return Date.now() / 1000 - ((h && h.latency) || 10);
}

async function downloadChat(v) {
  const n = await state.api.enqueue([{ url: v.url, chat: true, title: cleanTitle(v.title), thumb: v.thumb, duration: Math.round(v.duration || 0) }]);
  toast(n ? t("toast.chatQueued") : t("toast.chatExists"));
}

/* ---------- kartin "diger islemler" menusu ----------
   Uc nokta ya da sag tik. Islemler videonun durumuna gore: inmemis, iniyor, durmus / hatali, inmis. */
const cmenu = { url: null, btn: null };

function cardMenuItems(v) {
  const kind = kindOf(v), d = state.byUrl.get(v.url);
  const items = [["watch", "play", t("card.watch")]];
  if (!d) items.push(["dl", "download", kind === "clip" ? t("act.dlClip") : t("act.dlAll"), "go"]);
  else if (d.status === "done") items.push(["playfile", "play", t("act.playDownloaded")], ["reveal", "reveal", t("act.reveal")]);
  else if (["stopped", "error"].includes(d.status)) items.push(["retry", "retry", d.status === "error" ? t("act.retry") : t("act.resume"), "go"]);
  else items.push(["cancel", "stop", t("act.stopDl"), "danger"]);
  if (d && d.status !== "done" && !d.live) items.push(["abort", "trash", t("act.abortDelete"), "danger"]);
  if (kind === "vod") items.push(["cut", "scissors", t("card.cut")]);
  if (kind === "vod" || kind === "clip") {
    const c = chatJob(v.url);
    if (!c || ["error", "stopped"].includes(c.status)) items.push(["chat", "chat", t("act.dlChat")]);
  }
  items.push("-", ["select", "check", state.selected.has(v.url) ? t("sel.remove") : t("card.select"), "", t("act.ctrlClick")]);
  items.push("-", ["kick", "external", t("act.openKick")], ["copy", "link", t("act.copyLink")]);
  return items;
}

function openCardMenu(url, at, btn) {
  const v = itemByUrl(url);
  if (!v) return;
  const anchor = btn ? btn.getBoundingClientRect() : at && at.rect;     // buyuyen kartin dugmesi onizleme kapaninca kalkar: dikdortgen once alinir
  closeCardMenu(false);
  hover.stop();
  cmenu.url = url;
  cmenu.btn = btn || null;
  const m = $("cardMenu");
  m.innerHTML = cardMenuItems(v).map((x) => x === "-" ? "<hr>"
    : `<button type="button" role="menuitem" data-cm="${x[0]}" class="${x[3] || ""}">${icon(x[1])}<span>${esc(x[2])}</span>${x[4] ? `<small>${x[4]}</small>` : ""}</button>`).join("");
  m.hidden = false;
  const w = m.offsetWidth, h = m.offsetHeight;
  const r = anchor || { left: at.x, right: at.x, top: at.y, bottom: at.y };
  const left = anchor ? r.right - w : r.left;
  const down = window.innerHeight - r.bottom - 8 >= h;
  m.style.left = `${clamp(left, 8, window.innerWidth - w - 8)}px`;
  m.style.top = `${down ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
  m.classList.toggle("up", !down);
  if (btn) btn.setAttribute("aria-expanded", "true");
  m.querySelector("button").focus({ preventScroll: true });
}

function closeCardMenu(focusBtn) {
  const m = $("cardMenu");
  if (m.hidden) return;
  m.hidden = true;
  if (cmenu.btn) { cmenu.btn.setAttribute("aria-expanded", "false"); if (focusBtn) cmenu.btn.closest(".card").focus(); }
  cmenu.url = cmenu.btn = null;
}

async function onCardMenu(act, at = cmenu.url) {
  const url = at, v = itemByUrl(url), d = state.byUrl.get(url);
  closeCardMenu(false);
  if (!v) return;
  if (act === "watch") focusItem(url);
  else if (act === "dl") await enqueueItems([v]);
  else if (act === "playfile" && d) playFile(d.filename);
  else if (act === "reveal" && d) state.api.reveal(d.id);
  else if (act === "retry" && d) state.api.retry(d.id);
  else if (act === "cancel" && d) state.api.cancel(d.id);
  else if (act === "abort" && d) state.api.abort(d.id);
  else if (act === "cut") openCutter(cutTarget(v));
  else if (act === "chat") downloadChat(v);
  else if (act === "select") { toggleSel(url); state.anchor = url; selectionChanged(); }
  else if (act === "kick") state.api.open_url(kickPage(v));
  else if (act === "copy") copyText(kickPage(v)).then((ok) => toast(ok ? t("toast.linkCopied") : t("toast.linkCopyFailed")));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* asagidaki yol */ }
  const t = document.createElement("textarea");
  t.value = text;
  t.style.cssText = "position:fixed;opacity:0";
  document.body.append(t);
  t.select();
  const ok = document.execCommand("copy");
  t.remove();
  return ok;
}

function bindCardMenu() {
  const m = $("cardMenu");
  m.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cm]");
    if (b) onCardMenu(b.dataset.cm);
  });
  m.addEventListener("keydown", (e) => {
    const items = [...m.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    else if (e.key === "Home") items[0].focus();
    else if (e.key === "End") items[items.length - 1].focus();
    else if (e.key === "Escape" || e.key === "Tab") closeCardMenu(e.key === "Escape");
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!m.hidden && !e.target.closest(".cardmenu") && e.target.closest(".more") !== cmenu.btn) closeCardMenu(false);
  });
  $("gridWrap").addEventListener("scroll", () => closeCardMenu(false), { passive: true });
  window.addEventListener("resize", () => closeCardMenu(false));
  window.addEventListener("blur", () => closeCardMenu(false));
}

/* VOD'un sohbeti: videoyla ayni adla .ass + .json; durum dugmenin uzerinde */
/* videonun tamaminin sohbet isi (kesit sohbetleri ayri) */
const chatJob = (url) => state.downloads.find((x) => x.chat && x.url === url && !x.section);

function chatButton(v) {
  const c = chatJob(v.url);
  const busy = c && ["queued", ...ACTIVE].includes(c.status);
  const label = busy ? t("chat.downloadingPct", { p: Math.floor(c.pct) }) : c && c.status === "done" ? t("chat.done") : c && c.status === "error" ? t("chat.failedRetry") : t("act.dlChat");
  return `<button class="btn ghost span" data-ins="chat" data-k="${c ? `${c.status}:${Math.floor(c.pct)}` : ""}"${busy ? " disabled" : ""}
    title="${esc(t("chat.tip"))}">${icon("chat")}${esc(label)}</button>`;
}

function stateBlock(d) {
  let line = statusName(d.status);
  if (d.status === "downloading") line += " " + t("pct", { p: Math.floor(d.pct) });
  let sub = "";
  if (d.status === "downloading") sub = [d.size ? `${fmtBytes(d.size * d.pct / 100)} / ${d.exact ? "" : "~"}${fmtBytes(d.size)}` : "", fmtSpeed(d.speed), fmtEta(d.eta)].filter(Boolean).join(" · ");
  if (d.status === "recording") sub = [d.started ? t("rec.recorded", { d: fmtDuration(Date.now() / 1000 - d.started) }) : "", fmtBytes(d.size)].filter(Boolean).join(" · ");
  if (d.status === "done") sub = fmtBytes(d.size);
  if (d.status === "error") sub = humanError(d.error, d.friendly);
  if (d.status === "stopped" && d.pct > 0) sub = t("dl.resumeHint");
  const showBar = ["downloading", "merging", "preparing", "recording", "queued"].includes(d.status);
  const acts = d.status === "done"
    ? `<div class="btnrow"><button class="btn sm" data-ins="playfile" data-file="${esc(d.filename)}">${icon("play")}${t("act.play")}</button><button class="btn ghost sm" data-ins="reveal" data-id="${d.id}">${icon("reveal")}${t("act.reveal")}</button></div>`
    : ["stopped", "error"].includes(d.status) ? `<div class="btnrow"><button class="btn sm" data-ins="retry" data-id="${d.id}">${icon("retry")}${t("act.retry")}</button>${d.live ? "" : `<button class="btn ghost sm danger" data-ins="abort" data-id="${d.id}">${icon("trash")}${t("act.abort")}</button>`}</div>`
    : `<div class="btnrow"><button class="btn ghost sm danger" data-ins="cancel" data-id="${d.id}">${icon("stop")}${t("act.stop")}</button>${d.live ? "" : `<button class="btn ghost sm danger" data-ins="abort" data-id="${d.id}">${icon("trash")}${t("act.abort")}</button>`}</div>`;
  return `<div class="insstate ${d.status}" data-k="${d.id}:${d.status}"><p>${line}</p>${showBar ? `<div class="bar"><i style="transform:scaleX(${d.status === "queued" ? 0 : d.pct / 100})"></i></div>` : ""}${sub ? `<p class="num">${esc(sub)}</p>` : ""}${acts}</div>`;
}

async function onInspectorAction(b) {
  const act = b.dataset.ins;
  const v = state.focus && itemByUrl(state.focus);
  if (act === "dl" && v) await enqueueItems([v]);
  else if (act === "cut" && v) { closeWatch(); openCutter(cutTarget(v)); }
  else if (act === "chat" && v) downloadChat(v);
  else if (act === "record" && v) {
    const n = await state.api.enqueue([{ url: v.url, title: cleanTitle(v.title), thumb: v.thumb || v.avatar, live: true }]);
    toast(n ? t("toast.recStarted") : t("toast.recExists"));
    if (n) track("live_record", { channel: state.channel ? state.channel.slug : "" });
  }
  else if (act === "stoprec" || act === "cancel") state.api.cancel(Number(b.dataset.id));
  else if (act === "retry") state.api.retry(Number(b.dataset.id));
  else if (act === "abort") state.api.abort(Number(b.dataset.id));
  else if (act === "reveal") state.api.reveal(Number(b.dataset.id));
  else if (act === "playfile" || act === "lplay") playFile(b.dataset.file);
  else if (act === "lopen") { player.el().pause(); state.api.open_file(b.dataset.file); }   // ayni anda iki yerde calmasin
  else if (act === "lreveal") state.api.reveal_file(b.dataset.file);
  else if (act === "lchatvideo") {
    track("chat_video_file");
    withBusy(b, () => state.api.chat_video_file(b.dataset.file).then((r) => toast(r.ok ? t("chat.vid.queued") : r.error)));
  }
  else if (act === "lcapcut") openInCapcut(b);
  else if (act === "lccchat") { capcut.chat = !capcut.chat; saveCapcut(); b.setAttribute("aria-checked", capcut.chat); }
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
    const tip = [f.name, live ? t("rail.isLive") : "", nv ? t("ch.newVods", { n: nv }) : "",
      f.autoDownload ? t("rail.autoDl") : "", f.autoRecord ? t("rail.autoRec") : ""].filter(Boolean).join(" · ");
    return `<button class="fav${live ? " live" : ""}${cur === f.slug ? " on" : ""}" type="button" role="listitem" data-slug="${esc(f.slug)}" title="${esc(tip)}" aria-label="${esc(tip)}">
      <img src="${esc(f.avatar || BLANK)}" alt="">${f.autoDownload || f.autoRecord ? `<i class="fauto"></i>` : ""}${live ? `<span class="flive">${t("live.chip")}</span>` : nv ? `<span class="fnew">${nv > 9 ? "9+" : nv}</span>` : ""}</button>`;
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
  if (!state.favorite) track("favorite_add", { channel: ch.slug });
  if (state.favorite) {
    state.favorites = await state.api.favorite_remove(ch.slug);
    state.favorite = false;
    toast(t("toast.favRemoved", { name: ch.name }));
  } else {
    const res = await state.api.favorite_add(ch.slug);
    if (!res.ok) { toast(res.error); return; }
    state.favorites = res.favorites;
    state.favorite = true;
    state.favStatus[ch.slug] = { ok: true, name: ch.name, avatar: ch.avatar, live: ch.live, newVods: 0 };
    toast(t("toast.favAdded", { name: ch.name }));
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
  toast(t("toast.favAdded", { name: res.favorite.name }));
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
  $("homeMeta").textContent = [live ? t("home.liveCount", { n: live }) : "", fresh ? t("ch.newVods", { n: fresh }) : ""].filter(Boolean).join(" · ");
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
    const stat = !st.ok ? esc(t("home.noInfo"))
      : live ? `<em>${t("player.live")}</em> · ${esc(cleanTitle((st.live && st.live.title) || ""))}`
      : st.newVods ? `<strong>${esc(t("ch.newVods", { n: st.newVods }))}</strong>` : lt ? esc(t("home.lastStream", { ago: fmtAgo(lt.start) })) : esc(t("home.noVods"));
    return `<button class="ftile${live ? " live" : ""}" type="button" data-slug="${esc(f.slug)}">
      <img class="av" src="${esc(f.avatar || BLANK)}" alt=""><b>${esc(f.name)}</b><span class="fstat">${stat}</span>
      ${lt ? `<span class="latest"><img src="${esc(lt.thumb || BLANK)}" alt=""><span>${esc(cleanTitle(lt.title))}</span></span>` : ""}</button>`;
  }).join("");
  const rec = state.library.filter((e) => e.exists && !e.chat).slice(0, 6);
  $("recentBox").hidden = !rec.length;
  renderCutSets();
  $("recentRow").innerHTML = rec.map((e) => `<button class="rtile" type="button" data-file="${esc(e.file)}">
    <img src="${esc(e.thumb || BLANK)}" alt=""><p>${esc(cleanTitle(e.title))}</p><span class="num">${esc(e.channel)} · ${fmtBytes(e.size)}</span></button>`).join("");
}

/* ana sayfadaki "Kayitli kesitler": bir kartla editor o VOD'un kesitleriyle acilir */
function renderCutSets() {
  const sets = state.cutSets;
  $("cutSetEmpty").hidden = sets.length > 0;
  $("cutSetExport").hidden = !sets.length;
  $("cutSetRow").innerHTML = sets.map((e) => {
    const total = e.clips.reduce((n, c) => n + c.b - c.a, 0);
    return `<div class="rtile cset" data-url="${esc(e.url)}">
      <button class="csetopen" type="button" data-cs="open"><img src="${esc(e.thumb || BLANK)}" alt=""><p>${esc(cleanTitle(e.title))}</p>
        <span class="num">${t("cut.count", { n: e.clips.length })} · ${fmtDuration(total)}${e.channel ? ` · ${esc(e.channel)}` : ""}</span></button>
      <button class="iconbtn danger csetdel" type="button" data-cs="del" title="${esc(t("home.deleteCuts"))}" aria-label="${esc(t("home.deleteCuts"))}">${icon("trash")}</button></div>`;
  }).join("");
}

function openCutSet(url) {
  const e = cutSet(url);
  if (!e) return;
  openCutter({ url: e.url, uuid: e.uuid, title: e.title, thumb: e.thumb, start: e.start, duration: e.duration, channel: e.channel });
}

async function importCuts() {
  const res = await state.api.cuts_import();
  if (res.error) { toast(res.error); return; }
  if (!res.ok) return;
  track("cuts_import");
  state.cutSets = res.cuts;
  renderCutSets();
  toast(res.added ? t("toast.cutsImported", { n: res.added }) : t("toast.cutsAlreadySaved"));
}

async function exportCuts() {
  const res = await state.api.cuts_export();
  if (res.error) toast(res.error);
  else if (res.ok) { toast(t("toast.cutsExported", { n: res.count })); track("cuts_export", { n: res.count }); }
}

/* ---------- indirmeler ---------- */
function sync(data) {
  state.downloads = data.downloads;
  if (cut.strip && cut.strip.bgPaused && bgOk()) scheduleStrip();     // indirme bitti: arka plan dalga dolumu surer
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
  const d = kind === "live" ? liveRec(v.url) : state.byUrl.get(v.url);
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
  $("sbText").innerHTML = downloadSummary(dl) || esc(dl.some((d) => d.status === "done") ? t("sb.allDone") : t("sb.idle"));
  const work = dl.filter((d) => ["downloading", "merging", "preparing", "queued"].includes(d.status) && !d.live && d.size);
  const total = work.reduce((a, d) => a + d.size, 0);
  const got = work.reduce((a, d) => a + d.size * d.pct / 100, 0);
  const pct = total ? got / total : 0;
  $("sbTrack").hidden = !active;
  $("sbFill").style.transform = `scaleX(${pct})`;
  const eta = Math.max(0, ...dl.filter((d) => d.status === "downloading" && d.eta != null).map((d) => d.eta));
  $("sbNums").textContent = active ? [t("pct", { p: Math.floor(pct * 100) }), eta ? fmtEta(eta) : ""].filter(Boolean).join(" · ") : "";
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
    fe.innerHTML = `${icon("hdd")}${esc(t("sb.free", { size: fmtBytes(free) }))}`;
    fe.classList.toggle("bad", free < 2 * 1024 ** 3);
    fe.classList.toggle("low", free >= 2 * 1024 ** 3 && free < 15 * 1024 ** 3);
  }
  $("sbSpeed").title = data.speedLimit ? t("sb.limitTip", { n: data.speedLimit }) : "";
  if (data.speedLimit && sp) $("sbSpeed").insertAdjacentHTML("beforeend", `<small>${esc(t("sb.limitSmall", { n: data.speedLimit }))}</small>`);
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
    icon: "power", warn: true, sticky: true, text: t("notice.shutdown"),
    actions: [[t("notice.cancelShutdown"), () => { state.api.cancel_shutdown(); closeNotice("shutdown"); toast(t("toast.shutdownCancelled")); }, "primary"]],
  });
}

function renderRows() {
  const box = $("rows");
  const list = state.downloads.filter((d) => d.status !== "done");
  $("activeGroup").hidden = !state.downloads.length;
  const dl = state.downloads;
  $("activeMeta").innerHTML = list.length ? downloadSummary(dl) : esc(t("lib.allDone"));
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
    row.querySelector(".rtitle").innerHTML = (d.chat ? `<span class="kind">${t("kind.chat")}</span>` : "") + esc(cleanTitle(d.title));
    row.querySelector(".rtitle").title = d.title;
    row.querySelector(".bar i").style.transform = `scaleX(${d.status === "queued" ? 0 : d.pct / 100})`;
    let status = d.rendering ? t("row.renderingChat") : d.chat && d.status === "merging" ? t("row.writingSubs") : d.chat && d.status === "downloading" ? t("row.chatDownloading") : d.sections && d.status === "merging" && d.pct >= 100 ? statusName("merging") : d.section && d.status === "merging" ? t("row.trimming") : d.live && d.status === "merging" ? t("row.remuxing") : statusName(d.status);
    if (d.status === "downloading" && d.size) status += ` · ${fmtBytes(d.size * d.pct / 100)} / ${d.exact ? "" : "~"}${fmtBytes(d.size)}`;
    if (d.status === "recording") status += ` · ${d.started ? fmtDuration(Date.now() / 1000 - d.started) : ""} · ${fmtBytes(d.size)}`;
    if (d.status === "stopped" && d.pct > 0) status += " · " + t("row.resumeHint");
    if (d.status === "error") status += `: ${humanError(d.error, d.friendly)}`;
    row.querySelector(".rstatus").textContent = status;
    row.querySelector(".rstatus").title = d.status === "error" ? d.error : "";
    const nums = row.querySelector(".rnums");
    nums.innerHTML = "";
    if (d.status === "recording") nums.textContent = fmtSpeed(d.speed);
    else if (d.status !== "queued") {
      const pct = document.createElement("b");
      pct.className = "pct";
      pct.textContent = t("pct", { p: Math.floor(d.pct) });
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
    `<button class="iconbtn ${cls}" data-act="${act}" data-id="${d.id}" title="${esc(label)}" aria-label="${esc(label)}">${icon(ic)}</button>`;
  switch (d.status) {
    case "queued": case "preparing": case "downloading": case "merging": case "recording":
      return { key: "run", html: b("cancel", "stop", d.live ? t("live.stopRec") : t("act.stop"), "danger") + (d.live ? "" : b("abort", "trash", t("act.abortDelete"), "danger")) };
    default:
      return { key: "bad", html: b("retry", "retry", t("act.retry")) + (d.live ? "" : b("abort", "trash", t("act.abortDelete"), "danger")) + b("remove", "x", t("act.removeFromList")) };
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
    [n((d) => ACTIVE.includes(d.status) && !d.live), "sum.downloading"],
    [n((d) => d.status === "queued"), "sum.queued"],
    [n((d) => d.live && ACTIVE.includes(d.status)), "sum.recording"],
    [n((d) => d.status === "stopped"), "sum.stopped", "amber"],
    [n((d) => d.status === "error"), "sum.error", "red"],
  ].filter(([x]) => x);
  return parts.map(([x, key, c]) => (c ? `<span class="${c}">${esc(t(key, { n: x }))}</span>` : esc(t(key, { n: x })))).join(" · ");
}

/* arka ucun ham hata metni yerine neden + ne yapilacagi; ham metin title'da kalir.
   friendly: arka uc metni secili dilde ve ne yapilacagini zaten soyluyor (UserError) */
function humanError(e, friendly) {
  e = String(e || "");
  if (friendly) return e;
  if (/403|forbidden/i.test(e)) return t("herr.403");
  if (/404|not found|bulunamad/i.test(e)) return t("herr.404");
  if (/canlı değil|not live/i.test(e)) return t("herr.notLive");
  if (/ffmpeg/i.test(e)) return t("herr.ffmpeg");
  if (/disk|space|no space|errno 28/i.test(e)) return t("herr.disk");
  if (/timed? ?out|connection|network|resolve|ulaşılamadı/i.test(e)) return t("herr.network");
  return t("herr.generic", { e: e.slice(0, 80) });
}

/* ---------- indirilenler (gecmis) ---------- */
async function refreshLibrary() {
  state.library = await state.api.library();
  state.libLoaded = true;
  if (state.view === "library") renderLibrary();
  if (state.view === "home") renderHome();
}

function dayLabel(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 1) {
    const s = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" }).format(-diff, "day");
    return s.charAt(0).toLocaleUpperCase(i18n.locale) + s.slice(1);
  }
  return d.toLocaleDateString(i18n.locale, { day: "numeric", month: "long", year: now.getFullYear() === d.getFullYear() ? undefined : "numeric" });
}

function libVisible() {
  const q = fold(state.libQuery);
  return state.library.filter((e) => !q || fold(e.title).includes(q) || fold(e.channel).includes(q));
}

function renderLibrary() {
  const q = fold(state.libQuery);
  const items = libVisible();
  const groups = new Map();
  for (const e of items) {
    const k = dayLabel(e.done);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  $("libEmpty").hidden = !state.libLoaded || state.library.length > 0 || state.downloads.length > 0;
  if (!state.libLoaded) {     // ilk yukleme: satir iskeletleri
    $("histGroups").innerHTML = `<section class="histgroup">${'<div class="hrow skeleton"><i class="hthumb"></i><div class="rmain"><p class="rtitle"></p><p class="hsub"></p></div></div>'.repeat(6)}</section>`;
    return;
  }
  $("histGroups").innerHTML = [...groups].map(([label, list]) => `<section class="histgroup"><h2>${esc(label)}</h2>${list.map((e) => {
    const sec = chatVid(e) ? " · " + t("lib.chatVideo") : e.chat ? " · " + t("lib.chatSubs") : e.sections ? " · " + t("lib.mergedCuts", { n: e.sections.length }) : e.section ? " · " + t("lib.cutRange", { a: fmtDuration(e.section[0]), b: fmtDuration(e.section[1]) }) : e.live ? " · " + t("lib.liveRec") : "";
    const time = new Date(e.done * 1000).toLocaleTimeString(i18n.locale, { hour: "2-digit", minute: "2-digit" });
    const b = (act, ic, label, cls = "") => `<button class="iconbtn ${cls}" type="button" data-ins="${act}" data-file="${esc(e.file)}" title="${esc(label)}" aria-label="${esc(label)}">${icon(ic)}</button>`;
    return `<div class="hrow${e.exists ? "" : " gone"}${state.libFocus === e.file ? " on" : ""}" data-file="${esc(e.file)}" tabindex="0">
      <div class="hthumb"><img alt=""></div>
      <div class="rmain"><p class="rtitle" title="${esc(e.title)}">${e.chat ? `<span class="kind">${t("kind.chat")}</span>` : ""}${esc(cleanTitle(e.title))}</p>
        <p class="hsub num">${esc(e.channel)}${sec} · ${fmtBytes(e.size)} · ${time}${e.exists ? "" : ` · <em>${t("lib.missing")}</em>`}</p></div>
      <div class="ractions">${e.exists && playable(e) ? b("lplay", "play", t("lib.playHere")) + b("lopen", "external", t("lib.openWindows")) : ""}${e.exists ? b("lreveal", "reveal", t("act.reveal")) : ""}
        ${b("ldel", "trash", e.exists ? t("lib.deleteRecycle") : t("act.removeFromList"), "danger")}</div></div>`;
  }).join("")}</section>`).join("") || (q && state.library.length ? `<p class="gridnote">${t("lib.noMatch")}</p>` : "");
  for (const row of $("histGroups").querySelectorAll(".hrow[data-file]")) {
    const e = libEntry(row.dataset.file);
    if (e) bindLibThumb(row.querySelector(".hthumb"), e);
  }
}

/* Indirilenler'deki sohbet videosu (.chat.mp4 / .chat.webm): sohbet kaydidir ama video gibi oynar */
const chatVid = (e) => !!e && e.chat && /\.(mp4|webm)$/i.test(e.file);
const playable = (e) => !e.chat || chatVid(e);

function libEntry(file) {
  return state.library.find((e) => e.file === file);
}

async function playFile(file) {
  const e = libEntry(file);
  if (!e) return;
  state.focus = null;
  state.libFocus = file;
  if (state.view === "library") renderLibrary();
  openWatch();
  renderLibraryInspector();
  if (!e || !e.exists) return;
  if (!playable(e)) { player.poster(e.thumb, t("lib.chatPoster"), avatarFor(e.url)); return; }
  const r = await state.api.media_url(file);
  if (state.libFocus !== file) return;
  if (!r.ok) { player.poster(e.thumb, r.error, avatarFor(e.url)); return; }
  if (!r.playable) { player.poster(e.thumb, t("lib.tsNotPlayable"), avatarFor(e.url)); return; }
  player.load(`file:${file}`, { file: r.url, poster: e.thumb, avatar: avatarFor(e.url) });
}

function renderLibraryInspector() {
  const body = $("insBody"), btns = $("insBtns");
  $("qualityBox").hidden = true;
  const e = state.libFocus && libEntry(state.libFocus);
  if (!e) { closeWatch(); return; }
  const facts = [[t("ch.label"), esc(e.channel)], [t("fact.size"), fmtBytes(e.size)], [t("card.downloaded"), new Date(e.done * 1000).toLocaleString(i18n.locale, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })]];
  if (e.sections) facts.push([t("cut.sections"), e.sections.map((x) => `${fmtDuration(x[0])}–${fmtDuration(x[1])}`).join(", ")]);
  else if (e.section) facts.push([t("fact.cut"), `${fmtDuration(e.section[0])} – ${fmtDuration(e.section[1])}`]);
  facts.push([t("fact.file"), `<span class="num">${esc(e.file.split(/[\\/]/).pop())}</span>`]);
  body.innerHTML = `<h2>${esc(cleanTitle(e.title))}</h2><dl class="facts">${facts.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join("")}</dl>
    ${e.exists ? "" : `<p class="insnote">${t("lib.fileGone")}</p>`}`;
  btns.innerHTML = e.exists && !playable(e)
    ? `<button class="btn primary span" data-ins="lchatvideo" data-file="${esc(e.file)}" title="${esc(t("chat.vid.makeTip"))}">${icon("film")}${t("chat.vid.make")}</button>
       <button class="btn span" data-ins="lreveal" data-file="${esc(e.file)}">${icon("reveal")}${t("act.reveal")}</button>
       <button class="btn ghost danger span" data-ins="ldel" data-file="${esc(e.file)}">${icon("trash")}${t("keys.deleteFile")}</button>`
    : e.exists
    ? `<button class="btn" data-ins="lreveal" data-file="${esc(e.file)}">${icon("reveal")}${t("act.reveal")}</button>
       <button class="btn" data-ins="lopen" data-file="${esc(e.file)}">${icon("external")}${t("lib.openOutside")}</button>
       ${e.chat ? "" : capcutBox(e)}
       <button class="btn ghost danger span" data-ins="ldel" data-file="${esc(e.file)}">${icon("trash")}${t("keys.deleteFile")}</button>`
    : `<button class="btn ghost span" data-ins="ldel" data-file="${esc(e.file)}">${icon("x")}${t("act.removeFromList")}</button>`;
  syncWatchChat();
}

/* CapCut'ta ac: video kendi boyutunda gider; varsa ayni anin sohbet videosu ust ize eklenir (son secim hatirlanir) */
const capcut = { chat: true };
try { Object.assign(capcut, JSON.parse(localStorage.getItem("capcut") || "{}")); } catch { /* depolama kapali */ }
const saveCapcut = () => { try { localStorage.setItem("capcut", JSON.stringify(capcut)); } catch { /* depolama kapali */ } };
const chatFileFor = (file) => {
  const base = file.replace(/\.[^.\\/]+$/, "");
  return [".chat.mp4", ".chat.webm"].map((x) => libEntry(base + x)).find((c) => c && c.exists);
};

function capcutBox(e) {
  const chat = chatFileFor(e.file)
    ? `<div class="ccrow"><span>${t("capcut.withChat")}</span><button class="switch" type="button" role="switch" aria-checked="${capcut.chat}" aria-label="${esc(t("capcut.withChat"))}" data-ins="lccchat"><i></i></button></div>` : "";
  return `<div class="capcutbox span">${chat}
    <button class="btn primary" data-ins="lcapcut" data-file="${esc(e.file)}">${icon("film")}${t("capcut.open")}</button></div>`;
}

async function openInCapcut(btn) {
  const file = btn.dataset.file;
  btn.disabled = true;
  try {
    const r = await state.api.capcut_open(file, capcut.chat && !!chatFileFor(file));
    toast(r.ok ? t("capcut.done", { name: r.name }) : r.error);
    if (r.ok) track("capcut_open", {});
  } finally { btn.disabled = false; }
}

/* onay penceresi: true/false doner. Varsayilan odak "Vazgec"te; Esc ve disari tik de vazgecer. */
function askConfirm({ title, name, thumb, text, ok, ic = "trash" }) {
  const dlg = $("askDlg");
  $("askIc").firstElementChild.setAttribute("href", `#i-${ic}`);
  $("askTitle").textContent = title;
  $("askText").textContent = text;
  $("askYes").textContent = ok;
  $("askItem").hidden = !name;
  $("askName").textContent = name || "";
  $("askThumb").src = thumb || BLANK;
  return new Promise((resolve) => {
    dlg.returnValue = "no";
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true });
    dlg.showModal();
    $("askNo").focus();
  });
}

/* pencere kapatilirken indirme suruyorsa: Python kapanmayi iptal eder, bunu cagirir */
async function askExit() {
  if ($("askDlg").open) return;
  const ok = await askConfirm({ title: t("ask.exitTitle"), ic: "power", ok: t("ask.exitOk"), text: t("ask.exitText") });
  if (ok) state.api.exit_now();
}

async function deleteFile(file) {
  const e = libEntry(file);
  if (!e) return;
  if (e.exists && !(await askConfirm({ title: t("ask.deleteTitle"), name: cleanTitle(e.title), thumb: e.thumb || avatarFor(e.url),
    text: t("ask.deleteText"), ok: t("ask.deleteOk") }))) return;
  if (player.key === `file:${file}`) player.stop();     // acik dosya silinemez
  await new Promise((r) => setTimeout(r, 150));
  const res = await state.api.library_remove(file, e.exists);
  if (!res.ok) { toast(res.error); return; }
  if (state.libFocus === file) closeWatch();
  toast(res.trashed ? t("toast.trashed") : t("toast.removed"));
  await refreshLibrary();
}

/* ---------- ayarlar ---------- */
function renderSettings() {
  const s = state.settings;
  $("setFolder").textContent = s.folder;
  fillSelect($("setQuality"), s.qualities.map((q) => [q, qualityName(q)]), s.quality);
  fillSelect($("setLang"), s.langs.map((l) => [l, t(`lang.${l}`)]), s.lang);
  fillSelect($("setParallel"), [["auto", t("set.auto")], ...Array.from({ length: s.maxParallel }, (_, i) => [String(i + 1), String(i + 1)])], String(s.parallel));
  const th = [4, 8, 16, 24, 32, 48, 64].filter((x) => x <= s.maxFragThreads);
  fillSelect($("setThreads"), [["auto", t("set.autoN", { n: s.autoFragThreads })], ...th.map((x) => [String(x), String(x)])], String(s.fragThreads));
  fillSelect($("setSection"), [...$("setSection").options].map((o) => [o.value, o.textContent]), String(s.sectionLength === "auto" ? 30 : s.sectionLength));
  for (const [id, key] of SWITCHES) $(id).setAttribute("aria-checked", !!s[key]);
  $("setUsage").setAttribute("aria-checked", s.telemetry === true);
  renderChatFormats();
  renderChatVideo();
  fillSelect($("setLimit"), [["0", t("set.unlimited")], ...[1, 2, 5, 10, 20, 50, 100].map((x) => [String(x), `${x} MB/s`])], String(s.speedLimit || 0));
  fillSelect($("setThumbCache"), [["0", t("set.off")], ...[50, 100, 200, 500, 1000].map((x) => [String(x), `${x} MB`])], String(s.thumbCacheMB));
  showThumbCache();
  $("setVersion").textContent = t("set.version", { v: state.cfg.version });
  $("setVolume").value = s.volume;
  $("setVolume").style.setProperty("--v", `${s.volume}%`);
  $("setVolumeTxt").textContent = t("pct", { p: s.volume });
  $("setName").value = s.nameTemplate;
  $("nameTokens").innerHTML = esc(t("set.tokens")) + " " + s.nameTokens.map((k) => `<button class="tok" type="button" data-tok="${k}">{${k}}</button>`).join("");
  previewName();
  filterSettings();
}

/* ayarlar: sol kategori listesi + arama. Arama tum kategorilerdeki satirlari etiket+aciklamaya gore suzer
   (aksan/buyuk-kucuk harf duyarsiz); sonuclar kategori adi altinda gruplanir */
const SET_CATS = ["download", "player", "chat", "cuts", "notify", "app", "advanced"];
const setFold = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u0131/g, "i").toLowerCase();
function setCat() {
  let c = "";
  try { c = localStorage.getItem("setCat"); } catch { /* depolama kapali */ }
  return SET_CATS.includes(c) ? c : SET_CATS[0];
}
function filterSettings() {
  const raw = $("setSearch").value.trim(), q = setFold(raw), cat = setCat();
  $("settingsView").classList.toggle("searching", !!q);
  $("setTitle").hidden = !!q;
  $("setTitle").textContent = t(`set.${cat === "notify" ? "notifications" : cat}`);
  let hits = 0;
  for (const g of document.querySelectorAll("#setInner .setgroup")) {
    let any = false;
    for (const r of g.querySelectorAll(".setrow")) {
      r.hidden = !!q && !setFold(r.querySelector(".setlbl").textContent).includes(q);
      any = any || !r.hidden;
    }
    g.hidden = q ? !any : g.dataset.cat !== cat;
    if (q && any) hits++;
  }
  highlightSettings(q);
  $("setNone").hidden = !q || hits > 0;
  $("setNone").textContent = t("set.noResults", { q: raw });
  for (const b of $("setCats").children) {
    const on = b.dataset.cat === cat;
    b.setAttribute("aria-selected", on);
    b.tabIndex = on ? 0 : -1;
  }
}
/* eslesen kismi <mark> ile isaretler: katlanmis metinden orijinal konuma harf harf esleme */
function highlightSettings(q) {
  const box = $("setInner");
  for (const m of [...box.querySelectorAll("mark")]) { const p = m.parentNode; m.replaceWith(m.textContent); p.normalize(); }
  if (!q) return;
  for (const r of box.querySelectorAll(".setrow:not([hidden]) .setlbl")) {
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      let folded = "";
      const map = [];
      [...n.data].forEach((ch, i) => { const f = setFold(ch); for (let k = 0; k < f.length; k++) map.push(i); folded += f; });
      const chars = [...n.data];
      const hits = [];
      for (let at = folded.indexOf(q); at >= 0; at = folded.indexOf(q, at + q.length)) hits.push([map[at], map[at + q.length - 1] + 1]);
      for (const [a, b] of hits.reverse()) {
        const rg = document.createRange();
        const off = (i) => chars.slice(0, i).join("").length;
        rg.setStart(n, off(a)); rg.setEnd(n, off(b));
        rg.surroundContents(document.createElement("mark"));
      }
    }
  }
}
function pickSettingsCat(cat, focus) {
  try { localStorage.setItem("setCat", cat); } catch { /* depolama kapali */ }
  $("setSearch").value = "";
  filterSettings();
  $("setInner").parentElement.scrollTop = 0;
  if (focus) $("setCats").querySelector(`[data-cat="${cat}"]`).focus();
}
function initSettingsNav() {
  $("setCats").addEventListener("click", (e) => { const b = e.target.closest("[data-cat]"); if (b) pickSettingsCat(b.dataset.cat); });
  $("setCats").addEventListener("keydown", (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    let i = SET_CATS.indexOf(setCat());
    if (step) i = (i + step + SET_CATS.length) % SET_CATS.length;
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = SET_CATS.length - 1;
    else return;
    e.preventDefault();
    pickSettingsCat(SET_CATS[i], true);
  });
  $("setSearch").addEventListener("input", filterSettings);
  $("setSearch").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ""; filterSettings(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); $("setCats").querySelector('[aria-selected="true"]').focus(); }
  });
}

/* ayarlar: kare onbelleginin disk kullanimi */
async function showThumbCache(info) {
  info = info || await state.api.thumb_cache_info();
  $("thumbCacheUsed").textContent = t("set.thumbCacheUsed", { size: fmtBytes(info.bytes) });
  $("thumbCacheClear").disabled = !info.bytes;
}

const NAME_ALIASES = { kanal: "channel", baslik: "title", tarih: "date" };   // eski Turkce sablon adlari

function previewName() {
  const tpl = $("setName").value.replace(/\{(kanal|baslik|tarih)\}/g, (_, k) => `{${NAME_ALIASES[k]}}`);
  const ok = /\{(title|id)\}/.test(tpl) && !/[\\/:*?"<>|]/.test(tpl.replace(/\{[a-z]+\}/g, "")) &&
    (tpl.match(/\{([^}]*)\}/g) || []).every((x) => state.settings.nameTokens.includes(x.slice(1, -1)));
  const sample = { channel: "xqc", title: t("set.sampleTitle"), date: "2026-10-03", id: "dbed3e05-917" };
  $("setName").classList.toggle("bad", !ok);
  $("namePrev").classList.toggle("bad", !ok);
  $("namePrev").textContent = ok
    ? t("set.sample", { name: tpl.replace(/\{([a-z]+)\}/g, (_, k) => sample[k] ?? "") + ".mp4" })
    : t("set.nameInvalid");
  return ok;
}

async function saveSetting(patch, quiet) {
  const res = await state.api.set_settings(patch);
  const rejected = res.rejected || [];
  delete res.rejected;
  state.settings = res;
  if (rejected.length) toast(t("toast.notSaved"));
  else if (!quiet) toast(t("toast.saved"));
  return !rejected.length;
}

const SWITCHES = [["setHover", "hoverPreview"], ["setMuted", "previewMuted"], ["setNotifyDone", "notifyDone"], ["setNotifyLive", "notifyLive"],
  ["setRemux", "liveRemux"], ["setClip", "clipboardWatch"], ["setUpdate", "updateCheck"], ["setChatAuto", "chatAuto"]];
const CHAT_FORMATS = ["ass", "txt", "json", "html", "video"];
const CV_SIZES = [[360, 640], [400, 720], [480, 854], [540, 960], [720, 1280], [1080, 1920], [600, 1080], [1280, 720]];
const CV_FONTS = [14, 16, 18, 22, 26, 32, 40];

/* sohbet videosu secenekleri: olcu, yazi boyutu, arka plan, saat / rozet / emote */
function renderChatVideo() {
  const v = state.settings.chatVideo;
  fillSelect($("setCvSize"), CV_SIZES.map(([w, h]) => [`${w}x${h}`, `${w}×${h}`]), `${v.width}x${v.height}`);
  fillSelect($("setCvFont"), CV_FONTS.map((f) => [String(f), `${f} px`]), String(v.font));
  const chip = (key, on, label, tip) => `<button class="btn sm chiptoggle" type="button" data-cv="${key}" aria-pressed="${on}"${tip ? ` title="${esc(tip)}"` : ""}>${esc(label)}</button>`;
  const opt = (val, label, tip) => `<button type="button" role="radio" data-cv="bg:${val}" aria-checked="${v.bg === val}" title="${esc(tip)}">${esc(label)}</button>`;
  $("setCvChips").innerHTML = `<span class="setseg" role="radiogroup" aria-label="${esc(t("chat.vid.bg"))}">${opt("green", t("chat.vid.green"), t("chat.vid.greenTip"))}${opt("transparent", t("chat.vid.transparent"), t("chat.vid.transparentTip"))}</span>`
    + chip("time", v.time, t("chat.img.time")) + chip("badges", v.badges, t("chat.img.badges")) + chip("emotes", v.emotes, t("chat.img.emotes"));
}

async function saveChatVideo(change) {
  await saveSetting({ chatVideo: { ...state.settings.chatVideo, ...change } });
  renderChatVideo();
}

function renderChatFormats() {
  const on = state.settings.chatFormats || [];
  $("setChatFormats").innerHTML = CHAT_FORMATS.map((f) => `<button class="btn sm chiptoggle" type="button" data-fmt="${f}"
    aria-pressed="${on.includes(f)}" title="${esc(t(`chat.fmtTip.${f}`))}">${esc(t(`chat.fmt.${f}`))}</button>`).join("");
}

/* ---------- anonim kullanim verisi ----------
   Ilk acilista sorulur (cevap verilene kadar hicbir sey gonderilmez); Ayarlar'dan acilip kapatilir. */
function askUsage() {
  const list = (key) => t(key).split("|").map((x) => `<li>${esc(x)}</li>`).join("");
  $("usageSends").innerHTML = list("usage.sends");
  $("usageNever").innerHTML = list("usage.never");
  const dlg = $("usageDlg");
  dlg.returnValue = "";
  dlg.oncancel = (e) => { if (state.settings.telemetry == null) e.preventDefault(); };   // ilk soruda Esc ile gecilmez
  dlg.onclose = () => {
    if (dlg.returnValue !== "yes" && dlg.returnValue !== "no") return;
    const on = dlg.returnValue === "yes";
    saveSetting({ telemetry: on }, true);
    $("setUsage").setAttribute("aria-checked", on);
  };
  dlg.showModal();
}

/* ozellik kullanimi (izin yoksa Python tarafi atar) */
const track = (name, props) => state.api && state.api.track(name, props || {});

function bindSettings() {
  $("setUsage").addEventListener("click", () => {
    const on = $("setUsage").getAttribute("aria-checked") !== "true";
    $("setUsage").setAttribute("aria-checked", on);
    saveSetting({ telemetry: on });
  });
  $("usageWhat").addEventListener("click", askUsage);
  for (const [id, key] of SWITCHES) {
    $(id).addEventListener("click", async () => {
      const on = $(id).getAttribute("aria-checked") !== "true";
      $(id).setAttribute("aria-checked", on);
      await saveSetting({ [key]: on });
      if (key === "hoverPreview" && !on) hover.stop();
    });
  }
  $("setQuality").addEventListener("change", (e) => setQuality(e.target.value, true));
  initSettingsNav();
  const num = (v) => (v === "auto" ? "auto" : Number(v));
  $("setParallel").addEventListener("change", (e) => saveSetting({ parallel: num(e.target.value) }));
  $("setThreads").addEventListener("change", (e) => saveSetting({ fragThreads: num(e.target.value) }));
  $("setLimit").addEventListener("change", (e) => saveSetting({ speedLimit: Number(e.target.value) }));
  $("setThumbCache").addEventListener("change", async (e) => {
    await saveSetting({ thumbCacheMB: Number(e.target.value) });
    showThumbCache();
  });
  $("thumbCacheClear").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    showThumbCache(await state.api.thumb_cache_clear());
    toast(t("toast.thumbCacheCleared"));
  }));
  // dil degisince arayuz bastan kurulur; indirmeler arka uctadir, kesilmez
  $("setLang").addEventListener("change", async (e) => { if (await saveSetting({ lang: e.target.value }, true)) location.reload(); });
  $("checkUpdBtn").addEventListener("click", (e) => withBusy(e.currentTarget, () => checkUpdate(true)));
  $("setChatFormats").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-fmt]");
    if (!b) return;
    const cur = state.settings.chatFormats || [];
    const next = cur.includes(b.dataset.fmt) ? cur.filter((f) => f !== b.dataset.fmt) : [...cur, b.dataset.fmt];
    if (!next.length) { toast(t("toast.chatFormatMin")); return; }
    await saveSetting({ chatFormats: next });
    renderChatFormats();
  });
  $("setCvSize").addEventListener("change", (e) => {
    const [width, height] = e.target.value.split("x").map(Number);
    saveChatVideo({ width, height });
  });
  $("setCvFont").addEventListener("change", (e) => saveChatVideo({ font: Number(e.target.value) }));
  $("setCvChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cv]");
    if (!b) return;
    const [k, v] = b.dataset.cv.split(":");
    saveChatVideo(v ? { [k]: v } : { [k]: !state.settings.chatVideo[k] });
  });
  $("setSection").addEventListener("change", async (e) => {
    await saveSetting({ sectionLength: Number(e.target.value) });
    applySectionLength();
  });
  $("setVolume").addEventListener("input", (e) => {
    e.target.style.setProperty("--v", `${e.target.value}%`);
    $("setVolumeTxt").textContent = t("pct", { p: e.target.value });
  });
  $("setVolume").addEventListener("change", (e) => saveSetting({ volume: Number(e.target.value) }));
  $("setFolderBtn").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    state.settings.folder = await state.api.pick_folder();
    $("setFolder").textContent = state.settings.folder;
  }));
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
  seen: new Set(), geom: {}, hoverT: null, t0: 0, perf: null, peekT0: 0, peekAt: 0,   // olcum (PERF.md): acilis zamani, daha once acilan VOD'lar
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
  follow: true,              // oynarken cizelge oynatma cizgisini izler; kullanici gezinince kapanir
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
  track("cut_editor_open", { live: !!vod.live });
  cut.vod = vod;
  cut.sel = null;
  cut.stopAt = null;
  cut.chain = null;
  cut.markIn = null;
  cut.withChat = !!state.settings.chatAuto;    // varsayilan ayardan; bu kesitler icin degistirilebilir
  if (!state.cuts.has(vod.url)) {
    const saved = cutSet(vod.url);
    state.cuts.set(vod.url, saved ? saved.clips.map((c) => ({ id: cut.seq++, a: c.a, b: c.b, name: c.name, note: c.note })) : []);
  }
  $("cutTitle").textContent = cleanTitle(vod.title);
  $("cutTitle").title = vod.title;
  const ch = state.channel;
  $("cutMeta").textContent = [vod.channel || (ch && (ch.name || ch.slug)), vod.live ? t("cut.liveMeta", { ago: fmtAgo(vod.start) }) : vod.start && fmtDate(vod.start),
    vod.duration && fmtDuration(vod.duration)].filter(Boolean).join(" · ");
  $("cutLive").hidden = !vod.live;
  const video = $("cutVideo");
  video.poster = vod.thumb || "";
  setCutPoster(vod);
  video.muted = false;
  cut.view = [0, Math.min(WAVE_MAX, vod.duration || WAVE_MAX)];   // 15 dk'lik yakin gorunumle ac
  cut.density = null;
  loadChatDensity(vod);
  cut.strip = { uuid: vod.uuid, segs: null, data: new Map(), thumbs: new Map(), busy: 0, tbusy: 0, pbusy: 0, pfail: new Set(), note: "",
    pf: null, pl: null,            // parca basina: tam veri tepe degeri / kaba seviye (-1: yok); uzak gorunum dalgasi
    bbusy: 0, bgSkip: new Set(), bgTry: new Map(), bgPaused: false };
  cut.retried = false;
  cut.t0 = performance.now();   // olcum: acilistan ilk kare / ilk goruntu suresine
  cut.perf = { thumbs: false, reopen: cut.seen.has(vod.uuid) };
  cut.seen.add(vod.uuid);
  loadStrip(cut.strip);
  setSideTab(cut.tab);
  setRate(Number($("cutRate").value));
  cutterMsg(t("cut.loadingVideo"));
  $("cutter").showModal();
  renderCutter();   // dialog acikken: serit genislikleri olculebilsin
  $("cutter").focus();   // ilk dugme odak almasin; klavye kisayollari dogrudan calissin
  cut.raf = requestAnimationFrame(tick);
  const res = await state.api.vod_source(vod.uuid, !!vod.live);
  if (cut.vod !== vod || !$("cutter").open) return;
  if (!res.ok) { cutterMsg(res.error + " " + t("cut.stillAdd")); return; }
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
  // capLevelToPlayerSize + dusuk kaliteyle basla: ilk goruntu hizli gelir, sonra ABR yukselir (PERF.md)
  cut.hls = new Hls({ maxBufferLength: 20, capLevelToPlayerSize: true, startPosition: live ? Math.max(0, dur - LIVE_BACK) : -1 });
  cut.hls.on(Hls.Events.MANIFEST_PARSED, () => {
    // goruntusuz ("audio_only") surum baslangic olmasin; buyuk oynatici icin 160p cok bulanik: en az 360p olan en dusuk surum
    const lv = cut.hls.levels.map((l, i) => ({ i, l })).filter((x) => x.l.height || x.l.videoCodec);
    const pool = lv.filter((x) => x.l.height >= 360);
    const best = (pool.length ? pool : lv);
    if (best.length) cut.hls.startLevel = best.reduce((a, b) => (b.l.bitrate < a.l.bitrate ? b : a)).i;
  });
  const vod = cut.vod;
  cut.hls.on(Hls.Events.ERROR, async (_, d) => {
    if (!d.fatal) return;
    const E = Hls.ErrorDetails;
    const deadSource = [E.MANIFEST_LOAD_ERROR, E.MANIFEST_LOAD_TIMEOUT, E.LEVEL_LOAD_ERROR, E.LEVEL_LOAD_TIMEOUT].includes(d.details);
    if (deadSource && !cut.retried) {   // diskteki adres olmus olabilir (VOD silindi / tasindi): bir kez API'den yeniden al
      cut.retried = true;
      const res = await state.api.vod_source(vod.uuid, !!vod.live, true);
      if (cut.vod !== vod || !$("cutter").open) return;
      if (res.ok) {
        cut.src = res.source;
        if (cut.strip) loadStrip(cut.strip);
        attachCut(res.duration);
        return;
      }
      cutterMsg(res.error + " " + t("cut.stillAdd"));
      return;
    }
    cutterMsg(t("cut.previewFailed") + " " + t("cut.stillAdd"));
  });
  cut.hls.on(Hls.Events.MANIFEST_PARSED, () => cutterMsg(""));
  const t0 = cut.t0;
  for (const ev of ["loadeddata", "playing"]) {   // olcum: acilistan ilk goruntuye (oynatma baslamazsa loadeddata)
    const log = () => {
      video.removeEventListener(ev, log);
      if (cut.t0 === t0) state.api.client_log(`perf ana oynatici ${ev}: ${Math.round(performance.now() - cut.t0)} ms`);
    };
    video.addEventListener(ev, log);
  }
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
  $("cutLive").classList.add("is-busy");
  cutterMsg(t("cut.loadingLatest"));
  const playing = !$("cutVideo").paused;
  const res = await state.api.vod_source(vod.uuid, true);
  $("cutLive").disabled = false;
  $("cutLive").classList.remove("is-busy");
  if (cut.vod !== vod) return;
  if (!res.ok || !res.duration) { cutterMsg(""); toast(t("cut.latestFailed")); return; }
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
  if (cut.vod) {
    persistCuts(cut.vod, true);
    if (!cutClips().length) state.cuts.delete(cut.vod.url);
  }
  cutChat.stop();
  cutChat.uuid = null;
  cut.density = null;
  cut.vod = null;
}

/* sag panel sekmesi: kesitler ya da sohbet. Sohbet yalnizca sekmesi acilinca cekilir. */
let cutChat = null;
function setSideTab(tab) {
  cut.tab = tab;
  try { localStorage.setItem("cutTab", tab); } catch { /* depolama kapali */ }
  const chat = tab === "chat";
  $("sideTabCuts").setAttribute("aria-selected", String(!chat));
  $("sideTabChat").setAttribute("aria-selected", String(chat));
  document.querySelector(".cutside").classList.toggle("chattab", chat);
  if (chat && cut.vod && cutChat.uuid !== cut.vod.uuid) {
    cutChat.uuid = cut.vod.uuid;
    cutChat.start({ vod: cut.vod.uuid });
  }
}

/* kesit penceresi kapagi: kapak yoksa / bozuksa video karesi gelene kadar markali yedek */
function setCutPoster(vod) {
  const box = $("cutVideo").parentElement, video = $("cutVideo");
  clearFallback(box);
  box.classList.remove("hasframe");
  const fb = () => { if (!box.classList.contains("hasframe")) { video.removeAttribute("poster"); showFallback(box, avatarOf(vod)); } };
  video.addEventListener("loadeddata", () => { box.classList.add("hasframe"); clearFallback(box); }, { once: true });
  if (!vod.thumb) { fb(); return; }
  const probe = new Image();
  probe.onerror = fb;
  probe.src = vod.thumb;
}

function cutterMsg(msg) {
  $("cutMsg").hidden = !msg;
  $("cutMsg").textContent = msg;
  // halka: kaynak/akis yuklenirken donsun; hata mesajinda ya da hazir olunca sussun
  const busy = !!msg && !/kesit yine eklenebilir/i.test(msg);
  $("cutVideo").parentElement.classList.toggle("loading", busy);
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
  cut.follow = true;
  followView(t, true);
}

/* kullanici gorunen araligi degistirdi (kaydirma, yakinlasma, genel bakis): oynatma cizgisi
   gorunumde kaldiysa izlemeye devam, disarida kaldiysa birakir ve "Oynatma cizgisine don" cikar */
function userView() {
  const t = nowTime();
  cut.follow = $("cutVideo").paused && t >= cut.view[0] && t <= cut.view[1];
}
function backToHead() {
  cut.follow = true;
  followView(nowTime(), true);
  drawTimeline();
}

/* ---------- kayitli kesitler ----------
   Kesit listesi her degistiginde kisa bir beklemeyle diske yazilir; editor yeniden acilinca
   (ya da program kapanip acilinca) geri gelir. Canli yayinlarin kesitleri saklanmaz: suren
   yayinin saatleri sonradan anlamsiz kalir. */
const cutSet = (url) => state.cutSets.find((e) => e.url === url);
let persistTimer = 0, persistSig = "";

function persistCuts(vod, now = false) {
  if (!vod || vod.live || !state.cuts.has(vod.url)) return;
  if (!state.cuts.get(vod.url).length && !cutSet(vod.url)) return;
  const clips = state.cuts.get(vod.url).map((c) => ({ a: c.a, b: c.b, name: c.name || "", note: c.note || "" }));
  const sig = vod.url + JSON.stringify(clips);
  if (sig === persistSig) return;
  clearTimeout(persistTimer);
  const run = async () => {
    persistSig = sig;
    const ch = state.channel;
    const meta = { uuid: vod.uuid, title: vod.title, thumb: vod.thumb, start: vod.start || "",
      duration: Math.round(vod.duration || 0), channel: vod.channel || (ch && (ch.name || ch.slug)) || "" };
    state.cutSets = await state.api.cuts_save(vod.url, meta, clips);
    if (state.view === "home") renderCutSets();
  };
  if (now) run(); else persistTimer = setTimeout(run, 500);
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
  if (list.some((x) => x.a === c.a && x.b === c.b)) { toast(t("toast.cutExists")); return; }
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
  if (dur && dur < MIN_CUT) { toast(t("toast.tooShort")); return; }
  const now = nowTime();
  // genelde bir sey olduktan hemen sonra basilir: uzunlugun 2/3'u oncesinden, 1/3'u sonrasindan
  let a = now - (cut.len * 2) / 3;
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
  if (dur && dur < MIN_CUT) { toast(t("toast.tooShort")); return; }
  const now = nowTime();
  const c = cut.markIn != null
    ? { id: cut.seq++, a: Math.min(cut.markIn, now), b: Math.max(cut.markIn, now) }
    : { id: cut.seq++, a: Math.max(0, now - cut.len), b: now };
  if (cut.markIn != null && c.b - c.a < MIN_CUT) toast(t("toast.minCut", { n: MIN_CUT }));
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
  const now = nowTime();
  const to = dir < 0 ? sorted.filter((x) => x < now - 0.25).pop() : sorted.find((x) => x > now + 0.25);
  if (to == null) { toast(sorted.length ? (dir < 0 ? t("toast.noEdgeBefore") : t("toast.noEdgeAfter")) : t("toast.noCuts")); return; }
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
  if (sec < 90) return t("span.sec", { n: Math.round(sec) });
  if (sec < 5400) return t("span.min", { n: Math.round(sec / 60) });
  const h = sec / 3600;
  return t("span.hour", { n: fmtNum(h, Math.round(h * 10) % 10 ? 1 : 0) });
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
      (c.id === cut.sel && px >= 40 ? `<i class="grip" data-edge="a" title="${esc(t("cut.dragStart"))}"></i><i class="grip" data-edge="b" title="${esc(t("cut.dragEnd"))}"></i>` : "");
    el.title = t("cut.blockTip", { i: i + 1, a: fmtDuration(c.a), b: fmtDuration(c.b) });
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
  $("tlSpan").textContent = !dur ? t("cut.durUnknown") : span >= dur - 0.5
    ? t("cut.wholeStream", { d: fmtDuration(dur) })
    : `${fmtDuration(s)} – ${fmtDuration(e)} · ${fmtSpan(span)}`;
  const zr = $("zoomRange");
  zr.disabled = !dur || dur <= MIN_VIEW;
  zr.value = String(Math.round(zoomLevel()));
  zr.style.setProperty("--v", `${zr.value / 10}%`);
  $("zoomIn").disabled = !dur || span <= Math.min(MIN_VIEW, dur) + 0.5;
  $("zoomOut").disabled = $("zoomFit").disabled = !dur || span >= dur - 0.5;
  drawStrip();
  drawChatDensity();
  scheduleStrip();
  paintHeads();
}

/* sohbet yogunlugu: dakika basina mesaj; hareketli anlar yuksek cubuk. Veri editor acilinca arkada gelir. */
async function loadChatDensity(vod) {
  if (vod.live || !vod.uuid || !vod.duration) return;
  cut.density = { uuid: vod.uuid, state: "loading" };
  drawChatDensity();
  const res = await state.api.chat_density(vod.uuid, vod.duration, false);
  if (cut.vod !== vod) return;
  const counts = res.ok ? res.counts : [];
  const sorted = [...counts].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0;
  cut.density = res.ok
    ? { uuid: vod.uuid, state: "ok", bin: res.bin, counts, lo: at(0.1), hi: Math.max(at(0.98), at(0.1) + 1) }   // goreli yogunluk: sakin = alcak, patlama = tam boy
    : { uuid: vod.uuid, state: "error" };
  drawChatDensity();
}

function drawChatDensity() {
  const cv = $("tlChat");
  const d = cut.density;
  const note = !d ? "" : d.state === "loading" ? t("cut.chatLoading") : d.state === "error" ? t("cut.chatFailed") : "";
  $("chatNote").hidden = !note;
  if (note) $("chatNote").innerHTML = (d.state === "loading" ? MINI : "") + esc(note);
  const dpr = window.devicePixelRatio || 1;
  const cw = cv.clientWidth, ch = cv.clientHeight;
  if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  if (!d || d.state !== "ok" || !cut.view) return;
  const [s, e] = cut.view;
  const span = e - s;
  if (!(span > 0)) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim();
  const px = cw / span;
  const first = Math.max(0, Math.floor(s / d.bin));
  for (let i = first; i < d.counts.length && i * d.bin < e; i++) {
    if (!d.counts[i]) continue;
    const r = 0.1 + 0.9 * clamp((d.counts[i] - d.lo) / (d.hi - d.lo), 0, 1);
    const x0 = (i * d.bin - s) * px;
    const h = Math.max(1.5, r * (ch - 2));
    g.globalAlpha = r > 0.7 ? 1 : 0.35 + r * 0.6;
    g.fillStyle = accent;
    g.fillRect(Math.floor(x0), ch - h, Math.max(1, Math.ceil(d.bin * px) - 1), h);
  }
  g.globalAlpha = 1;
}

/* ---------- kare ve ses seridi ---------- */
async function loadStrip(st, fresh) {
  const res = await state.api.strip_index(st.uuid, !!fresh);
  if (cut.strip !== st) return;
  if (!res.ok) { st.note = res.error; state.api.client_log(`strip_index: ${res.error}`); drawStrip(); return; }
  st.segs = res.segments;
  ensurePeaks(st);
  st.pps = res.peaksPerSec;
  st.fe = res.frameEvery;
  drawTimeline();
}

/* uzak gorunum dalgasi icin parca basina tepe degerleri; canlida liste uzayinca buyur */
function ensurePeaks(st) {
  const n = st.segs.length;
  if (st.pf && st.pf.length === n) return;
  for (const k of ["pf", "pl"]) {
    const a = new Int16Array(n).fill(-1);
    if (st[k]) a.set(st[k].subarray(0, Math.min(n, st[k].length)));
    st[k] = a;
  }
}
const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), 0);

/* arka plan dolumunun odagi: imlec zaman cizelgesi / genel bakis uzerindeyse orasi, degilse oynatma cizgisi */
const focusTime = () => (cut.hoverT != null ? cut.hoverT : nowTime());

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
function tilesFor(w, fw, s, span) {
  if (!w || !span) return [];
  return Array.from({ length: Math.ceil(w / fw) }, (_, i) => s + ((i + 0.5) * fw * span) / w);
}
function tileTimes(el, s, span) {
  const w = el.clientWidth, fw = frameW(el);
  if (w) cut.geom[el.id] = { w, fw };    // kart onisitmasi ayni kareleri istesin diye olculer hatirlanir
  return tilesFor(w, fw, s, span);
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
  const out = [...new Set([...times.map((t) => segAt(st.segs, t)), ...waveWanted(st)])];
  return out.filter((i) => !st.data.get(i) && !st.thumbs.has(i));
}

/* uzak gorunumde (> WAVE_MAX) kaba dalga icin ornek parcalar: en cok WAVE_SAMPLES tane, gorunume esit aralikli
   (her k. sutunun ortasindaki parca). Tum yayini taramaz; boylece odaktaki tam dolum birkac sn icinde baslar. Aradaki
   sutunlar cizimde komsu orneginden doldurulur. Odaga en yakin once. */
const WAVE_SAMPLES = 300;
function waveSamples(st) {
  const [s, e] = cut.view;
  if (!st.pl || e - s <= WAVE_MAX) return [];
  const cols = $("tlWave").clientWidth || 1200, per = (e - s) / cols;
  const step = Math.max(1, Math.ceil(cols / WAVE_SAMPLES));
  const mid = segAt(st.segs, clamp(focusTime(), s, e));
  const segs = new Set();
  for (let x = step >> 1; x < cols; x += step) segs.add(segAt(st.segs, s + (x + 0.5) * per));
  return [...segs].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
}
const waveWanted = (st) => waveSamples(st).filter((i) => st.pl[i] < 0 && st.pf[i] < 0);

/* strip_thumbs yaniti {"f": kare, "l": ses seviyesi}: kareyi ve seviyeyi yerine koyar */
function takeThumb(st, i, r, fallback) {
  st.thumbs.set(i, (r && r.f) || fallback);
  if (r && r.l != null && st.pl) st.pl[i] = r.l;
}

/* olcum: gorunen seridin tum kareleri dolunca acilistan gecen sure (bir kez) */
function logThumbsReady(st) {
  if (!cut.perf || cut.perf.thumbs || !st.segs) return;
  const [s, e] = cut.view;
  const segs = [...new Set(tileTimes($("tlFilm"), s, e - s).map((t) => segAt(st.segs, t)))];
  if (!segs.length || !segs.every((i) => st.thumbs.get(i) || st.data.get(i))) return;
  cut.perf.thumbs = true;
  state.api.client_log(`perf editor ilk ${segs.length} kare: ${Math.round(performance.now() - cut.t0)} ms (${cut.perf.reopen ? "yeniden acilis" : "ilk acilis"})`);
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
    const tb = performance.now();
    const done = (res) => {
      if (cut.strip !== st) return;
      st.tbusy--;
      if (cut.perf && !cut.perf.batch) {    // olcum: ilk kare istegi (kart onisitmasi varsa <0.1 sn beklenir)
        cut.perf.batch = true;
        state.api.client_log(`perf editor ilk kare istegi: ${batch.length} kare, ${Math.round(performance.now() - tb)} ms`);
      }
      const failed = batch.filter((i) => !(res && res[i]));
      for (const i of batch) takeThumb(st, i, res && res[i], "");   // "": denendi, alinamadi
      drawStrip();
      logThumbsReady(st);
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
    if (!batch.length) break;
    batch.forEach((i) => st.data.set(i, null));   // yolda
    st.busy++;
    // bir istek hata verse de kuyruk kilitlenmesin; basarisiz parcalar bir sure sonra yeniden istenir
    const done = (res) => {
      if (cut.strip !== st) return;
      st.busy--;
      let failed = false;
      for (const i of batch) {
        const d = res && res[i];
        if (d && !d.failed) { st.data.set(i, d); if (st.pf && d.peaks.length) st.pf[i] = maxOf(d.peaks); }
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
  prefetchThumbs(st);
  pumpBackground(st);
}

/* tum yayinin tam dalgasi arka planda: odaga (imlec / oynatma cizgisi) en yakin eksik parcalar, iki yana dogru.
   Gorunen kareler ve gorunen aralik once; indirme calisirken durur (ortak hat); editor kapaninca biter.
   160p parcalar ~300-400 KB: 3 saatlik yayin ~400 MB, bu yuzden diskte kalir (ikinci acilista aninda). */
const bgOk = () => !state.downloads.some((d) => ["downloading", "preparing", "merging"].includes(d.status));

function bgWanted(st) {
  if (!st.pf) return [];
  const n = st.segs.length, f = clamp(segAt(st.segs, focusTime()), 0, n - 1);
  const out = [];
  for (let d = 0; d < n && out.length < 8; d++) {
    for (const i of d ? [f + d, f - d] : [f]) {
      if (i >= 0 && i < n && st.pf[i] < 0 && !st.bgSkip.has(i) && out.length < 8) out.push(i);
    }
  }
  return out;
}

function pumpBackground(st) {
  if (st.busy || st.tbusy || st.pbusy) return;      // gorunen is bitmeden yarismaz
  st.bgPaused = !bgOk();
  if (st.bgPaused) return;
  while (st.bbusy < 2) {
    const batch = bgWanted(st);
    if (!batch.length) return;
    batch.forEach((i) => st.bgSkip.add(i));          // yolda
    st.bbusy++;
    const t0 = performance.now();
    const done = (res) => {
      if (cut.strip !== st) return;
      st.bbusy--;
      let failed = false;
      for (const i of batch) {
        const d = res && res[i];
        if (d && !d.failed) { st.pf[i] = d.peaks.length ? maxOf(d.peaks) : 0; st.bgSkip.delete(i); }   // sessiz parca da dolu sayilir
        else if ((st.bgTry.get(i) || 0) < 3) { st.bgTry.set(i, (st.bgTry.get(i) || 0) + 1); failed = true; setTimeout(() => st.bgSkip.delete(i), 5000); }
      }
      if (!st.bgLogged) { st.bgLogged = true; state.api.client_log(`perf arka plan dalga: ilk ${batch.length} parca ${Math.round(performance.now() - t0)} ms`); }
      if (cut.view[1] - cut.view[0] > WAVE_MAX) drawStrip();
      if (failed) { clearTimeout(cut.stripTimer); cut.stripTimer = setTimeout(pumpStrip, 5200); }
      else pumpStrip();
    };
    state.api.strip_data(st.uuid, batch, true).then(done, () => done(null));
  }
}

/* gorunen her sey bitince: gorunumun bir ekran solu ve sagi icin ilk kareler (dusuk oncelik, tek istek).
   Gorunum degisince yeni gorunen kareler once gelir (pumpStrip sirasi); yoldaki istek biter, atilmaz. */
function prefetchWanted(st) {
  const [s, e] = cut.view, span = e - s, dur = cutDuration();
  if (!(span > 0) || !dur) return [];
  const el = $("tlFilm");
  const times = [...tileTimes(el, s - span, span), ...tileTimes(el, e, span)].filter((t) => t >= 0 && t < dur);
  const dist = (t) => (t < s ? s - t : t - e);
  const segs = [...new Set(times.sort((a, b) => dist(a) - dist(b)).map((t) => segAt(st.segs, t)))];
  return segs.filter((i) => !st.data.get(i) && !st.thumbs.has(i) && !st.pfail.has(i));
}

function prefetchThumbs(st) {
  if (st.busy || st.tbusy || st.pbusy) return;
  const batch = prefetchWanted(st).slice(0, 16);
  if (!batch.length) return;
  batch.forEach((i) => st.thumbs.set(i, null));
  st.pbusy = 1;
  const t0 = performance.now();
  const done = (res) => {
    if (cut.strip !== st) return;
    st.pbusy = 0;
    for (const i of batch) {
      if (res && res[i]) takeThumb(st, i, res[i], "");
      else { st.thumbs.delete(i); st.pfail.add(i); }   // onyukleme tekrar denemez; gorunur olunca normal yolla istenir
    }
    state.api.client_log(`perf yakin onyukleme: ${batch.length} kare, ${Math.round(performance.now() - t0)} ms`);
    pumpStrip();
  };
  state.api.strip_thumbs(st.uuid, batch).then(done, () => done(null));
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
  const far = span > WAVE_MAX;
  const waiting = st.segs && (far ? waveMissing(st) : !st.data.get(segAt(st.segs, s + span / 2)));
  const note = st.note || (!st.segs ? t("cut.loadingStrip") : waiting ? t("cut.loadingAudio") : "");
  $("waveNote").hidden = !note;
  if (note) $("waveNote").innerHTML = (!st.note ? MINI : "") + esc(note);
  if ((note && !waiting) || !span) return;   // yuklenirken gelen parcalar yine cizilsin
  if (far) { drawFarWave(g, st, cw, ch, s, span); return; }
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

/* uzak gorunumde dalga icin hic verisi (ne tam ne kaba) olmayan ornek parca var mi */
function waveMissing(st) {
  return !st.pl || waveWanted(st).length > 0;
}

/* uzak gorunum: her piksel sutunu icin kapsadigi parcalarin tepe degeri. Tam veri (tum parcanin tepesi) varsa o,
   yoksa kaba seviye (parcanin ilk saniyesi) ve soluk cizilir: kesin olmayan yer gorulsun */
function drawFarWave(g, st, cw, ch, s, span) {
  const mid = ch / 2, n = st.segs.length;
  g.fillStyle = "#2a2a2a";
  g.fillRect(0, mid - 0.5, cw, 1);
  const clips = cutClips();
  const on = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), off = "#6b737d";
  const per = span / cw, step = Math.max(1, Math.ceil(cw / WAVE_SAMPLES));
  let hold = -1, holdLeft = 0;      // kaba ornekler arasi bosluk: son kaba deger komsu sutunlara tasinir
  for (let x = 0; x < cw; x++) {
    const t0 = s + x * per;
    let full = -1, coarse = -1;
    for (let k = segAt(st.segs, Math.max(0, t0)), kb = segAt(st.segs, t0 + per); k <= kb && k < n; k++) {
      if (st.pf[k] > full) full = st.pf[k];
      if (st.pl[k] > coarse) coarse = st.pl[k];
    }
    if (full < 0 && coarse >= 0) { hold = coarse; holdLeft = step - 1; }
    else if (full < 0 && holdLeft > 0) { coarse = hold; holdLeft--; }
    const peak = full >= 0 ? full : coarse;
    if (peak < 0) continue;
    const tm = t0 + per / 2;
    g.globalAlpha = full >= 0 ? 1 : 0.45;
    g.fillStyle = clips.some((c) => tm >= c.a && tm <= c.b) ? on : off;
    const hh = Math.max(1, (peak / 255) * (mid - 2));
    g.fillRect(x, mid - hh, 1, hh * 2);
  }
  g.globalAlpha = 1;
}

/* giris isareti: cetveldeki bayrak, giristen oynatma cizgisine kadar bekleyen kesit ve videodaki not */
function paintMarks() {
  const m = cut.markIn;
  const on = m != null && !!cut.vod;
  $("markIn").classList.toggle("on", on);
  $("markIn").setAttribute("aria-pressed", String(on));
  const now = on ? nowTime() : 0;
  const xi = on ? xOf(m) : 0;
  $("tlIn").hidden = !on || xi < 0 || xi > 100;
  if (on) $("tlIn").style.left = `${xi}%`;
  const l = on ? clamp(Math.min(xi, xOf(now)), 0, 100) : 0, r = on ? clamp(Math.max(xi, xOf(now)), 0, 100) : 0;
  $("tlPending").hidden = !on || r - l <= 0;
  if (on) { $("tlPending").style.left = `${l}%`; $("tlPending").style.width = `${r - l}%`; }
  const flag = on ? t("cut.markFlag", { a: fmtDuration(m), d: fmtDuration(Math.abs(now - m)) }) : "";
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
  $("tlFollow").hidden = !dur || (x >= 0 && x <= 100 && (cut.follow || v.paused));
  $("tlFollow").classList.toggle("left", x < 50);
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
    const inside = v.currentTime >= s && v.currentTime <= e;
    if (cut.follow && !inside) { followView(v.currentTime, false); drawTimeline(); }
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
  const first = peek.hidden;
  if (first) cut.peekT0 = performance.now();   // olcum: uzerine gelinen andan ilk goruntuye
  peek.hidden = false;
  const half = peek.offsetWidth / 2;
  peek.style.left = `${clamp(x, lane.left - track.left + half, lane.right - track.left - half)}px`;
  $("peekTime").textContent = fmtDuration(t);
  // hemen serit karesi (ag istegi yok); video o ana varinca ustune gecer
  const frame = frameAt(cut.strip, t);
  if (peek.dataset.src !== frame) { peek.dataset.src = frame; peek.style.backgroundImage = frame ? `url("${frame}")` : ""; }
  if (first && frame) state.api.client_log(`perf peek serit karesi: ${Math.round(performance.now() - cut.peekT0)} ms`);
  cut.peekAt = t;
  cut.hoverT = t;     // arka plan dalga dolumunun odagi
  const pv = $("peekVideo");
  peek.classList.toggle("live", !frame || (pv.readyState >= 2 && !pv.seeking && Math.abs(pv.currentTime - t) < 1.5));   // serit karesi yoksa video gorunur kalir
  if (cut.peekHls) cut.peek.to(t);
}
function hidePeek() {
  cut.hoverT = null;
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
            ${c.name ? `<span class="cname">${esc(c.name)}</span>` : ""}
            <span class="rng num">${fmtDuration(c.a)} – ${fmtDuration(c.b)}</span>
            <span class="len num">${fmtDuration(c.b - c.a)}${c.note ? ` · ${esc(c.note)}` : ""}</span>
          </span>
        </button>
        <div class="cacts">
          <button class="iconbtn" data-act="play" type="button" title="${esc(t("cut.playThis"))}" aria-label="${esc(t("cut.playThis"))}">${icon("play")}</button>
          <button class="iconbtn danger" data-act="del" type="button" title="${esc(t("cut.deleteTip"))}" aria-label="${esc(t("cut.delete"))}">${icon("trash")}</button>
        </div>
      </div>` + (sel ? `
      <div class="cutedit">
        <div class="cfields">
          <input class="cfield" data-field="name" maxlength="80" spellcheck="false" placeholder="${esc(t("cut.namePh"))}" title="${esc(t("cut.namePh"))}" aria-label="${esc(t("cut.name"))}" value="${esc(c.name || "")}">
          <input class="cfield" data-field="note" maxlength="300" placeholder="${esc(t("cut.notePh"))}" aria-label="${esc(t("cut.note"))}" value="${esc(c.note || "")}">
        </div>
        ${["a", "b"].map((k) => `
        <div class="edgerow">
          <span class="edgelbl">${t(`cut.edge.${k}`)}</span>
          <div class="stepper">
            <button type="button" data-act="nudge" data-edge="${k}" data-d="-1" title="${esc(t("cut.nudgeBack"))}" aria-label="${esc(t(`cut.edge.${k}`) + " · " + t("cut.nudgeBack"))}">${icon("minus")}</button>
            <input class="num" data-edge="${k}" aria-label="${esc(t(`cut.edge.${k}`))}" spellcheck="false" value="${fmtDuration(c[k])}">
            <button type="button" data-act="nudge" data-edge="${k}" data-d="1" title="${esc(t("cut.nudgeFwd"))}" aria-label="${esc(t(`cut.edge.${k}`) + " · " + t("cut.nudgeFwd"))}">${icon("plus")}</button>
          </div>
          <button class="iconbtn" type="button" data-act="here" data-edge="${k}" title="${esc(t(`cut.here.${k}`))} (Shift+${k === "a" ? "I" : "O"})" aria-label="${esc(t(`cut.here.${k}`))}">${icon("here")}</button>
        </div>`).join("")}
      </div>` : "");
    ol.append(li);
  });
  if (cut.sel !== cut.shownSel) {         // secim degisti: satirin basi gorunsun
    cut.shownSel = cut.sel;
    const li = ol.querySelector(".cutrow.sel");
    li && li.scrollIntoView({ block: "nearest" });
  }
  $("cutEmpty").hidden = list.length > 0;
  $("cutCount").textContent = list.length || "";
  const total = list.reduce((s, c) => s + c.b - c.a, 0);
  const merge = cut.mode === "merge" && list.length > 1;
  for (const b of document.querySelectorAll(".outmode [data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === cut.mode));
  $("cutChat").setAttribute("aria-checked", String(!!cut.withChat));
  const q = qualityName($("quality").value);
  $("cutInfo").textContent = !list.length ? t("cut.infoEmpty", { q, n: MIN_CUT })
    : merge ? t("cut.infoMerge", { n: list.length, d: fmtDuration(total), q })
    : t("cut.infoSplit", { n: list.length, d: fmtDuration(total), q });
  $("cutDownload").disabled = !list.length;
  $("cutCapcut").disabled = !list.length;
  $("cutDownloadLabel").textContent = merge ? t("cut.dlMerge") : t("cut.dl", { n: list.length });
  $("cutDel").disabled = cut.sel == null;
  persistCuts(cut.vod);
  $("cutChain").disabled = !list.length;
  $("cutChain").innerHTML = cut.chain ? `${icon("pause")}<span>${t("act.stop")}</span>` : `${icon("play")}<span>${t("cut.chain")}</span>`;
  $("cutAdd").title = t("cut.addTip", { len: fmtSpan(cut.len), before: fmtSpan((cut.len * 2) / 3), after: fmtSpan(cut.len / 3) });
  drawTimeline();
}

/* kesit editorundeki kesitlerden siraya girecek ogeler (ayir: her kesit ayri dosya, birlestir: tek dosya) */
function cutItems(list) {
  const vod = cut.vod;
  const title = cleanTitle(vod.title);
  return cut.mode === "merge" && list.length > 1
    ? [{ url: vod.url, thumb: vod.thumb, sections: list.map((c) => [c.a, c.b]), title: `${t("cut.count", { n: list.length })} · ${title}`, withChat: !!cut.withChat }]
    : list.map((c) => ({
      url: vod.url, thumb: vod.thumb, start: c.a, end: c.b, withChat: !!cut.withChat,
      title: `${c.name ? `${c.name} · ` : ""}${fmtDuration(c.a)}–${fmtDuration(c.b)} · ${title}`,
    }));
}

/* kesitleri indirir; hepsi inince arka ucta tek CapCut taslagi yazilir, CapCut acilir (app.capcutDone) */
async function capcutCuts() {
  const list = cutClips();
  if (!list.length) return;
  const vod = cut.vod;
  track("capcut_cuts", { n: list.length, mode: cut.mode, with_chat: !!cut.withChat });
  const name = `${vod.channel || (state.channel && state.channel.slug) || "Kick"} ${cleanTitle(vod.title)}`.slice(0, 70);
  const r = await state.api.capcut_cuts(cutItems(list), name);
  if (!r.ok) { toast(r.error); return; }
  state.cuts.delete(vod.url);
  closeCutter();
  toast(t("capcut.cutsQueued", { n: list.length }));
}

function capcutDone(r) {
  toast(r.ok ? t("capcut.done", { name: r.name }) : r.error);
}

async function downloadCuts() {
  const vod = cut.vod;
  const list = cutClips();
  if (!list.length) return;
  track("cut_download", { n: list.length, mode: cut.mode, with_chat: !!cut.withChat });
  const merge = cut.mode === "merge" && list.length > 1;
  const items = cutItems(list);
  const n = await state.api.enqueue(items);
  state.cuts.delete(vod.url);
  closeCutter();
  if (merge) toast(n ? t("toast.cutsMergedQueued", { n: list.length }) : t("toast.mergedExists"));
  else toast(n === items.length ? t("toast.cutsQueued", { n })
    : n ? t("toast.cutsSomeExist", { n, m: items.length - n }) : t("toast.cutsExist"));
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
  const k = e.key.toLowerCase().replace(/[ıİ]|i̇/g, "i");   // Turkce klavyede I tusu "ı" yazar
  const c = selClip();
  if (k === " ") { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  else if (k === "arrowleft") { e.preventDefault(); seekTo(nowTime() - (e.shiftKey ? 30 : 5)); }
  else if (k === "arrowright") { e.preventDefault(); seekTo(nowTime() + (e.shiftKey ? 30 : 5)); }
  else if (k === "arrowup") { e.preventDefault(); jumpEdge(-1); }
  else if (k === "arrowdown") { e.preventDefault(); jumpEdge(1); }
  else if (k === "k") addClipHere();
  else if ((k === "i" || k === "o") && e.shiftKey) {
    if (!c) { toast(t("toast.selectCutFirst")); return; }
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
    toast(t("cut.rateToast", { r: fmtNum(v.playbackRate, v.playbackRate % 1 ? 2 : 0).replace(/0$/, "") }));
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
  $("peekVideo").addEventListener("seeked", () => {
    const pv = $("peekVideo");
    if (cut.peek.pending == null && !pv.seeking && Math.abs(pv.currentTime - cut.peekAt) < 1.5) $("tlPeek").classList.add("live");
    if (!cut.peekT0) return;
    state.api.client_log(`perf peek video karesi: ${Math.round(performance.now() - cut.peekT0)} ms`);
    cut.peekT0 = 0;
  });
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
  try { cut.tab = localStorage.getItem("cutTab") === "chat" ? "chat" : "cuts"; } catch { cut.tab = "cuts"; }
  cutChat = new ChatPanel($("cutChatPane"), { now: () => (cut.vod ? nowTime() : null), seek: seekTo,
    info: () => ({ url: cut.vod.url, title: cleanTitle(cut.vod.title), thumb: cut.vod.thumb }) });
  $("sideTabCuts").addEventListener("click", () => setSideTab("cuts"));
  $("sideTabChat").addEventListener("click", () => setSideTab("chat"));
  $("cutDownload").addEventListener("click", downloadCuts);
  $("cutCapcut").addEventListener("click", capcutCuts);
  $("cutChat").addEventListener("click", () => { cut.withChat = !cut.withChat; renderCutter(); });
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
  $("zoomFit").addEventListener("click", () => { setView(0, cutDuration()); cut.follow = true; drawTimeline(); });
  $("zoomRange").addEventListener("input", (e) => {
    const dur = cutDuration(), lo = Math.min(MIN_VIEW, dur);
    if (dur) { zoomSpan(dur * Math.pow(lo / dur, Number(e.target.value) / 1000), zoomAnchor()); userView(); }
  });
  $("tlFollow").addEventListener("click", backToHead);

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
      userView();
      drawTimeline();
    } else { zoomAt(Math.exp(e.deltaY * 0.0015), timeAt(e.clientX)); userView(); }
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
    userView();
    drawTimeline();
  };
  ov.addEventListener("pointerdown", (e) => { ov.setPointerCapture(e.pointerId); ov.dataset.drag = "1"; ovMove(e); });
  ov.addEventListener("pointermove", (e) => {
    if (ov.dataset.drag) ovMove(e);
    const dur = cutDuration(), r = ov.getBoundingClientRect();
    if (dur) cut.hoverT = clamp((e.clientX - r.left) / r.width, 0, 1) * dur;     // arka plan dalga dolumunun odagi
  });
  ov.addEventListener("pointerleave", () => { cut.hoverT = null; });
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
    const field = e.target.closest("input[data-field]");
    if (field) {
      const c = cutClips().find((x) => x.id === Number(field.closest("li").dataset.id));
      if (!c) return;
      c[field.dataset.field] = field.value.trim();
      // yeniden cizmek Tab ile gecilen sonraki alani silerdi: yalnizca satirin yazisini guncelle
      const li = field.closest("li");
      let nm = li.querySelector(".cname");
      if (c.name && !nm) { nm = document.createElement("span"); nm.className = "cname"; li.querySelector(".ctext").prepend(nm); }
      if (nm) { nm.textContent = c.name; nm.hidden = !c.name; }
      li.querySelector(".len").textContent = fmtDuration(c.b - c.a) + (c.note ? ` · ${c.note}` : "");
      persistCuts(cut.vod);
      return;
    }
    const inp = e.target.closest("input[data-edge]");
    if (!inp) return;
    const c = cutClips().find((x) => x.id === Number(inp.closest("li").dataset.id));
    const sec = parseTime(inp.value);
    if (sec == null) toast(t("toast.timeFormat"));
    else { setEdge(c, inp.dataset.edge, sec); sortClips(); seekTo(c[inp.dataset.edge]); }
    renderCutter();
  });
  list.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input[data-edge], input[data-field]")) e.target.blur();
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
    el.insertAdjacentHTML("beforeend", `<button class="iconbtn" type="button" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${icon("x")}</button>`);
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
    icon: "clipboard", text: t("notice.clipboard", { link: `<span class="num">${esc(short.length > 70 ? short.slice(0, 70) + "…" : short)}</span>` }),
    actions: [[t("top.open"), () => listLink(link), "primary"]],
  });
}

async function checkUpdate(manual) {
  const r = await state.api.check_update();
  if (r.update) {
    notice("update", {
      icon: "gift", text: t("upd.available", { v: `<b>${esc(r.version)}</b>`, cur: `<span class="num">${esc(r.current)}</span>` }),
      actions: r.auto
        ? [[t("upd.update"), () => runUpdate(r, false), "primary"],
           [t("upd.updateRestart"), () => runUpdate(r, true)],
           [t("upd.notes"), () => state.api.open_url(r.url)]]
        : [[t("upd.openPage"), () => state.api.open_url(r.url), "primary"]],
    });
  } else if (manual) toast(r.ok ? t("upd.upToDate", { v: r.current }) : t("upd.checkFailed"));
}

/* guncelleme: indirme ve kurulum ayni seritte ilerler; ilerleme arka yuzden okunur, serit kapatilamaz.
   restart=false: indirme bitince "hazir" bildirimi; yeniden baslatinca ya da program kapanirken kurulur */
async function runUpdate(r, restart) {
  const u = await state.api.install_update(restart);
  if (!u.ok) return updateFailed(r, u.error);
  const strip = updateStrip(r);
  for (;;) {
    let p;
    try { p = await state.api.update_progress(); } catch { return; }   // uygulama kapandı: yeni sürüm açılıyor
    if (p.phase === "error") { closeNotice("update-run"); return updateFailed(r, p.error); }
    if (p.phase === "ready" && !restart) { closeNotice("update-run"); return updateReady(r); }
    strip(p);
    await new Promise((ok) => setTimeout(ok, 300));
  }
}

/* ilerleme seridi; dondurdugu fonksiyon her yoklamada seridi gunceller */
function updateStrip(r) {
  notice("update-run", { icon: "gift", text: "", sticky: true });
  const el = state.notices.get("update-run");
  el.classList.add("run");
  el.setAttribute("aria-live", "off");
  el.querySelector("p").after(Object.assign(document.createElement("div"), {
    className: "bar meter", role: "progressbar", ariaLabel: t("upd.progress"), innerHTML: "<i></i>",
  }));
  const text = el.querySelector("p"), meter = el.querySelector(".meter");
  return (p) => {
    const known = p.phase === "downloading" && p.total > 0;
    const pct = known ? Math.floor((p.done / p.total) * 100) : null;
    meter.classList.toggle("wait", !known);
    meter.firstElementChild.style.transform = known ? `scaleX(${p.done / p.total})` : "";
    if (known) meter.setAttribute("aria-valuenow", pct);
    else meter.removeAttribute("aria-valuenow");
    text.innerHTML = p.phase === "downloading"
      ? t("upd.downloading", { v: `<b>${esc(r.version)}</b>` }) + (known ? ` <span class="num">${t("pct", { p: pct })} · ${fmtBytes(p.done)} / ${fmtBytes(p.total)}</span>` : "")
      : t("upd.installed", { v: `<b>${esc(r.version)}</b>` });
  };
}

function updateReady(r) {
  notice("update", {
    icon: "gift", text: t("upd.ready", { v: `<b>${esc(r.version)}</b>` }),
    actions: [[t("upd.restart"), async () => {
      const u = await state.api.restart_to_update();
      if (!u.ok) return updateFailed(r, u.error);
      updateStrip(r)({ phase: "installing" });
    }, "primary"]],
  });
}

/* guncellemeden sonraki ilk acilis: hangi surume gecildigini soyler */
function updatedNotice(u) {
  notice("updated", {
    icon: "gift", text: t("upd.done", { v: `<b>${esc(u.version)}</b>` }),
    actions: [[t("upd.notes"), () => state.api.open_url(u.url)]],
  });
}

function updateFailed(r, msg) {
  notice("update", {
    icon: "alert", warn: true, text: t("upd.failed", { msg: esc(msg) }),
    actions: [[t("act.retry"), () => runUpdate(r, true), "primary"], [t("upd.openPage"), () => state.api.open_url(r.url)]],
  });
}

/* onceki oturumdan yarim kalan indirmeler: kendiliginden baslamaz, kullaniciya sorulur */
function offerRestored(n) {
  notice("restored", {
    icon: "retry", text: t("notice.restored", { n }),
    actions: [
      [t("notice.resume"), () => { state.api.resume_all(); toast(t("toast.resumed")); }, "primary"],
      [t("notice.clearList"), () => state.downloads.filter((d) => d.status === "stopped").forEach((d) => state.api.remove(d.id))],
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
    else if (text) toast(t("toast.notKick"));
  });
}

/* ---------- kucuk yardimcilar ---------- */
let toastTimer;
/* kalite tek ayar: oynatici penceresi, secim cubugu ve ayarlardaki kutular birlikte */
async function setQuality(q, quiet) {
  await saveSetting({ quality: q }, true);
  for (const id of ["quality", "selQuality", "setQuality"]) { $(id).value = q; syncSelect($(id)); }
  if (!quiet) toast(t("toast.quality", { q: qualityName(q) }));
}

function toast(msg) {
  const t = $("toast");
  const host = $("cutter").open ? $("cutter") : $("watch").open ? $("watch") : document.body;   // modal acikken ustte gorunsun
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
  $("keysDlg").addEventListener("click", (e) => { if (e.target === $("keysDlg")) $("keysDlg").close(); });
  $("askDlg").addEventListener("click", (e) => { if (e.target === $("askDlg")) $("askDlg").close("no"); });   // disari tiklayinca
  $("afterDone").addEventListener("change", async (e) => {
    const mode = await state.api.set_after_done(e.target.value);
    toast(t(`after.toast.${mode}`));
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
  $("cutSetRow").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cs]");
    if (!b) return;
    const url = b.closest("[data-url]").dataset.url;
    if (b.dataset.cs === "open") openCutSet(url);
    else { state.cutSets = await state.api.cuts_delete(url); state.cuts.delete(url); renderCutSets(); }
  });
  $("cutSetImport").addEventListener("click", importCuts);
  $("cutSetExport").addEventListener("click", exportCuts);

  // kanal
  $("favToggle").addEventListener("click", toggleFavorite);
  $("tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t || t.dataset.tab === state.tab) return;
    setTab(t.dataset.tab);
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
    const lb = e.target.closest("[data-live]");
    if (lb) { onLiveAction(lb); return; }
    const mb = e.target.closest(".more");
    if (mb) { $("cardMenu").hidden || cmenu.btn !== mb ? openCardMenu(url, null, mb) : closeCardMenu(false); return; }
    if (e.target.closest(".cutbtn")) { hover.stop(); player.el().pause(); openCutter(cutTarget(itemByUrl(url))); return; }
    const live = c.classList.contains("livecard");
    // secim varken tik secime ekler / cikarir; izlemek icin kartin ortasindaki oynat dugmesi
    if (!live && !e.target.closest(".cplay") && !e.shiftKey && (e.target.closest(".check") || e.ctrlKey || e.metaKey || state.selected.size)) {
      toggleSel(url);
      state.anchor = url;
      selectionChanged();
      return;
    }
    if (!live && e.shiftKey && state.anchor) {
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
  grid.addEventListener("contextmenu", (e) => {
    const c = e.target.closest(".card[data-url]:not(.livecard)");
    if (!c) return;
    e.preventDefault();
    openCardMenu(c.dataset.url, { x: e.clientX, y: e.clientY }, null);
  });
  grid.addEventListener("keydown", (e) => {
    const c = e.target.closest(".card[data-url]");
    if (!c) return;
    if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && !c.classList.contains("livecard")) {
      e.preventDefault();
      openCardMenu(c.dataset.url, null, c.querySelector(".more"));
      return;
    }
    if (e.key === " " && !c.classList.contains("livecard")) { e.preventDefault(); toggleSel(c.dataset.url); selectionChanged(); }
    if (e.key === "Enter") focusItem(c.dataset.url);
  });
  grid.addEventListener("pointerover", (e) => {
    const c = e.target.closest(".card[data-url]");
    if (c) { hover.start(c); prewarm.over(c); }
  });
  const inFloat = (el) => !!(el && el.closest && el.closest("#hCard"));
  grid.addEventListener("pointerleave", (e) => { if (inFloat(e.relatedTarget)) return; hover.stop(); prewarm.cancel(); });
  grid.addEventListener("pointerout", (e) => {
    const c = e.target.closest(".card[data-url]");
    if (c && !c.contains(e.relatedTarget) && !inFloat(e.relatedTarget)) { hover.stop(); prewarm.cancel(); }
  });
  // buyuyen kart: kartin disina cikinca kapanir; tik video alaninda ayni andan izleme penceresini acar
  const hc = $("hCard");
  hc.addEventListener("pointerleave", (e) => {
    if (hover.card && hover.card.contains(e.relatedTarget)) return;
    hover.stop();
    prewarm.cancel();
  });
  hc.addEventListener("click", (e) => {
    const card = hcard.card, url = hcard.url;
    if (!card) return;
    const b = e.target.closest("[data-hc]");
    if (!b) {                                   // video / baslik: kartin kendi tikini ayni durumla (hover.time) calistir
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey }));
      return;
    }
    const act = b.dataset.hc;
    if (act === "more") { openCardMenu(url, { rect: b.getBoundingClientRect() }, null); return; }
    hover.stop();
    if (act === "cut") { player.el().pause(); openCutter(cutTarget(itemByUrl(url))); }
    else onCardMenu(act, url);
  });
  for (const ev of ["contextmenu"]) hc.addEventListener(ev, (e) => e.preventDefault());
  $("gridWrap").addEventListener("scroll", () => { if (hcard.el) hover.stop(); }, { passive: true });
  window.addEventListener("resize", () => { if (hcard.el) hover.stop(); });
  window.addEventListener("blur", () => { if (hcard.el) hover.stop(); });

  // secim cubugu
  $("selCount").addEventListener("click", toggleSelList);
  $("selClear").addEventListener("click", () => { state.selected.clear(); selectionChanged(); });
  $("selDl").addEventListener("click", () => downloadSelected([...state.selected]));
  $("selList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-unsel]");
    if (b) { toggleSel(b.dataset.unsel, false); selectionChanged(); }
  });

  // oynatici penceresi
  const watch = $("watch");
  watch.addEventListener("close", onWatchClosed);
  watch.addEventListener("click", (e) => { if (e.target === watch) closeWatch(); });   // panelin disi
  $("wClose").addEventListener("click", closeWatch);
  $("wPrev").addEventListener("click", () => watchStep(-1));
  $("wNext").addEventListener("click", () => watchStep(1));
  $("inspector").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ins]");
    if (b) onInspectorAction(b);
  });
  for (const id of ["quality", "selQuality"]) $(id).addEventListener("change", (e) => setQuality(e.target.value));
  bindPlayer();
  watchChat = new ChatPanel($("wChatBody"), { now: watchChatNow, seek: (sec) => { player.el().currentTime = sec; }, info: watchChatInfo });
  $("pChat").addEventListener("click", () => {
    state.settings.chatPanel = !state.settings.chatPanel;
    state.api.set_settings({ chatPanel: state.settings.chatPanel });
    syncWatchChat();
  });
  $("insPoster").addEventListener("error", (e) => {
    const l = player.live && liveItem();
    const fb = l && l.avatar && e.target.src !== l.avatar;
    if (fb) { e.target.src = l.avatar; e.target.classList.add("avfb"); return; }
    e.target.removeAttribute("src");
    showFallback($("player"), e.target.dataset.av || "");
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
    if ($("askDlg").open) return;
    if ($("cutter").open) return cutterKey(e);
    if ($("keysDlg").open) return;
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName);
    if (e.ctrlKey && e.key.toLowerCase() === "l") { e.preventDefault(); $("linkInput").focus(); $("linkInput").select(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "j") { e.preventDefault(); showView("library"); return; }
    if (e.ctrlKey && e.key.toLowerCase() === "f" && state.view === "settings") { e.preventDefault(); $("setSearch").focus(); $("setSearch").select(); return; }
    if (typing) { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "?") { e.preventDefault(); $("keysDlg").showModal(); return; }
    const v = player.el();
    if (e.key === "m" && player.key) { v.muted = !v.muted; return; }
    if (e.key === "f" && player.key) { fullscreen(); return; }
    if ((e.key === "," || e.key === ".") && player.key && !player.live) {
      const i = PLAY_RATES.indexOf(player.rate);
      setPlayRate(PLAY_RATES[clamp((i < 0 ? 3 : i) + (e.key === "." ? 1 : -1), 0, PLAY_RATES.length - 1)]);
      toast(t("cut.rateToast", { r: player.rate }));
      return;
    }
    if (e.key === "k" && player.key) { v.paused ? v.play().catch(() => {}) : v.pause(); return; }
    if ($("watch").open) {
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.target.type !== "range") { e.preventDefault(); watchStep(e.key === "ArrowLeft" ? -1 : 1); }
      return;
    }
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
  bindCardMenu();
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
  setLang(cfg.lang, cfg.strings);
  applyStatic();
  for (const o of $("cutRate").options) o.textContent = `${fmtNum(Number(o.value), Number(o.value) % 1 ? String(o.value).split(".")[1].length : 0)}×`;
  state.settings = cfg.settings;
  state.favorites = cfg.favorites || [];
  state.cutSets = await api.cuts_list();
  for (const id of ["quality", "selQuality"]) {
    $(id).innerHTML = cfg.qualities.map((q) => `<option value="${q}">${esc(qualityName(q))}</option>`).join("");
    $(id).value = cfg.quality;
  }
  bind();
  syncSelects();
  applySectionLength();
  if (!cfg.ffmpeg) showError(t("err.noFfmpeg"));
  showView("home");
  renderRail();
  refreshLibrary();
  refreshFavorites();
  setInterval(refreshFavorites, 10 * 60 * 1000);
  if (!state.favorites.length) $("linkInput").focus();   // ilk acilista nereden baslanacagi belli olsun
  if (cfg.restored) offerRestored(cfg.restored);
  if (state.settings.telemetry == null) askUsage();
  state.api.just_updated().then((u) => u && updatedNotice(u));
  if (state.settings.updateCheck) setTimeout(() => checkUpdate(false), 3000);
  checkClipboard();
}

window.app = { sync, capcutDone };
window.addEventListener("error", (e) => state.api && state.api.client_error(String(e.message), String(e.filename || ""), e.lineno || 0, String((e.error && e.error.stack) || "")));
window.addEventListener("unhandledrejection", (e) => state.api && state.api.client_log(`promise: ${e.reason && (e.reason.message || e.reason)}`));
if (window.pywebview && window.pywebview.api) start(window.pywebview.api);
else window.addEventListener("pywebviewready", () => start(window.pywebview.api));
