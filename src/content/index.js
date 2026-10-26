/**
 * Content script — holat mashinasi.
 *
 * Muhim: "topildi" holatida mib.uz to'liq yangi sahifaga o'tadi va bu skript
 * o'ladi. Shuning uchun holat HECH QACHON JS o'zgaruvchisida saqlanmaydi —
 * faqat chrome.storage.local da (background orqali).
 */
(async function () {
  'use strict';

  const { PAGE, STAGE } = self.MibConfig;
  const Overlay = self.MibOverlay;
  const Parser = self.MibParser;

  let settings = null;
  let session = null;      // background'dagi holatning joriy nusxasi
  let resultTimer = null;
  let busy = false;        // bir vaqtda bitta holat qayta ishlanadi
  let autoSubmitTimer = null;
  let submitting = false;  // "Қидириш" bosildi, javob kutilyapti

  // ─── Background bilan aloqa ────────────────────────────────────────────────

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || {});
      });
    });
  }

  // ─── Yordamchi ─────────────────────────────────────────────────────────────

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Wicket qiymatni faqat haqiqiy foydalanuvchi hodisalari bilan qabul qiladi.
   * `no-copy-paste` klassi tufayli paste ishlamaydi — value + event ishlatamiz.
   */
  function setInputValue(input, value) {
    if (!input) return false;
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /**
   * Yig'ilgan sahifalarni bitta HTML'ga birlashtiradi.
   * Ajratgich saqlanadi — backendda sahifalarni qayta ajratish mumkin bo'lsin.
   */
  function packRawHtml(pages) {
    const html = pages
      .map((page) => `<!-- MIB-PAGE ${page.page} -->\n${page.html}`)
      .join('\n');
    return compressHtml(html);
  }

  /** To'liq sahifa HTML — CLAUDE.md 1-qoidasi, dalil sifatida majburiy. */
  async function captureRawHtml() {
    return compressHtml(document.documentElement.outerHTML);
  }

  async function compressHtml(html) {
    if (!settings.compressRawHtml || typeof CompressionStream === 'undefined') {
      return { raw_html: html, raw_html_encoding: 'plain' };
    }

    try {
      const stream = new Blob([html]).stream().pipeThrough(new CompressionStream('gzip'));
      const buffer = await new Response(stream).arrayBuffer();
      const bytes = new Uint8Array(buffer);

      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }

      return { raw_html: btoa(binary), raw_html_encoding: 'gzip+base64' };
    } catch {
      // Siqish ishlamasa ham HTML yo'qolmaydi.
      return { raw_html: html, raw_html_encoding: 'plain' };
    }
  }

  // ─── Sahifa turini aniqlash ────────────────────────────────────────────────

  /** Ishlangan feedback xabarlari qayta hisoblanmasligi uchun belgilanadi. */
  function freshFeedback() {
    return $$(settings.selectors.feedbackItem).filter((li) => !li.dataset.mibHandled);
  }

  function markFeedbackHandled() {
    for (const li of $$(settings.selectors.feedbackItem)) li.dataset.mibHandled = '1';
  }

  function detectPage() {
    const { selectors } = settings;

    if ($(selectors.totalsTable)) return PAGE.FOUND;

    const feedback = freshFeedback();
    if (feedback.some((li) => li.classList.contains(selectors.feedbackError))) {
      return PAGE.CAPTCHA_FAILED;
    }
    if (feedback.some((li) => li.classList.contains(selectors.feedbackWarning))) {
      return PAGE.NOT_FOUND;
    }

    if ($(selectors.pinflInput)) return PAGE.FORM;

    return PAGE.UNKNOWN;
  }

  /**
   * Captcha maydoniga fokus.
   *
   * Bir marta `focus()` yetmaydi: Wicket sahifani yuklab bo'lgach fokusni
   * `body` ga qaytaradi, shuning uchun bir necha marta takrorlanadi. Operator
   * boshqa maydonga o'tib olgan bo'lsa tortib olinmaydi.
   */
  function focusCaptcha(captcha) {
    const attempt = () => {
      const active = document.activeElement;
      // Faqat operator boshqa maydonga matn yozayotgan bo'lsa tegmaymiz.
      // Submit tugmasi, body, havola — bularda fokus "bo'sh" hisoblanadi
      // (AJAX javobdan keyin fokus aynan tugmada qoladi).
      const typing =
        active &&
        active !== captcha &&
        (active.tagName === 'TEXTAREA' ||
          (active.tagName === 'INPUT' && !/^(submit|button|checkbox|radio)$/i.test(active.type)) ||
          active.isContentEditable);

      if (!typing && document.contains(captcha)) captcha.focus();
    };

    attempt();
    for (const delay of [150, 500, 1200]) setTimeout(attempt, delay);
  }

  /** ЖШШИР formasi va uning ichidagi maydonlar. */
  function pinflForm() {
    const input = $(settings.selectors.pinflInput);
    return input ? input.form : null;
  }

  function captchaInput() {
    const form = pinflForm();
    return form ? form.querySelector(settings.selectors.captchaInput) : null;
  }

  function submitButton() {
    const form = pinflForm();
    return form ? form.querySelector(settings.selectors.submitButton) : null;
  }

  // ─── Ko'rinish ─────────────────────────────────────────────────────────────

  function paint(tone, status, extra = {}) {
    Overlay.render({
      tone,
      status,
      running: session?.running,
      pinfl: session?.current?.pinfl || '',
      name: session?.current?.debtor_name || '',
      progress: session?.progress,
      stats: session?.stats,
      error: session?.lastError,
      ...extra
    });
  }

  async function refreshSession() {
    const response = await send('getState');
    session = response.state || null;
    settings = settings || (await send('getSettings'));
    return response;
  }

  // ─── Holatlar ──────────────────────────────────────────────────────────────

  /** Forma sahifasi: PINFL to'ldiriladi, captcha operatorga qoldiriladi. */
  async function handleForm() {
    if (!session.current) {
      paint('busy', 'Получаем должника из очереди…');

      const response = await send('fetchNext');

      if (response.done) {
        await refreshSession();
        paint('done', 'Очередь пуста — все проверено');
        return;
      }
      if (response.authError) {
        await refreshSession();
        paint('error', 'Сессия истекла — войдите заново');
        return;
      }
      if (response.blocked) {
        await refreshSession();
        paint('error', 'Аккаунт заблокирован — обратитесь к администратору');
        return;
      }
      if (response.error) {
        await refreshSession();
        paint('error', 'Сервер не ответил');
        // Tarmoq uzilishi, 429 limit yoki 409 claim to'qnashuvi — qayta urinamiz.
        if (response.retryable) {
          await sleep(response.retryAfterMs || 5000);
          if (session.running) handleForm();
        }
        return;
      }

      await refreshSession();
    }

    // Bootstrap tab — client-side, captcha yangilanmaydi, kutish shart emas.
    $(settings.selectors.pinflTab)?.click();

    // Forma maydoni yo'qligi MIB javobi emas — natija yozilmaydi, qator
    // navbatda qoladi. Operator sahifani to'g'rilaydi yoki selektorni yangilaydi.
    const input = $(settings.selectors.pinflInput);
    if (!input) {
      await send('reportError', { message: 'Поле ЖШШИР не найдено — селектор устарел' });
      await refreshSession();
      paint('error', 'Поле ЖШШИР не найдено — селектор устарел');
      return;
    }

    setInputValue(input, session.current.pinfl);

    const captcha = captchaInput();
    if (!captcha) {
      await send('reportError', { message: 'Поле капчи не найдено — селектор устарел' });
      await refreshSession();
      paint('error', 'Поле капчи не найдено — селектор устарел');
      return;
    }

    captcha.value = '';
    submitting = false;
    Overlay.highlightCaptcha(captcha);
    focusCaptcha(captcha);

    await send('setStage', { stage: STAGE.AWAITING_CAPTCHA });
    armCaptcha();

    paint('waiting', 'Введите капчу и нажмите Enter');
  }

  /**
   * Operator captcha'ni terib Enter bosadi → biz "Қидириш" ni bosamiz.
   * Formaning o'z Enter-submit'i ikki marta yubormasligi uchun to'xtatiladi.
   *
   * Wicket AJAX javobdan keyin captcha input'ini YANGI element bilan
   * almashtiradi — shuning uchun "o'rnatilgan" belgisi global emas, aynan
   * elementda saqlanadi. Aks holda ikkinchi qidiruvda Enter ishlamay qoladi.
   */
  function armCaptcha() {
    const captcha = captchaInput();
    if (!captcha || captcha.dataset.mibArmed) return;

    captcha.addEventListener('keydown', onCaptchaKeydown);
    if (settings.autoSubmit) captcha.addEventListener('input', onCaptchaInput);
    captcha.dataset.mibArmed = '1';
  }

  function onCaptchaKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(autoSubmitTimer);
    triggerSearch();
  }

  /**
   * Enter kutmasdan yuborish.
   *
   * Javob to'liq (ikki xonali) bo'lsa darhol, bir xonali bo'lsa — operator
   * ikkinchi raqamni terishi mumkin, shuning uchun pauza bilan.
   */
  function onCaptchaInput(event) {
    clearTimeout(autoSubmitTimer);

    const value = event.target.value.trim();
    if (!/^\d+$/.test(value)) return;

    const delay = value.length >= settings.captchaFullLength ? 0 : settings.autoSubmitDelayMs;

    autoSubmitTimer = setTimeout(() => {
      // Oraliqda o'zgargan bo'lsa yangi taymer allaqachon ishlaydi.
      if (event.target.value.trim() !== value) return;
      triggerSearch();
    }, delay);
  }

  async function triggerSearch() {
    const captcha = captchaInput();
    if (!captcha || !captcha.value.trim()) {
      paint('waiting', 'Сначала введите ответ на капчу');
      return;
    }

    // Enter va avtomatik yuborish bir vaqtda kelib qolmasin.
    if (submitting) return;
    submitting = true;
    clearTimeout(autoSubmitTimer);

    Overlay.clearHighlight(captcha);
    await send('setStage', { stage: STAGE.SUBMITTED });
    paint('busy', 'Идет поиск…');

    awaitResult();
    submitButton()?.click();
  }

  /**
   * Doimiy kuzatuvchi.
   *
   * "Topildi" — to'liq sahifa yuklanadi (bu skript o'ladi, yangisi ishlaydi).
   * "Topilmadi" va "captcha xato" — AJAX, sahifa o'zgarmaydi.
   *
   * Natija paneli har doim ham biz "Қидириш" bosgandan keyin kelmaydi:
   * Wicket uni sahifa yuklangandan keyin ham qo'shishi mumkin, operator esa
   * tugmani o'zi bosishi mumkin. Shu sababli sahifa turini butun umr
   * kuzatamiz — aks holda natija jim o'tib ketadi (CLAUDE.md 2-qoida).
   */
  function watchPage() {
    let timer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (busy || !session?.running) return;

        const page = detectPage();
        if (page === PAGE.FORM || page === PAGE.UNKNOWN) return;
        // FOUND sahifasi allaqachon qayta ishlangan — takror yubormaymiz.
        if (page === PAGE.FOUND && session.stage === STAGE.RESULT_SENT) return;

        await guard(() => route(page));
      }, 150);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  /** Bir vaqtda bitta oqim — observer va boot bir-birini takrorlamasin. */
  async function guard(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  }

  /** Natija kelmasa operatorga aytamiz. Natijani `watchPage` ushlaydi. */
  function awaitResult() {
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      paint('error', 'Ответ не пришел — обновите страницу');
    }, settings.resultTimeoutMs);
  }

  /**
   * Qarzdorlik topildi.
   *
   * Ijro hujjatlari 10 tadan sahifalanadi, har sahifa alohida navigatsiya —
   * bu skript o'ladi. Shuning uchun har sahifa background buferiga yoziladi,
   * oxirgi sahifada hammasi birlashtirilib bir marta yuboriladi. Aks holda
   * kartalar yig'indisi umumiy qarzga teng chiqmaydi (`amount_mismatch`).
   */
  async function handleFound() {
    if (session.stage === STAGE.RESULT_SENT || !session.current) {
      // Natija allaqachon yuborilgan (sahifa qayta yuklangan) — davom etamiz.
      clickRepeatSearch();
      return;
    }

    // Sahifadagi yangiliklar tickeri DOM'ni tinimsiz o'zgartiradi va kuzatuvchini
    // qayta-qayta uyg'otadi. Har hujjat faqat bir marta o'qiladi.
    if (document.documentElement.dataset.mibFoundHandled) return;
    document.documentElement.dataset.mibFoundHandled = '1';

    const pagination = Parser.parsePagination(document, settings.selectors);
    paint('busy', pagination.last > 1
      ? `Читаем результат… (страница ${pagination.current}/${pagination.last})`
      : 'Читаем результат…');

    const collected = await send('collectPage', {
      id: session.current.id,
      page: pagination.current,
      cases: Parser.parsePageCases(document, settings),
      totals: Parser.parseTotals(document, settings.selectors),
      // Sahifalar oxirida birlashtirilib bir marta siqiladi.
      html: document.documentElement.outerHTML
    });

    // Cheksiz siklga qarshi ikki qulf:
    //   duplicate — shu sahifa allaqachon o'qilgan (pagination noto'g'ri o'qilgan),
    //   visits    — umumiy tashriflar soni, takrorlanish bo'lsa ham o'sadi.
    const looping = collected.duplicate || collected.visits > settings.maxResultPages;

    if (pagination.nextLink && !looping) {
      pagination.nextLink.click();
      return;
    }

    if (pagination.nextLink) {
      await send('reportError', {
        message: collected.duplicate
          ? `Пагинация зациклилась (страница ${pagination.current}) — сбор остановлен`
          : `Превышен лимит страниц (${settings.maxResultPages})`
      });
    }

    await finishFound(pagination);
  }

  /** Yig'ilgan sahifalarni birlashtirib tekshiradi va yuboradi. */
  async function finishFound(pagination) {
    const { pages } = await send('takeCollected', { id: session.current.id });

    const cases = pages
      .flatMap((page) => page.cases)
      .map((item, index) => ({ ...item, position: index + 1 }));

    // Umumiy jadval har sahifada bir xil — birinchisini olamiz.
    const totals = pages.find((page) => page.totals)?.totals || null;
    const parsed = Parser.buildResult(totals, cases, Parser.findPageDate(document));

    const raw = await packRawHtml(pages);

    if (!parsed.ok) {
      const diag = `parse_error: ${parsed.error} (sahifa: ${pages.length}, `
        + `kartalar: ${cases.length}, umumiy: ${totals?.total_debt ?? '—'})`;
      console.error('[MIB] parse_error', parsed.error, parsed.details || {}, { pages: pages.length });

      // CLAUDE.md 2-qoidasi: jim o'tkazib yuborish yo'q.
      await submit(
        {
          id: session.current.id,
          pinfl: session.current.pinfl,
          status: 'parse_error',
          checked_at: new Date().toISOString(),
          source_url: location.href,
          parse_error: parsed.error,
          parse_details: parsed.details || null,
          ...raw
        },
        { parseError: 1 }
      );

      // Yuborishdan KEYIN — submitResult muvaffaqiyatli bo'lsa lastError'ni tozalaydi.
      await send('reportError', { message: diag });
      await refreshSession();

      paint('error', `Страница не прочитана: ${parsed.error}`);

      // Sahifada to'xtaymiz — operator sababni o'z ko'zi bilan ko'rsin.
      // Davom etish uchun "O'tkazib yuborish" bosiladi.
      if (settings.pauseOnParseError) return;

      await sleep(settings.delayMs);
      clickRepeatSearch();
      return;
    }

    await submit(
      {
        id: session.current.id,
        pinfl: session.current.pinfl,
        status: 'found',
        ...parsed.data,
        checked_at: parsed.data.checked_at || new Date().toISOString(),
        source_url: location.href,
        ...raw
      },
      { found: 1 }
    );

    paint('busy', `Найдено: ${parsed.data.cases_count} исполнительных документов`
      + (pagination.last > 1 ? ` (страниц: ${pagination.last})` : ''));
    await sleep(settings.delayMs);
    clickRepeatSearch();
  }

  /** Qarzdorlik yo'q: yuborish → maydonlarni tozalash → keyingisiga. */
  async function handleNotFound() {
    if (!session.current) {
      console.warn('[MIB] not_found, lekin navbatda qator yo\'q — yuborilmadi');
      markFeedbackHandled();
      return;
    }

    const message = Parser.parseNotFoundMessage(document, settings);
    const raw = await captureRawHtml();

    await submit(
      {
        id: session.current.id,
        pinfl: session.current.pinfl,
        status: 'not_found',
        checked_at: new Date().toISOString(),
        source_url: location.href,
        message: message?.text || null,
        ...raw
      },
      { notFound: 1 }
    );

    markFeedbackHandled();
    paint('busy', 'Задолженность не найдена');

    // Sahifa qayta yuklanmagan — maydonlarni o'zimiz tozalaymiz.
    setInputValue($(settings.selectors.pinflInput), '');
    const captcha = captchaInput();
    if (captcha) captcha.value = '';

    await sleep(settings.delayMs);
    await refreshSession();
    if (session.running) handleForm();
  }

  /**
   * Captcha xato: backendga HECH NARSA yuborilmaydi, qator navbatda qoladi
   * (CLAUDE.md 3-qoidasi). PINFL Wicket tomonidan saqlanadi.
   */
  async function handleCaptchaFailed() {
    markFeedbackHandled();

    const captcha = captchaInput();
    if (captcha) {
      captcha.value = '';
      submitting = false;
      Overlay.highlightCaptcha(captcha);
      focusCaptcha(captcha);
    }

    // PINFL yo'qolgan bo'lsa qayta yozamiz.
    const input = $(settings.selectors.pinflInput);
    if (input && session.current && input.value !== session.current.pinfl) {
      setInputValue(input, session.current.pinfl);
    }

    await send('setStage', { stage: STAGE.AWAITING_CAPTCHA });
    session.stats = { ...session.stats, captchaRetries: (session.stats?.captchaRetries || 0) + 1 };

    armCaptcha();
    paint('waiting', 'Капча неверна — введите заново');
  }

  /**
   * Sahifa tanilmadi.
   *
   * MUHIM: bu o'z-o'zidan xato EMAS. Operator mib.uz'ning boshqa sahifasiga
   * o'tsa (bosh sahifa, yangiliklar) ham shu holat chiqadi. Faqat qidiruv
   * YUBORILGANDAN keyin sahifa tanilmasa — bu haqiqiy nosozlik.
   */
  async function handleUnknown() {
    if (!session.current || session.stage !== STAGE.SUBMITTED) {
      paint('error', 'Страница не распознана — откройте "Қарздорликни текшириш"');
      return;
    }
    await fail('unknown_page', 'Qidiruvdan keyin sahifa tanilmadi — mib.uz o\'zgargan bo\'lishi mumkin');
  }

  /** Natijani backendga uzatadi. Yuborilmasa buferga tushadi, ish to'xtamaydi. */
  async function submit(payload, stats) {
    const response = await send('submitResult', { payload, stats });
    console.log('[MIB] submitResult', payload.status, payload.pinfl, response);

    if (response.authError) {
      await refreshSession();
      paint('error', 'Сессия истекла — войдите заново');
      return false;
    }

    if (response.blocked) {
      await refreshSession();
      paint('error', 'Аккаунт заблокирован — обратитесь к администратору');
      return false;
    }

    // 422/404/409 — backend qabul qilmadi. Ish to'xtamaydi: `saved` bo'lsa
    // sahifa backendda snapshot sifatida saqlangan, aks holda dead-letter'da.
    if (response.rejected) {
      await refreshSession();
      paint(
        'error',
        response.saved
          ? `Сервер отклонил, страница сохранена (snapshot ${response.snapshotId}): ${response.error}`
          : `Сервер отклонил: ${response.error}`
      );
      return true;
    }

    await refreshSession();
    return true;
  }

  /** Parse qilib bo'lmagan holat: yozib qo'yamiz va keyingisiga o'tamiz. */
  async function fail(code, message) {
    if (session.current) {
      const raw = await captureRawHtml();
      await submit(
        {
          id: session.current.id,
          pinfl: session.current.pinfl,
          status: 'parse_error',
          checked_at: new Date().toISOString(),
          source_url: location.href,
          parse_error: code,
          ...raw
        },
        { parseError: 1 }
      );
    }
    await send('reportError', { message });
    await refreshSession();
    paint('error', message);
  }

  function clickRepeatSearch() {
    const link = $$(settings.selectors.repeatSearchLink).find((a) =>
      /такрорий/i.test(a.textContent)
    );

    if (link) {
      link.click();
      return;
    }

    // Havola topilmasa qidiruv sahifasiga o'zimiz qaytamiz.
    paint('error', '"Такрорий қидирув" не найден — откройте страницу поиска');
  }

  // ─── Marshrutlash ──────────────────────────────────────────────────────────

  async function route(page) {
    clearTimeout(resultTimer);
    console.log('[MIB] route', page, {
      stage: session?.stage,
      running: session?.running,
      current: session?.current?.pinfl || null
    });

    switch (page) {
      case PAGE.FOUND:
        return handleFound();
      case PAGE.NOT_FOUND:
        return handleNotFound();
      case PAGE.CAPTCHA_FAILED:
        return handleCaptchaFailed();
      case PAGE.FORM:
        return handleForm();
      default:
        return handleUnknown();
    }
  }

  // ─── Ishga tushirish ───────────────────────────────────────────────────────

  async function boot() {
    settings = await send('getSettings');
    const info = await refreshSession();

    Overlay.build();

    Overlay.onToggle(async () => {
      if (session?.running) {
        await send('stop');
        await refreshSession();
        paint('idle', 'Остановлено');
      } else {
        const response = await send('start');
        if (response.error) {
          await refreshSession();
          paint('error', response.error);
          return;
        }
        await refreshSession();
        await guard(() => route(detectPage()));
      }
    });

    Overlay.onSkip(async () => {
      await send('releaseCurrent', { reason: 'operator_stopped' });
      await refreshSession();
      if (!session.running) return;

      // Natija sahifasida forma yo'q — avval qidiruvga qaytamiz.
      if (detectPage() === PAGE.FOUND) {
        clickRepeatSearch();
        return;
      }
      await guard(() => handleForm());
    });

    if (!info.configured) {
      paint('error', 'Не настроено — войдите на странице настроек');
      return;
    }

    // Kuzatuvchi to'xtatilgan holatda ham o'rnatiladi — operator
    // "Boshlash" bosgach sahifa allaqachon kuzatilayotgan bo'ladi.
    watchPage();

    if (!session.running) {
      paint('idle', 'Остановлено — нажмите "Начать"');
      return;
    }

    await guard(() => route(detectPage()));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
