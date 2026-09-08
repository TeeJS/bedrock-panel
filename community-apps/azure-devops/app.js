'use strict';

const query = new URLSearchParams(location.search);
const dark = query.get('_dark');
document.documentElement.dataset.theme = dark === '0' ? 'light' : 'dark';

const els = {
  content: document.getElementById('content'),
  connectionStatus: document.getElementById('connectionStatus'),
  organizationButton: document.getElementById('organizationButton'),
  organizationLabel: document.getElementById('organizationLabel'),
  projectButton: document.getElementById('projectButton'),
  projectLabel: document.getElementById('projectLabel'),
  refreshButton: document.getElementById('refreshButton'),
  diagnosticButton: document.getElementById('diagnosticButton'),
  openDevOpsButton: document.getElementById('openDevOpsButton'),
  pickerOverlay: document.getElementById('pickerOverlay'),
  pickerTitle: document.getElementById('pickerTitle'),
  pickerList: document.getElementById('pickerList'),
  closePicker: document.getElementById('closePicker'),
  confirmOverlay: document.getElementById('confirmOverlay'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmMessage: document.getElementById('confirmMessage'),
  branchField: document.getElementById('branchField'),
  branchInput: document.getElementById('branchInput'),
  cancelConfirm: document.getElementById('cancelConfirm'),
  acceptConfirm: document.getElementById('acceptConfirm'),
  diagnosticOverlay: document.getElementById('diagnosticOverlay'),
  diagnosticText: document.getElementById('diagnosticText'),
  closeDiagnostic: document.getElementById('closeDiagnostic'),
  copyDiagnostic: document.getElementById('copyDiagnostic'),
  doneDiagnostic: document.getElementById('doneDiagnostic')
};

const state = {
  connected: false,
  organizations: [],
  projects: [],
  organization: null,
  project: null,
  view: 'overview',
  contextVersion: 0,
  requestVersion: 0,
  refreshTimer: null,
  refreshMinutes: 5,
  cachedViews: new Map(),
  confirmResolve: null,
  lastDiagnostic: null
};

const CARD_ICONS = {
  repositories: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M8 7h4a6 6 0 0 1 6 6"/></svg>',
  pipelines: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/></svg>',
  'pull-requests': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10a2 2 0 0 0 2 2h3M18 17V9a4 4 0 0 0-4-4h-3m0 0 3-3m-3 3 3 3"/></svg>',
  'work-items': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.6 2.6L16.5 9"/></svg>'
};
const STATE_ICONS = {
  healthy: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="m6.5 10 2.2 2.2 4.8-4.8"/></svg>',
  warning: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18 17H2Z"/><path d="M10 7v4m0 3h.01"/></svg>',
  danger: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="m7 7 6 6m0-6-6 6"/></svg>',
  info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 9v5m0-8h.01"/></svg>',
  neutral: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M6.5 10h7"/></svg>'
};
const VIEW_LABELS = { overview: 'Overview', repositories: 'Repositories', pipelines: 'Pipelines', 'pull-requests': 'Pull Requests', 'work-items': 'Work Items' };

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function fmtBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tone(value) {
  const status = String(value || '').toLowerCase();
  if (['succeeded', 'completed', 'active', 'approved', 'wellformed'].includes(status)) return 'good';
  if (['failed', 'error', 'rejected', 'abandoned'].includes(status)) return 'bad';
  if (['inprogress', 'notstarted', 'postponed', 'cancelling', 'draft'].includes(status)) return 'warn';
  return '';
}

function setStatus(message) {
  els.connectionStatus.textContent = message;
  els.connectionStatus.classList.toggle('connected', /^Connected/.test(message));
  els.connectionStatus.classList.toggle('warning', /cached|problem|expired|required/i.test(message));
}

function contextMatches(version, organization, projectId) {
  return version === state.contextVersion && state.organization && state.project
    && state.organization.name === organization && state.project.id === projectId;
}

async function api(action, params, options) {
  const search = new URLSearchParams(params || {});
  const response = await fetch(`/app-api/${action}${search.size ? `?${search}` : ''}`, Object.assign({ cache: 'no-store' }, options));
  let data;
  try { data = await response.json(); }
  catch (error) { throw new Error('The local app service returned an unreadable response.'); }
  if (!response.ok || !data.ok) {
    const failure = new Error(data.error || 'The request failed.');
    failure.code = data.code;
    failure.reauth = data.reauth;
    failure.diagnostic = data.diagnostic || null;
    throw failure;
  }
  return data;
}

function showToast(message, bad) {
  document.querySelectorAll('.toast').forEach(item => item.remove());
  const toast = document.createElement('div');
  toast.className = `toast${bad ? ' bad' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3800);
}

function showState(title, detail, button) {
  els.content.innerHTML = `<div class="state"><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>${button || ''}</div></div>`;
}

function cleanDiagnosticValue(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 500);
}

function rememberDiagnostic(value, userMessage) {
  const values = Array.isArray(value) ? value : [value];
  const source = values.filter(Boolean).pop();
  if (!source || typeof source !== 'object') return;
  state.lastDiagnostic = {
    source: cleanDiagnosticValue(source.source, 80) || 'Azure DevOps',
    status: Number(source.status) || 0,
    providerMessage: cleanDiagnosticValue(source.providerMessage, 500),
    providerCode: cleanDiagnosticValue(source.providerCode, 120),
    providerType: cleanDiagnosticValue(source.providerType, 160),
    requestId: cleanDiagnosticValue(source.requestId, 120),
    occurredAt: cleanDiagnosticValue(source.occurredAt, 80) || new Date().toISOString(),
    userMessage: cleanDiagnosticValue(userMessage, 300)
  };
  els.diagnosticButton.hidden = false;
}

function captureDiagnostics(data) {
  if (!data) return;
  if (Array.isArray(data.diagnostics) && data.diagnostics.length) rememberDiagnostic(data.diagnostics, data.warning);
  else if (data.diagnostic) rememberDiagnostic(data.diagnostic, data.warning);
}

function diagnosticSummary() {
  const item = state.lastDiagnostic;
  if (!item) return 'No Azure DevOps error details have been recorded in this session.';
  const lines = [
    'Azure DevOps troubleshooting details',
    `Time: ${item.occurredAt}`,
    `Organization: ${state.organization ? state.organization.name : 'Not selected'}`,
    `Project: ${state.project ? state.project.name : 'Not selected'}`,
    `Area: ${item.source}`,
    `HTTP status: ${item.status || 'No response'}`,
    `Diagnostic code: ${item.providerCode || 'Not supplied'}`
  ];
  if (item.providerType) lines.push(`Azure DevOps type: ${item.providerType}`);
  if (item.requestId) lines.push(`Request/activity ID: ${item.requestId}`);
  if (item.providerMessage) lines.push(`Azure DevOps message: ${item.providerMessage}`);
  if (item.userMessage) lines.push(`Panel message: ${item.userMessage}`);
  lines.push('', 'OAuth tokens, authorization headers, and request URLs are omitted.');
  return lines.join('\n');
}

function openDiagnostic() {
  els.diagnosticText.textContent = diagnosticSummary();
  els.diagnosticOverlay.hidden = false;
}

function closeDiagnostic() {
  els.diagnosticOverlay.hidden = true;
}

async function copyDiagnostic() {
  try {
    await navigator.clipboard.writeText(diagnosticSummary());
    showToast('Troubleshooting details copied.');
  } catch (error) {
    showToast('Could not copy automatically. Select the details and copy them manually.', true);
  }
}

function showLoading(label) {
  els.content.innerHTML = `<div class="overview-grid" aria-label="Loading ${escapeHtml(label)}">
    ${Array.from({ length: 4 }, () => '<div class="overview-card skeleton"></div>').join('')}
  </div>`;
}

function selectedParams(extra) {
  return Object.assign({ organization: state.organization.name, project: state.project.id }, extra || {});
}

function cacheKey(view) {
  return `${state.organization && state.organization.name}:${state.project && state.project.id}:${view}`;
}

function saveSelection() {
  try {
    localStorage.setItem('azure-devops.organization', state.organization ? state.organization.name : '');
    localStorage.setItem('azure-devops.project', state.project ? state.project.id : '');
  } catch (error) {}
}

function saved(key) {
  try { return localStorage.getItem(`azure-devops.${key}`) || ''; }
  catch (error) { return ''; }
}

function updateHeader() {
  els.organizationLabel.textContent = state.organization ? state.organization.name : 'Choose organization';
  els.projectLabel.textContent = state.project ? state.project.name : 'Choose project';
  els.organizationButton.disabled = !state.connected || !state.organizations.length;
  els.projectButton.disabled = !state.organization || !state.projects.length;
}

function setActiveNav(view) {
  document.querySelectorAll('.nav-button[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
}

function safeDevOpsUrl(value) {
  if (!state.organization) return '';
  try {
    const url = new URL(value);
    const org = decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] || '');
    return url.protocol === 'https:' && url.hostname === 'dev.azure.com' && org.toLowerCase() === state.organization.name.toLowerCase() ? url.href : '';
  } catch (error) { return ''; }
}

function openExternal(value) {
  const target = safeDevOpsUrl(value);
  if (!target) return showToast('That external link was rejected.', true);
  const link = document.createElement('a');
  link.href = target;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.click();
}

function externalLink(url, label) {
  const safe = safeDevOpsUrl(url);
  return safe ? `<a class="external-link" href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>` : '';
}

function staleNote(data) {
  if (!data || !data.stale) return '';
  return `<span class="stale-note">Showing cached data${data.warning ? ` · ${escapeHtml(data.warning)}` : ''}</span>`;
}

function beginRequest() {
  return { request: ++state.requestVersion, context: state.contextVersion, organization: state.organization.name, project: state.project.id };
}

function requestIsCurrent(ticket) {
  return ticket.request === state.requestVersion && contextMatches(ticket.context, ticket.organization, ticket.project);
}

function renderOverview(data) {
  const tones = new Set(['healthy', 'warning', 'danger', 'info', 'neutral']);
  els.content.innerHTML = `<div class="overview-grid">
    ${data.cards.map(card => {
      const tone = tones.has(card.tone) ? card.tone : 'neutral';
      const metrics = Array.isArray(card.metrics) ? card.metrics.slice(0, 3) : [];
      return `<button class="overview-card tone-${tone}" type="button" data-view-target="${escapeHtml(card.view)}">
        <div class="card-top">
          <span class="card-heading"><span class="card-icon">${CARD_ICONS[card.type] || CARD_ICONS.repositories}</span><span class="card-label">${escapeHtml(card.label)}</span></span>
          <span class="card-state">${STATE_ICONS[tone]}<span>${escapeHtml(card.status || 'Status')}</span></span>
        </div>
        <div class="card-primary"><strong>${escapeHtml(card.value)}</strong><span>${escapeHtml(card.unit || '')}</span></div>
        <div class="card-metrics">${metrics.map(metric => `<span class="card-metric"><strong>${escapeHtml(metric.value)}</strong><span>${escapeHtml(metric.label)}</span></span>`).join('')}</div>
        <div class="card-message">${STATE_ICONS[tone]}<span>${escapeHtml(card.message || '')}</span></div>
        <div class="card-footer"><span>Updated ${escapeHtml(fmtDate(data.fetchedAt))}${data.stale ? ' · cached' : ''}</span><span class="card-affordance">View <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-4-4 4 4-4 4"/></svg></span></div>
      </button>`;
    }).join('')}
  </div>`;
  if (data.stale) showToast(data.warning || 'Showing cached Azure DevOps data.', false);
}

function sectionShell(title, subtitle, list, detail, stale) {
  return `<div class="section-shell">
    <div class="section-heading"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${stale || ''}</div>
    <div class="split-view"><section class="panel"><div class="list">${list}</div></section><section class="panel"><div class="detail" id="detailPanel">${detail}</div></section></div>
  </div>`;
}

function emptyDetail(message) {
  return `<div class="state"><div><strong>Nothing selected</strong><span>${escapeHtml(message)}</span></div></div>`;
}

function renderRepositories(data) {
  const list = data.repositories.length ? data.repositories.map(repo => `<button class="row-button" type="button" data-repository="${escapeHtml(repo.id)}">
    <span><span class="row-title">${escapeHtml(repo.name)}</span><span class="row-meta">${escapeHtml(repo.defaultBranch || 'No default branch')}</span></span>
    <span class="badge">${escapeHtml(fmtBytes(repo.size))}</span>
  </button>`).join('') : '<div class="state"><span>No repositories in this project.</span></div>';
  els.content.innerHTML = sectionShell('Repositories', `${data.repositories.length} available`, list, emptyDetail('Choose a repository to browse branches, commits, and pull requests.'), staleNote(data));
}

function renderRepositoryDetail(data) {
  const repo = data.repository;
  const branches = data.branches.slice(0, 8).map(branch => `<div class="compact-item"><span>${escapeHtml(branch.name)}</span><small>${escapeHtml(branch.objectId.slice(0, 8))}</small></div>`).join('') || '<p>No branches found.</p>';
  const commits = data.commits.slice(0, 7).map(commit => `<a class="compact-item external-link" href="${escapeHtml(safeDevOpsUrl(commit.url))}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(commit.message.split('\n')[0])}</span><small>${escapeHtml(commit.author)} · ${escapeHtml(fmtDate(commit.date))}</small></a>`).join('') || '<p>No recent commits.</p>';
  document.getElementById('detailPanel').innerHTML = `<header><div><h2>${escapeHtml(repo.name)}</h2><p>${escapeHtml(repo.defaultBranch || 'No default branch')} · ${escapeHtml(fmtBytes(repo.size))}</p></div>${externalLink(repo.url, 'Open repository')}</header>
    <div class="detail-grid"><div><h3>Branches (${data.branches.length})</h3><div class="compact-list">${branches}</div></div><div><h3>Recent commits</h3><div class="compact-list">${commits}</div></div></div>
    <h3>Active pull requests (${data.pullRequests.length})</h3>
    <div class="compact-list">${data.pullRequests.slice(0, 5).map(pr => `<button class="row-button" type="button" data-pull-request="${pr.id}"><span><span class="row-title">#${pr.id} ${escapeHtml(pr.title)}</span><span class="row-meta">${escapeHtml(pr.author)}</span></span><span class="badge ${pr.isDraft ? 'warn' : ''}">${pr.isDraft ? 'Draft' : 'Active'}</span></button>`).join('') || '<p>No active pull requests.</p>'}</div>`;
}

function runLabel(run) {
  if (!run) return 'Never run';
  return run.status === 'completed' ? (run.result || 'completed') : (run.status || 'unknown');
}

function renderPipelines(data) {
  const list = data.pipelines.length ? data.pipelines.map(pipeline => `<button class="row-button" type="button" data-pipeline="${pipeline.id}" data-run="${pipeline.latestRun ? pipeline.latestRun.id : ''}">
    <span><span class="row-title">${escapeHtml(pipeline.name)}</span><span class="row-meta">${escapeHtml(pipeline.folder || '\\')} · ${pipeline.latestRun ? escapeHtml(fmtDate(pipeline.latestRun.queuedAt)) : 'No runs'}</span></span>
    <span class="badge ${tone(runLabel(pipeline.latestRun))}">${escapeHtml(runLabel(pipeline.latestRun))}</span>
  </button>`).join('') : '<div class="state"><span>No pipelines in this project.</span></div>';
  const detail = `<div class="state"><div><strong>Choose a pipeline</strong><span>Inspect its latest run${data.actionsEnabled ? ' or queue a new run' : ''}.</span></div></div>`;
  els.content.innerHTML = sectionShell('Pipelines', `${data.pipelines.length} definitions · ${data.runs.length} recent runs`, list, detail, staleNote(data));
  state.cachedViews.set(`${cacheKey('pipelines')}:data`, data);
}

function renderPipelineSummary(pipeline, actionsEnabled) {
  document.getElementById('detailPanel').innerHTML = `<header><div><h2>${escapeHtml(pipeline.name)}</h2><p>${escapeHtml(pipeline.folder || '\\')} · No recent run</p></div><div class="button-group">${actionsEnabled ? `<button class="primary-button" type="button" data-run-pipeline="${pipeline.id}">Run pipeline</button>` : ''}${externalLink(pipeline.url, 'Open pipeline')}</div></header>
    <div class="state"><span>No recent run is available for this pipeline.</span></div>`;
}

function renderRunDetail(data) {
  const run = data.run;
  const canCancel = data.actionsEnabled && ['notStarted', 'inProgress', 'postponed'].includes(run.status);
  const stages = data.stages.map(stage => `<div class="compact-item"><span>${escapeHtml(stage.name)} <small>${escapeHtml(stage.type)}${stage.issues && stage.issues.length ? ` · ${escapeHtml(stage.issues[0])}` : ''}</small></span><span class="badge ${tone(stage.result || stage.state)}">${escapeHtml(stage.result || stage.state || 'pending')}</span></div>`).join('') || '<p>Stage and job details are not available.</p>';
  document.getElementById('detailPanel').innerHTML = `<header><div><h2>${escapeHtml(run.pipeline || `Run ${run.id}`)}</h2><p>${escapeHtml(run.buildNumber)} · ${escapeHtml(run.branch || 'default branch')}</p></div><div class="button-group">${data.actionsEnabled ? `<button class="primary-button" type="button" data-run-pipeline="${run.pipelineId}" data-ref="${escapeHtml(run.branch ? `refs/heads/${run.branch}` : '')}">Run pipeline</button>` : ''}${canCancel ? `<button class="secondary-button" type="button" data-cancel-run="${run.id}">Cancel run</button>` : ''}${externalLink(run.url, 'Open run')}</div></header>
    <div class="detail-grid">
      <div class="detail-field"><small>Status</small><strong><span class="badge ${tone(run.result || run.status)}">${escapeHtml(run.result || run.status || 'unknown')}</span></strong></div>
      <div class="detail-field"><small>Requested by</small><strong>${escapeHtml(run.requestedFor || '—')}</strong></div>
      <div class="detail-field"><small>Queued</small><strong>${escapeHtml(fmtDate(run.queuedAt))}</strong></div>
      <div class="detail-field"><small>Commit</small><strong>${run.commitUrl ? externalLink(run.commitUrl, run.sourceVersion.slice(0, 10)) : escapeHtml(run.sourceVersion ? run.sourceVersion.slice(0, 10) : '—')}</strong></div>
    </div><h3>Stages and jobs</h3><div class="compact-list">${stages}</div>
    ${data.workItems.length ? `<h3>Linked work items</h3><div class="compact-list">${data.workItems.map(item => `<a class="compact-item external-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"><span>Work item #${item.id}</span><small>Open ↗</small></a>`).join('')}</div>` : ''}`;
}

function renderPullRequests(data) {
  const list = data.pullRequests.length ? data.pullRequests.map(pr => `<button class="row-button" type="button" data-pull-request="${pr.id}">
    <span><span class="row-title">#${pr.id} ${escapeHtml(pr.title)}</span><span class="row-meta">${escapeHtml(pr.repository)} · ${escapeHtml(pr.author)}</span></span>
    <span class="badge ${pr.isDraft ? 'warn' : 'good'}">${pr.isDraft ? 'Draft' : 'Active'}</span>
  </button>`).join('') : '<div class="state"><span>No active pull requests in this project.</span></div>';
  els.content.innerHTML = sectionShell('Pull Requests', `${data.pullRequests.length} active`, list, emptyDetail('Choose a pull request to inspect its branches, reviewers, and linked work items.'), staleNote(data));
}

function voteLabel(vote) {
  if (vote >= 10) return 'Approved';
  if (vote > 0) return 'Approved with suggestions';
  if (vote <= -10) return 'Rejected';
  if (vote < 0) return 'Waiting for author';
  return 'No vote';
}

function renderPullRequestDetail(data) {
  const pr = data.pullRequest;
  const reviewers = data.reviewers.map(reviewer => `<div class="compact-item"><span>${escapeHtml(reviewer.name)}${reviewer.required ? ' · required' : ''}</span><span class="badge ${tone(voteLabel(reviewer.vote))}">${escapeHtml(voteLabel(reviewer.vote))}</span></div>`).join('') || '<p>No reviewers.</p>';
  document.getElementById('detailPanel').innerHTML = `<header><div><h2>#${pr.id} ${escapeHtml(pr.title)}</h2><p>${escapeHtml(pr.repository)} · ${escapeHtml(pr.author)}</p></div>${externalLink(pr.url, 'Open pull request')}</header>
    <div class="detail-grid"><div class="detail-field"><small>Source</small><strong>${escapeHtml(pr.sourceBranch)}</strong></div><div class="detail-field"><small>Target</small><strong>${escapeHtml(pr.targetBranch)}</strong></div></div>
    ${data.description ? `<p>${escapeHtml(data.description)}</p>` : ''}<h3>Reviewers</h3><div class="compact-list">${reviewers}</div>
    ${data.workItems.length ? `<h3>Linked work items</h3><div class="compact-list">${data.workItems.map(item => `<a class="compact-item external-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"><span>Work item #${item.id}</span><small>Open ↗</small></a>`).join('')}</div>` : ''}`;
}

function renderWorkItems(data) {
  const list = data.workItems.length ? data.workItems.map(item => `<button class="row-button" type="button" data-work-item="${item.id}">
    <span><span class="row-title">#${item.id} ${escapeHtml(item.title)}</span><span class="row-meta">${escapeHtml(item.type)} · ${escapeHtml(item.assignedTo || 'Unassigned')}</span></span>
    <span class="badge ${tone(item.state)}">${escapeHtml(item.state)}</span>
  </button>`).join('') : '<div class="state"><span>No active work items in this project.</span></div>';
  els.content.innerHTML = sectionShell('Work Items', `${data.workItems.length} recently changed and active`, list, emptyDetail('Choose a work item to inspect its assignment and explicit links.'), staleNote(data));
}

function linkedRelation(relation) {
  const value = `${relation.name} ${relation.url}`.toLowerCase();
  if (value.includes('pull request')) return 'Pull request';
  if (value.includes('commit')) return 'Commit';
  if (value.includes('build')) return 'Build';
  return relation.name || relation.rel || 'Related item';
}

function renderWorkItemDetail(data) {
  const item = data.workItem;
  const relations = item.relations.map(relation => `<div class="compact-item"><span>${escapeHtml(linkedRelation(relation))}</span><small>${escapeHtml(relation.rel)}</small></div>`).join('') || '<p>No explicit links.</p>';
  document.getElementById('detailPanel').innerHTML = `<header><div><h2>#${item.id} ${escapeHtml(item.title)}</h2><p>${escapeHtml(item.type)} · ${escapeHtml(item.state)}</p></div>${externalLink(item.url, 'Open work item')}</header>
    <div class="detail-grid">
      <div class="detail-field"><small>Assigned to</small><strong>${escapeHtml(item.assignedTo || 'Unassigned')}</strong></div>
      <div class="detail-field"><small>Changed</small><strong>${escapeHtml(fmtDate(item.changedAt))}</strong></div>
      <div class="detail-field"><small>Iteration</small><strong>${escapeHtml(item.iteration || '—')}</strong></div>
      <div class="detail-field"><small>Tags</small><strong>${escapeHtml(item.tags || '—')}</strong></div>
    </div><h3>Explicit links</h3><div class="compact-list">${relations}</div>`;
}

async function loadView(view, force) {
  if (!state.organization || !state.project) return;
  state.view = view;
  setActiveNav(view);
  showLoading(VIEW_LABELS[view] || view);
  const ticket = beginRequest();
  try {
    const data = await api(view, selectedParams(force ? { force: '1' } : {}));
    if (!requestIsCurrent(ticket)) return;
    captureDiagnostics(data);
    state.cachedViews.set(cacheKey(view), data);
    if (view === 'overview') renderOverview(data);
    else if (view === 'repositories') renderRepositories(data);
    else if (view === 'pipelines') renderPipelines(data);
    else if (view === 'pull-requests') renderPullRequests(data);
    else if (view === 'work-items') renderWorkItems(data);
    setStatus(data.stale ? 'Connected · cached data' : `Connected · updated ${fmtDate(data.fetchedAt)}`);
  } catch (error) {
    if (!requestIsCurrent(ticket)) return;
    rememberDiagnostic(error.diagnostic, error.message);
    if (error.reauth) state.connected = false;
    const cached = state.cachedViews.get(cacheKey(view));
    if (cached) {
      if (view === 'overview') renderOverview(Object.assign({}, cached, { stale: true, warning: error.message }));
      else if (view === 'repositories') renderRepositories(Object.assign({}, cached, { stale: true, warning: error.message }));
      else if (view === 'pipelines') renderPipelines(Object.assign({}, cached, { stale: true, warning: error.message }));
      else if (view === 'pull-requests') renderPullRequests(Object.assign({}, cached, { stale: true, warning: error.message }));
      else renderWorkItems(Object.assign({}, cached, { stale: true, warning: error.message }));
      showToast(`Showing cached data · ${error.message}`, true);
    } else {
      showState('Could not load Azure DevOps', error.message, '<button class="primary-button" id="retryButton" type="button">Try again</button>');
    }
    setStatus(error.reauth ? 'Sign-in required' : 'Connection problem');
  }
}

async function loadDetail(action, params, renderer) {
  const ticket = beginRequest();
  const panel = document.getElementById('detailPanel');
  if (panel) panel.innerHTML = '<div class="state"><span>Loading details…</span></div>';
  try {
    const data = await api(action, selectedParams(params));
    if (requestIsCurrent(ticket) && document.getElementById('detailPanel')) {
      captureDiagnostics(data);
      renderer(data);
    }
  } catch (error) {
    rememberDiagnostic(error.diagnostic, error.message);
    if (requestIsCurrent(ticket) && document.getElementById('detailPanel')) document.getElementById('detailPanel').innerHTML = `<div class="state"><div><strong>Details unavailable</strong><span>${escapeHtml(error.message)}</span></div></div>`;
  }
}

function openPicker(title, items, selected, choose) {
  els.pickerTitle.textContent = title;
  els.pickerList.innerHTML = items.map(item => `<button class="picker-option" type="button" data-picker-id="${escapeHtml(item.id || item.name)}"><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description || item.state || '')}</small></span>${(item.id || item.name) === selected ? '<span class="badge good">Selected</span>' : ''}</button>`).join('') || '<div class="state"><span>No choices are available.</span></div>';
  els.pickerOverlay.hidden = false;
  els.pickerList.onclick = event => {
    const button = event.target.closest('[data-picker-id]');
    if (!button) return;
    const item = items.find(candidate => String(candidate.id || candidate.name) === button.dataset.pickerId);
    els.pickerOverlay.hidden = true;
    if (item) choose(item);
  };
}

function closePicker() { els.pickerOverlay.hidden = true; }

function confirmAction(title, message, branch, showBranch) {
  els.confirmTitle.textContent = title;
  els.confirmMessage.textContent = message;
  els.branchField.hidden = !showBranch;
  els.branchInput.value = branch || '';
  els.confirmOverlay.hidden = false;
  if (showBranch) window.setTimeout(() => els.branchInput.focus(), 0);
  return new Promise(resolve => { state.confirmResolve = resolve; });
}

function closeConfirm(value) {
  els.confirmOverlay.hidden = true;
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  if (resolve) resolve(value);
}

async function runPipeline(pipelineId, defaultRef) {
  const confirmed = await confirmAction('Run pipeline', 'Azure DevOps will validate the run before it is queued.', defaultRef || '', true);
  if (!confirmed) return;
  let refName = els.branchInput.value.trim();
  if (refName && !refName.startsWith('refs/heads/')) refName = `refs/heads/${refName}`;
  try {
    const data = await api('run-pipeline', selectedParams(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pipelineId, refName })
    });
    showToast(data.message || 'Pipeline queued.');
    await loadView('pipelines', true);
  } catch (error) {
    rememberDiagnostic(error.diagnostic, error.message);
    showToast(error.message, true);
  }
}

async function cancelRun(runId) {
  const confirmed = await confirmAction('Cancel pipeline run', 'This asks Azure DevOps to cancel the queued or running build.', '', false);
  if (!confirmed) return;
  try {
    const data = await api('cancel-run', selectedParams(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId })
    });
    showToast(data.message || 'Cancellation requested.');
    await loadView('pipelines', true);
  } catch (error) {
    rememberDiagnostic(error.diagnostic, error.message);
    showToast(error.message, true);
  }
}

async function selectOrganization(organization) {
  state.contextVersion++;
  state.organization = organization;
  state.project = null;
  state.projects = [];
  state.cachedViews.clear();
  updateHeader();
  showState('Loading projects', `Finding projects in ${organization.name}…`);
  try {
    const data = await api('projects', { organization: organization.name });
    if (!state.organization || state.organization.name !== organization.name) return;
    state.projects = data.projects;
    const preferred = saved('project') || data.defaultProject;
    state.project = state.projects.find(project => project.id === preferred || project.name.toLowerCase() === String(preferred).toLowerCase()) || state.projects[0] || null;
    updateHeader();
    saveSelection();
    if (state.project) await loadView('overview');
    else showState('No accessible projects', 'This organization has no projects available to the signed-in account.');
  } catch (error) {
    rememberDiagnostic(error.diagnostic, error.message);
    showState('Could not load projects', error.message, '<button class="primary-button" id="retryButton" type="button">Try again</button>');
  }
}

async function selectProject(project) {
  state.contextVersion++;
  state.project = project;
  state.cachedViews.clear();
  updateHeader();
  saveSelection();
  await loadView('overview');
}

function scheduleRefresh() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(() => {
    if (!document.hidden && state.connected && state.project) loadView(state.view, true);
  }, state.refreshMinutes * 60 * 1000);
}

async function connect() {
  setStatus('Opening Microsoft sign-in');
  try {
    await api('connect');
    window.setTimeout(boot, 1000);
  } catch (error) {
    rememberDiagnostic(error.diagnostic, error.message);
    setStatus('Not connected');
    showToast(error.message, true);
  }
}

async function boot() {
  showState('Connecting to Azure DevOps', 'Checking Microsoft Entra sign-in…');
  try {
    const auth = await api('auth-status');
    state.connected = !!auth.connected;
    if (!auth.configured) {
      setStatus('Setup required');
      showState('Microsoft Entra setup required', 'Add this app’s client ID in Drop-In Apps settings, then connect.', '<button class="primary-button" id="connectButton" type="button">Connect</button>');
      return;
    }
    if (!state.connected) {
      setStatus('Not connected');
      showState('Connect Azure DevOps', 'Sign in with Microsoft Entra ID to load your organizations and projects.', '<button class="primary-button" id="connectButton" type="button">Connect</button>');
      return;
    }
    setStatus('Loading organizations');
    const data = await api('organizations');
    state.organizations = data.organizations;
    const preferred = saved('organization') || data.defaultOrganization;
    const organization = state.organizations.find(item => item.name.toLowerCase() === String(preferred).toLowerCase()) || state.organizations[0];
    updateHeader();
    if (!organization) {
      showState('No organizations found', 'Set a default organization in this app’s settings or confirm your Azure DevOps access.');
      return;
    }
    await selectOrganization(organization);
    scheduleRefresh();
  } catch (error) {
    rememberDiagnostic(error.diagnostic, error.message);
    setStatus('Connection problem');
    showState('Could not connect', error.message, '<button class="primary-button" id="retryButton" type="button">Try again</button>');
  }
}

els.organizationButton.addEventListener('click', () => openPicker('Choose organization', state.organizations, state.organization && state.organization.name, selectOrganization));
els.projectButton.addEventListener('click', () => openPicker('Choose project', state.projects, state.project && state.project.id, selectProject));
els.closePicker.addEventListener('click', closePicker);
els.pickerOverlay.addEventListener('click', event => { if (event.target === els.pickerOverlay) closePicker(); });
els.cancelConfirm.addEventListener('click', () => closeConfirm(false));
els.acceptConfirm.addEventListener('click', () => closeConfirm(true));
els.confirmOverlay.addEventListener('click', event => { if (event.target === els.confirmOverlay) closeConfirm(false); });
els.refreshButton.addEventListener('click', () => state.project ? loadView(state.view, true) : boot());
els.diagnosticButton.addEventListener('click', openDiagnostic);
els.closeDiagnostic.addEventListener('click', closeDiagnostic);
els.doneDiagnostic.addEventListener('click', closeDiagnostic);
els.copyDiagnostic.addEventListener('click', copyDiagnostic);
els.diagnosticOverlay.addEventListener('click', event => { if (event.target === els.diagnosticOverlay) closeDiagnostic(); });
els.openDevOpsButton.addEventListener('click', () => {
  if (!state.organization || !state.project) return showToast('Choose a project first.', true);
  openExternal(state.project.url);
});

document.querySelector('.bottom-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button && state.project) loadView(button.dataset.view);
});

els.content.addEventListener('click', event => {
  const viewButton = event.target.closest('[data-view-target]');
  if (viewButton) return loadView(viewButton.dataset.viewTarget);
  if (event.target.closest('#connectButton')) return connect();
  if (event.target.closest('#retryButton')) return state.connected ? (state.project ? loadView(state.view, true) : boot()) : boot();
  const repo = event.target.closest('[data-repository]');
  if (repo) return loadDetail('repository', { repository: repo.dataset.repository }, renderRepositoryDetail);
  const pr = event.target.closest('[data-pull-request]');
  if (pr) {
    if (state.view !== 'pull-requests') {
      state.view = 'pull-requests';
      setActiveNav('pull-requests');
      loadView('pull-requests').then(() => loadDetail('pull-request', { pullRequest: pr.dataset.pullRequest }, renderPullRequestDetail));
    } else loadDetail('pull-request', { pullRequest: pr.dataset.pullRequest }, renderPullRequestDetail);
    return;
  }
  const pipeline = event.target.closest('[data-pipeline]');
  if (pipeline) {
    const data = state.cachedViews.get(`${cacheKey('pipelines')}:data`);
    const selected = data && data.pipelines.find(item => String(item.id) === pipeline.dataset.pipeline);
    if (!pipeline.dataset.run && selected) return renderPipelineSummary(selected, data.actionsEnabled);
    if (pipeline.dataset.run) return loadDetail('run', { run: pipeline.dataset.run }, renderRunDetail);
  }
  const workItem = event.target.closest('[data-work-item]');
  if (workItem) return loadDetail('work-item', { workItem: workItem.dataset.workItem }, renderWorkItemDetail);
  const runButton = event.target.closest('[data-run-pipeline]');
  if (runButton) return runPipeline(Number(runButton.dataset.runPipeline), runButton.dataset.ref || '');
  const cancelButton = event.target.closest('[data-cancel-run]');
  if (cancelButton) return cancelRun(Number(cancelButton.dataset.cancelRun));
});

window.oqKnob = function (event) {
  const nav = Array.from(document.querySelectorAll('.nav-button[data-view]'));
  if (event.type === 'rotate') {
    const current = Math.max(0, nav.findIndex(button => button.classList.contains('active')));
    const next = (current + (event.dir > 0 ? 1 : -1) + nav.length) % nav.length;
    nav[next].focus();
    return true;
  }
  if (event.type === 'press') {
    const focused = document.activeElement;
    if (focused && focused.matches('button, a')) focused.click();
    return true;
  }
  return false;
};

boot();
