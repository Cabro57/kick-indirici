"use strict";

/* Arayuz metinleri. Sozluk arka uctan gelir (init: Ingilizce temel + secili dil ustune).
   t("anahtar", {ad: deger}): {ad} yerlerini doldurur. Deger {one, other} ise vars.n ile cogul secilir.
   Sabit HTML: data-i18n (metin), data-i18n-html (bicimli metin), data-i18n-title,
   data-i18n-placeholder, data-i18n-aria, data-i18n-label (ozel select'in etiketi). */
const i18n = {
  lang: "en",
  locale: "en-US",
  strings: {},
  plural: new Intl.PluralRules("en-US"),
  missing: new Set(),
};

function setLang(lang, strings) {
  i18n.lang = lang;
  i18n.locale = { en: "en-US", tr: "tr-TR" }[lang] || "en-US";
  i18n.strings = strings || {};
  i18n.plural = new Intl.PluralRules(i18n.locale);
  document.documentElement.lang = lang;
}

function t(key, vars) {
  let s = i18n.strings[key];
  if (s == null) {
    if (!i18n.missing.has(key)) { i18n.missing.add(key); console.warn("i18n: missing", key); }
    return key;
  }
  if (typeof s === "object") s = s[vars && vars.n != null ? i18n.plural.select(vars.n) : "other"] ?? s.other;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
}

const I18N_ATTRS = [["i18nTitle", "title"], ["i18nPlaceholder", "placeholder"], ["i18nAria", "aria-label"],
  ["i18nLabel", "data-label"], ["i18nAlt", "alt"]];

function translateTree(root) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml);   // yalniz kendi sozlugumuz
  for (const [attr, name] of I18N_ATTRS) {
    const sel = `[data-${attr.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}]`;
    for (const el of root.querySelectorAll(sel)) el.setAttribute(name, t(el.dataset[attr]));
  }
  for (const tpl of root.querySelectorAll("template")) translateTree(tpl.content);   // kart sablonlari
}

function applyStatic() {
  translateTree(document);
  document.title = t("app.name");
  document.documentElement.classList.remove("i18n-pending");
}

// sozluk gelene kadar sayfa gizli (yanlis dilde metin gorunmesin); bir sey ters giderse yine de acilir
setTimeout(() => document.documentElement.classList.remove("i18n-pending"), 3000);
