/** Options: backend, kirish, ish tartibi, selektorlar. */
(function () {
  'use strict';

  const { DEFAULT_SELECTORS, loadSettings, saveSettings } = self.MibConfig;

  const el = (id) => document.getElementById(id);

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (response) =>
        resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : response || {})
      );
    });
  }

  function flash(node, message, isError = false) {
    node.textContent = message;
    node.classList.toggle('hint--error', isError);
    if (!isError) setTimeout(() => (node.textContent = ''), 2500);
  }

  /** Selektorlarni tahrirlash maydonlari. */
  function renderSelectors(selectors) {
    const container = el('selectors');
    container.innerHTML = '';

    for (const [key, value] of Object.entries({ ...DEFAULT_SELECTORS, ...selectors })) {
      const row = document.createElement('label');
      row.className = 'field field--inline';
      row.innerHTML = `<span>${key}</span>`;

      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.selectorKey = key;
      input.value = value;
      input.spellcheck = false;

      row.appendChild(input);
      container.appendChild(row);
    }
  }

  function collectSelectors() {
    const result = {};
    for (const input of document.querySelectorAll('[data-selector-key]')) {
      const value = input.value.trim();
      if (value) result[input.dataset.selectorKey] = value;
    }
    return result;
  }

  function renderAuth(settings) {
    el('auth-status').textContent = settings.token
      ? `Вход выполнен${settings.operator ? `: ${settings.operator.name}` : ''}`
      : 'Вход не выполнен';
  }

  async function load() {
    const settings = await loadSettings();

    el('api-base').value = settings.apiBase;
    el('delay-ms').value = settings.delayMs;
    el('result-timeout').value = settings.resultTimeoutMs;
    el('max-retries').value = settings.maxRetries;
    el('compress-html').checked = settings.compressRawHtml;
    el('auto-submit').checked = settings.autoSubmit;
    el('auto-submit-delay').value = settings.autoSubmitDelayMs;
    el('pause-on-parse-error').checked = settings.pauseOnParseError;

    renderSelectors(settings.selectors);
    renderAuth(settings);
  }

  /**
   * Backend mib.uz'dan boshqa domenda — MV3 uchun alohida ruxsat kerak.
   * Foydalanuvchi saqlaganda so'raladi.
   */
  async function ensureHostPermission(apiBase) {
    let origin;
    try {
      origin = `${new URL(apiBase).origin}/*`;
    } catch {
      return { error: 'Неверный адрес API' };
    }

    if (await chrome.permissions.contains({ origins: [origin] })) return { ok: true };

    const granted = await chrome.permissions.request({ origins: [origin] });
    return granted ? { ok: true } : { error: `Доступ к ${origin} не разрешен` };
  }

  el('save').addEventListener('click', async () => {
    const apiBase = el('api-base').value.trim();

    if (apiBase) {
      const permission = await ensureHostPermission(apiBase);
      if (permission.error) {
        flash(el('save-status'), permission.error, true);
        return;
      }
    }

    await saveSettings({
      apiBase,
      delayMs: Number(el('delay-ms').value) || 1000,
      resultTimeoutMs: Number(el('result-timeout').value) || 20000,
      maxRetries: Number(el('max-retries').value) || 5,
      compressRawHtml: el('compress-html').checked,
      autoSubmit: el('auto-submit').checked,
      autoSubmitDelayMs: Number(el('auto-submit-delay').value) || 3000,
      pauseOnParseError: el('pause-on-parse-error').checked,
      selectors: collectSelectors()
    });

    flash(el('save-status'), 'Сохранено');
  });

  el('do-login').addEventListener('click', async () => {
    const apiBase = el('api-base').value.trim();
    const login = el('login').value.trim();
    const password = el('password').value;

    if (!apiBase || !login || !password) {
      flash(el('auth-status'), 'Заполните адрес API, номер телефона и пароль', true);
      return;
    }

    const permission = await ensureHostPermission(apiBase);
    if (permission.error) {
      flash(el('auth-status'), permission.error, true);
      return;
    }

    const response = await send('login', { apiBase, login, password });

    if (response.error) {
      flash(el('auth-status'), response.error, true);
      return;
    }

    el('password').value = '';
    await load();
    flash(el('auth-status'), 'Вход выполнен');
  });

  el('do-logout').addEventListener('click', async () => {
    await saveSettings({ token: '', operator: null });
    await send('stop');
    await load();
  });

  el('reset-selectors').addEventListener('click', () => {
    renderSelectors(DEFAULT_SELECTORS);
    flash(el('save-status'), 'Установлены стандартные селекторы — нажмите Сохранить');
  });

  load();
})();
