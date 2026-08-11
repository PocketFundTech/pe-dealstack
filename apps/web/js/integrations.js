const PROVIDER_CATALOG = [
  { id: 'granola',         name: 'Granola',         desc: 'Auto-import meeting transcripts', icon: 'mic',           phase: 1 },
  { id: 'gmail',           name: 'Gmail',           desc: 'Sync deal-related emails',        icon: 'mail',          phase: 2 },
  { id: 'google_calendar', name: 'Google Calendar', desc: 'Pre-meeting briefs & timeline',   icon: 'event',         phase: 3 },
  { id: 'fireflies',       name: 'Fireflies',       desc: 'Auto-import meeting transcripts', icon: 'mic',           phase: 'later' },
  { id: 'otter',           name: 'Otter',           desc: 'Auto-import meeting transcripts', icon: 'graphic_eq',    phase: 'later' },
];

const NAVY = '#003366';

async function authFetch(path, init = {}) {
  if (window.PEAuth?.authFetch) return window.PEAuth.authFetch(path, init);
  return fetch(path, init);
}

function statusBadge(integration) {
  if (!integration) {
    return `<span class="text-xs text-text-muted">Not connected</span>`;
  }
  const colors = {
    connected:       { bg: '#ECFDF5', fg: '#047857', label: 'Connected' },
    token_expired:   { bg: '#FFFBEB', fg: '#92400E', label: 'Reconnect needed' },
    error:           { bg: '#FEF2F2', fg: '#991B1B', label: 'Error' },
    revoked:         { bg: '#F3F4F6', fg: '#374151', label: 'Disconnected' },
  };
  const c = colors[integration.status] ?? colors.revoked;
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold"
    style="background:${c.bg};color:${c.fg}">${c.label}</span>`;
}

function renderCard(provider, integration) {
  const isComingSoon = provider.phase === 'later';
  const isAvailable  = !isComingSoon;
  const ctaLabel     = integration ? 'Disconnect' : (isAvailable ? 'Connect' : 'Coming soon');
  const ctaDisabled  = !integration && !isAvailable;
  const ctaStyle     = integration
    ? `background:#FEF2F2;color:#991B1B;border:1px solid #FCA5A5`
    : `background:${NAVY};color:#fff`;

  return `
    <div class="bg-white border border-border-subtle rounded-lg p-4 flex flex-col gap-3"
         data-provider="${provider.id}">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg flex items-center justify-center"
               style="background:#E6EEF5;color:${NAVY}">
            <span class="material-symbols-outlined">${provider.icon}</span>
          </div>
          <div>
            <div class="text-sm font-semibold text-text-main">${provider.name}</div>
            <div class="text-xs text-text-muted">${provider.desc}</div>
          </div>
        </div>
        ${statusBadge(integration)}
      </div>
      ${integration?.externalAccountEmail
        ? `<div class="text-xs text-text-muted">Connected as ${integration.externalAccountEmail}</div>`
        : ''}
      <div class="flex items-center justify-between gap-2 mt-1">
        <div class="text-xs text-text-muted">
          ${integration?.lastSyncAt
            ? `Last sync: ${new Date(integration.lastSyncAt).toLocaleString()}`
            : ''}
        </div>
        <button class="text-xs font-semibold rounded-md px-3 py-1.5 transition-opacity ${ctaDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'}"
                style="${ctaStyle}"
                ${ctaDisabled ? 'disabled' : ''}
                data-action="${integration ? 'disconnect' : 'connect'}"
                data-id="${integration?.id ?? ''}">
          ${ctaLabel}
        </button>
      </div>
    </div>
  `;
}

async function fetchIntegrations() {
  try {
    const res = await authFetch('/api/integrations');
    if (!res.ok) return [];
    const json = await res.json();
    return json.integrations ?? [];
  } catch {
    return [];
  }
}

async function render() {
  const grid = document.getElementById('integrations-grid');
  if (!grid) return;
  const integrations = await fetchIntegrations();
  const byProvider = new Map(
    integrations.filter(i => i.status !== 'revoked').map(i => [i.provider, i])
  );
  grid.innerHTML = PROVIDER_CATALOG
    .map(p => renderCard(p, byProvider.get(p.id) ?? null))
    .join('');

  grid.addEventListener('click', onCardClick);
}

async function onCardClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const card = btn.closest('[data-provider]');
  const provider = card?.dataset.provider;
  if (!provider) return;

  if (action === 'connect') {
    btn.disabled = true;
    try {
      const res = await authFetch(`/api/integrations/${provider}/connect`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      if (result.mode === 'oauth' && result.authUrl) {
        window.location.href = result.authUrl;
        return;
      }
      if (result.mode === 'api_key' && result.instructions) {
        openApiKeyModal(provider, result.instructions);
        btn.disabled = false;
        return;
      }
      throw new Error('Unsupported auth mode in response');
    } catch (err) {
      btn.disabled = false;
      alert(`Could not start connection: ${err.message}`);
    }
  } else if (action === 'disconnect') {
    if (!confirm('Disconnect this integration? Past data stays; no new sync.')) return;
    const id = btn.dataset.id;
    btn.disabled = true;
    try {
      const res = await authFetch(`/api/integrations/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await render();
    } catch (err) {
      btn.disabled = false;
      alert(`Disconnect failed: ${err.message}`);
    }
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function openApiKeyModal(provider, instructions) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center';
  overlay.style.background = 'rgba(0,0,0,0.45)';
  overlay.innerHTML = `
    <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-6 mx-4" role="dialog" aria-modal="true">
      <h3 class="text-base font-bold text-text-main mb-1">${escapeHtml(instructions.title)}</h3>
      <p class="text-sm text-text-secondary mb-3 whitespace-pre-line">${escapeHtml(instructions.body)}</p>
      ${instructions.helpUrl
        ? `<a href="${escapeHtml(instructions.helpUrl)}" target="_blank" rel="noopener" class="text-xs font-semibold inline-block mb-3" style="color:${NAVY}">How to find your key →</a>`
        : ''}
      <input type="password" id="api-key-input"
        class="mt-1 w-full border border-border-subtle rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2"
        style="--tw-ring-color:${NAVY}66"
        placeholder="${escapeHtml(instructions.placeholder ?? '')}" autocomplete="off" />
      <div id="api-key-error" class="mt-2 text-xs" style="color:#991B1B; display:none;"></div>
      <div class="mt-5 flex items-center justify-end gap-2">
        <button id="api-key-cancel" class="px-3 py-1.5 text-sm font-semibold rounded-md border border-border-subtle bg-white">Cancel</button>
        <button id="api-key-submit" class="px-3 py-1.5 text-sm font-semibold rounded-md text-white" style="background:${NAVY}">Connect</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#api-key-input');
  const errEl = overlay.querySelector('#api-key-error');
  const submitBtn = overlay.querySelector('#api-key-submit');
  const closeModal = () => overlay.remove();

  overlay.querySelector('#api-key-cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', escHandler);
      closeModal();
    }
  });

  setTimeout(() => input.focus(), 0);

  async function submit() {
    const apiKey = input.value.trim();
    errEl.style.display = 'none';
    if (apiKey.length < 8) {
      errEl.textContent = 'That key looks too short.';
      errEl.style.display = 'block';
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connecting…';
    try {
      const res = await authFetch(`/api/integrations/${provider}/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        errEl.textContent = j.error ?? `HTTP ${res.status}`;
        errEl.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Connect';
        return;
      }
      closeModal();
      await render();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Connect';
    }
  }

  submitBtn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}
