/** Popup: joriy holat, boshlash/to'xtatish. */
(function () {
  'use strict';

  const MIB_SEARCH_URL = 'https://mib.uz/home';

  const el = (id) => document.getElementById(id);

  function send(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (response) =>
        resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : response || {})
      );
    });
  }

  function render({ state, configured, outboxSize, deadLetterSize }) {
    const stats = state.stats || {};

    el('status').textContent = !configured
      ? 'Не настроено — откройте настройки'
      : state.blocked
        ? 'Аккаунт заблокирован'
        : state.running
          ? 'Работает'
          : 'Остановлено';

    el('dot').dataset.tone =
      !configured || state.blocked ? 'error' : state.running ? 'busy' : 'idle';

    el('pinfl').textContent = state.current
      ? `${state.current.pinfl}${state.current.debtor_name ? ` — ${state.current.debtor_name}` : ''}`
      : '';

    el('progress').textContent = state.progress?.total
      ? `${state.progress.position}/${state.progress.total}`
      : '';

    el('stat-found').textContent = stats.found || 0;
    el('stat-not-found').textContent = stats.notFound || 0;
    el('stat-parse-error').textContent = stats.parseError || 0;
    el('stat-captcha').textContent = stats.captchaRetries || 0;

    if (state.lastError) {
      el('error').textContent = state.lastError;
      el('error').hidden = false;
    } else {
      el('error').hidden = true;
    }

    // Bufer — hali yuboriladi. Dead-letter — backend rad etgan, qo'l kerak.
    const parts = [];
    if (outboxSize) parts.push(`в буфере ${outboxSize}`);
    if (deadLetterSize) parts.push(`отклонено ${deadLetterSize}`);

    if (parts.length) {
      el('outbox').textContent = `Неотправленные результаты: ${parts.join(', ')}`;
      el('outbox').hidden = false;
    } else {
      el('outbox').hidden = true;
    }

    el('retry-failed').hidden = !deadLetterSize;

    const toggle = el('toggle');
    toggle.textContent = state.running ? 'Остановить' : 'Начать';
    toggle.classList.toggle('btn--danger', Boolean(state.running));
    toggle.disabled = !configured || Boolean(state.blocked);
  }

  async function refresh() {
    render(await send('getState'));
  }

  el('toggle').addEventListener('click', async () => {
    const { state } = await send('getState');
    await send(state.running ? 'stop' : 'start');
    await refresh();
  });

  el('retry-failed').addEventListener('click', async () => {
    const response = await send('retryDeadLetter');
    if (response.requeued) {
      el('outbox').textContent = `${response.requeued} результатов возвращено в очередь`;
    }
    await refresh();
  });

  // Faqat hisoblagichlar — navbatdagi qator va bufer tegilmaydi.
  el('reset-stats').addEventListener('click', async () => {
    await send('resetStats');
    await refresh();
  });

  el('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  el('open-mib').addEventListener('click', async () => {
    const [existing] = await chrome.tabs.query({ url: 'https://mib.uz/*' });
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: MIB_SEARCH_URL });
    }
    window.close();
  });

  refresh();
  setInterval(refresh, 1500);
})();
