/**
 * CollPro backend bilan aloqa. Faqat service worker ichida ishlaydi.
 *
 * Haqiqat manbai: MIB_BACKEND.md (deploy qilingan holat).
 * API.md — dastlabki taklif, ziddiyatda MIB_BACKEND.md ustun.
 */
(function (root) {
  'use strict';

  class ApiError extends Error {
    constructor(status, code, message, extra = {}) {
      super(message || code || `HTTP ${status}`);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      /** 422 da bo'lishi mumkin: sahifa saqlangan, qayta yubormaymiz. */
      this.snapshotId = extra.snapshotId ?? null;
      /** 429 da `Retry-After` sekundlarda. */
      this.retryAfterMs = extra.retryAfterMs ?? null;
    }

    /** 401 — sessiya tugadi, ish to'xtaydi (CLAUDE.md 6-qoida). */
    get isAuthError() {
      return this.status === 401;
    }

    /**
     * 400 — operator akkaunti bloklangan (`is_active = 0`).
     * Qayta login YORDAM BERMAYDI, administrator kerak (MIB_BACKEND.md §6).
     */
    get isBlocked() {
      return this.status === 400;
    }

    /** Navbat band — bir necha soniyadan keyin qayta so'raladi. */
    get isClaimConflict() {
      return this.status === 409 && this.code === 'claim_failed';
    }

    /** Qayta urinish ma'noli bo'lgan xatolar. */
    get isRetryable() {
      return this.status === 429 || this.status >= 500 || this.status === 0;
    }

    /**
     * Qayta yuborish hech qachon yordam bermaydigan holatlar — natija
     * buferda abadiy aylanib qolmasligi uchun (404 task_not_found,
     * 409 pinfl_mismatch, 422 validatsiya).
     */
    get isPermanent() {
      return this.status === 404 || this.status === 409 || this.status === 422;
    }
  }

  function joinUrl(base, path) {
    return `${String(base).replace(/\/+$/, '')}${path}`;
  }

  /**
   * Xato javoblarining uch xil shakli bor (MIB_BACKEND.md §6):
   *   {ok:false, error, message}   — odatiy
   *   {message: "Unauthenticated."} — 401
   *   {errors: [{message}]}         — 400, bloklangan akkaunt
   */
  function errorMessage(payload) {
    if (!payload) return null;
    if (payload.message) return payload.message;
    if (Array.isArray(payload.errors) && payload.errors.length) {
      return payload.errors.map((item) => item?.message).filter(Boolean).join('; ') || null;
    }
    return null;
  }

  function retryAfterMs(response) {
    const header = response.headers.get('Retry-After');
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  }

  async function request(settings, path, { method = 'GET', body = null, auth = true } = {}) {
    if (!settings.apiBase) {
      throw new ApiError(0, 'no_api_base', 'Адрес API не настроен');
    }

    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (auth) {
      if (!settings.token) throw new ApiError(401, 'no_token', 'Нет токена — выполните вход');
      headers.Authorization = `Bearer ${settings.token}`;
    }

    let response;
    try {
      response = await fetch(joinUrl(settings.apiBase, path), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (cause) {
      // Tarmoq uzilgan — buferga tushadi, keyin qayta yuboriladi.
      throw new ApiError(0, 'network_error', cause.message);
    }

    if (response.status === 204) return null;

    let payload = null;
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // Backend JSON o'rniga HTML qaytardi — odatda login sahifasiga redirect.
        throw new ApiError(
          response.status === 200 ? 502 : response.status,
          'non_json_response',
          'Сервер вернул не JSON (возможно, страница входа)'
        );
      }
    }

    if (!response.ok) {
      throw new ApiError(response.status, payload?.error, errorMessage(payload), {
        snapshotId: payload?.snapshot_id ?? null,
        retryAfterMs: retryAfterMs(response)
      });
    }

    return payload;
  }

  /**
   * Login/parol → token.
   *
   * `login` — CollPro'da **telefon raqami** (email emas). `+`, bo'shliq, `()`,
   * `-` backend tomonda tozalanadi (MIB_BACKEND.md FARQ 1).
   *
   * Javobdagi `expires_at` hozircha doim `null` — token muddatsiz. Shuning
   * uchun sanaga qarab oldindan logout qilinmaydi; yagona signal — 401
   * (MIB_BACKEND.md FARQ 2).
   */
  async function login(apiBase, login_, password) {
    return request({ apiBase, token: null }, '/login', {
      method: 'POST',
      auth: false,
      body: { login: login_, password }
    });
  }

  /** Navbatdagi bitta PINFL. Navbat bo'sh bo'lsa null. */
  async function fetchNext(settings) {
    return request(settings, '/next');
  }

  /** Natija (found | not_found | parse_error). */
  async function postResult(settings, payload) {
    return request(settings, '/result', { method: 'POST', body: payload });
  }

  /** Operator to'xtatganda qatorni navbatga qaytarish. */
  async function releaseTask(settings, id, reason) {
    return request(settings, '/release', { method: 'POST', body: { id, reason } });
  }

  root.MibApi = { ApiError, login, fetchNext, postResult, releaseTask };
})(typeof self !== 'undefined' ? self : globalThis);
