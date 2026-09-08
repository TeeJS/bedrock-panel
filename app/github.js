'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const content = $('content');
  const query = new URLSearchParams(location.search);
  if (query.get('_dark') === '0') document.body.classList.add('light');
  const accent = query.get('_accent');
  if (/^#[0-9a-f]{6}$/i.test(accent || '')) document.documentElement.style.setProperty('--accent', accent);
  const fragment = new URLSearchParams(location.hash.slice(1));
  let capability = fragment.get('_cap') || '';
  history.replaceState(null, '', location.pathname + location.search);

  const state = window.GitHubPanelState.create();
  state.runBack = 'actions';
  let requestQueue = Promise.resolve();
  let toastTimer = null;

  function esc(value) { return String(value == null ? '' : value).replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]); }
  function relative(value) { const seconds = Math.round((Date.now() - Date.parse(value || '')) / 1000); if (!Number.isFinite(seconds)) return 'unknown'; if (Math.abs(seconds) < 60) return 'just now'; const minutes = Math.round(seconds / 60); const amount = Math.abs(minutes) < 60 ? Math.abs(minutes) + 'm' : Math.abs(minutes) < 1440 ? Math.abs(Math.round(minutes / 60)) + 'h' : Math.abs(Math.round(minutes / 1440)) + 'd'; return seconds < 0 ? 'in ' + amount : amount + ' ago'; }
  function duration(ms) { if (!Number.isFinite(ms)) return '—'; const seconds = Math.max(0, Math.round(ms / 1000)); return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's'; }
  function bytes(value) { const size = Math.max(0, Number(value) || 0); if (size < 1024) return size + ' B'; if (size < 1024 * 1024) return Math.round(size / 1024) + ' KB'; return (size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0) + ' MB'; }
  function statusPill(value) { value = value || { key:'unknown', label:'Unknown' }; return `<span class="status-pill ${esc(value.key)}">${esc(value.label)}</span>`; }
  function statusIcon(value) { const key = value && value.key || 'unknown'; return key === 'success' ? '✓' : key === 'failure' ? '✕' : key === 'running' ? '●' : key === 'cancelled' ? '■' : '○'; }
  function reviewLabel(value) { const stateValue = value && value.state || 'pending'; return stateValue === 'changes_requested' ? 'Changes requested' : stateValue === 'review_requested' ? 'Review requested' : stateValue === 'approved' ? 'Approved' : 'Pending'; }
  function mergeLabel(item) { if (item.mergeable === false) return 'Conflicts'; if (item.mergeable === true) return item.mergeableState === 'clean' ? 'Mergeable' : 'Mergeable · ' + (item.mergeableState || 'checking'); return 'Checking'; }
  function notify(message, bad) { $('toast').textContent = message; $('toast').className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').className = 'toast'; }, 3200); }

  function storedArray(key) {
    try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 20) : []; }
    catch (error) { return []; }
  }
  function saveArray(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) {} }

  function api(operation, options = {}) {
    const execute = async () => {
      if (!capability) throw new Error('GitHub panel session expired; leave and reopen the page');
      const url = new URL('/api/github/' + operation, location.origin);
      Object.entries(options.query || {}).forEach(([key, value]) => url.searchParams.set(key, value));
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: Object.assign({ Authorization: 'Bearer ' + capability }, options.body === undefined ? {} : { 'Content-Type':'application/json' }),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const next = response.headers.get('X-Open-Quake-Capability');
      if (next) capability = next;
      if (response.status === 403) throw new Error('GitHub panel session expired; leave and reopen the page');
      try { return await response.json(); } catch (error) { throw new Error('Invalid response from Bedrock Panel'); }
    };
    const result = requestQueue.then(execute, execute);
    requestQueue = result.catch(() => {});
    return result;
  }

  function repoUrl() { return state.settings && state.settings.repository ? 'https://github.com/' + state.settings.repository : ''; }
  function setConnection(kind, text) { $('connectionState').className = 'connection ' + kind; $('connectionState').innerHTML = '<span class="dot"></span>' + esc(text); }
  function updateHeader() {
    const settings = state.settings || {};
    $('repositoryLabel').textContent = settings.repository || 'Choose repository';
    $('branchLabel').textContent = settings.branch || 'default branch';
    $('repositoryButton').disabled = !settings.connected;
    if (!settings.connected) setConnection('muted', 'Disconnected');
    else if (state.stale) setConnection('stale', 'Stale / error');
    else if (state.loading) setConnection('connected', 'Updating…');
    else if (state.fetchedAt) setConnection('connected', 'Updated ' + relative(state.fetchedAt));
    else setConnection('connected', 'Connected');
    document.querySelectorAll('.bottom-nav [data-view]').forEach(button => {
      const selected = button.dataset.view === state.view || (state.view === 'run' && button.dataset.view === state.runBack);
      button.classList.toggle('selected', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    $('openButton').disabled = !state.currentUrl;
  }
  function loading(message) { content.innerHTML = `<div class="loading">${esc(message || 'Loading GitHub…')}</div>`; }
  function errorView(result) { const reset = result && result.resetAt ? '<br>Retry after ' + esc(new Date(result.resetAt).toLocaleTimeString()) : ''; content.innerHTML = `<div class="error-state"><div><strong>${esc(result && result.error || 'GitHub request failed')}</strong><span>${esc(result && result.code || 'github_error')}${reset}</span></div></div>`; state.stale = true; updateHeader(); }
  function disconnectedView() { state.currentUrl = repoUrl(); content.innerHTML = '<div class="empty"><div><strong>GitHub is not connected</strong><br>Open this GitHub page in the desktop editor and connect your account.</div></div>'; }
  function currentRequest(version, repository) { return version === state.requestVersion && state.settings && state.settings.repository === repository; }

  function repositoryRank(item) {
    const name = item.fullName.toLowerCase();
    const favourite = state.favourites.findIndex(value => value.toLowerCase() === name);
    const recent = state.recents.findIndex(value => value.toLowerCase() === name);
    const configured = state.configuredRepository.toLowerCase() === name;
    return favourite >= 0 ? favourite : recent >= 0 ? 100 + recent : configured ? 200 : 1000;
  }
  function renderRepositoryList() {
    const search = String($('repositorySearch').value || '').trim().toLowerCase();
    const items = state.repositories.filter(item => !search || item.fullName.toLowerCase().includes(search))
      .slice().sort((a, b) => repositoryRank(a) - repositoryRank(b));
    $('repositoryList').innerHTML = items.map(item => {
      const relationship = item.relationship === 'upstream' && item.upstreamOf ? 'Upstream' : item.archived ? 'Archived' : item.fork ? 'Fork' : 'Source';
      const selected = state.settings && String(state.settings.repository || '').toLowerCase() === item.fullName.toLowerCase();
      const favourite = state.favourites.some(value => value.toLowerCase() === item.fullName.toLowerCase());
      const recent = state.recents.some(value => value.toLowerCase() === item.fullName.toLowerCase());
      const configured = state.configuredRepository && state.configuredRepository.toLowerCase() === item.fullName.toLowerCase();
      return `<div class="repository-entry ${selected ? 'selected' : ''}"><button class="repository-row" type="button" data-repository="${esc(item.fullName)}"${selected ? ' aria-current="true"' : ''}><span class="repository-row-main"><strong class="repository-row-name">${esc(item.fullName)}</strong><span class="repository-row-meta"><span>${item.private ? 'Private' : 'Public'}</span><span>${esc(item.permission)}</span><span>${relationship}</span>${configured ? '<span>Configured</span>' : recent ? '<span>Recent</span>' : ''}<span>Updated ${esc(relative(item.updatedAt))}</span></span></span><span>${esc(item.defaultBranch || '—')} ›</span></button><button class="repository-pin ${favourite ? 'pinned' : ''}" type="button" data-pin="${esc(item.fullName)}" aria-label="${favourite ? 'Unpin' : 'Pin'} ${esc(item.fullName)}">${favourite ? '★' : '☆'}</button></div>`;
    }).join('') || `<div class="repository-empty">${state.repositoriesLoaded ? 'No matching repositories.' : 'Loading repositories…'}</div>`;
    $('repositoryList').querySelectorAll('[data-repository]').forEach(button => { button.onclick = () => selectRepository(button.dataset.repository); });
    $('repositoryList').querySelectorAll('[data-pin]').forEach(button => {
      button.onclick = () => {
        const name = button.dataset.pin;
        const index = state.favourites.findIndex(value => value.toLowerCase() === name.toLowerCase());
        if (index >= 0) state.favourites.splice(index, 1); else state.favourites.unshift(name);
        saveArray('open-quake.github.favourites', state.favourites);
        renderRepositoryList();
      };
    });
  }

  async function loadRepositories(forceRefresh) {
    const result = await api('repositories', forceRefresh ? { query:{ refresh:'1' } } : {});
    if (!result.ok) throw new Error(result.error || 'Could not list repositories');
    state.repositories = Array.isArray(result.items) ? result.items : [];
    state.repositoriesLoaded = true;
    return result;
  }
  async function openRepositoryBrowser(forceRefresh) {
    $('repositoryOverlay').hidden = false;
    $('repositorySearch').value = '';
    renderRepositoryList();
    if (!state.repositoriesLoaded || forceRefresh) {
      try { await loadRepositories(!!forceRefresh); renderRepositoryList(); }
      catch (error) { $('repositoryList').innerHTML = '<div class="repository-empty">' + esc(error.message) + '</div>'; }
    }
    $('repositorySearch').focus();
  }
  function closeRepositoryBrowser() { $('repositoryOverlay').hidden = true; }
  function selectRepository(fullName) {
    const item = state.repositories.find(value => value.fullName.toLowerCase() === String(fullName || '').toLowerCase());
    if (!item || !state.settings) return;
    window.GitHubPanelState.selectRepository(state, item.fullName, item.defaultBranch || '');
    state.recents = [item.fullName].concat(state.recents.filter(value => value.toLowerCase() !== item.fullName.toLowerCase())).slice(0, 6);
    saveArray('open-quake.github.recents', state.recents);
    try { localStorage.setItem('open-quake.github.repository', item.fullName); } catch (error) {}
    closeRepositoryBrowser(); updateHeader(); loadCurrent();
  }

  function openCommitDetail(commit, branch) {
    $('commitTitle').textContent = 'Latest commit · ' + (commit.sha || 'unknown');
    $('commitDetail').innerHTML = `<div class="commit-message-full">${esc(commit.fullMessage || commit.message || 'No commit message')}</div><div class="commit-meta"><span><small>Author</small><strong>${esc(commit.author || 'unknown')}</strong></span><span><small>Timestamp</small><strong>${esc(commit.date ? new Date(commit.date).toLocaleString() : 'unknown')}</strong></span><span><small>Branch</small><strong>${esc(branch || '—')}</strong></span>${commit.associatedPull ? `<span><small>Associated PR</small><strong>#${commit.associatedPull.number} ${esc(commit.associatedPull.title)}</strong></span>` : ''}</div>`;
    $('commitOpen').disabled = !commit.url;
    $('commitOpen').onclick = () => openExternal(commit.url);
    $('commitOverlay').hidden = false;
  }

  function renderOverview(data) {
    const repository = data.repository || {}, commit = data.commit || {}, pulls = data.pulls || { open:0,drafts:0,ready:0 }, actions = data.actions || {}, latest = actions.latest, comparison = data.comparison;
    const upstream = repository.source || repository.parent;
    const forkStatus = comparison ? `<span class="metric success">↑ ${comparison.ahead} ahead</span><span class="metric ${comparison.behind ? 'warning' : 'success'}">↓ ${comparison.behind} behind</span>` : '<span class="metric">Comparison unavailable</span>';
    state.currentUrl = repository.url || repoUrl();
    content.innerHTML = `<div class="overview-grid">
      <section class="card repository-card"><h2>Repository</h2><div class="primary">${esc(repository.fullName || state.settings.repository)}</div><div class="secondary">${repository.private ? 'Private' : 'Public'} repository · default ${esc(repository.defaultBranch || '—')}</div>${repository.fork ? `<div class="fork-source"><small>Source</small><strong>${esc(upstream && upstream.fullName || 'Unknown upstream')}</strong></div><div class="metric-row">${forkStatus}</div>` : '<div class="metric-row"><span class="metric success">● Source repository</span></div>'}<div class="secondary">${data.release ? 'Latest ' + esc(data.release.tag || data.release.name) : 'No release or tag found'}</div></section>
      <article class="card clickable commit-card" role="button" tabindex="0" data-commit><h2>Latest Commit · ${esc(data.selectedBranch || '')}</h2><div class="primary commit-message"><span class="sha">${esc(commit.sha || '—')}</span>${esc(commit.message || 'No commit data')}</div><div class="secondary">${esc(commit.author || 'unknown')} · ${esc(relative(commit.date))}</div></article>
      <article class="card clickable pull-card" role="button" tabindex="0" data-go="pulls"><h2>Pull Requests</h2><div class="primary">${pulls.open} Open</div><div class="metric-row"><span class="metric ${pulls.drafts ? 'warning' : 'success'}">${pulls.drafts || 0} draft</span><span class="metric success">${pulls.ready || 0} ready</span></div><div class="card-preview">${pulls.failing ? '✕ ' + pulls.failing + (pulls.attentionSampled ? ' recent PRs with failing checks' : ' failing checks') : pulls.running ? '● ' + pulls.running + (pulls.attentionSampled ? ' recent PRs with checks running' : ' checks running') : pulls.reviewRequested ? '◌ ' + pulls.reviewRequested + ' review requested' : pulls.attentionSampled ? 'Latest PRs have no alerts' : 'No PR attention needed'}</div></article>
      <article class="card clickable actions-card" role="button" tabindex="0" data-go="actions"><h2>Actions</h2><div class="primary">${actions.running ? actions.running + ' Running' : latest ? esc(latest.workflowName) : 'No workflow runs'}</div><div class="metric-row">${actions.running ? '<span class="metric info">● Active now</span>' : latest ? statusPill(latest.status) + '<span class="metric">' + esc(duration(latest.durationMs)) + '</span>' : ''}</div><div class="card-preview">${actions.failed || 0} recently failed · ${actions.successful || 0} recently successful</div></article>
    </div>`;
    content.querySelectorAll('[data-go]').forEach(card => {
      card.onclick = () => switchView(card.dataset.go);
      card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); } };
    });
    const commitCard = content.querySelector('[data-commit]');
    if (commitCard) {
      commitCard.onclick = () => openCommitDetail(commit, data.selectedBranch);
      commitCard.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); commitCard.click(); } };
    }
  }

  function pullRowState(item) {
    if (item.checks && item.checks.failed) return { key:'failure', label:'Checks failed' };
    if (item.review && item.review.state === 'changes_requested') return { key:'failure', label:'Changes requested' };
    if (item.checks && item.checks.pending) return { key:'running', label:'Checks running' };
    if (item.review && item.review.state === 'review_requested') return { key:'running', label:'Review requested' };
    if (item.review && item.review.state === 'approved') return { key:'success', label:'Approved' };
    if (!item.review && !item.checks) return { key:item.draft ? 'neutral' : 'unknown', label:item.draft ? 'Draft' : 'Open' };
    return { key:item.draft ? 'neutral' : 'success', label:item.draft ? 'Draft' : 'Ready' };
  }
  function renderPullCheck(check, index) {
    const selectable = !!check.runId;
    const tag = selectable ? 'button' : 'div';
    return `<${tag} class="check-row ${check.status.key}"${selectable ? ` type="button" data-check="${index}"` : ''}><span class="check-icon">${statusIcon(check.status)}</span><span><strong>${esc(check.name)}</strong><small>${esc(check.app || check.type)}${check.runNumber ? ' · run #' + check.runNumber : ''}</small></span>${selectable ? '<span>›</span>' : ''}</${tag}>`;
  }
  function renderCheckDetail(selected, check) {
    return `<div class="pr-check-detail"><div class="detail-heading"><button id="backToPull" class="compact-button" type="button">← PR #${selected.number}</button>${statusPill(check.status)}</div><h2>${esc(check.name)}</h2><div class="detail-stat"><span>Provider</span><strong>${esc(check.app || check.type)}</strong></div><div class="detail-stat"><span>Run</span><strong>${check.runNumber ? '#' + check.runNumber : 'Unavailable'}</strong></div><div class="detail-stat"><span>Duration</span><strong>${esc(duration(check.durationMs))}</strong></div><div class="detail-actions">${check.runId ? '<button id="viewCheckRun" type="button">View Run</button>' : ''}<button id="openCheck" type="button">Open in GitHub</button></div></div>`;
  }
  function renderPullDetail(selected) {
    const checks = selected.checks || { items:[], total:0 };
    const review = selected.review || { state:'pending', items:[] };
    const reviewItems = (review.items || []).slice(0, 4).map(item => `<span>${esc(item.reviewer)} · ${esc(item.state.replace(/_/g, ' '))}</span>`).join('');
    return `<div class="pr-detail"><div class="pr-detail-header"><div><h2>#${selected.number} ${esc(selected.title)}</h2><div class="row-meta"><span>${esc(selected.author)}</span><span>${esc(selected.headRef)} → ${esc(selected.baseRef)}</span></div></div>${statusPill({ key:selected.draft ? 'neutral' : 'success', label:selected.draft ? 'Draft' : 'Open' })}</div><div class="pr-stats"><span><strong class="success">+${selected.additions || 0}</strong> additions</span><span><strong class="danger-text">−${selected.deletions || 0}</strong> deletions</span><span><strong>${selected.changedFiles || 0}</strong> files</span><span><strong>${selected.comments + selected.reviewComments}</strong> comments</span><span><strong>${selected.reviewCount || 0}</strong> reviews</span><span>${esc(mergeLabel(selected))}</span></div><div class="pr-detail-columns"><section><h3>Reviews · ${esc(reviewLabel(review))}</h3><div class="review-summary">${reviewItems || '<span>No submitted reviews</span>'}</div></section><section><h3>Checks · ${checks.success || 0}/${checks.total || 0} passing</h3><div class="checks-list">${(checks.items || []).map(renderPullCheck).join('') || '<div class="small-empty">No checks reported.</div>'}</div></section></div><div class="detail-actions"><button id="openPull" type="button">Open PR in GitHub</button></div></div>`;
  }
  function renderPulls(data) {
    const items = data.items || [], selected = state.selectedPull && state.selectedPull.item;
    state.currentUrl = selected && selected.url || repoUrl() + '/pulls';
    const rows = items.map(item => {
      const rowState = pullRowState(item);
      return `<button type="button" class="list-row ${selected && selected.number === item.number ? 'selected' : ''}" data-pr="${item.number}"${selected && selected.number === item.number ? ' aria-current="true"' : ''}><span><span class="row-title">#${item.number} ${esc(item.title)}</span><span class="row-meta"><span>${esc(item.author)}</span><span>${item.draft ? 'Draft' : 'Open'}</span><span>◌ ${item.comments + item.reviewComments}</span><span>${esc(relative(item.updatedAt))}</span></span></span>${statusPill(rowState)}</button>`;
    }).join('');
    const selectedCheck = selected && state.selectedCheck != null && selected.checks && selected.checks.items[state.selectedCheck];
    const detail = selectedCheck ? renderCheckDetail(selected, selectedCheck) : selected ? renderPullDetail(selected) : '<div class="empty">Tap a pull request for reviews and checks.</div>';
    content.innerHTML = `<div class="split-view"><section class="list-panel"><div class="panel-title">Open Pull Requests · ${items.length}</div><div class="scroll-list">${rows || '<div class="empty">No open pull requests.</div>'}</div></section><section class="detail-panel">${detail}</section></div>`;
    content.querySelectorAll('[data-pr]').forEach(row => { row.onclick = () => loadPull(row.dataset.pr); });
    content.querySelectorAll('[data-check]').forEach(row => { row.onclick = () => { state.selectedCheck = Number(row.dataset.check); renderPulls(data); }; });
    const back = $('backToPull'); if (back) back.onclick = () => { state.selectedCheck = null; renderPulls(data); };
    const openPull = $('openPull'); if (openPull) openPull.onclick = () => openExternal(selected.url);
    const openCheck = $('openCheck'); if (openCheck) openCheck.onclick = () => openExternal(selectedCheck.runUrl || selectedCheck.url);
    const viewCheckRun = $('viewCheckRun'); if (viewCheckRun) viewCheckRun.onclick = () => loadRun(selectedCheck.runId, 'pulls');
  }

  function renderIssueLabels(labels, limit) {
    const values = Array.isArray(labels) ? labels : [];
    const shown = values.slice(0, limit);
    const rendered = shown.map(label => {
      const color = /^[0-9a-f]{6}$/i.test(label && label.color || '') ? label.color : '6e7781';
      const foreground = label && label.foreground === '#000000' ? '#000000' : '#ffffff';
      return `<span class="issue-label" style="background:#${color};color:${foreground}">${esc(label && label.name || 'label')}</span>`;
    }).join('');
    return rendered + (values.length > shown.length ? `<span class="issue-label-more">+${values.length - shown.length}</span>` : '');
  }

  function issueStatus(item) {
    return item.state === 'closed'
      ? { key:'neutral', label:item.stateReason === 'not_planned' ? 'Not planned' : 'Closed' }
      : { key:'success', label:'Open' };
  }

  function issueEmpty(filter) {
    if (filter === 'assigned') return '<div class="empty"><div><strong>Nothing assigned to you</strong>There are no open issues assigned to your GitHub account.</div></div>';
    if (filter === 'closed') return '<div class="empty"><div><strong>No recently closed issues</strong>No closed issues were returned for this repository.</div></div>';
    return '<div class="empty"><div><strong>No open issues</strong>This repository currently has no open issues.</div></div>';
  }

  function renderIssueDetail(selected) {
    if (state.issueDetailError) return `<div class="empty"><div><strong>Issue unavailable</strong>${esc(state.issueDetailError.error || 'This issue could not be loaded.')}</div></div>`;
    if (!selected) return '<div class="empty"><div><strong>Select an issue</strong>Tap an issue to read its details.</div></div>';
    if (state.selectedIssue && state.selectedIssue.loading) return '<div class="loading">Loading issue detail…</div>';
    const assignees = selected.assignees && selected.assignees.length ? selected.assignees.join(', ') : 'Unassigned';
    const milestone = selected.milestone ? selected.milestone.title : 'No milestone';
    const body = selected.body ? esc(selected.body) : 'No description provided.';
    return `<div class="issue-detail"><div class="issue-detail-header"><div><h2>#${selected.number} ${esc(selected.title)}</h2><div class="issue-detail-meta"><span>Opened by ${esc(selected.author)}</span><span>${esc(relative(selected.createdAt))}</span><span>Updated ${esc(relative(selected.updatedAt))}</span></div></div>${statusPill(issueStatus(selected))}</div><div class="issue-labels">${renderIssueLabels(selected.labels, 5)}</div><div class="issue-detail-meta"><span>Assignees · ${esc(assignees)}</span><span>Milestone · ${esc(milestone)}</span></div><div class="issue-body-scroll"><div class="issue-body">${body}</div></div><div class="issue-comments">${selected.comments} comment${selected.comments === 1 ? '' : 's'} · Open in GitHub to view discussion</div><div class="detail-actions"><button id="openIssue" type="button">Open Issue in GitHub</button></div></div>`;
  }

  function renderIssues(data) {
    const items = data.items || [];
    const selected = state.selectedIssue && state.selectedIssue.item;
    state.currentUrl = selected && selected.url || repoUrl() + '/issues';
    const filters = [['open','Open'],['assigned','Assigned to me'],['closed','Closed']].map(([key, label]) => `<button type="button" data-issue-filter="${key}" class="${state.issueFilter === key ? 'selected' : ''}"${state.issueFilter === key ? ' aria-pressed="true"' : ''}>${label}</button>`).join('');
    const rows = items.map(item => `<button type="button" class="list-row issue-row ${selected && selected.number === item.number ? 'selected' : ''}" data-issue="${item.number}"${selected && selected.number === item.number ? ' aria-current="true"' : ''}><span><span class="row-title">#${item.number} ${esc(item.title)}</span><span class="row-meta"><span>${esc(item.author)}</span><span>◌ ${item.comments}</span><span>${item.assignees && item.assignees.length ? 'Assigned' : 'Unassigned'}</span><span>${esc(relative(item.updatedAt))}</span></span><span class="issue-labels">${renderIssueLabels(item.labels, 3)}</span></span>${statusPill(issueStatus(item))}</button>`).join('');
    const more = data.hasMore ? '<button type="button" class="load-more" id="loadMoreIssues">Load More Issues</button>' : '';
    const listContent = rows || (data.hasMore ? '<div class="small-empty">No issues on this page. Load more to continue.</div>' : issueEmpty(state.issueFilter));
    content.innerHTML = `<div class="split-view"><section class="list-panel issues-list-panel"><div class="issues-toolbar"><div class="panel-title">Issues · ${items.length}${data.hasMore ? '+' : ''}</div><div class="issue-filters" role="group" aria-label="Issue filter">${filters}</div></div><div class="scroll-list issue-scroll-list">${listContent}${more}</div></section><section class="detail-panel">${renderIssueDetail(selected)}</section></div>`;
    content.querySelectorAll('[data-issue-filter]').forEach(button => { button.onclick = () => setIssueFilter(button.dataset.issueFilter); });
    content.querySelectorAll('[data-issue]').forEach(row => { row.onclick = () => loadIssue(row.dataset.issue, false); });
    const loadMore = $('loadMoreIssues'); if (loadMore) loadMore.onclick = loadMoreIssues;
    const openIssue = $('openIssue'); if (openIssue) openIssue.onclick = () => openExternal(selected.url);
    const list = content.querySelector('.issue-scroll-list'); if (list) window.TouchDragScroll.attach(list);
    const bodyScroll = content.querySelector('.issue-body-scroll'); if (bodyScroll) window.TouchDragScroll.attach(bodyScroll);
  }

  function renderActions(data) {
    state.currentUrl = repoUrl() + '/actions';
    const workflows = (data.workflows || []).map(item => `<div class="list-row static-row"><div><div class="row-title">${esc(item.name)}</div><div class="row-meta"><span>${esc(item.state)}</span><span>${esc(item.path)}</span>${item.lastRun ? `<span>${statusIcon(item.lastRun.status)} ${esc(item.lastRun.status.label)} · ${esc(relative(item.lastRun.updatedAt))}</span>` : ''}</div></div><button class="compact-button" type="button" data-dispatch="${item.id}" data-name="${esc(item.name)}">Run</button></div>`).join('');
    const runs = (data.runs || []).map(item => `<button type="button" class="list-row" data-run="${item.id}"><span><span class="row-title">${esc(item.workflowName)} · #${item.runNumber || '—'}</span><span class="row-meta"><span>${esc(item.branch || 'no branch')}</span><span>${esc(item.event || 'event unknown')}</span><span>${esc(duration(item.durationMs))}</span><span>${esc(relative(item.updatedAt))}</span></span></span>${statusPill(item.status)}</button>`).join('');
    content.innerHTML = `<div class="actions-view"><section class="list-panel"><div class="panel-title">Workflows · run on ${esc(data.branch)}</div><div class="scroll-list">${workflows || '<div class="empty">No workflows found.</div>'}</div></section><section class="list-panel"><div class="panel-title">Recent Runs</div><div class="scroll-list">${runs || '<div class="empty">No workflow runs found.</div>'}</div></section></div>`;
    content.querySelectorAll('[data-run]').forEach(row => { row.onclick = () => loadRun(row.dataset.run, 'actions'); });
    content.querySelectorAll('[data-dispatch]').forEach(button => { button.onclick = event => { event.stopPropagation(); openDispatch(Number(button.dataset.dispatch), button.dataset.name, data.branch); }; });
  }

  function renderRun(result) {
    const run = result.item, jobs = run.jobs || [], selected = jobs[state.selectedJob] || jobs[0] || null;
    state.currentUrl = run.url || repoUrl() + '/actions';
    const jobRows = jobs.map((job, index) => `<button type="button" class="list-row ${index === state.selectedJob ? 'selected' : ''}" data-job="${index}"${index === state.selectedJob ? ' aria-current="true"' : ''}><span><span class="row-title">${esc(job.name)}</span><span class="row-meta"><span>${esc(duration(job.durationMs))}</span></span></span>${statusPill(job.status)}</button>`).join('');
    const steps = selected ? selected.steps.map(step => `<div class="step-row ${step.status.key}"><span class="step-icon">${statusIcon(step.status)}</span><strong>${esc(step.name)}</strong><span>${esc(duration(step.durationMs))}</span></div>`).join('') : '<div class="empty">No job selected.</div>';
    const attention = run.failure ? `<div class="failure-banner"><strong>Failed · ${esc(run.failure.jobName)}</strong><span>${run.failure.stepName ? 'Step: ' + esc(run.failure.stepName) : 'Open GitHub for full logs'}</span></div>` : run.active ? `<div class="active-banner"><strong>Running · ${esc(run.active.jobName)}</strong><span>${run.active.stepName ? 'Step: ' + esc(run.active.stepName) : 'Waiting for step data'}</span></div>` : '';
    const artifacts = (run.artifacts || []).map(item => `<div class="artifact-row"><span><strong>${esc(item.name)}</strong><small>${esc(bytes(item.sizeBytes))}${item.expired ? ' · Expired' : item.expiresAt ? ' · expires ' + esc(relative(item.expiresAt)) : ''}</small></span><button type="button" data-artifact="${item.id}" ${item.expired ? 'disabled' : ''}>Download</button></div>`).join('');
    const controls = `${run.controls && run.controls.rerunFailed ? '<button data-run-action="rerun-failed" type="button">↻ Rerun Failed</button>' : ''}${run.controls && run.controls.rerun ? '<button data-run-action="rerun" type="button">↻ Rerun All</button>' : ''}${run.controls && run.controls.cancel ? '<button data-run-action="cancel" class="danger" type="button">■ Cancel Run</button>' : ''}<button id="openRun" type="button">↗ ${run.failure ? 'Open Full Logs' : 'Open in GitHub'}</button>`;
    content.innerHTML = `<div class="run-view"><section class="run-main"><div class="list-panel"><div class="panel-title"><button id="backToRuns" class="compact-button" type="button">← ${state.runBack === 'pulls' ? 'Pull Request' : 'Actions'}</button></div><div class="run-summary"><strong>${esc(run.workflowName)} #${run.runNumber || ''}</strong><span>${esc(run.branch || 'no branch')} · ${esc(run.event || 'unknown trigger')} · ${esc(run.actor || 'unknown actor')}</span><span class="sha">${esc((run.headSha || '').slice(0, 7) || '—')}</span></div><div class="job-list">${jobRows || '<div class="empty">No jobs returned.</div>'}</div></div><div class="detail-panel run-detail">${attention}<h2>${esc(selected ? selected.name : run.name)}</h2><div class="step-list">${steps}</div></div></section><aside class="run-controls">${statusPill(run.status)}<div class="run-duration">${esc(duration(run.durationMs))}</div>${controls}${artifacts ? `<h3>Artifacts</h3><div class="artifact-list">${artifacts}</div>` : run.status.key !== 'running' ? '<div class="small-empty">No artifacts</div>' : ''}</aside></div>`;
    $('backToRuns').onclick = backFromRun;
    $('openRun').onclick = () => openExternal(run.url);
    content.querySelectorAll('[data-job]').forEach(row => { row.onclick = () => { state.selectedJob = Number(row.dataset.job); renderRun(result); }; });
    content.querySelectorAll('[data-run-action]').forEach(button => {
      button.onclick = () => {
        const action = button.dataset.runAction;
        const label = action === 'cancel' ? 'Cancel workflow run' : action === 'rerun-failed' ? 'Rerun failed jobs' : 'Rerun all jobs';
        confirmAction(label, label + ' for ' + run.workflowName + ' #' + run.runNumber + '?', action === 'cancel' ? 'Cancel run' : 'Rerun').then(ok => { if (ok) performAction(action, { runId:run.id }); });
      };
    });
    content.querySelectorAll('[data-artifact]').forEach(button => { button.onclick = () => performAction('download-artifact', { artifactId:Number(button.dataset.artifact) }); });
  }

  function closeDispatch() { $('dispatchOverlay').hidden = true; $('dispatchFields').innerHTML = ''; }
  async function openDispatch(workflowId, name, ref) {
    $('dispatchTitle').textContent = 'Run ' + name;
    $('dispatchRef').textContent = 'Branch · ' + ref;
    $('dispatchFields').innerHTML = '<div class="loading">Reading workflow inputs…</div>';
    $('dispatchOverlay').hidden = false;
    try {
      const result = await api('workflow', { query:{ id:workflowId, ref, repository:state.settings.repository } });
      if (!result.ok) throw new Error(result.error || 'Could not read workflow metadata');
      if (!result.hasDispatch) { closeDispatch(); notify('This workflow does not support manual dispatch', true); return; }
      if (!result.supported) { closeDispatch(); notify(result.reason || 'Workflow inputs must be entered in GitHub', true); return; }
      if (!result.inputs.length) {
        closeDispatch();
        const ok = await confirmAction('Run workflow', 'Run ' + name + ' on ' + ref + '?', 'Run');
        if (ok) performAction('dispatch', { workflowId, ref, inputs:{} });
        return;
      }
      $('dispatchFields').innerHTML = result.inputs.map(item => {
        const id = 'dispatch-' + item.name.replace(/[^A-Za-z0-9_-]/g, '-');
        const label = `${esc(item.name)}${item.required ? ' *' : ''}`;
        if (item.type === 'boolean') return `<label class="dispatch-toggle" for="${id}"><span><strong>${label}</strong><small>${esc(item.description || 'On or off')}</small></span><input id="${id}" data-input-name="${esc(item.name)}" data-input-type="boolean" type="checkbox" ${item.default === true || item.default === 'true' ? 'checked' : ''}></label>`;
        if (item.type === 'choice') return `<label class="dispatch-field" for="${id}"><strong>${label}</strong><small>${esc(item.description)}</small><select id="${id}" data-input-name="${esc(item.name)}" data-input-type="choice">${item.options.map(option => `<option value="${esc(option)}" ${String(item.default) === option ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select></label>`;
        return `<label class="dispatch-field" for="${id}"><strong>${label}</strong><small>${esc(item.description || (item.type === 'environment' ? 'GitHub environment name' : 'Workflow input'))}</small><input id="${id}" data-input-name="${esc(item.name)}" data-input-type="${esc(item.type)}" type="text" maxlength="1024" value="${esc(item.default)}" ${item.required ? 'required' : ''}></label>`;
      }).join('');
      $('dispatchForm').dataset.workflowId = workflowId;
      $('dispatchForm').dataset.ref = ref;
    } catch (error) { closeDispatch(); notify(error.message, true); }
  }

  async function loadCurrent(silent, forceRefresh) {
    if (!state.settings || !state.settings.connected) { disconnectedView(); updateHeader(); return; }
    if (!state.settings.repository) { state.currentUrl = ''; content.innerHTML = '<div class="empty"><div><strong>Choose a repository</strong><br>Use the repository selector in the header to browse your accessible repositories.</div></div>'; updateHeader(); return; }
    if (state.view === 'run') return refreshRun(silent);
    if (state.loading) return;
    const version = state.requestVersion;
    const repository = state.settings.repository;
    const view = state.view;
    state.loading = true; state.stale = false; updateHeader();
    if (!silent && !state.data) loading('Loading ' + (view === 'pulls' ? 'pull requests' : view === 'actions' ? 'workflows' : view === 'issues' ? 'issues' : 'repository status') + '…');
    $('refreshButton').disabled = true;
    try {
      const operation = view === 'pulls' ? 'pulls' : view === 'actions' ? 'actions' : view === 'issues' ? 'issues' : 'overview';
      const query = { repository };
      if (view === 'issues') { query.filter = state.issueFilter; query.page = 1; if (forceRefresh) query.refresh = '1'; }
      const selectedIssueNumber = view === 'issues' && state.selectedIssue && state.selectedIssue.item && state.selectedIssue.item.number;
      const result = await api(operation, { query });
      if (!currentRequest(version, repository) || state.view !== view) return;
      if (!result.ok) { if (silent || state.data) { state.stale = true; notify(result.error || 'GitHub refresh failed', true); } else errorView(result); return; }
      state.data = result; state.fetchedAt = result.fetchedAt || new Date().toISOString(); state.stale = false;
      if (result.selectedBranch) state.settings.branch = result.selectedBranch; else if (result.branch) state.settings.branch = result.branch;
      if (view === 'overview') renderOverview(result); else if (view === 'pulls') renderPulls(result); else if (view === 'issues') renderIssues(result); else renderActions(result);
      if (view === 'issues' && selectedIssueNumber) await loadIssue(selectedIssueNumber, !!forceRefresh);
    } catch (error) {
      if (!currentRequest(version, repository)) return;
      if (silent || state.data) { state.stale = true; notify(error.message, true); } else errorView({ error:error.message, code:'panel_error' });
    } finally {
      if (currentRequest(version, repository)) { state.loading = false; $('refreshButton').disabled = false; updateHeader(); schedulePoll(); }
    }
  }

  async function loadPull(number) {
    const version = state.requestVersion, repository = state.settings.repository;
    loading('Loading pull request detail…');
    try {
      const result = await api('pull', { query:{ number, repository } });
      if (!currentRequest(version, repository) || state.view !== 'pulls') return;
      if (!result.ok) return errorView(result);
      state.selectedPull = result; state.selectedCheck = null; state.fetchedAt = result.fetchedAt; state.stale = false;
      renderPulls(state.data); updateHeader();
    } catch (error) { if (currentRequest(version, repository)) errorView({ error:error.message, code:'panel_error' }); }
  }

  async function loadIssue(number, forceRefresh) {
    const version = state.requestVersion, repository = state.settings.repository, filter = state.issueFilter;
    const summary = state.data && (state.data.items || []).find(item => item.number === Number(number));
    state.selectedIssue = { item: summary || { number:Number(number), title:'Issue' }, loading:true };
    state.issueDetailError = null;
    if (state.data) renderIssues(state.data);
    try {
      const result = await api('issue', { query:{ number, repository, refresh:forceRefresh ? '1' : '0' } });
      if (!currentRequest(version, repository) || state.view !== 'issues' || state.issueFilter !== filter) return;
      if (!result.ok) {
        state.selectedIssue = null;
        state.issueDetailError = result;
        state.stale = true;
        renderIssues(state.data || { items:[], hasMore:false });
        notify(result.error || 'Issue detail could not be loaded', true);
        return;
      }
      state.selectedIssue = result; state.issueDetailError = null; state.fetchedAt = result.fetchedAt; state.stale = false;
      renderIssues(state.data); updateHeader();
    } catch (error) {
      if (currentRequest(version, repository) && state.view === 'issues' && state.issueFilter === filter) {
        state.selectedIssue = null; state.issueDetailError = { error:error.message }; state.stale = true;
        renderIssues(state.data || { items:[], hasMore:false }); updateHeader();
      }
    }
  }

  function setIssueFilter(filter) {
    if (!['open', 'assigned', 'closed'].includes(filter) || filter === state.issueFilter) return;
    state.requestVersion += 1; state.loading = false; state.data = null; state.issueFilter = filter;
    state.selectedIssue = null; state.issueDetailError = null; loadCurrent();
  }

  async function loadMoreIssues() {
    if (state.loading || !state.data || !state.data.hasMore) return;
    const version = state.requestVersion, repository = state.settings.repository, filter = state.issueFilter;
    state.loading = true; $('refreshButton').disabled = true; updateHeader();
    try {
      const result = await api('issues', { query:{ repository, filter, page:(state.data.page || 1) + 1 } });
      if (!currentRequest(version, repository) || state.view !== 'issues' || state.issueFilter !== filter) return;
      if (!result.ok) { state.stale = true; notify(result.error || 'Could not load more issues', true); return; }
      state.data = window.GitHubPanelState.mergeIssuePage(state.data, result);
      state.fetchedAt = result.fetchedAt; state.stale = false; renderIssues(state.data);
    } catch (error) {
      if (currentRequest(version, repository)) { state.stale = true; notify(error.message, true); }
    } finally {
      if (currentRequest(version, repository)) { state.loading = false; $('refreshButton').disabled = false; updateHeader(); schedulePoll(); }
    }
  }

  async function loadRun(id, back) {
    const version = state.requestVersion, repository = state.settings.repository;
    state.view = 'run'; state.runBack = back || state.runBack || 'actions'; state.selectedJob = 0;
    loading('Loading jobs and steps…'); updateHeader();
    try {
      const result = await api('run', { query:{ id, repository } });
      if (!currentRequest(version, repository) || state.view !== 'run') return;
      if (!result.ok) return errorView(result);
      state.selectedRun = result; state.selectedJob = result.item.preferredJobIndex || 0; state.fetchedAt = result.fetchedAt; state.stale = false;
      renderRun(result); updateHeader(); schedulePoll();
    } catch (error) { if (currentRequest(version, repository)) errorView({ error:error.message, code:'panel_error' }); }
  }

  async function refreshRun(silent) {
    const runId = state.selectedRun && state.selectedRun.item && state.selectedRun.item.id;
    if (!runId || state.loading) return;
    const version = state.requestVersion, repository = state.settings.repository;
    state.loading = true; updateHeader();
    try {
      const result = await api('run', { query:{ id:runId, repository } });
      if (!currentRequest(version, repository) || state.view !== 'run') return;
      if (!result.ok) { state.stale = true; if (!silent) notify(result.error, true); return; }
      state.selectedRun = result; state.fetchedAt = result.fetchedAt; state.stale = false;
      if (state.selectedJob >= result.item.jobs.length) state.selectedJob = result.item.preferredJobIndex || 0;
      renderRun(result);
    } catch (error) { if (currentRequest(version, repository)) { state.stale = true; if (!silent) notify(error.message, true); } }
    finally { if (currentRequest(version, repository)) { state.loading = false; updateHeader(); schedulePoll(); } }
  }

  async function performAction(action, payload) {
    try {
      const result = await api('action', { method:'POST', body:Object.assign({ action, repository:state.settings.repository }, payload) });
      if (!result.ok) return notify(result.error || 'GitHub action failed', true);
      if (action === 'download-artifact') { notify('Artifact download started'); return; }
      notify(action === 'cancel' ? 'Cancel requested' : action === 'dispatch' ? 'Workflow started' : 'Rerun requested');
      if (action === 'dispatch' && result.runId) return loadRun(result.runId, 'actions');
      if (state.view === 'run') await refreshRun(true); else await loadCurrent(true);
      setTimeout(() => { if (state.view === 'run') refreshRun(true); else loadCurrent(true); }, 1200);
    } catch (error) { notify(error.message, true); }
  }
  async function openExternal(url) { if (!url) return; try { const result = await api('open', { method:'POST', body:{ url, repository:state.settings.repository } }); if (!result.ok) notify(result.error || 'That GitHub link was blocked', true); } catch (error) { notify(error.message, true); } }
  function confirmAction(title, message, label) { $('confirmTitle').textContent = title; $('confirmMessage').textContent = message; $('confirmAccept').textContent = label || 'Confirm'; $('confirmOverlay').hidden = false; return new Promise(resolve => { const finish = value => { $('confirmOverlay').hidden = true; $('confirmAccept').onclick = null; $('confirmCancel').onclick = null; resolve(value); }; $('confirmAccept').onclick = () => finish(true); $('confirmCancel').onclick = () => finish(false); }); }
  function switchView(view) { state.requestVersion += 1; state.loading = false; state.view = view; state.data = null; state.selectedPull = null; state.selectedCheck = null; state.selectedRun = null; state.selectedIssue = null; state.issueDetailError = null; state.runBack = view; loadCurrent(); }
  function backFromRun() {
    state.view = state.runBack;
    state.selectedRun = null;
    if (state.data) { if (state.view === 'pulls') renderPulls(state.data); else renderActions(state.data); updateHeader(); schedulePoll(); }
    else loadCurrent();
  }
  function schedulePoll() { clearTimeout(state.timer); state.timer = null; if (document.hidden || !state.settings || !state.settings.connected) return; const running = state.view === 'run' && state.selectedRun && state.selectedRun.item.status.key === 'running'; const delay = running ? 10000 : state.view === 'actions' ? 20000 : state.view === 'issues' ? 60000 : 30000; state.timer = setTimeout(() => loadCurrent(true), delay); }

  document.querySelectorAll('.bottom-nav [data-view]').forEach(button => { button.onclick = () => switchView(button.dataset.view); });
  $('repositoryButton').onclick = () => openRepositoryBrowser(false);
  $('repositoryClose').onclick = closeRepositoryBrowser;
  $('repositoryRefresh').onclick = () => openRepositoryBrowser(true);
  $('repositorySearch').oninput = renderRepositoryList;
  window.TouchDragScroll.attach($('repositoryList'));
  $('repositoryOverlay').onclick = event => { if (event.target === $('repositoryOverlay')) closeRepositoryBrowser(); };
  $('commitClose').onclick = () => { $('commitOverlay').hidden = true; };
  $('commitOverlay').onclick = event => { if (event.target === $('commitOverlay')) $('commitOverlay').hidden = true; };
  $('dispatchClose').onclick = closeDispatch;
  $('dispatchCancel').onclick = closeDispatch;
  $('dispatchOverlay').onclick = event => { if (event.target === $('dispatchOverlay')) closeDispatch(); };
  $('dispatchForm').onsubmit = event => {
    event.preventDefault();
    const inputs = {};
    $('dispatchFields').querySelectorAll('[data-input-name]').forEach(control => { inputs[control.dataset.inputName] = control.dataset.inputType === 'boolean' ? control.checked : control.value; });
    const workflowId = Number(event.currentTarget.dataset.workflowId), ref = event.currentTarget.dataset.ref;
    closeDispatch(); performAction('dispatch', { workflowId, ref, inputs });
  };
  $('refreshButton').onclick = () => state.settings && state.settings.connected ? loadCurrent(false, true) : boot();
  $('openButton').onclick = () => openExternal(state.currentUrl);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadCurrent(true); else schedulePoll(); });
  window.oqKnob = event => {
    const selector = !$('confirmOverlay').hidden ? '#confirmOverlay button:not(:disabled)'
      : !$('dispatchOverlay').hidden ? '#dispatchOverlay input,#dispatchOverlay select,#dispatchOverlay button:not(:disabled)'
        : !$('commitOverlay').hidden ? '#commitOverlay button:not(:disabled)'
          : !$('repositoryOverlay').hidden ? '#repositoryOverlay .repository-row,#repositoryOverlay button:not(:disabled)'
            : '.topbar button:not(:disabled),.content button:not(:disabled),.content [role="button"],.bottom-nav button:not(:disabled)';
    const controls = Array.from(document.querySelectorAll(selector));
    if (!controls.length) return false;
    if (event.type === 'rotate') { state.focusIndex = (state.focusIndex + event.dir + controls.length) % controls.length; controls[state.focusIndex].focus(); return true; }
    if (event.type === 'press' && event.index === 1) { (controls[state.focusIndex] || controls[0]).click(); return true; }
    return false;
  };

  async function boot() {
    loading('Starting GitHub panel…');
    try {
      const settings = await api('settings');
      if (!settings.ok) throw new Error(settings.error || 'Could not read GitHub settings');
      state.settings = settings; state.configuredRepository = settings.repository || ''; state.view = 'overview';
      state.favourites = storedArray('open-quake.github.favourites'); state.recents = storedArray('open-quake.github.recents');
      updateHeader();
      if (settings.connected) {
        try {
          await loadRepositories(false);
          let saved = ''; try { saved = localStorage.getItem('open-quake.github.repository') || ''; } catch (error) {}
          const current = state.repositories.find(item => item.fullName.toLowerCase() === String(settings.repository || '').toLowerCase());
          const remembered = state.repositories.find(item => item.fullName.toLowerCase() === saved.toLowerCase());
          const chosen = remembered || current || state.repositories[0];
          if (chosen) { state.settings.repository = chosen.fullName; if (chosen !== current || !state.settings.branch) state.settings.branch = chosen.defaultBranch || ''; }
        } catch (error) { notify(error.message, true); }
        await loadCurrent();
      } else disconnectedView();
    } catch (error) { errorView({ error:error.message, code:'panel_error' }); }
  }
  boot();
})();
