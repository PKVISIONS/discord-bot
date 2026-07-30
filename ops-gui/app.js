(function () {
  const listEl = document.getElementById('error-list');
  const emptyEl = document.getElementById('empty');
  const statusEl = document.getElementById('status-line');
  const filterEl = document.getElementById('status-filter');
  const refreshBtn = document.getElementById('btn-refresh');
  const demoBtn = document.getElementById('btn-demo');

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || localStorage.getItem('opsGuiToken') || '';
  if (params.get('token')) {
    localStorage.setItem('opsGuiToken', params.get('token'));
  }

  function apiUrl(path) {
    const url = new URL(path, window.location.origin);
    if (token) url.searchParams.set('token', token);
    return url.toString();
  }

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('error', Boolean(isError));
  }

  function formatWhen(iso) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function statusPill(status) {
    if (status === 'open') return '<span class="pill">Needs attention</span>';
    if (status === 'resolved') return '<span class="pill ok">Fixed</span>';
    return '<span class="pill muted">Dismissed</span>';
  }

  function renderErrors(errors) {
    listEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', errors.length > 0);

    for (const err of errors) {
      const li = document.createElement('li');
      li.className = 'error-card';
      li.dataset.id = err.id;

      const who = err.context?.username
        ? ` · from ${escapeHtml(err.context.username)}`
        : '';

      li.innerHTML = `
        <div class="meta">
          ${statusPill(err.status)}
          <span>${escapeHtml(err.automation || 'Automation')}</span>
          <span>${formatWhen(err.createdAt)}${who}</span>
        </div>
        <h2>${escapeHtml(err.title)}</h2>
        <p class="meaning">${escapeHtml(err.meaning)}</p>
        ${err.detail ? `<pre class="detail">${escapeHtml(err.detail)}</pre>` : ''}
        <div class="actions"></div>
      `;

      const actions = li.querySelector('.actions');
      if (err.status === 'open') {
        if (err.retryable) {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'btn primary';
          retry.textContent = 'Retry';
          retry.addEventListener('click', () => act(err.id, 'retry', retry));
          actions.appendChild(retry);
        }

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'btn ghost';
        dismiss.textContent = 'Dismiss';
        dismiss.addEventListener('click', () => act(err.id, 'dismiss', dismiss));
        actions.appendChild(dismiss);
      }

      listEl.appendChild(li);
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function loadErrors() {
    setStatus('Loading…');
    try {
      const status = filterEl.value;
      const res = await fetch(apiUrl(`/ops/api/errors?status=${encodeURIComponent(status)}`), {
        headers: token ? { 'x-ops-token': token } : {},
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      renderErrors(data.errors || []);
      setStatus(`${(data.errors || []).length} shown · updated ${formatWhen(new Date().toISOString())}`);
    } catch (error) {
      renderErrors([]);
      emptyEl.classList.add('hidden');
      setStatus(error.message || 'Could not load errors', true);
    }
  }

  async function act(id, action, button) {
    button.disabled = true;
    setStatus(action === 'retry' ? 'Retrying…' : 'Dismissing…');
    try {
      const res = await fetch(apiUrl(`/ops/api/errors/${id}/${action}`), {
        method: 'POST',
        headers: token ? { 'x-ops-token': token } : {},
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus(data.message || (action === 'retry' ? 'Retry finished.' : 'Dismissed.'));
      await loadErrors();
    } catch (error) {
      setStatus(error.message || 'Action failed', true);
      button.disabled = false;
      await loadErrors();
    }
  }

  async function addDemo() {
    demoBtn.disabled = true;
    try {
      const res = await fetch(apiUrl('/ops/api/errors/demo'), {
        method: 'POST',
        headers: token ? { 'x-ops-token': token } : {},
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      filterEl.value = 'open';
      setStatus('Sample error added.');
      await loadErrors();
    } catch (error) {
      setStatus(error.message || 'Could not add sample', true);
    } finally {
      demoBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', loadErrors);
  demoBtn.addEventListener('click', addDemo);
  filterEl.addEventListener('change', loadErrors);

  loadErrors();
  setInterval(loadErrors, 15000);
})();
