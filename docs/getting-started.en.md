# Installation and first run

[Back to README](<../README.en.md>) · [中文](<getting-started.md>)

Install the publicly released **`dsh-agent-team-workflow@0.2.1-rc.1`** from npm. A fresh installation from the official registry has passed verification. Normal installation requires no source checkout, build, local tgz or npm login. For source development and local packaging, see the [development guide](<development.md>); maintainers should use the [release guide](<releasing.md>) (Chinese).

## 1. Prerequisites

- Node.js **≥ 22.19** and DSH **≥ 0.2.1-rc.2**; Node.js 24 is recommended.
- `dsh` and pnpm on your PATH. A first installation does not require Git or the plugin source.
- The Web profile. Configure at least one usable model in DSH **before running a workflow**; installing the plugin does not require a model first. Model usage is billed by your chosen provider.
- If you use a custom `DSH_HOME`, keep it consistent throughout installation, initialization, every DSH start or restart, upgrades and troubleshooting.

```sh
node --version
dsh --version
pnpm --version
```

The declared minimum versions remain as stated above. This fresh-install verification used **Windows + Node.js 24.16.0 + DSH 0.2.1-rc.5**; it does not establish coverage of every operating system, Node and DSH version combination.

For an upgrade or a switch from a development build, let active tasks finish before stopping the relevant DSH instance. If the Web profile already registers a development bundle (such as `wfdev`) or local source installation, inspect and disable that old development registration before switching to npm. **Do not load two plugin instances.** Preserve custom presets, workflow configuration and state data; do not delete user resources to switch installations. The command below changes the selected Web profile.

## 2. Install from npm

Run this from any directory; no source checkout is needed:

```sh
dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.1
```

Stop if the command fails and investigate the error instead of assuming installation succeeded. If you need to select the official npm registry explicitly, use an environment variable for this command only; do not change global npm/pnpm configuration:

**PowerShell (temporary child-process environment; leaves your current environment unchanged)**

```powershell
pwsh -NoProfile -Command '$env:npm_config_registry = "https://registry.npmjs.org"; dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.1'
```

**macOS / Linux shell (applies only to this command)**

```sh
npm_config_registry=https://registry.npmjs.org dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.1
```

These are alternatives for the same installation; choose one. A custom `DSH_HOME` must already be set in your current environment, which the child process inherits. Start or restart DSH Web, then refresh the browser:

```sh
dsh web
```

> **Package contents and installation boundaries**
>
> - The release includes compiled server and Web client, Cordis patch, Manager preset, the single default `development-workflow` template, README and MIT LICENSE. Runtime dependencies are only `yaml` / `zod`; host packages are not installed with the plugin.
> - Installation and `init` are separate configuration-writing steps. Installing the npm package does not perform the initialization below.
> - Local tgz packages, source builds and development deployment are not normal installation prerequisites. See the [development guide](<development.md>) if you need them. Packing is not installation or deployment.

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

- **Update the plugin:** first confirm that the target new version has been published to npm. Preserve your configuration, let active tasks finish and stop the relevant DSH instance, then install with `dsh plugin --profile web add package-name@exact-version`. Restart DSH and refresh the browser. An existing exact-version example is `dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.1` (reinstalling this same version is not an upgrade). For a future upgrade, use a new version that has actually been published, not a made-up version number.
- **Missing commands or UI:** check that you installed into `web`, used the same `DSH_HOME` for installation and startup, loaded the plugin without a duplicate development instance, and restarted/refreshed.
- **Init reports missing resources:** check the loaded plugin version and installation errors, reinstall the complete published npm package and restart. Do not copy only server artifacts or substitute an old development build.
- **Invalid template or unavailable route:** read the `list` and `check` diagnostics and follow the [configuration reference](<example/README.md>) (Chinese) before starting.
- **Source development or an offline local package:** see the [development guide](<development.md>); these are not first-time npm installation steps.

See the [user guide](<user-guide.md>) (Chinese) for operations, the [development guide](<development.md>) for source validation and packaging, and the [release guide](<releasing.md>) (Chinese) for npm publishing.
