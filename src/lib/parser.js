/**
 * mib.uz natija sahifasini strukturaga aylantiradi.
 *
 * CLAUDE.md 2-qoidasi: jim o'tkazib yuborish yo'q. Har qanday nomuvofiqlik
 * xato sifatida qaytadi, taxmin qilinmaydi.
 */
(function (root) {
  'use strict';

  /**
   * "68 947 417.64 сўм" → 68947417.64. Nol ham to'g'ri qiymat, null emas.
   * mib.uz raqam ichida oddiy bo'shliq, NBSP va tor NBSP ishlatadi —
   * uchalasi ham hisobga olinadi.
   */
  const AMOUNT_RE = /(\d[\d\s\u00a0\u202f]*(?:[.,]\d{1,2})?)[\s\u00a0\u202f]*сўм/i;
  const SPACE_RE = /[\s\u00a0\u202f]/g;

  function parseAmount(text) {
    if (!text) return null;

    const match = String(text).match(AMOUNT_RE);
    if (!match) return null;

    const cleaned = match[1].replace(SPACE_RE, '').replace(',', '.');
    const value = Number.parseFloat(cleaned);
    return Number.isFinite(value) ? value : null;
  }

  /** "07.08.2026 16:31:11" → ISO. mib.uz vaqti O'zbekiston (UTC+5). */
  function parsePageDate(text) {
    const m = String(text || '').match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+05:00`;
  }

  /**
   * Sahifada sana `<p>07.08.2026 16:31:11</p>` ko'rinishida, alohida klasssiz.
   * Shuning uchun formatga mos birinchi bo'sh (bolasiz) elementni qidiramiz.
   */
  function findPageDate(doc) {
    const nodes = doc.querySelectorAll('p, span, div');
    for (const node of nodes) {
      if (node.children.length) continue;
      const iso = parsePageDate(node.textContent.trim());
      if (iso) return iso;
    }
    return null;
  }

  /** Umumiy / жорий / реестрдаги qarzdorlik. */
  function parseTotals(doc, selectors) {
    const table = doc.querySelector(selectors.totalsTable);
    if (!table) return null;

    const rows = [...table.querySelectorAll('tr')];
    const totals = { total_debt: null, current_debt: null, registry_debt: null };

    for (const row of rows) {
      const cells = [...row.children].map((c) => c.textContent.trim());
      const line = cells.join(' ');
      const amount = parseAmount(line);
      if (amount === null) continue;

      const lower = line.toLowerCase();
      if (lower.includes('умумий')) totals.total_debt = amount;
      else if (lower.includes('жорий')) totals.current_debt = amount;
      else if (lower.includes('реестр')) totals.registry_debt = amount;
    }

    return totals;
  }

  /** Bitta `.black_item` kartani o'qiydi. */
  function parseCase(card, index, settings) {
    const { selectors, fieldMap } = settings;
    const result = { position: index + 1 };
    const unknownKeys = [];

    for (const item of card.querySelectorAll(selectors.caseField)) {
      const keyNode = item.querySelector('span');
      const valueNode = item.querySelector('label');
      if (!keyNode || !valueNode) continue;

      // textContent — innerText emas: CSS text-transform matnni buzadi.
      const rawKey = keyNode.textContent.trim().replace(/\s+/g, ' ').toLowerCase();
      const value = valueNode.textContent.trim().replace(/\s+/g, ' ');

      const mapped = fieldMap[rawKey];
      if (mapped) result[mapped] = value;
      else unknownKeys.push({ key: rawKey, value });
    }

    result.amount = parseAmount(card.querySelector(selectors.caseAmount)?.textContent);

    // Noma'lum kalitni jim tashlamaymiz — backendga yetkazamiz.
    if (unknownKeys.length) result.unknown_fields = unknownKeys;

    return result;
  }

  /**
   * Sahifalash holati.
   *
   * Ijro hujjatlari 10 tadan bo'linadi. JORIY sahifaning havolasi bo'sh
   * (`href=""`), qolganlariniki to'la. Shu bilan joriy sahifa aniqlanadi.
   *
   * @returns {{current: number, last: number, nextLink: Element|null}}
   */
  function parsePagination(doc, selectors) {
    const items = [...doc.querySelectorAll(selectors.paginationItem)];

    const numbered = items
      .map((li) => {
        const link = li.querySelector(selectors.paginationLink);
        const page = Number.parseInt(li.textContent.trim(), 10);
        if (!link || !Number.isFinite(page)) return null;
        return { page, link, isCurrent: !link.getAttribute('href') };
      })
      .filter(Boolean);

    if (!numbered.length) return { current: 1, last: 1, nextLink: null };

    const current = numbered.find((item) => item.isCurrent)?.page ?? 1;
    const last = Math.max(...numbered.map((item) => item.page));
    const next = numbered.find((item) => item.page === current + 1);

    return { current, last, nextLink: next ? next.link : null };
  }

  /**
   * Bitta sahifadagi kartalar. Validatsiya qilinmaydi — ko'p sahifali
   * natijada u faqat hammasi yig'ilgandan keyin ma'noga ega.
   */
  function parsePageCases(doc, settings, offset = 0) {
    const cards = [...doc.querySelectorAll(settings.selectors.caseCard)];
    return cards.map((card, i) => parseCase(card, offset + i, settings));
  }

  /**
   * Yig'ilgan kartalarni tekshiradi va natija tuzilmasini quradi.
   * @returns {{ok: true, data: object} | {ok: false, error: string, details?: object}}
   */
  function buildResult(totals, cases, pageDate) {
    if (!totals) {
      return { ok: false, error: 'totals_table_missing' };
    }
    if (totals.total_debt === null) {
      return { ok: false, error: 'total_debt_unreadable', details: totals };
    }
    if (!cases.length) {
      // Umumiy jadval bor, karta yo'q — sahifa tuzilishi o'zgargan.
      return { ok: false, error: 'no_case_cards' };
    }

    // Majburiy maydonlar tekshiruvi.
    const incomplete = [];
    for (const item of cases) {
      const missing = root.MibConfig.REQUIRED_CASE_FIELDS.filter((f) => !item[f]);
      if (item.amount === null) missing.push('amount');
      if (missing.length) incomplete.push({ position: item.position, missing });
    }
    if (incomplete.length) {
      return { ok: false, error: 'incomplete_cases', details: { incomplete, cases } };
    }

    // Yig'indi umumiy bilan mos kelishi shart — aks holda karta o'qilmay qolgan.
    const sum = cases.reduce((acc, c) => acc + c.amount, 0);
    if (Math.abs(sum - totals.total_debt) > 0.01) {
      return {
        ok: false,
        error: 'amount_mismatch',
        details: { sum: Number(sum.toFixed(2)), total_debt: totals.total_debt, cases }
      };
    }

    const firstCase = cases[0] || {};

    return {
      ok: true,
      data: {
        fio_masked: firstCase.fio || null,
        pinfl_from_page: firstCase.pinfl || null,
        checked_at: pageDate || null,
        ...totals,
        cases_count: cases.length,
        cases: cases.map(({ fio, pinfl, ...rest }) => rest)
      }
    };
  }

  /**
   * Bir sahifali natija — yig'ish oqimisiz to'g'ridan-to'g'ri o'qish.
   * Ko'p sahifada content script `parsePageCases` + `buildResult` ishlatadi.
   */
  function parseResultPage(doc, settings) {
    const totals = parseTotals(doc, settings.selectors);
    const cases = parsePageCases(doc, settings);
    return buildResult(totals, cases, findPageDate(doc));
  }

  /** "Топилмади" xabaridan PINFL ni ajratib oladi — tekshirish uchun. */
  function parseNotFoundMessage(doc, settings) {
    const items = [...doc.querySelectorAll(settings.selectors.feedbackItem)];
    const warning = items.find((li) =>
      li.classList.contains(settings.selectors.feedbackWarning)
    );
    if (!warning) return null;

    const text = warning.textContent.trim().replace(/\s+/g, ' ');
    const pinfl = (text.match(/\b(\d{14})\b/) || [])[1] || null;
    return { text, pinfl };
  }

  root.MibParser = {
    parseAmount,
    parsePageDate,
    findPageDate,
    parseTotals,
    parseCase,
    parsePagination,
    parsePageCases,
    buildResult,
    parseResultPage,
    parseNotFoundMessage
  };
})(typeof self !== 'undefined' ? self : globalThis);
