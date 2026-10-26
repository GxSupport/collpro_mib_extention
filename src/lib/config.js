/**
 * Sozlamalar va selektorlar.
 *
 * CLAUDE.md 7-qoidasi: DOM o'zgarsa kod emas, sozlama tahrirlanadi.
 * Bu yerdagi hamma narsa options sahifasidan qayta yozilishi mumkin.
 *
 * Fayl ham content script, ham service worker (importScripts) ichida yuklanadi,
 * shuning uchun ES module emas — globalThis ga yoziladi.
 */
(function (root) {
  'use strict';

  const DEFAULT_SELECTORS = {
    // ── Qidiruv formasi ────────────────────────────────────────────────
    // Bootstrap tab (client-side, Wicket AJAX emas). ID'lar barqaror.
    pinflTab: 'a[href="#tab_pinfl"]',
    pinflPane: '#tab_pinfl',

    // Wicket id'lari beqaror (#id13 → #id46), faqat name= ishlatiladi.
    pinflInput: 'input[name="pinfl"]',
    captchaInput: 'input[name="secure_code"]',
    submitButton: 'button[name="submit_button"]',
    captchaImage: 'img[src*="antiCache"]',

    // ── Natija sahifasi ────────────────────────────────────────────────
    totalsTable: '.debit-all-info-table',
    caseCard: '.black_item',
    caseField: '.bl-f-item',
    caseAmount: '.debit-amount',
    repeatSearchLink: 'a.btn-primary',

    // Ijro hujjatlari 10 tadan sahifalanadi. Joriy sahifaning havolasi BO'SH —
    // shu bilan ajratiladi. Sahifa o'tish to'liq navigatsiya, captcha so'ralmaydi.
    paginationItem: 'ul.pagination li.page-item',
    paginationLink: 'a.page-link',

    // ── Wicket feedback panel ──────────────────────────────────────────
    feedbackItem: 'ul.feedbackPanel li',
    feedbackError: 'feedbackPanelERROR',
    feedbackWarning: 'feedbackPanelWARNING'
  };

  /**
   * Karta ichidagi kalitlar. mib.uz'da CSS `text-transform: uppercase` bor,
   * shuning uchun textContent kichik harfga keltirilib solishtiriladi.
   */
  const DEFAULT_FIELD_MAP = {
    'фио': 'fio',
    'жшшир': 'pinfl',
    'ижро иши рақами': 'case_number',
    'ҳужжат ҳолати': 'doc_status',
    'и/ҳ мазмуни': 'subject',
    'ҳужжат иш юритувида': 'department',
    'ундирувчи': 'claimant_raw'
  };

  /** Kartada bo'lishi shart bo'lgan maydonlar. Yo'q bo'lsa → parse_error. */
  const REQUIRED_CASE_FIELDS = ['case_number', 'doc_status', 'subject', 'claimant_raw'];

  const DEFAULT_SETTINGS = {
    /**
     * CollPro API. `admin.trackcoll.uz` — SPA frontend, API emas
     * (2026-08-08 da tekshirilgan, MIB_BACKEND.md dagi izohga qarang).
     */
    apiBase: 'https://api.trackcoll.uz/api/mib',
    token: '',
    operator: null,

    /** Qidiruvlar orasidagi qo'shimcha pauza. Captcha terish o'zi pauza beradi. */
    delayMs: 1000,

    /** Submit'dan keyin natijani kutish chegarasi. */
    resultTimeoutMs: 20000,

    /** Backendga yuborishda necha marta qayta urinish. */
    maxRetries: 5,

    /** Raw HTML gzip qilinsinmi (~400 KB → ~30 KB). */
    compressRawHtml: true,

    /**
     * Parse xatosida sahifada to'xtab turish. Operator sahifani o'z ko'zi
     * bilan ko'radi va "O'tkazib yuborish" bosadi. Selektorlar barqarorlashgach
     * o'chirish mumkin.
     */
    pauseOnParseError: true,

    /** Bitta qarzdorda kutiladigan maksimal sahifa soni — cheksiz siklga qarshi. */
    maxResultPages: 25,

    /**
     * Captcha terilgach "Қидириш" ni o'zi bosish. Operator Enter bosmasa ham
     * ishlaydi; Enter baribir darhol yuboradi.
     */
    autoSubmit: true,

    /**
     * Javob shu uzunlikka yetsa darhol yuboriladi. mib.uz arifmetikasi
     * ("тўққиз + икки =") maksimum ikki xonali javob beradi.
     */
    captchaFullLength: 2,

    /** Javob to'liq emas (bir xonali) — shuncha kutib yuboriladi. */
    autoSubmitDelayMs: 3000,

    selectors: DEFAULT_SELECTORS,
    fieldMap: DEFAULT_FIELD_MAP
  };

  /** Content script holat mashinasining bosqichlari. */
  const STAGE = {
    IDLE: 'idle',
    FETCHING: 'fetching',          // backenddan PINFL so'ralyapti
    AWAITING_CAPTCHA: 'awaiting_captcha',
    SUBMITTED: 'submitted',        // Қидириш bosildi, natija kutilyapti
    RESULT_SENT: 'result_sent'     // natija yuborildi, keyingisiga o'tilyapti
  };

  /** Sahifa turlari. */
  const PAGE = {
    FORM: 'FORM',
    FOUND: 'FOUND',
    NOT_FOUND: 'NOT_FOUND',
    CAPTCHA_FAILED: 'CAPTCHA_FAILED',
    UNKNOWN: 'UNKNOWN'
  };

  const STORAGE_KEYS = {
    settings: 'mib_settings',
    state: 'mib_state',
    outbox: 'mib_outbox',
    /** Ko'p sahifali natijani yig'ish buferi (sahifalar orasida saqlanadi). */
    collect: 'mib_collect',
    /** Yuborib bo'lmagan natijalar — jim yo'qolmasligi uchun (CLAUDE.md 2-qoida). */
    deadLetter: 'mib_dead_letter'
  };

  /** Sozlamalarni o'qish — saqlanmagan maydonlar default bilan to'ldiriladi. */
  async function loadSettings() {
    const stored = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    if (!stored) return structuredClone(DEFAULT_SETTINGS);

    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      selectors: { ...DEFAULT_SELECTORS, ...(stored.selectors || {}) },
      fieldMap: { ...DEFAULT_FIELD_MAP, ...(stored.fieldMap || {}) }
    };
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
    return next;
  }

  const DEFAULT_STATE = {
    running: false,
    stage: STAGE.IDLE,
    current: null,        // { id, pinfl, debtor_name }
    progress: { position: 0, total: 0 },
    stats: { found: 0, notFound: 0, parseError: 0, captchaRetries: 0 },
    lastError: null,
    /** Operator akkaunti bloklangan (HTTP 400) — qayta login yordam bermaydi. */
    blocked: false,
    startedAt: null
  };

  async function loadState() {
    const stored = (await chrome.storage.local.get(STORAGE_KEYS.state))[STORAGE_KEYS.state];
    return { ...structuredClone(DEFAULT_STATE), ...(stored || {}) };
  }

  async function saveState(patch) {
    const current = await loadState();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [STORAGE_KEYS.state]: next });
    return next;
  }

  async function resetState() {
    await chrome.storage.local.set({ [STORAGE_KEYS.state]: structuredClone(DEFAULT_STATE) });
  }

  root.MibConfig = {
    DEFAULT_SETTINGS,
    DEFAULT_SELECTORS,
    DEFAULT_FIELD_MAP,
    REQUIRED_CASE_FIELDS,
    DEFAULT_STATE,
    STAGE,
    PAGE,
    STORAGE_KEYS,
    loadSettings,
    saveSettings,
    loadState,
    saveState,
    resetState
  };
})(typeof self !== 'undefined' ? self : globalThis);
