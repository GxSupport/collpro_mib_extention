/**
 * Service worker: navbat, API, offline bufer, retry.
 *
 * Content script hech qachon to'g'ridan-to'g'ri backendga murojaat qilmaydi —
 * hammasi shu yerdan o'tadi, chunki service worker sahifa qayta yuklanganda
 * o'lmaydi va bufer saqlanib qoladi.
 */
importScripts('/src/lib/config.js', '/src/lib/api.js');

const { STAGE, STORAGE_KEYS, loadSettings, loadState, saveState, resetState } = self.MibConfig;
const { ApiError } = self.MibApi;

const OUTBOX_ALARM = 'mib_flush_outbox';
const CLAIM_ALARM = 'mib_claim_ttl';

/**
 * Backend qatorni 30 daqiqaga band qiladi (MIB_BACKEND.md §5). Undan oshsa
 * qator tortib olinadi va natija `late_submission` bo'ladi. Shuning uchun
 * 25 daqiqada o'zimiz `release` qilamiz.
 */
const CLAIM_TTL_MINUTES = 25;

// ─── Offline bufer ───────────────────────────────────────────────────────────
// CLAUDE.md 3-qoidasi: navbatdan yo'qotish yo'q. Internet uzilsa natija
// buferga tushadi va tiklanganda ketma-ket yuboriladi.

async function readOutbox() {
  return (await chrome.storage.local.get(STORAGE_KEYS.outbox))[STORAGE_KEYS.outbox] || [];
}

async function writeOutbox(items) {
  await chrome.storage.local.set({ [STORAGE_KEYS.outbox]: items });
}

async function enqueue(payload) {
  const outbox = await readOutbox();
  outbox.push({ payload, attempts: 0, queuedAt: new Date().toISOString() });
  await writeOutbox(outbox);
  chrome.alarms.create(OUTBOX_ALARM, { delayInMinutes: 1 });
}

/**
 * Buferni bo'shatishga urinadi. Tartib saqlanadi — birinchi element
 * yuborilmaguncha keyingilariga o'tilmaydi.
 */
async function flushOutbox() {
  const settings = await loadSettings();
  if (!settings.apiBase || !settings.token) return;

  let outbox = await readOutbox();

  while (outbox.length) {
    const entry = outbox[0];
    try {
      await self.MibApi.postResult(settings, entry.payload);
      outbox.shift();
      await writeOutbox(outbox);
    } catch (error) {
      if (error instanceof ApiError && (error.isAuthError || error.isBlocked)) {
        await haltOnApiError(error);
        return;
      }

      entry.attempts += 1;
      entry.lastError = error.message;

      // 404 / 409 / 422 — qayta yuborish hech qachon yordam bermaydi.
      // 422 da `snapshot_id` bo'lsa sahifa backendda saqlangan, ya'ni
      // CLAUDE.md 1-qoidasi buzilmaydi va navbatga qator o'zi qaytadi.
      if (error instanceof ApiError && error.isPermanent) {
        outbox.shift();
        await writeOutbox(outbox);
        await recordDeadLetter(entry, error);
        continue;
      }

      if (entry.attempts >= settings.maxRetries) {
        outbox.shift();
        await writeOutbox(outbox);
        await recordDeadLetter(entry, error);
        continue;
      }

      await writeOutbox(outbox);
      const delayMinutes = error.retryAfterMs
        ? Math.max(1, Math.ceil(error.retryAfterMs / 60000))
        : Math.min(entry.attempts, 5);
      chrome.alarms.create(OUTBOX_ALARM, { delayInMinutes: delayMinutes });
      return;
    }
  }
}

/**
 * Buferdan chiqarilgan, lekin YO'QOTILMAGAN natija. Operator popup'da ko'radi
 * va kerak bo'lsa qo'lda qayta yuboradi (CLAUDE.md 2-qoida).
 */
async function readDeadLetter() {
  return (await chrome.storage.local.get(STORAGE_KEYS.deadLetter))[STORAGE_KEYS.deadLetter] || [];
}

async function recordDeadLetter(entry, error) {
  const store = await readDeadLetter();

  store.push({
    id: entry.payload?.id ?? null,
    pinfl: entry.payload?.pinfl ?? null,
    status: entry.payload?.status ?? null,
    attempts: entry.attempts,
    error: error.message,
    httpStatus: error.status ?? null,
    // 422 da backend sahifani baribir saqlagan — raw_html ni ushlab turish shart emas.
    snapshotId: error.snapshotId ?? null,
    failedAt: new Date().toISOString(),
    payload: error.snapshotId ? null : entry.payload
  });

  await chrome.storage.local.set({ [STORAGE_KEYS.deadLetter]: store.slice(-200) });
  await saveState({
    lastError: `Не отправлено (попыток: ${entry.attempts}): ${error.message}`
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OUTBOX_ALARM) flushOutbox();
  if (alarm.name === CLAIM_ALARM) releaseStaleClaim();
});

// ─── Sessiya tugashi va bloklangan akkaunt ───────────────────────────────────

async function haltOnApiError(error) {
  await saveState({
    running: false,
    stage: STAGE.IDLE,
    blocked: Boolean(error?.isBlocked),
    lastError: error?.isBlocked
      ? `Аккаунт заблокирован — обратитесь к администратору. ${error.message}`
      : 'Сессия истекла — войдите заново'
  });
}

// ─── Band qilish muddati (TTL) ───────────────────────────────────────────────

function armClaimTimer() {
  chrome.alarms.create(CLAIM_ALARM, { delayInMinutes: CLAIM_TTL_MINUTES });
}

function disarmClaimTimer() {
  chrome.alarms.clear(CLAIM_ALARM);
}

/** Operator captcha'da qotib qoldi — qatorni navbatga qaytaramiz. */
async function releaseStaleClaim() {
  const state = await loadState();
  if (!state.current) return;

  const settings = await loadSettings();
  try {
    await self.MibApi.releaseTask(settings, state.current.id, 'captcha_abandoned');
  } catch {
    // Qaytarolmadik — backend 30 daqiqada o'zi bo'shatadi.
  }

  await saveState({
    current: null,
    stage: STAGE.IDLE,
    lastError: `Ожидание ${CLAIM_TTL_MINUTES} мин — запись возвращена в очередь`
  });
}

// ─── Content script buyruqlari ───────────────────────────────────────────────

const handlers = {
  async getState() {
    const [state, settings, outbox, deadLetter] = await Promise.all([
      loadState(),
      loadSettings(),
      readOutbox(),
      readDeadLetter()
    ]);
    return {
      state,
      configured: Boolean(settings.apiBase && settings.token),
      delayMs: settings.delayMs,
      resultTimeoutMs: settings.resultTimeoutMs,
      outboxSize: outbox.length,
      deadLetterSize: deadLetter.length
    };
  },

  async getSettings() {
    return loadSettings();
  },

  /** Navbatdagi keyingi qarzdor. Navbat bo'sh bo'lsa ish to'xtaydi. */
  async fetchNext() {
    const settings = await loadSettings();
    try {
      const task = await self.MibApi.fetchNext(settings);

      if (!task) {
        disarmClaimTimer();
        await saveState({ running: false, stage: STAGE.IDLE, current: null, lastError: null });
        return { done: true };
      }

      // `queue_total` — navbatning UMUMIY hajmi (bajarilgan + qolgan),
      // `queue_position` — nechanchisi ustida ishlanyapti (MIB_BACKEND.md FARQ 3).
      await saveState({
        current: {
          id: task.id,
          pinfl: task.pinfl,
          debtor_name: task.debtor_name || null,
          claimedAt: new Date().toISOString()
        },
        progress: { position: task.queue_position || 0, total: task.queue_total || 0 },
        stage: STAGE.AWAITING_CAPTCHA,
        lastError: null
      });
      armClaimTimer();

      return { task };
    } catch (error) {
      if (error instanceof ApiError && (error.isAuthError || error.isBlocked)) {
        await haltOnApiError(error);
        return error.isBlocked ? { blocked: true, error: error.message } : { authError: true };
      }
      await saveState({ lastError: error.message });
      return {
        error: error.message,
        // 409 claim_failed — boshqa operator bilan to'qnashuv, kutib qayta so'raymiz.
        retryable:
          error instanceof ApiError && (error.isRetryable || error.isClaimConflict),
        retryAfterMs: error instanceof ApiError ? error.retryAfterMs : null
      };
    }
  },

  /**
   * Natijani yuboradi. Yuborilmasa buferga tushadi va `buffered: true` qaytadi —
   * content script baribir keyingi qatorga o'tadi, ma'lumot yo'qolmaydi.
   */
  async submitResult({ payload, stats }) {
    const settings = await loadSettings();
    disarmClaimTimer();

    // Bufer bo'sh bo'lmasa tartibni buzmaymiz.
    const outbox = await readOutbox();
    if (outbox.length) {
      await enqueue(payload);
      await bumpStats(stats);
      flushOutbox();
      return { buffered: true };
    }

    try {
      const response = await self.MibApi.postResult(settings, payload);
      await bumpStats(stats);
      await saveState({ current: null, stage: STAGE.RESULT_SENT, lastError: null });
      return { ok: true, response };
    } catch (error) {
      if (error instanceof ApiError && (error.isAuthError || error.isBlocked)) {
        await haltOnApiError(error);
        return error.isBlocked ? { blocked: true, error: error.message } : { authError: true };
      }

      // Qayta yuborish yordam bermaydigan xato — buferga solmaymiz, chunki u
      // yerda abadiy aylanadi. Ma'lumot dead-letter'ga yoziladi.
      if (error instanceof ApiError && error.isPermanent) {
        await bumpStats(stats);
        await recordDeadLetter({ payload, attempts: 1 }, error);
        await saveState({ current: null, stage: STAGE.RESULT_SENT });
        return {
          rejected: true,
          error: error.message,
          snapshotId: error.snapshotId,
          // 422 + snapshot_id = sahifa backendda saqlangan, yo'qolmadi.
          saved: Boolean(error.snapshotId)
        };
      }

      await enqueue(payload);
      await bumpStats(stats);
      await saveState({
        current: null,
        stage: STAGE.RESULT_SENT,
        lastError: `Buferga yozildi: ${error.message}`
      });
      return { buffered: true, error: error.message };
    }
  },

  async releaseCurrent({ reason }) {
    const settings = await loadSettings();
    const state = await loadState();
    disarmClaimTimer();
    if (!state.current) return { ok: true };

    try {
      await self.MibApi.releaseTask(settings, state.current.id, reason || 'operator_stopped');
    } catch {
      // Qaytarolmadik — backend timeout bo'yicha o'zi bo'shatadi.
    }
    await saveState({ current: null, stage: STAGE.IDLE });
    return { ok: true };
  },

  async start() {
    const settings = await loadSettings();
    if (!settings.apiBase || !settings.token) {
      return { error: 'Сначала настройте API и вход на странице настроек' };
    }
    await saveState({
      running: true,
      stage: STAGE.FETCHING,
      lastError: null,
      blocked: false,
      startedAt: new Date().toISOString()
    });
    flushOutbox();
    return { ok: true };
  },

  async stop() {
    await handlers.releaseCurrent({ reason: 'operator_stopped' });
    await saveState({ running: false, stage: STAGE.IDLE });
    return { ok: true };
  },

  async reset() {
    await resetState();
    return { ok: true };
  },

  /** Faqat hisoblagichlar — joriy qator va bufer saqlanadi. */
  async resetStats() {
    await saveState({
      stats: { found: 0, notFound: 0, parseError: 0, captchaRetries: 0 },
      lastError: null
    });
    return { ok: true };
  },

  async setStage({ stage }) {
    await saveState({ stage });
    return { ok: true };
  },

  async reportError({ message }) {
    await saveState({ lastError: message });
    return { ok: true };
  },

  /** `login` — telefon raqami (MIB_BACKEND.md FARQ 1). */
  async login({ apiBase, login: username, password }) {
    try {
      const data = await self.MibApi.login(apiBase, username, password);
      await self.MibConfig.saveSettings({
        apiBase,
        token: data.token,
        operator: data.operator || null
      });
      // `expires_at` ataylab saqlanmaydi — u doim null, muddat yo'q (FARQ 2).
      await saveState({ blocked: false, lastError: null });
      return { ok: true, operator: data.operator || null };
    } catch (error) {
      if (error instanceof ApiError && error.isBlocked) {
        await saveState({ blocked: true, lastError: error.message });
        return { blocked: true, error: error.message };
      }
      return { error: error.message };
    }
  },

  /**
   * Ko'p sahifali natija yig'iladi: har sahifa alohida navigatsiya, content
   * script esa har safar o'ladi. Shuning uchun oraliq holat shu yerda.
   */
  async collectPage({ id, page, cases, totals, html }) {
    const store = (await chrome.storage.local.get(STORAGE_KEYS.collect))[STORAGE_KEYS.collect];
    const fresh = !store || store.id !== id;
    const next = fresh ? { id, pages: [], visits: 0 } : store;

    // Bir sahifa ikki marta kelsa (reload, orqaga qaytish) — ustiga yoziladi.
    const duplicate = next.pages.some((item) => item.page === page);
    next.pages = next.pages.filter((item) => item.page !== page);
    next.pages.push({ page, cases, totals, html });
    next.pages.sort((a, b) => a.page - b.page);

    // `pages` takrorlanishda o'smaydi — cheksiz siklni aynan `visits` ushlaydi.
    next.visits = (next.visits || 0) + 1;

    await chrome.storage.local.set({ [STORAGE_KEYS.collect]: next });
    return { ok: true, pages: next.pages.length, visits: next.visits, duplicate };
  },

  /** Yig'ilganini qaytaradi va buferni tozalaydi. */
  async takeCollected({ id }) {
    const store = (await chrome.storage.local.get(STORAGE_KEYS.collect))[STORAGE_KEYS.collect];
    await chrome.storage.local.remove(STORAGE_KEYS.collect);
    if (!store || store.id !== id) return { pages: [] };
    return { pages: store.pages };
  },

  async clearCollected() {
    await chrome.storage.local.remove(STORAGE_KEYS.collect);
    return { ok: true };
  },

  async getDeadLetter() {
    return { items: await readDeadLetter() };
  },

  /** Operator dead-letter'dagi natijalarni qo'lda qayta yuborishi mumkin. */
  async retryDeadLetter() {
    const items = await readDeadLetter();
    const resendable = items.filter((item) => item.payload);
    if (!resendable.length) return { ok: true, requeued: 0 };

    const outbox = await readOutbox();
    for (const item of resendable) {
      outbox.push({ payload: item.payload, attempts: 0, queuedAt: new Date().toISOString() });
    }
    await writeOutbox(outbox);
    await chrome.storage.local.set({
      [STORAGE_KEYS.deadLetter]: items.filter((item) => !item.payload)
    });

    flushOutbox();
    return { ok: true, requeued: resendable.length };
  },

  async flush() {
    await flushOutbox();
    return { ok: true, outboxSize: (await readOutbox()).length };
  }
};

async function bumpStats(delta) {
  if (!delta) return;
  const state = await loadState();
  const stats = { ...state.stats };
  for (const [key, value] of Object.entries(delta)) {
    stats[key] = (stats[key] || 0) + value;
  }
  await saveState({ stats });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ error: `Неизвестная команда: ${message?.type}` });
    return false;
  }

  handler(message.payload || {})
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));

  return true; // asinxron javob
});

chrome.runtime.onStartup.addListener(flushOutbox);
chrome.runtime.onInstalled.addListener(flushOutbox);
