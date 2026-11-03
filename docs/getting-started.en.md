# Installation and first run

[Back to README](<../README.en.md>) · [中文](<getting-started.md>)

This guide uses **a source build installed as a local bundle**. The npm package has not been published yet; installation by package name is not an available distribution path at this stage.

## 1. Prerequisites

- Node.js **≥ 22.19** and DSH **≥ 0.2.1-rc.2**; Node.js 24 is recommended.
- Git, pnpm and `dsh` on your PATH, plus at least one configured model in DSH.
- The Web profile. Model usage is billed by your chosen provider.
- If you use a custom `DSH_HOME`, keep it consistent during installation, initialization and startup.

```sh
node --version
dsh --version
pnpm --version
```

When upgrading, let active tasks finish before stopping the relevant DSH instance. The installation command below changes your Web profile; building and generating with an explicit `--out` do not deploy to the live profile.

## 2. Build and install the plugin

Run these commands **one at a time** from the directory where you want to keep the source. Stop on any failure rather than installing stale artifacts.

```sh
git clone https://github.com/hua0424/dsh-workflow-plugin.git
cd dsh-workflow-plugin
pnpm install
pnpm run build
node web-client/build.mjs
node scripts/deploy-web.mjs --out ../dsh-workflow-bundle
```

Use `../dsh-workflow-bundle` only as a dedicated output directory, empty on first use. The generator replaces build files inside it. **Never point it at your source checkout, DSH home or profile root.**

Install the generated bundle from the current source directory:

**PowerShell**

```powershell
$bundle = (Resolve-Path ../dsh-workflow-bundle).Path -replace '\\', '/'
dsh plugin --profile web add "file:$bundle"
```

**macOS / Linux shell**

```sh
bundle="$(cd ../dsh-workflow-bundle && pwd)"
dsh plugin --profile web add "file:$bundle"
```

Keep the bundle directory as the source of your local dependency. Start or restart DSH Web, then refresh the browser:

```sh
dsh web
```

> **Current packaging limitations**
>
> - The root [package manifest](<../package.json>) omits init resources from its publish allowlist and has no automatic build hook. Do not install the Git source or a root-level `npm pack` archive directly.
> - The [bundle generator](<../scripts/deploy-web.mjs>) includes server and client artifacts, the Manager preset and general development workflow template. Its generated manifest currently omits `engines`, so check Node / DSH versions yourself rather than relying on automatic compatibility enforcement.
> - Running the deployment script without `--out` writes a development bundle under the default user home. It does not install dependencies or register the profile for a first installation; this guide deliberately avoids that path.

## 3. Initialize templates and the Manager

In a DSH conversation with the plugin loaded, preview the changes, then install:

```text
/dsh-flow init --dry-run
/dsh-flow init
```

Initialization installs only the generic Manager preset and `development-workflow` (the general development workflow). It writes to the current DSH home's configuration patch and `workflows` directory; the default home is `~/.dsh`.

| Option | Behavior |
| --- | --- |
| No option | Install the generic Manager preset and general development workflow; skip differing existing content and report the difference |
| `--dry-run` | Preview only; write nothing |
| `--force` | Create a sibling `.bak-<timestamp>` backup, then replace differing content |

Do not use `--force` as a routine health check: it replaces custom configuration. `--full` has been removed and is rejected as an unknown argument. Other existing templates are left intact. The four previous complex templates remain [advanced examples](<example/README.md>) for manual copying; legacy templates and the combined demonstration are not installed either.

Restart DSH, then create a session using **团队工作流 Manager（通用）**, the generic team-workflow Manager preset. Set its working directory to the project you want to work on, not the plugin source checkout.

## 4. Configure and start your first task

1. Open **工作流配置** (Workflow configuration) in the sidebar. Select the `workflows` directory under your current DSH home and open the general development workflow.
2. All roles and the Judge inherit the Manager model by default; no additional model configuration or skills are required. Confirm that the Manager route works. To assign different models, configure `provider`, `modelId` and optional `reasoningEffort`, then save.
3. Check the template in your Manager conversation:

   ```text
   /dsh-flow list
   /dsh-flow check development-workflow
   ```

   `check` validates static configuration without sending a real inference request. Passing it does not guarantee provider availability.

4. Define the scope, acceptance criteria and permissions for commits, pushes or merges. Click **启动工作流** (Start workflow) near the conversation input, or run:

   ```text
   /dsh-flow start development-workflow Fix the specified issue, then review and test the changes
   ```

5. Use `/dsh-flow status` to inspect progress. If a companion sidebar providing `betterSidebar` is installed, you can also open **工作流监控** (Workflow monitor). The commands and editor do not require that sidebar.

Only one active Run is allowed per project workspace. BLOCK means that intervention is needed, not that the task is complete. See the [user guide](<user-guide.md>) (Chinese) for recovery, termination and external side-effect boundaries.

## Updates and troubleshooting

- **Update the plugin:** preserve your configuration, update the source, rebuild both server and client, regenerate the dedicated bundle, then install the update through the plugin manager. Restart DSH and refresh the browser; source edits alone do not update the loaded plugin.
- **Missing commands or UI:** check that you installed into `web`, built the client, loaded the plugin and restarted/refreshed.
- **Init reports missing resources:** generate the complete bundle again. Copying only server artifacts or packing the repository root is not sufficient.
- **Invalid template or unavailable route:** read the `list` and `check` diagnostics and follow the [configuration reference](<example/README.md>) (Chinese) before starting.
- **Initialize a different directory:** from the source checkout, use `node scripts/dsh-workflow-init.mjs --home <directory> --dry-run`. Remove `--dry-run` to write. This shares the conversation command's semantics, but is neither a global executable nor a plugin-package installer.

See the [user guide](<user-guide.md>) (Chinese) for operations and the [development guide](<development.md>) for validation and packaging boundaries.
