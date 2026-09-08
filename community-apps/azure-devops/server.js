'use strict';

const DEVOPS_RESOURCE_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';
const OAUTH_SCOPES = [DEVOPS_RESOURCE_SCOPE, 'offline_access'];
const DEVOPS_ORIGIN = 'https://dev.azure.com';
const PROFILE_ORIGIN = 'https://app.vssps.visualstudio.com';
const API_VERSION = '7.1';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_CACHE_MS = 60 * 1000;
const DETAIL_CACHE_MS = 30 * 1000;
const cache = new Map();
const inFlight = new Map();
let fetchImpl = (...args) => fetch(...args);

class AzureDevOpsError extends Error {
  constructor(message, code, status, diagnostic) {
    super(message);
    this.name = 'AzureDevOpsError';
    this.code = code || 'request_failed';
    this.status = status || 0;
    this.diagnostic = diagnostic || null;
  }
}

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max || 300);
}

function organizationName(value) {
  const name = text(value, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(name)) {
    throw new AzureDevOpsError('Choose a valid Azure DevOps organization.', 'invalid_organization');
  }
  return name;
}

function identifier(value, label) {
  const id = text(value, 200);
  if (!id || /[\u0000-\u001f]/.test(id)) {
    throw new AzureDevOpsError(`Choose a valid ${label}.`, `invalid_${label.replace(/\s/g, '_')}`);
  }
  return id;
}

function numericId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AzureDevOpsError(`Choose a valid ${label}.`, `invalid_${label.replace(/\s/g, '_')}`);
  }
  return id;
}

function pathPart(value) {
  return encodeURIComponent(String(value));
}

function queryString(params) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  return query.toString();
}

function projectApiUrl(organization, project, route, params) {
  const base = `${DEVOPS_ORIGIN}/${pathPart(organization)}/${pathPart(project)}/_apis/${route}`;
  return `${base}?${queryString(Object.assign({ 'api-version': API_VERSION }, params))}`;
}

function organizationApiUrl(organization, route, params) {
  const base = `${DEVOPS_ORIGIN}/${pathPart(organization)}/_apis/${route}`;
  return `${base}?${queryString(Object.assign({ 'api-version': API_VERSION }, params))}`;
}

function safeExternalUrl(value, organization) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'dev.azure.com' || url.username || url.password || url.port) return '';
    const firstPart = decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] || '');
    return firstPart.toLowerCase() === organization.toLowerCase() ? url.href : '';
  } catch (error) {
    return '';
  }
}

function devOpsUrl(organization, project, suffix) {
  const url = `${DEVOPS_ORIGIN}/${pathPart(organization)}/${pathPart(project)}${suffix || ''}`;
  return safeExternalUrl(url, organization);
}

function publicMessage(error) {
  if (error instanceof AzureDevOpsError) return error.message;
  if (error && error.name === 'AbortError') return 'Azure DevOps did not respond in time.';
  return 'Azure DevOps could not complete the request.';
}

function sanitizeDiagnosticText(value, max) {
  return text(value, max || 500)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/((?:access_token|refresh_token|client_secret|authorization|code)\s*[=:]\s*["']?)[^\s,"'&}]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted token]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted value]')
    .replace(/\s+/g, ' ')
    .trim();
}

function diagnosticSource(target) {
  const path = target.pathname.toLowerCase();
  if (target.hostname.toLowerCase() === 'app.vssps.visualstudio.com') return 'Organizations';
  if (path.includes('/_apis/projects')) return 'Projects';
  if (path.includes('/pullrequests')) return 'Pull requests';
  if (path.includes('/_apis/git/')) return 'Repositories';
  if (path.includes('/_apis/pipelines') || path.includes('/_apis/build/')) return 'Pipelines';
  if (path.includes('/_apis/wit/')) return 'Work items';
  return 'Azure DevOps';
}

function responseHeader(response, names) {
  if (!response || !response.headers || typeof response.headers.get !== 'function') return '';
  for (const name of names) {
    const value = sanitizeDiagnosticText(response.headers.get(name), 120);
    if (value && /^[A-Za-z0-9._:-]{1,120}$/.test(value)) return value;
  }
  return '';
}

function responseDiagnostic(target, response, data) {
  const providerCode = data && (data.errorCode || data.code || data.eventId);
  return {
    source: diagnosticSource(target),
    status: Number(response && response.status) || 0,
    providerMessage: sanitizeDiagnosticText(data && data.message, 500),
    providerCode: sanitizeDiagnosticText(providerCode, 120),
    providerType: sanitizeDiagnosticText(data && (data.typeKey || data.typeName), 160),
    requestId: responseHeader(response, ['x-vss-e2eid', 'activityid', 'x-ms-request-id', 'request-id']),
    occurredAt: new Date().toISOString()
  };
}

function publicDiagnostic(error) {
  if (!error) return null;
  if (error.diagnostic) return error.diagnostic;
  if (!(error instanceof AzureDevOpsError)) return null;
  return {
    source: 'Azure DevOps app',
    status: Number(error.status) || 0,
    providerMessage: '',
    providerCode: sanitizeDiagnosticText(error.code, 120),
    providerType: '',
    requestId: '',
    occurredAt: new Date().toISOString()
  };
}

async function requestJson(url, token, options) {
  const target = new URL(url);
  const host = target.hostname.toLowerCase();
  if (target.protocol !== 'https:' || (host !== 'dev.azure.com' && host !== 'app.vssps.visualstudio.com')) {
    throw new AzureDevOpsError('The Azure DevOps request target was rejected.', 'unsafe_target');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    const requestOptions = Object.assign({}, options, {
      redirect: 'error',
      signal: controller.signal,
      headers: Object.assign({
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }, options && options.headers)
    });
    response = await fetchImpl(target.href, requestOptions);
    const declaredLength = Number(response.headers && response.headers.get && response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new AzureDevOpsError('Azure DevOps returned more data than this panel can safely display.', 'response_too_large');
    }
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new AzureDevOpsError('Azure DevOps returned more data than this panel can safely display.', 'response_too_large');
    }
    let data = {};
    if (body) {
      try { data = JSON.parse(body); }
      catch (error) { throw new AzureDevOpsError('Azure DevOps returned an unreadable response.', 'invalid_response', response.status); }
    }
    if (!response.ok) {
      const diagnostic = responseDiagnostic(target, response, data);
      if (response.status === 401) throw new AzureDevOpsError('Your Azure DevOps sign-in has expired. Connect again.', 'unauthorized', 401, diagnostic);
      if (response.status === 403) throw new AzureDevOpsError('Your account does not have permission for this Azure DevOps operation.', 'forbidden', 403, diagnostic);
      if (response.status === 404) throw new AzureDevOpsError('The requested Azure DevOps item no longer exists or is unavailable.', 'not_found', 404, diagnostic);
      if (response.status === 429) throw new AzureDevOpsError('Azure DevOps is rate limiting requests. Try again shortly.', 'rate_limited', 429, diagnostic);
      throw new AzureDevOpsError('Azure DevOps returned an error. Try again shortly.', 'upstream_error', response.status, diagnostic);
    }
    return data;
  } catch (error) {
    if (error instanceof AzureDevOpsError) throw error;
    const diagnostic = responseDiagnostic(target, response, {});
    if (error && error.name === 'AbortError') {
      diagnostic.providerCode = 'timeout';
      throw new AzureDevOpsError('Azure DevOps did not respond in time.', 'timeout', 0, diagnostic);
    }
    diagnostic.providerCode = 'network_error';
    throw new AzureDevOpsError('Azure DevOps could not complete the request.', 'network_error', 0, diagnostic);
  } finally {
    clearTimeout(timer);
  }
}

async function accessToken(context) {
  if (!context.oauth) throw new AzureDevOpsError('OAuth is unavailable in this host.', 'oauth_unavailable');
  const token = await context.oauth.getAccessToken(OAUTH_SCOPES);
  if (!token || !token.accessToken) throw new AzureDevOpsError('Connect Azure DevOps to continue.', 'not_connected', 401);
  return token.accessToken;
}

async function cached(key, maxAge, loader, force) {
  const previous = cache.get(key);
  const now = Date.now();
  if (!force && previous && now - previous.fetchedAt < maxAge) {
    return { data: previous.data, fetchedAt: previous.fetchedAt, stale: false };
  }
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = (async () => {
    try {
      const data = await loader();
      const result = { data, fetchedAt: Date.now(), stale: false };
      cache.set(key, result);
      return result;
    } catch (error) {
      if (previous) {
        return {
          data: previous.data,
          fetchedAt: previous.fetchedAt,
          stale: true,
          warning: publicMessage(error),
          diagnostic: publicDiagnostic(error)
        };
      }
      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, pending);
  return pending;
}

function valueArray(data) {
  return Array.isArray(data && data.value) ? data.value : [];
}

function normalizeOrganization(item) {
  const name = text(item.accountName || item.name, 100);
  if (!name) return null;
  return { id: text(item.accountId || item.id, 100), name, url: `${DEVOPS_ORIGIN}/${pathPart(name)}` };
}

async function organizations(context, token, force) {
  const key = 'organizations';
  return cached(key, 10 * 60 * 1000, async () => {
    const profile = await requestJson(`${PROFILE_ORIGIN}/_apis/profile/profiles/me?api-version=${API_VERSION}`, token);
    const memberId = identifier(profile.id, 'profile');
    const accounts = await requestJson(`${PROFILE_ORIGIN}/_apis/accounts?memberId=${pathPart(memberId)}&api-version=${API_VERSION}`, token);
    const discovered = valueArray(accounts).map(normalizeOrganization).filter(Boolean);
    discovered.sort((a, b) => a.name.localeCompare(b.name));
    return { organizations: discovered };
  }, force);
}

function normalizeProject(item, organization) {
  const name = text(item.name, 200);
  return {
    id: text(item.id, 100),
    name,
    description: text(item.description, 400),
    state: text(item.state, 40),
    visibility: text(item.visibility, 40),
    lastUpdateTime: text(item.lastUpdateTime, 80),
    url: devOpsUrl(organization, name, '')
  };
}

async function projects(context, token, organization, force) {
  const org = organizationName(organization);
  return cached(`projects:${org.toLowerCase()}`, 5 * 60 * 1000, async () => {
    const data = await requestJson(organizationApiUrl(org, 'projects', { '$top': 250, stateFilter: 'wellFormed' }), token);
    const items = valueArray(data).map(item => normalizeProject(item, org)).filter(item => item.id && item.name);
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { projects: items };
  }, force);
}

async function selectedContext(context, token) {
  const org = organizationName(context.query.organization);
  const requested = identifier(context.query.project, 'project');
  const result = await projects(context, token, org, false);
  const project = result.data.projects.find(item => item.id === requested || item.name.toLowerCase() === requested.toLowerCase());
  if (!project) throw new AzureDevOpsError('The selected project is not available to this account.', 'project_unavailable');
  return { organization: org, project };
}

function normalizeRepository(item, organization, project) {
  return {
    id: text(item.id, 100),
    name: text(item.name, 200),
    defaultBranch: text(item.defaultBranch, 300).replace(/^refs\/heads\//, ''),
    size: Number(item.size) || 0,
    disabled: !!item.isDisabled,
    url: devOpsUrl(organization, project.name, `/_git/${pathPart(item.name)}`)
  };
}

async function repositoryList(token, organization, project, force) {
  const key = `repos:${organization.toLowerCase()}:${project.id}`;
  return cached(key, DEFAULT_CACHE_MS, async () => {
    const data = await requestJson(projectApiUrl(organization, project.id, 'git/repositories'), token);
    const repositories = valueArray(data).map(item => normalizeRepository(item, organization, project)).filter(item => item.id && item.name);
    repositories.sort((a, b) => a.name.localeCompare(b.name));
    return { repositories };
  }, force);
}

function normalizePullRequest(item, organization, project) {
  const repo = item.repository || {};
  return {
    id: Number(item.pullRequestId) || 0,
    title: text(item.title, 300),
    status: text(item.status, 40),
    isDraft: !!item.isDraft,
    author: text(item.createdBy && (item.createdBy.displayName || item.createdBy.uniqueName), 200),
    repositoryId: text(repo.id, 100),
    repository: text(repo.name, 200),
    sourceBranch: text(item.sourceRefName, 300).replace(/^refs\/heads\//, ''),
    targetBranch: text(item.targetRefName, 300).replace(/^refs\/heads\//, ''),
    createdAt: text(item.creationDate, 80),
    url: devOpsUrl(organization, project.name, `/_git/${pathPart(repo.name)}/pullrequest/${Number(item.pullRequestId) || 0}`)
  };
}

async function pullRequestList(token, organization, project, force) {
  const key = `prs:${organization.toLowerCase()}:${project.id}`;
  return cached(key, DEFAULT_CACHE_MS, async () => {
    const data = await requestJson(projectApiUrl(organization, project.id, 'git/pullrequests', {
      'searchCriteria.status': 'active', '$top': 100
    }), token);
    return { pullRequests: valueArray(data).map(item => normalizePullRequest(item, organization, project)).filter(item => item.id) };
  }, force);
}

function normalizeBuild(item, organization, project) {
  const definition = item.definition || {};
  const repository = item.repository || {};
  return {
    id: Number(item.id) || 0,
    buildNumber: text(item.buildNumber, 100),
    pipelineId: Number(definition.id) || 0,
    pipeline: text(definition.name, 200),
    status: text(item.status, 50),
    result: text(item.result, 50),
    branch: text(item.sourceBranch, 300).replace(/^refs\/heads\//, ''),
    sourceVersion: text(item.sourceVersion, 80),
    repositoryId: text(repository.id, 100),
    repository: text(repository.name, 200),
    requestedFor: text(item.requestedFor && (item.requestedFor.displayName || item.requestedFor.uniqueName), 200),
    queuedAt: text(item.queueTime, 80),
    startedAt: text(item.startTime, 80),
    finishedAt: text(item.finishTime, 80),
    url: devOpsUrl(organization, project.name, `/_build/results?buildId=${Number(item.id) || 0}&view=results`),
    commitUrl: repository.name && item.sourceVersion
      ? devOpsUrl(organization, project.name, `/_git/${pathPart(repository.name)}/commit/${pathPart(item.sourceVersion)}`)
      : ''
  };
}

async function pipelineList(token, organization, project, force) {
  const key = `pipelines:${organization.toLowerCase()}:${project.id}`;
  return cached(key, DEFAULT_CACHE_MS, async () => {
    const [pipelineData, buildData] = await Promise.all([
      requestJson(projectApiUrl(organization, project.id, 'pipelines', { '$top': 100 }), token),
      requestJson(projectApiUrl(organization, project.id, 'build/builds', { '$top': 100, queryOrder: 'queueTimeDescending' }), token)
    ]);
    const builds = valueArray(buildData).map(item => normalizeBuild(item, organization, project)).filter(item => item.id);
    const latestByPipeline = new Map();
    builds.forEach(build => { if (!latestByPipeline.has(build.pipelineId)) latestByPipeline.set(build.pipelineId, build); });
    const pipelines = valueArray(pipelineData).map(item => {
      const id = Number(item.id) || 0;
      const name = text(item.name, 200);
      return {
        id,
        name,
        folder: text(item.folder, 200),
        revision: Number(item.revision) || 0,
        latestRun: latestByPipeline.get(id) || null,
        url: devOpsUrl(organization, project.name, `/_build?definitionId=${id}`)
      };
    }).filter(item => item.id && item.name).sort((a, b) => a.name.localeCompare(b.name));
    return { pipelines, runs: builds.slice(0, 50) };
  }, force);
}

function normalizeWorkItem(item, organization, project) {
  const fields = item.fields || {};
  const assigned = fields['System.AssignedTo'];
  return {
    id: Number(item.id) || 0,
    title: text(fields['System.Title'], 300),
    type: text(fields['System.WorkItemType'], 100),
    state: text(fields['System.State'], 100),
    assignedTo: text(assigned && (assigned.displayName || assigned.uniqueName) || assigned, 200),
    changedAt: text(fields['System.ChangedDate'], 80),
    iteration: text(fields['System.IterationPath'], 250),
    tags: text(fields['System.Tags'], 500),
    relations: Array.isArray(item.relations) ? item.relations.map(relation => ({
      rel: text(relation.rel, 100),
      url: text(relation.url, 500),
      name: text(relation.attributes && (relation.attributes.name || relation.attributes.comment), 300)
    })).slice(0, 50) : [],
    url: devOpsUrl(organization, project.name, `/_workitems/edit/${Number(item.id) || 0}`)
  };
}

async function workItemList(token, organization, project, force) {
  const key = `work:${organization.toLowerCase()}:${project.id}`;
  return cached(key, DEFAULT_CACHE_MS, async () => {
    const wiql = {
      query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC"
    };
    const queryResult = await requestJson(projectApiUrl(organization, project.id, 'wit/wiql', { '$top': 100 }), token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wiql)
    });
    const ids = (Array.isArray(queryResult.workItems) ? queryResult.workItems : []).map(item => Number(item.id)).filter(Boolean).slice(0, 100);
    if (!ids.length) return { workItems: [] };
    const batch = await requestJson(projectApiUrl(organization, project.id, 'wit/workitemsbatch'), token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // Azure DevOps rejects `fields` and `$expand` together. Omitting `fields` returns the
      // standard field set while allowing the explicit relations required by the detail view.
      body: JSON.stringify({ ids, '$expand': 'Relations' })
    });
    return { workItems: valueArray(batch).map(item => normalizeWorkItem(item, organization, project)).filter(item => item.id) };
  }, force);
}

function cacheEnvelope(result) {
  return {
    fetchedAt: new Date(result.fetchedAt).toISOString(),
    stale: !!result.stale,
    warning: text(result.warning, 300),
    diagnostic: result.diagnostic || null
  };
}

function metricFor(type, datasets) {
  if (type === 'repositories') {
    const items = datasets.repositories.repositories;
    const openPullRequests = datasets.pullRequests.pullRequests.length;
    const primary = items[0];
    return {
      type,
      label: 'Repositories',
      value: items.length,
      unit: items.length === 1 ? 'Repository' : 'Repositories',
      metrics: [{ value: openPullRequests, label: openPullRequests === 1 ? 'open PR' : 'open PRs' }],
      tone: items.length ? 'info' : 'neutral',
      status: items.length ? 'Source ready' : 'No repositories',
      message: primary ? `${primary.name} · ${primary.defaultBranch || 'no default branch'}` : 'No repositories in this project',
      view: 'repositories'
    };
  }
  if (type === 'pipelines') {
    const items = datasets.pipelines.pipelines;
    const runs = datasets.pipelines.runs;
    const failing = runs.filter(run => run.result === 'failed').length;
    const running = runs.filter(run => run.status === 'inProgress' || run.status === 'notStarted').length;
    const succeeded = runs.filter(run => run.result === 'succeeded').length;
    const tone = failing ? 'danger' : running ? 'warning' : runs.length ? 'healthy' : 'neutral';
    return {
      type,
      label: 'Pipelines',
      value: items.length,
      unit: items.length === 1 ? 'Pipeline' : 'Pipelines',
      metrics: [
        { value: running, label: 'running' },
        { value: failing, label: 'failed' },
        { value: succeeded, label: 'succeeded' }
      ],
      tone,
      status: failing ? 'Attention' : running ? 'Running' : runs.length ? 'Healthy' : 'No recent runs',
      message: failing
        ? `${failing} recent pipeline ${failing === 1 ? 'failure' : 'failures'}`
        : running
          ? `${running} ${running === 1 ? 'pipeline is' : 'pipelines are'} active`
          : runs.length ? 'No recent pipeline failures' : 'No recent pipeline activity',
      view: 'pipelines'
    };
  }
  if (type === 'pull-requests') {
    const items = datasets.pullRequests.pullRequests;
    const drafts = items.filter(item => item.isDraft).length;
    const ready = items.length - drafts;
    return {
      type,
      label: 'Pull Requests',
      value: items.length,
      unit: 'Open',
      metrics: [{ value: ready, label: 'ready' }, { value: drafts, label: drafts === 1 ? 'draft' : 'drafts' }],
      tone: !items.length ? 'healthy' : drafts ? 'warning' : 'info',
      status: !items.length ? 'Clear' : drafts ? 'In progress' : 'Review queue',
      message: !items.length
        ? 'No PRs need attention'
        : drafts ? `${drafts} draft ${drafts === 1 ? 'PR is' : 'PRs are'} in progress` : `${ready} ${ready === 1 ? 'PR is' : 'PRs are'} ready to review`,
      view: 'pull-requests'
    };
  }
  const items = datasets.workItems.workItems;
  const assigned = items.filter(item => item.assignedTo).length;
  const bugs = items.filter(item => item.type.toLowerCase() === 'bug').length;
  const tasks = items.filter(item => item.type.toLowerCase() === 'task').length;
  return {
    type: 'work-items',
    label: 'Work Items',
    value: items.length,
    unit: 'Active',
    metrics: [
      { value: assigned, label: 'assigned' },
      { value: bugs, label: bugs === 1 ? 'bug' : 'bugs' },
      { value: tasks, label: tasks === 1 ? 'task' : 'tasks' }
    ],
    tone: !items.length ? 'healthy' : bugs ? 'warning' : 'info',
    status: !items.length ? 'Clear' : bugs ? 'Attention' : 'In progress',
    message: !items.length
      ? 'No active work items'
      : bugs ? `${bugs} active ${bugs === 1 ? 'bug needs' : 'bugs need'} attention` : `${items.length} work ${items.length === 1 ? 'item is' : 'items are'} in progress`,
    view: 'work-items'
  };
}

function configuredCards() {
  return ['repositories', 'pipelines', 'pull-requests', 'work-items'];
}

function parseBody(context) {
  if (!context.body || !context.body.length) return {};
  if (context.body.length > 64 * 1024) throw new AzureDevOpsError('The request is too large.', 'request_too_large');
  try { return JSON.parse(context.body.toString('utf8')); }
  catch (error) { throw new AzureDevOpsError('The request body is invalid.', 'invalid_request'); }
}

function actionsEnabled(context) {
  const value = context.options && context.options.enablePipelineActions;
  return value === true || value === 'true' || value === 1 || value === '1';
}

async function pipelineDetail(token, organization, project, runId, force) {
  const id = numericId(runId, 'run');
  return cached(`run:${organization.toLowerCase()}:${project.id}:${id}`, DETAIL_CACHE_MS, async () => {
    const [buildData, timeline, workItems] = await Promise.all([
      requestJson(projectApiUrl(organization, project.id, `build/builds/${id}`), token),
      requestJson(projectApiUrl(organization, project.id, `build/builds/${id}/timeline`), token).catch(() => ({ records: [] })),
      requestJson(projectApiUrl(organization, project.id, `build/builds/${id}/workitems`), token).catch(() => ({ value: [] }))
    ]);
    const records = (Array.isArray(timeline.records) ? timeline.records : []).filter(item => item.type === 'Stage' || item.type === 'Job').map(item => ({
      id: text(item.id, 100), name: text(item.name, 200), type: text(item.type, 50), state: text(item.state, 50), result: text(item.result, 50),
      issues: (Array.isArray(item.issues) ? item.issues : []).map(issue => text(issue.message, 300)).filter(Boolean).slice(0, 3)
    })).slice(0, 80);
    return {
      run: normalizeBuild(buildData, organization, project),
      stages: records,
      workItems: valueArray(workItems).map(item => ({ id: Number(item.id) || 0, url: devOpsUrl(organization, project.name, `/_workitems/edit/${Number(item.id) || 0}`) })).filter(item => item.id)
    };
  }, force);
}

async function repositoryDetail(token, organization, project, repositoryId, force) {
  const id = identifier(repositoryId, 'repository');
  const repos = await repositoryList(token, organization, project, false);
  const repository = repos.data.repositories.find(item => item.id === id);
  if (!repository) throw new AzureDevOpsError('The selected repository is not available.', 'repository_unavailable');
  return cached(`repo:${organization.toLowerCase()}:${project.id}:${id}`, DETAIL_CACHE_MS, async () => {
    const [refs, commits, pullRequests] = await Promise.all([
      requestJson(projectApiUrl(organization, project.id, `git/repositories/${pathPart(id)}/refs`, { filter: 'heads/', '$top': 100 }), token),
      requestJson(projectApiUrl(organization, project.id, `git/repositories/${pathPart(id)}/commits`, { 'searchCriteria.$top': 20 }), token),
      requestJson(projectApiUrl(organization, project.id, `git/repositories/${pathPart(id)}/pullrequests`, { 'searchCriteria.status': 'active', '$top': 50 }), token)
    ]);
    return {
      repository,
      branches: valueArray(refs).map(item => ({ name: text(item.name, 300).replace(/^refs\/heads\//, ''), objectId: text(item.objectId, 80) })),
      commits: valueArray(commits).map(item => ({
        id: text(item.commitId, 80), message: text(item.comment, 400), author: text(item.author && item.author.name, 200), date: text(item.author && item.author.date, 80),
        url: devOpsUrl(organization, project.name, `/_git/${pathPart(repository.name)}/commit/${pathPart(item.commitId)}`)
      })),
      pullRequests: valueArray(pullRequests).map(item => normalizePullRequest(item, organization, project)).filter(item => item.id)
    };
  }, force);
}

async function pullRequestDetail(token, organization, project, pullRequestId, force) {
  const id = numericId(pullRequestId, 'pull request');
  return cached(`pr:${organization.toLowerCase()}:${project.id}:${id}`, DETAIL_CACHE_MS, async () => {
    const [item, workItems] = await Promise.all([
      requestJson(projectApiUrl(organization, project.id, `git/pullrequests/${id}`), token),
      requestJson(projectApiUrl(organization, project.id, `git/pullrequests/${id}/workitems`), token).catch(() => ({ value: [] }))
    ]);
    return {
      pullRequest: normalizePullRequest(item, organization, project),
      description: text(item.description, 2000),
      reviewers: (Array.isArray(item.reviewers) ? item.reviewers : []).map(reviewer => ({
        name: text(reviewer.displayName || reviewer.uniqueName, 200), vote: Number(reviewer.vote) || 0, required: !!reviewer.isRequired
      })),
      workItems: valueArray(workItems).map(workItem => ({ id: Number(workItem.id) || 0, url: devOpsUrl(organization, project.name, `/_workitems/edit/${Number(workItem.id) || 0}`) })).filter(workItem => workItem.id)
    };
  }, force);
}

async function workItemDetail(token, organization, project, workItemId, force) {
  const id = numericId(workItemId, 'work item');
  return cached(`workitem:${organization.toLowerCase()}:${project.id}:${id}`, DETAIL_CACHE_MS, async () => {
    const batch = await requestJson(projectApiUrl(organization, project.id, 'wit/workitemsbatch'), token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id], '$expand': 'Relations' })
    });
    const item = valueArray(batch)[0];
    if (!item) throw new AzureDevOpsError('The work item is unavailable.', 'not_found', 404);
    return { workItem: normalizeWorkItem(item, organization, project) };
  }, force);
}

async function handleAction(action, context) {
  if (action === 'auth-status') {
    if (!context.oauth) return { ok: true, connected: false, configured: false };
    return Object.assign({ ok: true }, await context.oauth.status());
  }
  if (action === 'connect') {
    if (!context.oauth) throw new AzureDevOpsError('OAuth is unavailable in this host.', 'oauth_unavailable');
    const options = context.options || {};
    const clientId = text(options.oauthClientId, 200);
    if (!clientId) throw new AzureDevOpsError('Add the Microsoft Entra application client ID in this app\'s settings.', 'not_configured');
    const result = await context.oauth.connect(OAUTH_SCOPES, {
      clientId,
      clientSecret: text(options.oauthClientSecret, 500)
    });
    cache.clear();
    return Object.assign({ ok: true }, result);
  }
  if (action === 'disconnect') {
    if (!context.oauth) throw new AzureDevOpsError('OAuth is unavailable in this host.', 'oauth_unavailable');
    cache.clear();
    return Object.assign({ ok: true }, await context.oauth.disconnect());
  }

  const dataActions = new Set([
    'organizations', 'projects', 'overview', 'repositories', 'repository', 'pipelines', 'run',
    'pull-requests', 'pull-request', 'work-items', 'work-item', 'run-pipeline', 'cancel-run'
  ]);
  if (!dataActions.has(action)) return { ok: false, error: 'unknown action' };

  const token = await accessToken(context);
  const force = context.query.force === '1';
  if (action === 'organizations') {
    const result = await organizations(context, token, force);
    return Object.assign({ ok: true }, result.data, cacheEnvelope(result));
  }
  if (action === 'projects') {
    const result = await projects(context, token, context.query.organization, force);
    return Object.assign({ ok: true }, result.data, cacheEnvelope(result));
  }

  const selected = await selectedContext(context, token);
  const organization = selected.organization;
  const project = selected.project;
  if (action === 'overview') {
    const [repositories, pipelines, pullRequests, workItems] = await Promise.all([
      repositoryList(token, organization, project, force), pipelineList(token, organization, project, force),
      pullRequestList(token, organization, project, force), workItemList(token, organization, project, force)
    ]);
    const datasets = { repositories: repositories.data, pipelines: pipelines.data, pullRequests: pullRequests.data, workItems: workItems.data };
    const results = [repositories, pipelines, pullRequests, workItems];
    const oldest = Math.min(...results.map(item => item.fetchedAt));
    return {
      ok: true, project, cards: configuredCards().map(type => metricFor(type, datasets)),
      actionsEnabled: actionsEnabled(context), fetchedAt: new Date(oldest).toISOString(),
      stale: results.some(item => item.stale), warning: results.map(item => item.warning).filter(Boolean)[0] || '',
      diagnostics: results.map(item => item.diagnostic).filter(Boolean)
    };
  }
  if (action === 'repositories') {
    const result = await repositoryList(token, organization, project, force);
    return Object.assign({ ok: true, project }, result.data, cacheEnvelope(result));
  }
  if (action === 'repository') {
    const result = await repositoryDetail(token, organization, project, context.query.repository, force);
    return Object.assign({ ok: true, project }, result.data, cacheEnvelope(result));
  }
  if (action === 'pipelines') {
    const result = await pipelineList(token, organization, project, force);
    return Object.assign({ ok: true, project, actionsEnabled: actionsEnabled(context) }, result.data, cacheEnvelope(result));
  }
  if (action === 'run') {
    const result = await pipelineDetail(token, organization, project, context.query.run, force);
    return Object.assign({ ok: true, project, actionsEnabled: actionsEnabled(context) }, result.data, cacheEnvelope(result));
  }
  if (action === 'pull-requests') {
    const result = await pullRequestList(token, organization, project, force);
    return Object.assign({ ok: true, project }, result.data, cacheEnvelope(result));
  }
  if (action === 'pull-request') {
    const result = await pullRequestDetail(token, organization, project, context.query.pullRequest, force);
    return Object.assign({ ok: true, project }, result.data, cacheEnvelope(result));
  }
  if (action === 'work-items') {
    const result = await workItemList(token, organization, project, force);
    return Object.assign({ ok: true, project }, result.data, cacheEnvelope(result));
  }
  if (action === 'work-item') {
    const result = await workItemDetail(token, organization, project, context.query.workItem, force);
    return Object.assign({ ok: true, project }, result.data, cacheEnvelope(result));
  }
  if (action === 'run-pipeline') {
    if (!actionsEnabled(context)) throw new AzureDevOpsError('Pipeline actions are disabled in this app\'s settings.', 'actions_disabled', 403);
    const body = parseBody(context);
    const pipelineId = numericId(body.pipelineId, 'pipeline');
    const list = await pipelineList(token, organization, project, false);
    const pipeline = list.data.pipelines.find(item => item.id === pipelineId);
    if (!pipeline) throw new AzureDevOpsError('The selected pipeline is unavailable.', 'pipeline_unavailable');
    const refName = text(body.refName, 300);
    if (refName && !/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(refName)) throw new AzureDevOpsError('Use a valid refs/heads/... branch.', 'invalid_branch');
    const resources = refName ? { repositories: { self: { refName } } } : undefined;
    const previewBody = { previewRun: true };
    if (resources) previewBody.resources = resources;
    const route = `pipelines/${pipelineId}/runs`;
    try {
      await requestJson(projectApiUrl(organization, project.id, route), token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(previewBody)
      });
    } catch (error) {
      throw new AzureDevOpsError(
        'Azure DevOps could not validate this run. Required parameters or permissions may be missing; nothing was started.',
        'preview_failed', error.status, error.diagnostic
      );
    }
    const runBody = {};
    if (resources) runBody.resources = resources;
    const run = await requestJson(projectApiUrl(organization, project.id, route), token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(runBody)
    });
    cache.delete(`pipelines:${organization.toLowerCase()}:${project.id}`);
    return { ok: true, run: normalizeBuild(run, organization, project), message: `${pipeline.name} was queued.` };
  }
  if (action === 'cancel-run') {
    if (!actionsEnabled(context)) throw new AzureDevOpsError('Pipeline actions are disabled in this app\'s settings.', 'actions_disabled', 403);
    const body = parseBody(context);
    const runId = numericId(body.runId, 'run');
    const list = await pipelineList(token, organization, project, false);
    const run = list.data.runs.find(item => item.id === runId);
    if (!run) throw new AzureDevOpsError('The selected run is unavailable.', 'run_unavailable');
    if (!['notStarted', 'inProgress', 'postponed'].includes(run.status)) {
      throw new AzureDevOpsError('Only queued or running pipeline runs can be cancelled.', 'run_not_cancellable');
    }
    await requestJson(projectApiUrl(organization, project.id, `build/builds/${runId}`), token, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelling' })
    });
    cache.delete(`pipelines:${organization.toLowerCase()}:${project.id}`);
    cache.delete(`run:${organization.toLowerCase()}:${project.id}:${runId}`);
    return { ok: true, message: `Cancellation requested for ${run.buildNumber || `run ${runId}`}.` };
  }
  return { ok: false, error: 'unknown action' };
}

async function handle(action, context) {
  try {
    return await handleAction(action, context || { query: {}, options: {} });
  } catch (error) {
    return {
      ok: false,
      error: publicMessage(error),
      code: error && error.code || 'request_failed',
      reauth: !!(error && error.status === 401),
      diagnostic: publicDiagnostic(error)
    };
  }
}

module.exports = {
  handle,
  _test: {
    OAUTH_SCOPES,
    cache,
    configuredCards,
    metricFor,
    sanitizeDiagnosticText,
    safeExternalUrl,
    setFetch(value) { fetchImpl = value; },
    reset() { cache.clear(); inFlight.clear(); fetchImpl = (...args) => fetch(...args); }
  }
};
