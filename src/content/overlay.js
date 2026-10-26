/**
 * mib.uz sahifasiga chiziladigan operator paneli.
 * Sahifa har qidiruvda qayta yuklanadi, shuning uchun panel ham qayta chiziladi.
 */
(function (root) {
  'use strict';

  const PANEL_ID = 'mib-ext-panel';

  let elements = null;

  function build() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'mib-ext-panel';
    panel.innerHTML = `
      <div class="mib-ext-head">
        <span class="mib-ext-dot" data-role="dot"></span>
        <span class="mib-ext-title">MIB Result</span>
        <span class="mib-ext-progress" data-role="progress"></span>
      </div>
      <div class="mib-ext-body">
        <div class="mib-ext-status" data-role="status">Загрузка…</div>
        <div class="mib-ext-pinfl" data-role="pinfl"></div>
        <div class="mib-ext-name" data-role="name"></div>
        <div class="mib-ext-error" data-role="error" hidden></div>
      </div>
      <div class="mib-ext-stats" data-role="stats"></div>
      <div class="mib-ext-actions">
        <button type="button" class="mib-ext-btn mib-ext-btn--primary" data-role="toggle">Начать</button>
        <button type="button" class="mib-ext-btn" data-role="skip" hidden>Пропустить</button>
      </div>
    `;

    document.body.appendChild(panel);

    elements = {
      panel,
      dot: panel.querySelector('[data-role="dot"]'),
      progress: panel.querySelector('[data-role="progress"]'),
      status: panel.querySelector('[data-role="status"]'),
      pinfl: panel.querySelector('[data-role="pinfl"]'),
      name: panel.querySelector('[data-role="name"]'),
      error: panel.querySelector('[data-role="error"]'),
      stats: panel.querySelector('[data-role="stats"]'),
      toggle: panel.querySelector('[data-role="toggle"]'),
      skip: panel.querySelector('[data-role="skip"]')
    };

    return elements;
  }

  function ensure() {
    if (!elements || !document.body.contains(elements.panel)) build();
    return elements;
  }

  /**
   * @param {object} view
   * @param {'idle'|'waiting'|'busy'|'error'|'done'} view.tone
   * @param {string} view.status
   */
  function render(view) {
    const el = ensure();

    el.panel.dataset.tone = view.tone || 'idle';
    el.status.textContent = view.status || '';
    el.pinfl.textContent = view.pinfl || '';
    el.name.textContent = view.name || '';

    el.progress.textContent =
      view.progress && view.progress.total
        ? `${view.progress.position}/${view.progress.total}`
        : '';

    if (view.error) {
      el.error.textContent = view.error;
      el.error.hidden = false;
    } else {
      el.error.hidden = true;
    }

    if (view.stats) {
      const { found = 0, notFound = 0, parseError = 0, captchaRetries = 0 } = view.stats;
      const parts = [`найдено: ${found}`, `не найдено: ${notFound}`];
      if (parseError) parts.push(`ошибок: ${parseError}`);
      if (captchaRetries) parts.push(`капча: ${captchaRetries}`);
      el.stats.textContent = parts.join(' · ');
    }

    el.toggle.textContent = view.running ? 'Остановить' : 'Начать';
    el.toggle.classList.toggle('mib-ext-btn--danger', Boolean(view.running));
    el.skip.hidden = !view.running || !view.pinfl;
  }

  function onToggle(handler) {
    ensure().toggle.addEventListener('click', handler);
  }

  function onSkip(handler) {
    ensure().skip.addEventListener('click', handler);
  }

  /** Captcha maydonini ko'zga tashlanadigan qilish. */
  function highlightCaptcha(input) {
    if (!input) return;
    input.classList.add('mib-ext-highlight');
    input.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function clearHighlight(input) {
    input?.classList.remove('mib-ext-highlight');
  }

  root.MibOverlay = { build, render, onToggle, onSkip, highlightCaptcha, clearHighlight };
})(typeof self !== 'undefined' ? self : globalThis);
