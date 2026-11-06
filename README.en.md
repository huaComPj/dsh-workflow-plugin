# DSH Agent-Team Workflow

**An AI team with a delivery process—not just a chain of replies.**

[中文](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/README.md>) · English

`dsh-agent-team-workflow` brings configurable, serial team workflows to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). A Manager coordinates the work, role agents carry it out, and an independent Judge checks the result before the workflow moves on.

[Get started](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/getting-started.en.md>) · [Templates](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/README.md>) · [User guide](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/user-guide.md>) · [Report an issue](https://github.com/huaComPj/dsh-workflow-plugin/issues)

## Why use it?

- **Explicit roles and acceptance checks.** Assign responsibilities and models to development, review and testing roles. Results must pass verification before advancing.
- **Reusable workflows.** Visually edit nodes, result branches and subflows, then save them as YAML.
- **Start from a conversation.** Pick a template and describe the task, or use `/dsh-flow start`, rather than coordinating every handoff yourself.
- **Pause and recover.** Missing information or execution failures can put a workflow into BLOCK. Add context and resume; state and key events are stored locally.
- **Visible progress.** Inspect the current node, judgments and subflows. The optional companion sidebar providing the `betterSidebar` service adds a workflow-monitor tab.

> Nodes advance **serially**; this is not a parallel task scheduler. Verification constrains the process, not the correctness of every model response. Resuming or terminating a workflow does not undo file changes, pushes or merges already performed.

## Interface preview

### Visual editor

> **Screenshot pending** — Workflow canvas, connected nodes and role properties.

### Launch and monitor

> **Screenshots pending** — The workflow launch dialog and progress in the companion sidebar.

[How to add screenshots](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/images/README.md>)

## Choose a starting point

| Use case | Built-in template |
| --- | --- |
| One repository, one Issue / PR (installed by default) | `development-workflow` |
| One repository, one focused task (advanced example) | `coding-workflow-rapid` |
| One repository, issue breakdown and milestone delivery | `coding-workflow-single` |
| Multiple repositories, a focused task | `coding-workflow-rapid-multi` |
| Multiple repositories, issues and milestone delivery | `coding-workflow` |

The other four templates remain advanced examples and are not installed by `init`. Templates are starting points, not fixed policies. Adapt the roles, models, review and acceptance steps to your team. See the [template reference](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/README.md>) (Chinese).

## Install and run

**Installation requires Node.js ≥ 22.19 and DSH ≥ 0.2.1-rc.2; Node.js 24 is recommended.** Configure a working model provider before running workflows. Source builds additionally require Git and pnpm.

Install the published version from npm; no source checkout, local build or npm login is required (`dsh` and `pnpm` must be available):

```sh
dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.1
dsh web
```

For an existing DSH instance, finish active tasks and stop that instance first. If a development build is registered, avoid loading it alongside the npm version. Start or restart Web after installation and refresh the browser. Keep the same custom `DSH_HOME` throughout, if used. See the [installation guide](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/getting-started.en.md>) for version selection, updates and source installation.

Once the plugin is loaded, preview and then initialize it in a DSH conversation:

```text
/dsh-flow init --dry-run
/dsh-flow init
```

Restart DSH, create a project session with **团队工作流 Manager（通用）** (the generic team-workflow Manager preset), and confirm the Manager has a working model route (all roles and the Judge inherit it in the default template). Then check and start it:

```text
/dsh-flow list
/dsh-flow check development-workflow
/dsh-flow start development-workflow Fix the specified issue, then review and test the changes
```

`init` installs only the general development workflow and generic Manager preset. It skips differing existing configurations and leaves your other templates intact. See the [installation guide](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/getting-started.en.md>) for backup-and-replace and dry-run options. Starting a workflow uses models and may perform local or remote actions: define its authorization boundaries first.

## Learn more

- [User guide](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/user-guide.md>) (Chinese): commands, model routes, recovery and troubleshooting.
- [Template reference](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/README.md>) (Chinese): roles, nodes, result branches and subflows.
- [Development guide](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/development.md>): build, tests, architecture and runtime documentation.
- [Updating and publishing releases](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/releasing.md>) (Chinese): versioning, candidate acceptance, npm publication and registry re-verification.
- [Report an issue](https://github.com/huaComPj/dsh-workflow-plugin/issues/new/choose): include versions, reproduction steps and redacted errors.

## License

[MIT](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/LICENSE>) © hua0424
