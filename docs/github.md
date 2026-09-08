# GitHub panel

The built-in **GitHub** app is a 1920×480 repository and GitHub Actions operations panel. It uses
GitHub OAuth Device Flow; personal access tokens are not accepted or required.

## One-time OAuth App setup

Bedrock Panel is a native, locally installed application and does not ship a shared client secret. To
connect it, create a GitHub OAuth App owned by you or your organization:

1. Open **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Give it a recognizable name such as `bedrock-panel` and use the Bedrock Panel repository as its
   homepage. GitHub requires a callback field even though Device Flow does not use redirect URIs;
   use `http://127.0.0.1:53682/callback` so the placeholder does not imply port 80. Bedrock Panel does
   not listen on or contact this port, so another unused high port is equally valid.
3. Open the new OAuth App's settings and enable **Device Flow**.
4. Add the built-in **GitHub** app as an Bedrock Panel page. In that page's **App** section in the
   desktop editor, paste the public Client ID and save the editor configuration. A starting
   repository and branch are optional.
5. Select **Connect** in the same editor section. GitHub opens in the system browser; enter the
   one-time device code shown in the editor and approve access.

The app requests `repo` because GitHub requires that OAuth scope for private-repository workflow
controls, and `offline_access` so expiring access tokens can be refreshed. `offline_access` does not
grant repository access. GitHub OAuth App scopes are coarser than GitHub App permissions, so review
the authorization before approving it.

Access and refresh tokens are stored only in the Electron main process and encrypted at rest with
Bedrock Panel's existing secret store: current-user DPAPI on Windows and Electron `safeStorage`
elsewhere. The panel receives only a rotating, memory-only Bedrock Panel capability; it never receives
GitHub credentials. The editor receives only connection state and the temporary device code.
Long-lived OAuth tokens and GitHub's rotating eight-hour token form are both
supported. Disconnecting removes the locally stored tokens; the authorization can also be reviewed
or revoked in GitHub's **Authorized OAuth Apps** settings.

The panel is laid out specifically for the 1920×480 console. Primary controls use large touch targets,
scrolling is contained within repository, pull-request, workflow, job, and step lists, and pressed and
focus states remain visible in both themes. The panel knob can move through the active view's controls
and confirmation dialogs as an alternative to touch.

After connecting, use the repository button in the touchscreen panel header to browse and search
repositories the authenticated account owns, collaborates on, or can access through an organization.
For each listed fork, Bedrock Panel also discovers its accessible parent and original source repositories,
so a public upstream can be selected even when GitHub does not include it in the authenticated-user
repository list. These entries are labelled as upstreams and may be read-only. The list follows GitHub
pagination, includes private repositories covered by the authorization, and is cached for one minute
to avoid needless API usage. The last panel selection is remembered locally on that Bedrock Panel device.
It does not rewrite the editor configuration; the optional editor value is only the starting fallback.
Repositories other than that fallback use their own default branch.

## V2 features

- Searchable repository browser for owned, collaborator, and organization repositories, including
  private repositories permitted by the OAuth grant and accessible upstreams of listed forks. The
  device keeps a small local recent list and supports pinned favourites; GitHub's repository list is
  still cached so opening the selector does not repeatedly enumerate the account.
- Repository/default branch, selected branch, latest commit, latest release or tag, fork/upstream
  relationship, and GitHub-hosted ahead/behind comparison. The commit card opens a bounded detail
  overlay with the full message and an associated pull request when GitHub reports one.
- Open pull requests with author, draft state, comments, requested/latest review state, change
  counts, mergeability metadata, Checks, and legacy commit statuses. Failed and running checks are
  prioritised. A check backed by GitHub Actions opens the same run detail used by the Actions view.
- Read-only Issues with Open, Assigned to me, and Closed filters; compact labels, assignees,
  milestone, comment count, and a bounded plain-text body; deliberate Load More paging; and exact
  issue links through the existing trusted external-navigation boundary. GitHub's issue-shaped pull
  request resources are excluded using the documented `pull_request` response field. Inline comment
  previews are deliberately deferred; the panel shows the count and opens GitHub for discussion.
- Workflows and recent runs with last-run state, plus selectable run details containing jobs,
  individual timed steps, conclusions, actor/branch/commit context, and automatic failed or active
  job selection.
- State-valid, confirmed workflow controls: running runs show Cancel; failed runs show Rerun Failed
  and Rerun All; other completed runs show Rerun All. Merge and pull-request mutation are not
  available.
- Touch-friendly `workflow_dispatch` inputs discovered from the selected revision's workflow YAML.
  Boolean, choice, environment-name, and string inputs are validated again in the trusted service
  before dispatch. Unsupported YAML constructs are rejected rather than guessed.
- Completed-run artifacts with size/expiry metadata. Download authorization and GitHub's temporary
  redirect remain in the main-process service; neither the OAuth token nor privileged URL enters the
  renderer.
- Restricted external links for the configured repository and OAuth setup.
- Conservative visible-only polling: 10 seconds for a selected running run, 20 seconds for Actions,
  and 30 seconds elsewhere. Failed background refreshes preserve the visible data and mark it stale.
  Review/check attention enrichment is cached for two minutes and bounded to the 12 most recently
  updated PRs; older list rows remain labelled Open/Draft until selected instead of implying that
  unchecked state is healthy.

Authentication, scope, repository, network, Actions, and rate-limit failures are shown explicitly;
stale data is never presented as current.

## Deliberately omitted from V2

- Pull-request creation, editing, closing, merging, and review submission.
- Issue mutation, release, file, or branch management. Issues are browse-only: the panel cannot
  create, edit, close, assign, label, milestone, or comment on an issue.
- GitHub Notifications and a separate Activity screen, which would require unrelated access.
- Local checkout inspection or Git operations. The panel never claims a working tree is clean.
- Full Actions log display. Job and failed-step metadata is shown, but complete logs remain in GitHub
  because a bounded extract cannot be guaranteed to exclude credentials and environment secrets.
- A general YAML implementation. Workflow input discovery accepts the common explicit
  `workflow_dispatch.inputs` shape; anchors, aliases, and complex inline mappings must be run in
  GitHub rather than interpreted approximately.
- GitHub environment enumeration. An environment input accepts the exact environment name from the
  workflow instead of requesting broader administration data.

## API permissions

V2 and the read-only Issues screen do not add an OAuth scope. The existing `repo` scope covers
private-repository Issues, pull-request, contents, Checks, Actions, workflow-dispatch, artifact, and
comparison endpoints for OAuth App tokens. The Assigned filter reads the authenticated account's
public login from `/user` and caches it; it does not require an added `user` scope. Inline comments
are deferred, so this pass adds neither a comments endpoint nor a related permission. Public
repository reads can be less permissive at the API level, but Bedrock Panel keeps one consistent grant
because its deliberate workflow dispatch/rerun/cancel operations require `repo`.
`offline_access` remains a token-lifetime option and does not grant repository access.

Relevant GitHub documentation: [OAuth Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
[OAuth security practices](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app),
[authenticated-user repositories](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user),
[repository details and fork relationships](https://docs.github.com/en/rest/repos/repos#get-a-repository),
[REST API pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api),
[workflows](https://docs.github.com/en/rest/actions/workflows),
[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
[workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs),
[workflow artifacts](https://docs.github.com/en/rest/actions/artifacts),
[pull-request reviews](https://docs.github.com/en/rest/pulls/reviews),
[pull requests](https://docs.github.com/en/rest/pulls/pulls),
[issues](https://docs.github.com/en/rest/issues/issues),
[authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user),
[commits and associated pull requests](https://docs.github.com/en/rest/commits/commits),
[repository contents](https://docs.github.com/en/rest/repos/contents),
[check runs](https://docs.github.com/en/rest/checks/runs), and
[commit statuses](https://docs.github.com/en/rest/commits/statuses).
