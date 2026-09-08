'use strict';

const models = require('./githubModels');

const API_BASE = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const GITHUB_SCOPES = Object.freeze(['repo', 'offline_access']);
const GITHUB_ACCESS_SCOPES = Object.freeze(['repo']);
const REPOSITORY_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const ACTIONS = new Set(['dispatch', 'rerun-failed', 'rerun', 'cancel', 'download-artifact']);
const REPOSITORY_CACHE_MS = 60 * 1000;
const PULL_INDICATOR_CACHE_MS = 2 * 60 * 1000;
const ISSUE_LIST_CACHE_MS = 60 * 1000;
const ISSUE_DETAIL_CACHE_MS = 2 * 60 * 1000;
const ACCOUNT_CACHE_MS = 10 * 60 * 1000;
const WORKFLOW_METADATA_CACHE_MS = 2 * 60 * 1000;
const MAX_REPOSITORY_PAGES = 100;
const FORK_DETAIL_CONCURRENCY = 4;
const PULL_INDICATOR_LIMIT = 12;
const MAX_WORKFLOW_BYTES = 256 * 1024;
const MAX_DISPATCH_VALUE_LENGTH = 1024;
const ISSUE_FILTERS = new Set(['open', 'assigned', 'closed']);
const ISSUE_PAGE_SIZE = 30;

function yamlLine(value) {
  const match = /^(\s*)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:\s*(.*)$/.exec(value);
  return match ? { indent: match[1].length, key: match[2] || match[3] || match[4], value: stripYamlComment(match[5]).trim() } : null;
}

function stripYamlComment(value) {
  let quote = '';
  for (let index = 0; index < String(value || '').length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== '\\') quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index);
  }
  return String(value || '');
}

function yamlScalar(value) {
  value = stripYamlComment(value).trim();
  if (!value) return '';
  if (value[0] === '"' && value.endsWith('"')) {
    try { return JSON.parse(value); } catch (error) { return null; }
  }
  if (value[0] === "'" && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^[^{}[\],]*$/.test(value)) return value;
  return null;
}

function yamlArray(value) {
  value = stripYamlComment(value).trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  const items = body.split(',').map(item => yamlScalar(item));
  return items.some(item => item === null || typeof item === 'boolean') ? null : items.map(String);
}

function parseWorkflowDispatch(source) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > MAX_WORKFLOW_BYTES || source.includes('\t')) {
    return { supported: false, hasDispatch: false, inputs: [], reason: 'Workflow metadata is unavailable or uses unsupported YAML formatting' };
  }
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries = lines.map((raw, index) => ({ raw, index, parsed: yamlLine(raw) }));
  const onEntry = entries.find(entry => entry.parsed && entry.parsed.indent === 0 && entry.parsed.key === 'on');
  if (!onEntry) return { supported: true, hasDispatch: false, inputs: [] };
  if (onEntry.parsed.value) {
    const inline = onEntry.parsed.value;
    const events = inline.startsWith('[') ? yamlArray(inline) : [yamlScalar(inline)];
    if (!events) return { supported: false, hasDispatch: false, inputs: [], reason: 'Workflow event metadata uses unsupported inline YAML' };
    return { supported: true, hasDispatch: events.map(String).includes('workflow_dispatch'), inputs: [] };
  }
  const onEnd = entries.findIndex(entry => entry.index > onEntry.index && entry.parsed && entry.parsed.indent <= onEntry.parsed.indent);
  const onBlock = entries.slice(onEntry.index + 1, onEnd < 0 ? entries.length : onEnd);
  const dispatchEntry = onBlock.find(entry => entry.parsed && entry.parsed.key === 'workflow_dispatch');
  if (!dispatchEntry) return { supported: true, hasDispatch: false, inputs: [] };
  if (dispatchEntry.parsed.value && dispatchEntry.parsed.value !== '{}') {
    return { supported: false, hasDispatch: true, inputs: [], reason: 'workflow_dispatch uses unsupported inline YAML' };
  }
  const dispatchEnd = onBlock.findIndex(entry => entry.index > dispatchEntry.index && entry.parsed && entry.parsed.indent <= dispatchEntry.parsed.indent);
  const dispatchBlock = onBlock.slice(onBlock.indexOf(dispatchEntry) + 1, dispatchEnd < 0 ? onBlock.length : dispatchEnd);
  const inputsEntry = dispatchBlock.find(entry => entry.parsed && entry.parsed.key === 'inputs');
  if (!inputsEntry || inputsEntry.parsed.value === '{}') return { supported: true, hasDispatch: true, inputs: [] };
  if (inputsEntry.parsed.value) return { supported: false, hasDispatch: true, inputs: [], reason: 'Workflow inputs use unsupported inline YAML' };
  const inputLines = dispatchBlock.slice(dispatchBlock.indexOf(inputsEntry) + 1);
  const meaningfulInputs = inputLines.filter(entry => entry.raw.trim() && !entry.raw.trim().startsWith('#'));
  if (!meaningfulInputs.length) return { supported: true, hasDispatch: true, inputs: [] };
  const inputIndent = Math.min(...meaningfulInputs.map(entry => /^\s*/.exec(entry.raw)[0].length));
  if (meaningfulInputs.some(entry => /^\s*/.exec(entry.raw)[0].length === inputIndent && (!entry.parsed || entry.parsed.indent !== inputIndent))) {
    return { supported: false, hasDispatch: true, inputs: [], reason: 'Workflow input names use unsupported YAML' };
  }
  const definitions = [];
  let current = null;
  for (let offset = 0; offset < inputLines.length; offset += 1) {
    const entry = inputLines[offset];
    const parsed = entry.parsed;
    if (!parsed || parsed.indent <= inputsEntry.parsed.indent) continue;
    if (parsed.indent === inputIndent) {
      if (parsed.value && parsed.value !== '{}') return { supported: false, hasDispatch: true, inputs: [], reason: 'Workflow input definitions use unsupported inline YAML' };
      current = { name: parsed.key, description: '', required: false, type: 'string', default: '', options: [] };
      definitions.push(current);
      continue;
    }
    if (!current || parsed.indent <= inputIndent) continue;
    if (parsed.key === 'options') {
      if (parsed.value) {
        const options = yamlArray(parsed.value);
        if (!options) return { supported: false, hasDispatch: true, inputs: [], reason: 'Workflow choices use unsupported YAML' };
        current.options = options;
      } else {
        const options = [];
        for (let optionOffset = offset + 1; optionOffset < inputLines.length; optionOffset += 1) {
          const optionLine = inputLines[optionOffset];
          const indent = /^\s*/.exec(optionLine.raw)[0].length;
          if (optionLine.raw.trim() && indent <= parsed.indent) break;
          const match = /^\s*-\s+(.+)$/.exec(optionLine.raw);
          if (match) {
            const option = yamlScalar(match[1]);
            if (option === null || typeof option === 'boolean') return { supported: false, hasDispatch: true, inputs: [], reason: 'Workflow choices use unsupported YAML' };
            options.push(String(option));
            offset = optionOffset;
          }
        }
        current.options = options;
      }
      continue;
    }
    if (!['description', 'required', 'type', 'default'].includes(parsed.key)) continue;
    const scalar = yamlScalar(parsed.value);
    if (scalar === null) return { supported: false, hasDispatch: true, inputs: [], reason: 'Workflow input metadata uses unsupported YAML' };
    if (parsed.key === 'required') {
      if (typeof scalar !== 'boolean') return { supported: false, hasDispatch: true, inputs: [], reason: 'Workflow input required state is invalid' };
      current.required = scalar;
    } else current[parsed.key] = scalar;
  }
  if (definitions.length > 25 || definitions.some(item => !item.name || !['boolean', 'choice', 'environment', 'string'].includes(String(item.type)))) {
    return { supported: false, hasDispatch: true, inputs: [], reason: 'Workflow input metadata is unsupported' };
  }
  if (definitions.some(item => item.type === 'choice' && !item.options.length)) {
    return { supported: false, hasDispatch: true, inputs: [], reason: 'A workflow choice has no readable options' };
  }
  return { supported: true, hasDispatch: true, inputs: definitions };
}

function validateDispatchInputs(definitions, values) {
  const result = {};
  values = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  const allowed = new Set((Array.isArray(definitions) ? definitions : []).map(item => item.name));
  if (Object.keys(values).some(key => !allowed.has(key))) throw Object.assign(new Error('Workflow inputs contain an unknown field'), { code: 'invalid_workflow_inputs' });
  (Array.isArray(definitions) ? definitions : []).forEach(item => {
    let value = Object.hasOwn(values, item.name) ? values[item.name] : item.default;
    if (item.type === 'boolean') {
      if (value === '' || value == null) value = false;
      if (value !== true && value !== false && value !== 'true' && value !== 'false') throw Object.assign(new Error(item.name + ' must be true or false'), { code: 'invalid_workflow_inputs' });
      value = value === true || value === 'true';
    } else {
      value = value == null ? '' : String(value);
      if (value.length > MAX_DISPATCH_VALUE_LENGTH) throw Object.assign(new Error(item.name + ' is too long'), { code: 'invalid_workflow_inputs' });
      if (item.type === 'choice' && !item.options.includes(value)) throw Object.assign(new Error(item.name + ' must be one of the workflow choices'), { code: 'invalid_workflow_inputs' });
    }
    if (item.required && (value === '' || value == null)) throw Object.assign(new Error(item.name + ' is required'), { code: 'invalid_workflow_inputs' });
    result[item.name] = value;
  });
  return result;
}

function normalizeSettings(value) {
  value = value && typeof value === 'object' ? value : {};
  return {
    clientId: typeof value.clientId === 'string' ? value.clientId.trim() : '',
    repository: typeof value.repository === 'string' ? value.repository.trim() : '',
    branch: typeof value.branch === 'string' ? value.branch.trim() : '',
  };
}

function normalizeClientId(value) {
  const clientId = String(value || '').trim();
  if (clientId && (clientId.length > 200 || !/^[A-Za-z0-9._-]+$/.test(clientId))) {
    throw Object.assign(new Error('GitHub OAuth App client ID is invalid'), { code: 'invalid_client_id' });
  }
  return clientId;
}

function parseRepository(value) {
  const match = REPOSITORY_RE.exec(String(value || '').trim());
  if (!match || match[2] === '.' || match[2] === '..' || match[2].endsWith('.git')) throw Object.assign(new Error('Repository must be written as owner/name'), { code: 'invalid_repository' });
  return { owner: match[1], repo: match[2], fullName: match[1] + '/' + match[2] };
}

function validRef(value) {
  const ref = String(value || '').trim();
  if (!ref || ref.length > 255 || /[\x00-\x20~^:?*\\[]/.test(ref) || ref.startsWith('-') || ref.endsWith('/') || ref.includes('..') || ref.includes('@{')) throw Object.assign(new Error('Branch or tag is invalid'), { code: 'invalid_ref' });
  return ref;
}

function resultError(error) {
  return { ok: false, error: error && error.message || 'GitHub request failed', code: error && error.code || 'github_error', resetAt: error && error.resetAt || null };
}

function nextApiPath(linkHeader) {
  const part = String(linkHeader || '').split(',').find(value => /;\s*rel="next"\s*$/.test(value.trim()));
  const match = part && /<([^>]+)>/.exec(part);
  if (!match) return '';
  try {
    const url = new URL(match[1]);
    if (url.origin !== API_BASE || url.username || url.password) return '';
    return url.pathname + url.search;
  } catch (error) { return ''; }
}

function repositorySummary(value) {
  if (!value || typeof value !== 'object') return null;
  let repository;
  try { repository = parseRepository(value.full_name); } catch (error) { return null; }
  const permissions = value.permissions && typeof value.permissions === 'object' ? value.permissions : {};
  return {
    fullName: repository.fullName,
    private: !!value.private,
    archived: !!value.archived,
    fork: !!value.fork,
    defaultBranch: typeof value.default_branch === 'string' ? value.default_branch : '',
    permission: permissions.admin ? 'admin' : permissions.maintain ? 'maintain' : permissions.push ? 'write' : permissions.triage ? 'triage' : 'read',
    updatedAt: typeof value.updated_at === 'string' ? value.updated_at : '',
    url: 'https://github.com/' + repository.fullName,
  };
}

class GitHubService {
  constructor({ getSettings, oauth, openExternal, fetchImpl = fetch, now = Date.now }) {
    this.getSettings = getSettings;
    this.oauth = oauth;
    this.openExternal = openExternal;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.repositoryCache = null;
    this.pullIndicatorCache = new Map();
    this.issueListCache = new Map();
    this.issueDetailCache = new Map();
    this.accountCache = null;
    this.workflowMetadataCache = new Map();
  }

  settings() { return normalizeSettings(this.getSettings && this.getSettings()); }

  publicSettings() {
    const settings = this.settings();
    const auth = this.oauth.status('github');
    const granted = Array.isArray(auth.scopes) ? auth.scopes : [];
    // GitHub uses offline_access to opt into rotating tokens but does not track or return it as a
    // normal granted scope. Only repo is an API authorization requirement after sign-in.
    const connected = !!auth.connected && GITHUB_ACCESS_SCOPES.every(scope => granted.includes(scope));
    return {
      ok: true, configured: !!settings.clientId, connected,
      clientId: settings.clientId, repository: settings.repository, branch: settings.branch,
      scopes: GITHUB_SCOPES.slice(), expiresAt: auth.expiresAt || null,
    };
  }

  async connect() {
    try {
      const settings = this.settings();
      if (!settings.clientId) throw Object.assign(new Error('Save a GitHub OAuth App client ID first'), { code: 'not_configured' });
      return await this.oauth.beginDeviceFlow('github', GITHUB_SCOPES);
    } catch (error) { return resultError(error); }
  }

  async pollConnect() {
    try {
      const result = await this.oauth.pollDeviceFlow('github');
      if (result.connected) {
        this.repositoryCache = null;
        this.pullIndicatorCache.clear();
        this.issueListCache.clear();
        this.issueDetailCache.clear();
        this.workflowMetadataCache.clear();
        try {
          const account = await this.request('/user');
          const login = String(account && account.login || '').trim();
          if (!login) throw Object.assign(new Error('GitHub did not return the authenticated account'), { code: 'invalid_response' });
          this.accountCache = { login, expiresAt: this.now() + ACCOUNT_CACHE_MS };
          result.account = { login, avatarUrl: String(account && account.avatar_url || ''), url: String(account && account.html_url || '') };
        } catch (error) {
          await this.oauth.revokeToken('github');
          throw error;
        }
      }
      return result;
    } catch (error) { return resultError(error); }
  }

  async disconnect() {
    try {
      await this.oauth.revokeToken('github');
      this.repositoryCache = null;
      this.pullIndicatorCache.clear();
      this.issueListCache.clear();
      this.issueDetailCache.clear();
      this.accountCache = null;
      this.workflowMetadataCache.clear();
      return this.publicSettings();
    }
    catch (error) { return resultError(error); }
  }

  async accessToken() {
    const token = await this.oauth.getValidAccessToken('github', GITHUB_ACCESS_SCOPES);
    if (!token || !token.accessToken) throw Object.assign(new Error('GitHub is not connected'), { code: 'authentication_required' });
    return token.accessToken;
  }

  repository(value) {
    const repository = value && typeof value === 'object' ? value.repository : value;
    return parseRepository(repository == null ? this.settings().repository : repository);
  }
  repoPath(suffix, repository) { const repo = this.repository(repository); return '/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo) + suffix; }
  branchOverride(repository) {
    const settings = this.settings();
    return settings.repository && String(settings.repository).toLowerCase() === String(repository || '').toLowerCase() ? settings.branch : '';
  }

  async request(path, options = {}) {
    const token = await this.accessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await this.fetchImpl(API_BASE + path, {
        method: options.method || 'GET', signal: controller.signal,
        headers: Object.assign({ Accept: options.accept || 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'User-Agent': 'bedrock-panel', 'X-GitHub-Api-Version': API_VERSION }, options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: options.redirect || 'follow',
      });
    } catch (error) {
      throw Object.assign(new Error(error && error.name === 'AbortError' ? 'GitHub request timed out' : 'GitHub is unavailable'), { code: 'network_unavailable' });
    } finally { clearTimeout(timeout); }
    let data = null;
    if (response.status !== 204) { try { data = await response.json(); } catch (error) {} }
    if (!response.ok) {
      const remaining = response.headers && response.headers.get && response.headers.get('x-ratelimit-remaining');
      const reset = response.headers && response.headers.get && response.headers.get('x-ratelimit-reset');
      const code = response.status === 401 ? 'authentication_failed' : response.status === 403 && remaining === '0' ? 'rate_limited' : response.status === 403 ? 'insufficient_permissions' : response.status === 404 ? 'repository_unavailable' : response.status === 409 ? 'actions_unavailable' : response.status === 410 ? 'resource_gone' : response.status === 422 ? 'invalid_request' : 'github_error';
      const message = code === 'rate_limited' ? 'GitHub API rate limit reached' : code === 'authentication_failed' ? 'GitHub authorization expired or was revoked' : code === 'insufficient_permissions' ? 'GitHub denied this operation; reconnect with the repo scope and verify repository access' : data && typeof data.message === 'string' ? data.message : 'GitHub request failed (HTTP ' + response.status + ')';
      const error = Object.assign(new Error(message), { code });
      if (reset && Number.isFinite(Number(reset))) error.resetAt = new Date(Number(reset) * 1000).toISOString();
      throw error;
    }
    return options.includeHeaders ? { data, link: response.headers && response.headers.get && response.headers.get('link') || '' } : data;
  }

  async pullIndicators(value, repositoryValue) {
    const mapped = models.pull(value);
    if (!mapped.number || !mapped.headSha) return mapped;
    const repository = this.repository(repositoryValue).fullName;
    const key = repository.toLowerCase() + '#' + mapped.number;
    const cached = this.pullIndicatorCache.get(key);
    if (cached && cached.expiresAt > this.now()) return Object.assign(mapped, cached.value);
    const pullBase = this.repoPath('/pulls/' + mapped.number, repository);
    const commitBase = this.repoPath('/commits/' + encodeURIComponent(mapped.headSha), repository);
    const [reviews, checks, statuses] = await Promise.all([
      this.request(pullBase + '/reviews?per_page=100'),
      this.request(commitBase + '/check-runs?filter=latest&per_page=100'),
      this.request(commitBase + '/status'),
    ]);
    const valueSummary = {
      review: models.reviewSummary(reviews, mapped.requestedReviewers, mapped.requestedTeams),
      checks: models.checkDetails(checks, statuses, null, this.now()),
    };
    this.pullIndicatorCache.set(key, { value: valueSummary, expiresAt: this.now() + PULL_INDICATOR_CACHE_MS });
    return Object.assign(mapped, valueSummary);
  }

  async enrichPulls(values, repositoryValue, limit = PULL_INDICATOR_LIMIT) {
    const source = Array.isArray(values) ? values : [];
    const result = source.map(models.pull);
    for (let offset = 0; offset < Math.min(limit, source.length); offset += FORK_DETAIL_CONCURRENCY) {
      const batch = source.slice(offset, Math.min(limit, offset + FORK_DETAIL_CONCURRENCY));
      const details = await Promise.all(batch.map(value => this.pullIndicators(value, repositoryValue).catch(() => null)));
      details.forEach((value, index) => { if (value) result[offset + index] = value; });
    }
    return result;
  }

  async repositories(forceRefresh) {
    try {
      if (!forceRefresh && this.repositoryCache && this.repositoryCache.expiresAt > this.now()) {
        return { ok: true, items: this.repositoryCache.items.slice(), cached: true, truncated: this.repositoryCache.truncated, upstreamsIncomplete: this.repositoryCache.upstreamsIncomplete, fetchedAt: this.repositoryCache.fetchedAt };
      }
      let path = '/user/repos?visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=updated&direction=desc&per_page=100';
      const items = [];
      const rawRepositories = [];
      let pages = 0;
      while (path && pages < MAX_REPOSITORY_PAGES) {
        const page = await this.request(path, { includeHeaders: true });
        (Array.isArray(page.data) ? page.data : []).forEach(value => {
          const item = repositorySummary(value);
          if (!item) return;
          items.push(item);
          rawRepositories.push(value);
        });
        path = nextApiPath(page.link);
        pages += 1;
      }
      const seen = new Set();
      const unique = items.filter(item => { const key = item.fullName.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
      const forkNames = new Set();
      const forks = rawRepositories.filter(value => {
        const item = repositorySummary(value);
        if (!item || !item.fork) return false;
        const key = item.fullName.toLowerCase();
        if (forkNames.has(key)) return false;
        forkNames.add(key);
        return true;
      });
      let upstreamsIncomplete = false;
      for (let offset = 0; offset < forks.length; offset += FORK_DETAIL_CONCURRENCY) {
        const batch = forks.slice(offset, offset + FORK_DETAIL_CONCURRENCY);
        const details = await Promise.all(batch.map(async value => {
          if (value.parent || value.source) return value;
          try { return await this.request(this.repoPath('', value.full_name)); }
          catch (error) { upstreamsIncomplete = true; return null; }
        }));
        details.forEach((detail, index) => {
          const fork = repositorySummary(batch[index]);
          if (!fork || !detail) return;
          [detail.parent, detail.source].forEach(value => {
            const upstream = repositorySummary(value);
            if (!upstream) return;
            const key = upstream.fullName.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            unique.push(Object.assign(upstream, { relationship: 'upstream', upstreamOf: fork.fullName }));
          });
        });
      }
      const fetchedAt = new Date(this.now()).toISOString();
      const truncated = !!path;
      this.repositoryCache = { items: unique, truncated, upstreamsIncomplete, fetchedAt, expiresAt: this.now() + REPOSITORY_CACHE_MS };
      return { ok: true, items: unique.slice(), truncated, upstreamsIncomplete, fetchedAt };
    } catch (error) { return resultError(error); }
  }

  async overview(repositoryValue) {
    try {
      const repository = this.repository(repositoryValue).fullName;
      const repo = await this.request(this.repoPath('', repository));
      const configuredBranch = this.branchOverride(repository);
      const branch = configuredBranch ? validRef(configuredBranch) : validRef(repo.default_branch);
      const base = this.repoPath('', repository);
      const [commit, release, pulls, runs] = await Promise.all([
        this.request(base + '/commits/' + encodeURIComponent(branch)),
        this.request(base + '/releases/latest').catch(error => error.code === 'repository_unavailable' ? null : Promise.reject(error)),
        this.request(base + '/pulls?state=open&sort=updated&direction=desc&per_page=20'),
        this.request(base + '/actions/runs?branch=' + encodeURIComponent(branch) + '&per_page=10').catch(error => ['repository_unavailable', 'actions_unavailable'].includes(error.code) ? { workflow_runs: [] } : Promise.reject(error)),
      ]);
      let tag = null;
      if (!release) { const tags = await this.request(base + '/tags?per_page=1'); tag = Array.isArray(tags) ? tags[0] || null : null; }
      let comparison = null;
      if (repo.fork && repo.parent && repo.parent.full_name && repo.parent.default_branch) {
        const selected = this.repository(repository);
        const upstream = this.repository(repo.parent.full_name);
        const baseRef = upstream.owner + ':' + validRef(repo.parent.default_branch);
        const headRef = selected.owner + ':' + branch;
        comparison = await this.request(base + '/compare/' + encodeURIComponent(baseRef) + '...' + encodeURIComponent(headRef)).catch(error => error.code === 'repository_unavailable' ? null : Promise.reject(error));
      } else if (repo.default_branch && branch !== repo.default_branch) {
        comparison = await this.request(base + '/compare/' + encodeURIComponent(repo.default_branch) + '...' + encodeURIComponent(branch)).catch(error => error.code === 'repository_unavailable' ? null : Promise.reject(error));
      }
      const [associatedPulls, enrichedPulls] = await Promise.all([
        commit && commit.sha ? this.request(base + '/commits/' + encodeURIComponent(commit.sha) + '/pulls?per_page=5').catch(error => error.code === 'repository_unavailable' ? [] : Promise.reject(error)) : [],
        this.enrichPulls(pulls, repository, 8),
      ]);
      return Object.assign({ ok: true, selectedBranch: branch, fetchedAt: new Date(this.now()).toISOString() }, models.overview(repo, commit, release, tag, comparison, enrichedPulls, runs, associatedPulls, this.now()));
    } catch (error) { return resultError(error); }
  }

  async pulls(repositoryValue) {
    try {
      const values = await this.request(this.repoPath('/pulls?state=open&sort=updated&direction=desc&per_page=30', repositoryValue));
      const items = await this.enrichPulls(values, repositoryValue);
      return { ok: true, items, indicatorsLimited: items.length > PULL_INDICATOR_LIMIT, fetchedAt: new Date(this.now()).toISOString() };
    }
    catch (error) { return resultError(error); }
  }

  async accountLogin(forceRefresh) {
    if (!forceRefresh && this.accountCache && this.accountCache.login && this.accountCache.expiresAt > this.now()) return this.accountCache.login;
    const account = await this.request('/user');
    const login = String(account && account.login || '').trim();
    if (!login) throw Object.assign(new Error('GitHub did not return the authenticated account'), { code: 'invalid_response' });
    this.accountCache = { login, expiresAt: this.now() + ACCOUNT_CACHE_MS };
    return login;
  }

  async issues(filterValue, pageValue, repositoryValue, forceRefresh) {
    const filter = String(filterValue || 'open').toLowerCase();
    if (!ISSUE_FILTERS.has(filter)) return { ok: false, error: 'Issue filter is invalid', code: 'invalid_issue_filter' };
    const page = pageValue == null || pageValue === '' ? 1 : models.positiveInteger(pageValue);
    if (!page || page > 1000) return { ok: false, error: 'Issue page is invalid', code: 'invalid_issue_page' };
    try {
      const repository = this.repository(repositoryValue).fullName;
      const key = [repository.toLowerCase(), filter, page].join(':');
      const cached = this.issueListCache.get(key);
      if (!forceRefresh && cached && cached.expiresAt > this.now()) return Object.assign({}, cached.value, { items: cached.value.items.slice(), cached: true });
      const query = new URLSearchParams({
        state: filter === 'closed' ? 'closed' : 'open',
        sort: 'updated', direction: 'desc', per_page: String(ISSUE_PAGE_SIZE), page: String(page),
      });
      if (filter === 'assigned') query.set('assignee', await this.accountLogin(false));
      const response = await this.request(this.repoPath('/issues?' + query.toString(), repository), {
        includeHeaders: true,
        accept: 'application/vnd.github.text+json',
      });
      if (!Array.isArray(response.data)) throw Object.assign(new Error('GitHub returned an invalid Issues response'), { code: 'invalid_response' });
      const value = {
        ok: true,
        filter,
        page,
        items: models.issuePage(response.data, 'https://github.com/' + repository),
        hasMore: !!nextApiPath(response.link),
        fetchedAt: new Date(this.now()).toISOString(),
      };
      this.issueListCache.set(key, { value, expiresAt: this.now() + ISSUE_LIST_CACHE_MS });
      return Object.assign({}, value, { items: value.items.slice() });
    } catch (error) {
      if (error.code === 'resource_gone') return { ok: false, error: 'Issues are disabled for this repository', code: 'issues_unavailable' };
      return resultError(error);
    }
  }

  async issueDetails(numberValue, repositoryValue, forceRefresh) {
    const number = models.positiveInteger(numberValue);
    if (!number) return { ok: false, error: 'Issue number is invalid', code: 'invalid_issue' };
    try {
      const repository = this.repository(repositoryValue).fullName;
      const key = repository.toLowerCase() + '#' + number;
      const cached = this.issueDetailCache.get(key);
      if (!forceRefresh && cached && cached.expiresAt > this.now()) return Object.assign({}, cached.value, { item: Object.assign({}, cached.value.item), cached: true });
      const value = await this.request(this.repoPath('/issues/' + number, repository), { accept: 'application/vnd.github.text+json' });
      const item = models.issueDetail(value, 'https://github.com/' + repository);
      if (!item) {
        const code = value && value.pull_request ? 'not_an_issue' : 'invalid_response';
        throw Object.assign(new Error(code === 'not_an_issue' ? 'That number belongs to a pull request' : 'GitHub returned an invalid issue'), { code });
      }
      const result = { ok: true, item, fetchedAt: new Date(this.now()).toISOString() };
      this.issueDetailCache.set(key, { value: result, expiresAt: this.now() + ISSUE_DETAIL_CACHE_MS });
      return Object.assign({}, result, { item: Object.assign({}, item) });
    } catch (error) {
      if (error.code === 'repository_unavailable' || error.code === 'resource_gone') return { ok: false, error: 'This issue is no longer available', code: 'issue_unavailable' };
      return resultError(error);
    }
  }

  async pullDetails(numberValue, repositoryValue) {
    const number = models.positiveInteger(numberValue);
    if (!number) return { ok: false, error: 'Pull request number is invalid', code: 'invalid_pull_request' };
    try {
      const base = this.repoPath('/pulls/' + number, repositoryValue);
      const item = await this.request(base);
      const sha = item && item.head && item.head.sha;
      const [reviews, checks, statuses, workflowRuns] = await Promise.all([
        this.request(base + '/reviews?per_page=100'),
        sha ? this.request(this.repoPath('/commits/' + encodeURIComponent(sha) + '/check-runs?filter=latest&per_page=100', repositoryValue)) : { check_runs: [] },
        sha ? this.request(this.repoPath('/commits/' + encodeURIComponent(sha) + '/status', repositoryValue)) : { statuses: [] },
        sha ? this.request(this.repoPath('/actions/runs?head_sha=' + encodeURIComponent(sha) + '&per_page=30', repositoryValue)).catch(error => ['repository_unavailable', 'actions_unavailable'].includes(error.code) ? { workflow_runs: [] } : Promise.reject(error)) : { workflow_runs: [] },
      ]);
      return { ok: true, item: models.pullDetails(item, reviews, checks, statuses, workflowRuns, this.now()), fetchedAt: new Date(this.now()).toISOString() };
    } catch (error) { return resultError(error); }
  }

  async actions(repositoryValue) {
    try {
      const repository = this.repository(repositoryValue).fullName;
      let branch = this.branchOverride(repository);
      if (branch) branch = validRef(branch);
      if (!branch) { const repo = await this.request(this.repoPath('', repository)); branch = validRef(repo.default_branch); }
      const [workflows, runs] = await Promise.all([
        this.request(this.repoPath('/actions/workflows?per_page=100', repository)),
        this.request(this.repoPath('/actions/runs?per_page=30&branch=' + encodeURIComponent(branch), repository)),
      ]);
      const rawRuns = Array.isArray(runs && runs.workflow_runs) ? runs.workflow_runs : [];
      const latestByWorkflow = new Map();
      rawRuns.forEach(value => { const id = models.positiveInteger(value && value.workflow_id); if (id && !latestByWorkflow.has(id)) latestByWorkflow.set(id, value); });
      return {
        ok: true,
        branch,
        workflows: (Array.isArray(workflows && workflows.workflows) ? workflows.workflows : []).map(value => models.workflow(value, latestByWorkflow.get(models.positiveInteger(value && value.id)), this.now())),
        runs: rawRuns.map(value => models.run(value, this.now())),
        fetchedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) { return resultError(error); }
  }

  async runDetails(idValue, repositoryValue) {
    const id = models.positiveInteger(idValue);
    if (!id) return { ok: false, error: 'Workflow run id is invalid', code: 'invalid_run' };
    try {
      const [run, jobs, artifacts] = await Promise.all([
        this.request(this.repoPath('/actions/runs/' + id, repositoryValue)),
        this.request(this.repoPath('/actions/runs/' + id + '/jobs?filter=latest&per_page=100', repositoryValue)),
        this.request(this.repoPath('/actions/runs/' + id + '/artifacts?per_page=100', repositoryValue)).catch(error => error.code === 'repository_unavailable' ? { artifacts: [] } : Promise.reject(error)),
      ]);
      return { ok: true, item: models.runDetails(run, jobs, artifacts, this.now()), fetchedAt: new Date(this.now()).toISOString() };
    }
    catch (error) { return resultError(error); }
  }

  async workflowDispatchInfo(workflowIdValue, refValue, repositoryValue) {
    const workflowId = models.positiveInteger(workflowIdValue);
    if (!workflowId) return { ok: false, error: 'Workflow id is invalid', code: 'invalid_workflow' };
    try {
      const repository = this.repository(repositoryValue).fullName;
      const ref = validRef(refValue || this.branchOverride(repository) || this.settings().branch);
      const key = repository.toLowerCase() + '#' + workflowId + '@' + ref;
      const cached = this.workflowMetadataCache.get(key);
      if (cached && cached.expiresAt > this.now()) return Object.assign({ ok: true, cached: true }, cached.value);
      const workflow = await this.request(this.repoPath('/actions/workflows/' + workflowId, repository));
      const path = String(workflow && workflow.path || '');
      if (!/^\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/i.test(path) || path.includes('..')) {
        throw Object.assign(new Error('Workflow path is unavailable'), { code: 'workflow_metadata_unavailable' });
      }
      const content = await this.request(this.repoPath('/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(ref), repository));
      if (!content || content.encoding !== 'base64' || typeof content.content !== 'string') {
        throw Object.assign(new Error('Workflow content is unavailable'), { code: 'workflow_metadata_unavailable' });
      }
      let source;
      try { source = Buffer.from(content.content.replace(/\s+/g, ''), 'base64').toString('utf8'); }
      catch (error) { throw Object.assign(new Error('Workflow content is invalid'), { code: 'workflow_metadata_unavailable' }); }
      const parsed = parseWorkflowDispatch(source);
      const value = {
        workflow: { id: workflowId, name: String(workflow.name || 'Workflow'), path, url: String(workflow.html_url || '') },
        ref, supported: parsed.supported, hasDispatch: parsed.hasDispatch, inputs: parsed.inputs, reason: parsed.reason || '',
      };
      this.workflowMetadataCache.set(key, { value, expiresAt: this.now() + WORKFLOW_METADATA_CACHE_MS });
      return Object.assign({ ok: true }, value);
    } catch (error) { return resultError(error); }
  }

  async downloadArtifact(idValue, repositoryValue) {
    const id = models.positiveInteger(idValue);
    if (!id) return { ok: false, error: 'Artifact id is invalid', code: 'invalid_artifact' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const token = await this.accessToken();
      const response = await this.fetchImpl(API_BASE + this.repoPath('/actions/artifacts/' + id + '/zip', repositoryValue), {
        method: 'GET', signal: controller.signal, redirect: 'manual',
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'User-Agent': 'bedrock-panel', 'X-GitHub-Api-Version': API_VERSION },
      });
      if (response.status === 410) return { ok: false, error: 'This artifact has expired', code: 'artifact_expired' };
      if (![301, 302, 303, 307, 308].includes(response.status)) return { ok: false, error: 'GitHub did not provide an artifact download', code: 'artifact_download_failed' };
      const location = response.headers && response.headers.get && response.headers.get('location');
      let target;
      try { target = new URL(String(location || '')); } catch (error) {}
      if (!target || target.protocol !== 'https:' || target.username || target.password) return { ok: false, error: 'GitHub returned an invalid artifact download', code: 'artifact_download_failed' };
      const opened = await this.openExternal(target.href);
      return opened ? { ok: true } : { ok: false, error: 'Could not start the artifact download', code: 'artifact_download_failed' };
    } catch (error) {
      if (error && error.name === 'AbortError') return { ok: false, error: 'Artifact download timed out', code: 'network_unavailable' };
      return resultError(error);
    } finally { clearTimeout(timeout); }
  }

  async action(name, payload) {
    name = String(name || '');
    if (!ACTIONS.has(name)) return { ok: false, error: 'GitHub action is not allowed', code: 'invalid_action' };
    try {
      let path;
      let body;
      if (name === 'dispatch') {
        const workflowId = models.positiveInteger(payload && payload.workflowId);
        if (!workflowId) throw Object.assign(new Error('Workflow id is invalid'), { code: 'invalid_workflow' });
        const ref = validRef(payload && payload.ref || this.settings().branch);
        const metadata = await this.workflowDispatchInfo(workflowId, ref, payload && payload.repository);
        if (!metadata.ok) return metadata;
        if (!metadata.supported) return { ok: false, error: metadata.reason || 'Workflow inputs cannot be read safely', code: 'workflow_metadata_unsupported' };
        if (!metadata.hasDispatch) return { ok: false, error: 'This workflow does not support manual dispatch', code: 'workflow_dispatch_unavailable' };
        const inputs = validateDispatchInputs(metadata.inputs, payload && payload.inputs);
        path = this.repoPath('/actions/workflows/' + workflowId + '/dispatches', payload && payload.repository);
        body = metadata.inputs.length ? { ref, inputs } : { ref };
      } else if (name === 'download-artifact') {
        return this.downloadArtifact(payload && payload.artifactId, payload && payload.repository);
      } else {
        const runId = models.positiveInteger(payload && payload.runId);
        if (!runId) throw Object.assign(new Error('Workflow run id is invalid'), { code: 'invalid_run' });
        path = this.repoPath('/actions/runs/' + runId + (name === 'rerun-failed' ? '/rerun-failed-jobs' : name === 'rerun' ? '/rerun' : '/cancel'), payload && payload.repository);
      }
      const result = await this.request(path, { method: 'POST', body });
      return {
        ok: true,
        runId: name === 'dispatch' ? models.positiveInteger(result && result.workflow_run_id) : null,
      };
    } catch (error) { return resultError(error); }
  }

  externalUrl(value, repositoryValue) {
    let parsed;
    try { parsed = new URL(String(value || '')); } catch (error) { return null; }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password) return null;
    if (parsed.pathname === '/settings/applications/new' && !parsed.search && !parsed.hash) return parsed.href;
    const settings = this.settings();
    if (parsed.pathname === '/settings/connections/applications/' + encodeURIComponent(settings.clientId) && !parsed.search && !parsed.hash) return parsed.href;
    let repository;
    try { repository = this.repository(repositoryValue); } catch (error) { return null; }
    const expected = '/' + repository.owner.toLowerCase() + '/' + repository.repo.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return path === expected || path.startsWith(expected + '/') ? parsed.href : null;
  }

  async open(value, repositoryValue) {
    const target = this.externalUrl(value, repositoryValue);
    if (!target) return { ok: false, error: 'That GitHub link is not allowed', code: 'invalid_url' };
    try { return { ok: !!(await this.openExternal(target)) }; }
    catch (error) { return { ok: false, error: 'Could not open GitHub', code: 'open_failed' }; }
  }
}

module.exports = {
  API_VERSION, GITHUB_ACCESS_SCOPES, GITHUB_SCOPES, GitHubService, nextApiPath, normalizeClientId, normalizeSettings,
  parseRepository, parseWorkflowDispatch, repositorySummary, resultError, validRef, validateDispatchInputs,
};
