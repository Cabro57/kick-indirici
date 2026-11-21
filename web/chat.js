/* ---------- sohbet paneli ----------
   Izleme penceresinde ve kesit editorunde videoyla eszamanli sohbet. Mesajlar oynatma anina kadar akar;
   yukari kaydirinca ya da mesaj secince akis durur ("Simdiye don"). Mesaja tikla: sec, Shift: aralik;
   saate tikla: video o ana gider. Secilenler resim (PNG) olarak kopyalanir ya da kaydedilir.
   Kaynak Python'da (api/chat.py): VOD ve kliplerde 5 dk'lik parcalar istendikce gelir, canlida anlik akis. */
const CHAT_SHOW = 150;     // listede tutulan en fazla mesaj

class ChatPanel {
  /* now(): oynatilan an (VOD: videoda saniye, canli: epoch sn) ya da null. seek(t): videoyu o ana goturur.
     info(): sohbet videosunun adi icin {url, title, thumb}. */
  constructor(root, { now, seek, info }) {
    this.root = root;
    this.now = now;
    this.seek = seek;
    this.info = info;
    this.token = 0;
    this.reset();
    root.classList.add("chatp");
    root.innerHTML = `<div class="chatp-scroll"><ol class="chatp-list" role="log" aria-live="off"></ol></div>
      <p class="chatp-msg" hidden></p>
      <button class="btn sm chatp-now" type="button" hidden>${icon("chevron")}<span>${esc(t("chat.panel.now"))}</span></button>
      <div class="chatp-foot">
        <p class="chatp-hint">${esc(t("chat.panel.hint"))}</p>
        <div class="chatp-sel" hidden>
          <span class="num chatp-count"></span>
          <button class="iconbtn" type="button" data-cp="opts" title="${esc(t("chat.img.optsTip"))}" aria-label="${esc(t("chat.img.opts"))}" aria-expanded="false">${icon("settings")}</button>
          <button class="btn sm" type="button" data-cp="copy" title="${esc(t("chat.img.copyTip"))}">${icon("clipboard")}<span>${esc(t("chat.img.copy"))}</span></button>
          <button class="btn sm" type="button" data-cp="save" title="${esc(t("chat.img.saveTip"))}">${icon("download")}<span>${esc(t("chat.img.save"))}</span></button>
          <button class="iconbtn" type="button" data-cp="video" title="${esc(t("chat.vid.selTip"))}" aria-label="${esc(t("chat.vid.sel"))}">${icon("film")}</button>
          <button class="iconbtn" type="button" data-cp="clear" title="${esc(t("chat.panel.clearSel"))}" aria-label="${esc(t("chat.panel.clearSel"))}">${icon("x")}</button>
        </div>
        <div class="chatp-opts" hidden></div>
      </div>`;
    this.scroller = root.querySelector(".chatp-scroll");
    this.list = root.querySelector(".chatp-list");
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.list.addEventListener("click", (e) => this.onClick(e));
    root.querySelector(".chatp-now").addEventListener("click", () => this.resume());
    root.querySelector(".chatp-foot").addEventListener("click", (e) => this.onFoot(e));
  }

  reset() {
    clearInterval(this.timer);
    clearTimeout(this.pollTimer);
    this.id = null;
    this.live = false;
    this.chunks = new Map();     // parca no -> {msgs, final, at} ya da {loading}
    this.msgs = [];
    this.version = 0;            // msgs yeniden siralaninca artar: liste bastan cizilir
    this.shown = null;           // {version, from, to}: listede msgs[from..to)
    this.sel = new Set();        // secili mesajlarin id'leri
    this.anchor = null;
    this.held = false;           // kullanici yukari kaydirdi
    this.seq = 0;
    this.error = "";
  }

  get open() { return this.id != null; }

  async start(spec) {
    this.stop();
    const token = ++this.token;
    this.status(t("chat.panel.loading"), true);
    const res = await state.api.chat_open(spec);
    if (token !== this.token) return;
    if (!res.ok) { this.status(res.error); return; }
    this.id = res.id;
    this.live = res.live;
    track("chat_panel", { source: Object.keys(spec)[0], where: this.root.id });
    if (this.live) this.poll(token);
    this.timer = setInterval(() => this.tick(), 250);
    this.tick();
  }

  stop() {
    this.token++;
    if (this.live && this.id) state.api.chat_close(this.id);
    this.reset();
    this.list.textContent = "";
    this.paintSel();
    this.status("");
    this.root.querySelector(".chatp-now").hidden = true;
  }

  status(text, busy) {
    const m = this.root.querySelector(".chatp-msg");
    m.hidden = !text;
    m.textContent = text || "";
    if (text && busy) m.insertAdjacentHTML("afterbegin", `<i class="mini" aria-hidden="true"></i>`);
  }

  /* canli: Python'daki tampondan yeni mesajlar */
  async poll(token) {
    const res = await state.api.chat_live(this.id, this.seq);
    if (token !== this.token) return;
    if (res.ok && res.messages.length) {
      const last = this.msgs.length ? this.msgs[this.msgs.length - 1].t : -Infinity;
      this.msgs.push(...res.messages);
      if (res.messages.some((m) => m.t < last)) { this.msgs.sort((a, b) => a.t - b.t); this.version++; }
      if (this.msgs.length > 3000) { this.msgs = this.msgs.slice(-2000); this.version++; }
    }
    if (res.ok) this.seq = res.seq;
    this.pollTimer = setTimeout(() => this.poll(token), 1000);
  }

  /* VOD: oynatma aninin parcasini (sona yaklasinca sonrakini, basindaysa oncekini de) ister */
  ensure(k) {
    if (k < 0) return;
    const c = this.chunks.get(k);
    if (c && (c.loading || c.final || Date.now() - c.at < 30000)) return;
    this.chunks.set(k, { ...(c || {}), loading: true });
    const token = this.token;
    state.api.chat_chunk(this.id, k).then((res) => {
      if (token !== this.token) return;
      if (!res.ok) { this.chunks.set(k, { msgs: [], final: false, at: Date.now() }); this.error = res.error; return; }
      this.size = res.size;
      this.error = "";
      this.chunks.set(k, { msgs: res.messages, final: res.final, at: Date.now() });
      this.msgs = [...this.chunks.keys()].sort((a, b) => a - b).flatMap((i) => this.chunks.get(i).msgs || []);
      this.version++;
      this.tick();
    });
  }

  tick() {
    if (!this.open) return;
    const now = this.now();
    if (now == null) return;
    if (!this.live) {
      const size = this.size || 300, k = Math.floor(now / size), into = now - k * size;
      this.ensure(k);
      if (into > size - 60) this.ensure(k + 1);
      if (into < 60) this.ensure(k - 1);
    }
    const to = this.upto(now);
    // VOD: yalnizca oynatma anina kadar kesintisiz yuklu parcalar; arada eksik parca varsa eskiler gosterilmez
    let floor = 0, loading = false;
    if (!this.live) {
      const size = this.size || 300, has = (j) => !!(this.chunks.get(j) || {}).msgs;
      let j = Math.floor(now / size);
      loading = !has(j);
      while (has(j - 1)) j--;
      floor = loading ? Infinity : j * size;
    }
    const from = Math.max(to - CHAT_SHOW, Math.min(to, this.upto(floor - 0.001)));
    if (this.error) this.status(this.error);
    else if (loading) this.status(t("chat.panel.loading"), true);
    else this.status(to > from ? "" : this.live ? t("chat.panel.waiting") : t("chat.panel.empty"));
    if (this.held || this.sel.size) {
      this.root.querySelector(".chatp-now").hidden = false;
      return;
    }
    this.render(from, to);
  }

  /* t'si `now`a kadar olan mesajlarin sayisi (msgs zamana gore sirali) */
  upto(now) {
    let lo = 0, hi = this.msgs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.msgs[mid].t <= now) lo = mid + 1; else hi = mid; }
    return lo;
  }

  render(from, to) {
    const s = this.shown;
    if (s && s.version === this.version && s.to === to && s.from === from) return;
    if (s && s.version === this.version && to >= s.to && to - s.to < CHAT_SHOW && from >= s.from) {
      this.list.insertAdjacentHTML("beforeend", this.rows(s.to, to));
      for (let i = s.from; i < from; i++) this.list.firstElementChild && this.list.firstElementChild.remove();
    } else {
      this.list.innerHTML = this.rows(from, to);
    }
    this.shown = { version: this.version, from, to };
    this.toBottom();
  }

  rows(a, b) {
    let html = "";
    for (let i = a; i < b; i++) html += this.row(this.msgs[i], i);
    return html;
  }

  row(m, i) {
    const badges = (m.badges || []).map((u) => `<img class="cb" src="${esc(u)}" alt="">`).join("");
    const body = (m.content || m.text || "").split(/(\[emote:\d+:[^\]]*\])/).map((p) => {
      const e = p.match(/^\[emote:(\d+):([^\]]*)\]$/);
      return e ? `<img class="ce" src="https://files.kick.com/emotes/${e[1]}/fullsize" alt="${esc(e[2])}" title="${esc(e[2])}">` : esc(p);
    }).join("");
    const time = this.live ? new Date(m.t * 1000).toLocaleTimeString(i18n.locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : fmtDuration(m.t);
    return `<li data-i="${i}"${this.sel.has(m.id) ? ' class="sel"' : ""}><button class="ct num" type="button" tabindex="-1"${this.live ? " disabled" : ` title="${esc(t("chat.panel.seekTip"))}"`}>${time}</button>${badges}<b style="color:${esc(m.color || "#fff")}">${esc(m.user)}</b>: <span>${body}</span></li>`;
  }

  toBottom() {
    this.auto = true;
    this.scroller.scrollTop = this.scroller.scrollHeight;
    requestAnimationFrame(() => { this.auto = false; });
  }

  onScroll() {
    if (this.auto) return;
    const el = this.scroller;
    this.held = el.scrollHeight - el.scrollTop - el.clientHeight > 40;
    if (!this.held && !this.sel.size) this.root.querySelector(".chatp-now").hidden = true;
  }

  resume() {
    this.held = false;
    this.clearSel();
    this.root.querySelector(".chatp-now").hidden = true;
    this.shown = null;
    this.tick();
  }

  onClick(e) {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    const i = Number(li.dataset.i), m = this.msgs[i];
    if (!m) return;
    if (e.target.closest(".ct")) { if (!this.live) this.seek(m.t); return; }
    if (e.shiftKey && this.anchor != null) {
      const a = Math.min(this.anchor, i), b = Math.max(this.anchor, i);
      for (let j = a; j <= b; j++) if (this.msgs[j]) this.sel.add(this.msgs[j].id);
    } else {
      if (this.sel.has(m.id)) this.sel.delete(m.id); else this.sel.add(m.id);
      this.anchor = i;
    }
    for (const el of this.list.children) {
      const x = this.msgs[Number(el.dataset.i)];
      el.classList.toggle("sel", !!x && this.sel.has(x.id));
    }
    this.paintSel();
  }

  clearSel() {
    this.sel.clear();
    this.anchor = null;
    for (const el of this.list.querySelectorAll("li.sel")) el.classList.remove("sel");
    this.paintSel();
  }

  paintSel() {
    const n = this.sel.size, r = this.root;
    r.querySelector(".chatp-sel").hidden = !n;
    r.querySelector(".chatp-hint").hidden = !!n;
    if (!n) this.showOpts(false);
    r.querySelector(".chatp-count").textContent = t(n === 1 ? "chat.panel.sel1" : "chat.panel.selN", { n });
  }

  selected() {
    return this.msgs.filter((m) => this.sel.has(m.id));
  }

  async onFoot(e) {
    const b = e.target.closest("[data-cp]");
    if (b) {
      const act = b.dataset.cp;
      if (act === "clear") { this.clearSel(); this.resume(); }
      else if (act === "opts") this.showOpts(this.root.querySelector(".chatp-opts").hidden);
      else if (act === "copy" || act === "save") await this.image(act, b);
      else if (act === "video") {
        track("chat_video_selection", { n: this.sel.size, live: this.live });
        await withBusy(b, async () => {
          const res = await state.api.chat_video_selection(this.info(), this.selected(), this.live);
          toast(res.ok ? t("chat.vid.queued") : res.error);
        });
      }
      return;
    }
    const o = e.target.closest("[data-co]");
    if (!o) return;
    const opts = { ...state.settings.chatImage };
    const [k, v] = o.dataset.co.split(":");
    opts[k] = k === "width" ? Number(v) : k === "bg" ? v : !opts[k];
    state.settings.chatImage = opts;
    state.api.set_settings({ chatImage: opts });
    this.showOpts(true);
  }

  showOpts(on) {
    const box = this.root.querySelector(".chatp-opts");
    this.root.querySelector('[data-cp="opts"]').setAttribute("aria-expanded", on);
    box.hidden = !on;
    if (!on) return;
    const o = state.settings.chatImage;
    const seg = (key, vals) => `<div class="seg" role="radiogroup">${vals.map(([v, label]) =>
      `<button type="button" role="radio" data-co="${key}:${v}" aria-checked="${String(o[key]) === String(v)}">${esc(label)}</button>`).join("")}</div>`;
    const check = (key) => `<button type="button" class="chk" role="checkbox" data-co="${key}" aria-checked="${!!o[key]}">${icon("check")}<span>${esc(t(`chat.img.${key}`))}</span></button>`;
    box.innerHTML = `<p>${esc(t("chat.img.bg"))}</p>${seg("bg", [["dark", t("chat.img.dark")], ["transparent", t("chat.img.transparent")]])}
      <p>${esc(t("chat.img.width"))}</p>${seg("width", [[360, t("chat.img.narrow")], [480, t("chat.img.medium")], [640, t("chat.img.wide")]])}
      <div class="chks">${check("time")}${check("badges")}${check("emotes")}</div>`;
  }

  async image(act, btn) {
    const msgs = this.selected();
    if (!msgs.length) return;
    btn.disabled = true;
    btn.classList.add("is-busy");
    try {
      const res = await state.api.chat_image(msgs, { ...state.settings.chatImage, clock: this.live }, act);
      if (!res.ok) { toast(res.error); return; }
      track("chat_image", { act, n: msgs.length, live: this.live });
      if (act === "save") { if (res.saved) toast(t("chat.img.saved")); return; }
      const bytes = Uint8Array.from(atob(res.png), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
      toast(t(msgs.length === 1 ? "chat.img.copied1" : "chat.img.copiedN", { n: msgs.length }));
    } catch (err) {
      state.api.client_log(`chat image: ${err && err.message}`);
      toast(t("chat.img.copyFailed"));
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-busy");
    }
  }
}
