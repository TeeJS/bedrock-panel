'use strict';

const core = window.DevServicesCore;
const { PollingController } = window.DevServicesPolling;
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('_dark') === '0' ? 'light' : 'dark';
if (params.get('_accent')) document.documentElement.style.setProperty('--accent', params.get('_accent'));

const STORAGE_KEY = 'bedrock-panel.dev-services.settings.v1';
// Carry settings saved under the pre-rename key over once.
try { const legacy = localStorage.getItem('Bedrock Panel.dev-services.settings.v1'); if (legacy !== null) { if (localStorage.getItem(STORAGE_KEY) === null) localStorage.setItem(STORAGE_KEY, legacy); localStorage.removeItem('Bedrock Panel.dev-services.settings.v1'); } } catch (e) {}
const PAGE_SIZE = 4;
const $ = selector => document.querySelector(selector);
const track = $('#track');
const viewport = $('#viewport');
let settings = loadSettings();
let draft = null;
let selectedId = '';
let pageIndex = 0;
let statusById = new Map();
let stopCandidate = null;
let requestController = null;
let toastTimer = null;
let syncError = '';

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function loadSettings() {
  try { return core.normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); }
  catch (error) { return core.normalizeSettings({}); }
}

function saveSettings(value) {
  settings = core.normalizeSettings(value);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

async function api(action, body, suppliedController) {
  const controller = suppliedController || new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/app-api/' + action, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Request failed (' + response.status + ').');
    return payload;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('The request timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function displayUrl(service) {
  try { return core.buildUrl(service); } catch (error) { return 'Invalid URL'; }
}

function cardProcess(service, status) {
  if (status && status.processName) {
    return esc(status.processName) + (status.pid ? ' <small>PID ' + esc(status.pid) + '</small>' : '');
  }
  if (status && status.state === 'stopped') return '<span class="muted">No listener</span>';
  if (service.expectedProcess) return esc(service.expectedProcess) + ' <small>expected</small>';
  return '<span class="muted">Process unavailable</span>';
}

function statusFor(service) {
  return statusById.get(service.id) || {
    state: 'checking',
    label: 'CHECKING',
    detail: 'Checking port and process ownership…',
    canStop: false,
  };
}

function cardHtml(service) {
  const status = statusFor(service);
  let detail = status.detail || '';
  if (status.processLookupError && status.state === 'running') detail = 'Listening; process details unavailable: ' + status.processLookupError;
  const folderButton = service.projectFolder
    ? '<button type="button" data-action="folder" data-id="' + esc(service.id) + '">FOLDER</button>' : '';
  const stopTitle = status.state === 'unexpected'
    ? 'Disabled because the listening process does not match the configured expectation.'
    : (!status.canStop ? 'Stop is available only when one local owning process is verified.' : 'Stop the verified port owner.');
  return '<article class="service-card ' + esc(status.state) + '">'
    + '<div class="card-head"><div class="service-name" title="' + esc(service.name) + '">' + esc(service.name) + '</div>'
    + '<div class="port">:' + esc(service.port) + '</div></div>'
    + '<div class="status"><span class="status-dot"></span>' + esc(status.label) + '</div>'
    + '<div class="process">' + cardProcess(service, status) + '</div>'
    + '<div><div class="detail">' + esc(detail) + '</div><div class="service-url" title="' + esc(displayUrl(service)) + '">' + esc(displayUrl(service)) + '</div></div>'
    + '<div class="card-actions">'
    + '<button class="open" type="button" data-action="open" data-id="' + esc(service.id) + '">OPEN</button>'
    + '<button type="button" data-action="copy" data-id="' + esc(service.id) + '">COPY</button>'
    + folderButton
    + '<button class="stop" type="button" data-action="stop" data-id="' + esc(service.id) + '"'
    + (status.canStop ? '' : ' disabled') + ' title="' + esc(stopTitle) + '">STOP</button>'
    + '</div></article>';
}

function renderSummary() {
  const values = settings.services.map(statusFor);
  const running = values.filter(status => status.state === 'running').length;
  const attention = values.filter(status => status.state === 'unexpected' || status.state === 'error').length;
  if (!settings.services.length) $('#summary').textContent = syncError || 'No services configured';
  else if (values.some(status => status.state === 'checking')) $('#summary').textContent = 'Checking ' + settings.services.length + ' service' + (settings.services.length === 1 ? '' : 's') + '…';
  else $('#summary').textContent = running + ' running · ' + (settings.services.length - running - attention) + ' stopped'
    + (attention ? ' · ' + attention + ' need attention' : '');
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(settings.services.length / PAGE_SIZE));
  pageIndex = Math.max(0, Math.min(pageIndex, pages - 1));
  track.style.transform = 'translateX(-' + (pageIndex * 100) + '%)';
  $('#previous').disabled = pageIndex === 0;
  $('#next').disabled = pageIndex >= pages - 1;
  $('#previous').hidden = pages <= 1;
  $('#next').hidden = pages <= 1;
  $('#page-status').textContent = settings.services.length
    ? (pageIndex * PAGE_SIZE + 1) + '–' + Math.min(settings.services.length, (pageIndex + 1) * PAGE_SIZE) + ' of ' + settings.services.length
    : '';
  $('#dots').innerHTML = pages <= 1 ? '' : Array.from({ length: pages }, (_, index) =>
    '<span class="dot' + (index === pageIndex ? ' active' : '') + '"></span>').join('');
}

function render() {
  $('#empty').hidden = settings.services.length > 0;
  if (!settings.services.length) {
    track.innerHTML = '';
  } else {
    const pages = [];
    for (let index = 0; index < settings.services.length; index += PAGE_SIZE) {
      pages.push('<div class="service-page">' + settings.services.slice(index, index + PAGE_SIZE).map(cardHtml).join('') + '</div>');
    }
    track.innerHTML = pages.join('');
  }
  renderSummary();
  renderPager();
}

function showToast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}

async function refreshServices() {
  syncError = '';
  statusById = new Map(settings.services.map(service => [service.id, {
    state: 'checking',
    label: 'CHECKING',
    detail: 'Checking port and process ownership…',
    canStop: false,
  }]));
  render();
  if (requestController) requestController.abort();
  requestController = new AbortController();
  try {
    const result = await api('status', {
      useStoredSettings: true,
      fallback: settings,
    }, requestController);
    if (result.settings) {
      const previousRefresh = settings.refreshSeconds;
      saveSettings(result.settings);
      if (settings.refreshSeconds !== previousRefresh) poller.setInterval(settings.refreshSeconds * 1000);
    }
    statusById = new Map((result.services || []).map(status => [status.id, status]));
    const checked = new Date(result.checkedAt || Date.now());
    $('#updated').textContent = 'Updated ' + checked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (error) {
    syncError = error.message || 'Settings could not be loaded.';
    statusById = new Map(settings.services.map(service => [service.id, {
      state: 'error',
      label: 'ERROR',
      detail: error.message || 'Status check failed.',
      canStop: false,
    }]));
  } finally {
    requestController = null;
    render();
  }
}

const poller = new PollingController({
  task: refreshServices,
  intervalMs: settings.refreshSeconds * 1000,
});

function serviceById(id, source) {
  return (source || settings).services.find(service => service.id === id) || null;
}

async function serviceAction(action, service) {
  try {
    const result = await api(action, { service });
    if (action === 'copy') showToast('Copied ' + result.url);
  } catch (error) {
    showToast(error.message || 'Action failed.');
  }
}

function askToStop(service, status) {
  stopCandidate = { service, status };
  $('#confirm-message').textContent = 'Stop ' + (status.processName || 'process') + ' (PID ' + status.pid + ') listening on port ' + service.port + '?';
  $('#confirm-overlay').hidden = false;
  $('#cancel-stop').focus();
}

async function confirmStop() {
  if (!stopCandidate) return;
  const candidate = stopCandidate;
  $('#confirm-stop').disabled = true;
  try {
    const result = await api('stop', {
      serviceId: candidate.service.id,
      observationToken: candidate.status.observationToken,
    });
    showToast((result.stopped.processName || 'Process') + ' (PID ' + result.stopped.pid + ') was stopped.');
    $('#confirm-overlay').hidden = true;
    stopCandidate = null;
    await poller.trigger();
  } catch (error) {
    showToast(error.message || 'The process could not be stopped.');
    $('#confirm-overlay').hidden = true;
    stopCandidate = null;
    await poller.trigger();
  } finally {
    $('#confirm-stop').disabled = false;
  }
}

track.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const service = serviceById(button.dataset.id);
  const status = statusById.get(button.dataset.id);
  if (!service) return;
  if (button.dataset.action === 'stop') {
    if (status && status.canStop) askToStop(service, status);
    return;
  }
  serviceAction(button.dataset.action === 'folder' ? 'open-folder' : button.dataset.action, service);
});

function showPage(index) {
  const pages = Math.max(1, Math.ceil(settings.services.length / PAGE_SIZE));
  pageIndex = Math.max(0, Math.min(index, pages - 1));
  renderPager();
}

$('#previous').addEventListener('click', () => showPage(pageIndex - 1));
$('#next').addEventListener('click', () => showPage(pageIndex + 1));
$('#refresh').addEventListener('click', () => poller.trigger());
$('#settings').addEventListener('click', openSettings);
$('#empty-settings').addEventListener('click', openSettings);
$('#cancel-stop').addEventListener('click', () => { stopCandidate = null; $('#confirm-overlay').hidden = true; });
$('#confirm-stop').addEventListener('click', confirmStop);

let swipeStart = null;
viewport.addEventListener('pointerdown', event => {
  if (event.target.closest('button')) return;
  swipeStart = { x: event.clientX, y: event.clientY };
});
viewport.addEventListener('pointerup', event => {
  if (!swipeStart) return;
  const dx = event.clientX - swipeStart.x;
  const dy = event.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy)) showPage(pageIndex + (dx < 0 ? 1 : -1));
});
viewport.addEventListener('pointercancel', () => { swipeStart = null; });

function openSettings() {
  draft = core.normalizeSettings(settings);
  selectedId = draft.services[0] ? draft.services[0].id : '';
  $('#refresh-seconds').value = String(draft.refreshSeconds);
  $('#settings-overlay').hidden = false;
  poller.setVisible(false);
  renderSettings();
  $('#service-form').scrollTop = 0;
  $('#service-list').scrollTop = 0;
}

function closeSettings() {
  $('#settings-overlay').hidden = true;
  draft = null;
  selectedId = '';
  poller.setVisible(!document.hidden);
}

function renderSettingsList() {
  $('#service-list').innerHTML = draft.services.map(service =>
    '<button type="button" data-service-id="' + esc(service.id) + '" class="' + (service.id === selectedId ? 'selected' : '') + '">'
    + '<span>' + esc(service.name) + '</span><small>:' + esc(service.port) + '</small></button>').join('');
  $('#add-service').disabled = draft.services.length >= core.MAX_SERVICES;
  $('#settings-note').textContent = draft.services.length >= core.MAX_SERVICES ? 'Maximum of ' + core.MAX_SERVICES + ' services reached.' : '';
}

function populateForm() {
  const service = serviceById(selectedId, draft);
  $('#form-empty').hidden = !!service;
  $('#form-fields').hidden = !service;
  if (!service) return;
  document.querySelectorAll('[data-field]').forEach(field => {
    field.value = service[field.dataset.field] == null ? '' : String(service[field.dataset.field]);
  });
  const index = draft.services.findIndex(item => item.id === selectedId);
  $('#move-up').disabled = index <= 0;
  $('#move-down').disabled = index < 0 || index >= draft.services.length - 1;
}

function renderSettings() {
  renderSettingsList();
  populateForm();
}

$('#service-list').addEventListener('click', event => {
  const button = event.target.closest('[data-service-id]');
  if (!button) return;
  selectedId = button.dataset.serviceId;
  renderSettings();
});

$('#service-form').addEventListener('input', event => {
  const field = event.target.closest('[data-field]');
  const service = serviceById(selectedId, draft);
  if (!field || !service) return;
  service[field.dataset.field] = field.dataset.field === 'port' ? Number(field.value) : field.value;
  if (field.dataset.field === 'name' || field.dataset.field === 'port') renderSettingsList();
});

$('#service-form').addEventListener('change', event => {
  const field = event.target.closest('[data-field]');
  const service = serviceById(selectedId, draft);
  if (field && service) service[field.dataset.field] = field.dataset.field === 'port' ? Number(field.value) : field.value;
});

$('#refresh-seconds').addEventListener('change', event => { draft.refreshSeconds = Number(event.target.value); });
$('#add-service').addEventListener('click', () => {
  draft = core.addService(draft, {
    name: 'New Service',
    port: 3000,
    protocol: 'http',
    host: 'localhost',
  });
  selectedId = draft.services[draft.services.length - 1].id;
  renderSettings();
  const name = document.querySelector('[data-field="name"]');
  if (name) { name.focus(); name.select(); }
});
$('#remove-service').addEventListener('click', () => {
  const index = draft.services.findIndex(service => service.id === selectedId);
  draft = core.removeService(draft, selectedId);
  selectedId = draft.services[Math.min(index, draft.services.length - 1)]?.id || '';
  renderSettings();
});
$('#move-up').addEventListener('click', () => { draft = core.moveService(draft, selectedId, -1); renderSettings(); });
$('#move-down').addEventListener('click', () => { draft = core.moveService(draft, selectedId, 1); renderSettings(); });
$('#cancel-settings').addEventListener('click', closeSettings);
$('#save-settings').addEventListener('click', async () => {
  if (!$('#service-form').reportValidity()) return;
  const saveButton = $('#save-settings');
  saveButton.disabled = true;
  try {
    for (const service of draft.services) {
      if (!core.normalizePort(service.port)) throw new Error(service.name + ' has an invalid port.');
      core.buildUrl(service);
    }
    const result = await api('save-settings', { settings: draft });
    saveSettings(result.settings);
    statusById.clear();
    pageIndex = Math.min(pageIndex, Math.max(0, Math.ceil(settings.services.length / PAGE_SIZE) - 1));
    poller.setInterval(settings.refreshSeconds * 1000);
    closeSettings();
    render();
    poller.trigger();
  } catch (error) {
    $('#settings-note').textContent = error.message || 'Check the service settings.';
  } finally {
    saveButton.disabled = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (!$('#settings-overlay').hidden) return;
  poller.setVisible(!document.hidden);
});
window.addEventListener('pagehide', () => {
  poller.stop();
  if (requestController) requestController.abort();
});

window.oqKnob = function onKnob(event) {
  if (event.type === 'rotate') {
    showPage(pageIndex + (event.dir > 0 ? 1 : -1));
    return true;
  }
  if (event.type === 'press' && event.index === 1) { poller.trigger(); return true; }
  if (event.type === 'press' && event.index === 2) { openSettings(); return true; }
  return false;
};

render();
poller.start();
