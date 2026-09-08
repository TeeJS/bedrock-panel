# Azure DevOps drop-in setup

This app uses Microsoft Entra OAuth with PKCE. Azure DevOps access tokens stay in the
Bedrock Panel main process and are never returned to the app page.

## 1. Register an application

1. In the Microsoft Entra admin center, create an app registration for the people who may
   use this panel.
2. Add this redirect URI exactly:

   ```text
   http://localhost:5173/oauth/callback
   ```

3. Copy the **Application (client) ID** into the Azure DevOps drop-in settings in Bedrock Panel.
4. For a public-client registration, leave the client-secret setting empty. If your tenant
   requires a confidential client, create a secret and store it only in the drop-in's secret
   setting.

## 2. Configure delegated Azure DevOps permissions

Add delegated permissions for **Azure DevOps** (resource/application ID
`499b84ac-1321-427f-aa17-267ca6975798`). Use only the permissions needed by this app:

- `vso.profile` — discover the signed-in user's organizations.
- `vso.project` — list accessible projects.
- `vso.code` — read repositories, branches, commits, and pull requests.
- `vso.build` — read pipelines and builds.
- `vso.work` — read work items and WIQL results.

Pipeline actions are disabled by default. If you explicitly enable them in the app settings,
replace/readjust the build permission to include `vso.build_execute`, which permits queuing and
cancelling builds and includes read access. Do not grant the broad `user_impersonation` permission.

The app requests the Azure DevOps resource `.default` scope plus `offline_access`; Microsoft
Entra therefore issues only the delegated permissions configured on the app registration.
Tenant policy may require an administrator to grant consent.

## 3. Configure and connect

1. Import or install the `azure-devops` folder as an Bedrock Panel drop-in app.
2. Set the client ID. Organization and project selection happens directly on the panel and the
   last selection is remembered locally.
3. Leave **Enable pipeline run and cancel controls** off unless the device should be allowed to
   change pipeline state.
4. Add the app to a page and select **Connect** on the panel.

Organization and project choices are limited to what the signed-in user can access. The last
selection is remembered locally on the panel. External links are restricted to the selected
organization on `https://dev.azure.com` and use the panel's normal external-link behavior.

## Troubleshooting

- **No organizations found:** confirm the user is a member of the expected Azure DevOps
  organization and that the app registration has `vso.profile` permission.
- **Permission denied:** check the delegated permissions and the user's Azure DevOps project
  security. The app cannot elevate beyond the signed-in user. Open the warning-triangle button
  in the app header to see which data source failed, the HTTP status, Azure DevOps error type,
  and request/activity ID. The copyable summary omits credentials and request URLs.
- **Only some projects fail:** confirm the signed-in user can view the project, then check
  repository Read, build/pipeline View, and work-item/area permissions. An explicit Deny on the
  user or one of their groups takes precedence over an Allow.
- **Run validation failed:** the pipeline may require runtime parameters that this compact panel
  cannot safely infer. Nothing is queued when preflight validation fails; run it in Azure DevOps.
- **Cached data banner:** the last successful response is shown when a refresh temporarily fails.
  Use the refresh control to retry.
