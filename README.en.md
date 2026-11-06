# DSH Agent-Team Workflow

**An AI team with a delivery process—not just a chain of replies.**

[中文](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/README.md>) · English

`dsh-agent-team-workflow` brings configurable, **serial team workflows** to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). A Manager coordinates the work, role agents carry it out, and an independent Judge checks the result before the workflow moves on.

## Key features

- **Role-based work and independent checks.** Assign development, review, testing and other roles to workflow steps. The Judge checks each result against that node's criteria; an unapproved result cannot advance along an approved path.
- **Visual configuration.** Edit nodes, result branches, role properties and subflows, then save as YAML. Reuse workflows or adapt them to a project.
- **Models per role.** Inherit the Manager model by default, or configure separate models and reasoning efforts for roles and the Judge.
- **Start from a conversation.** Submit a task through the **启动工作流** (Start workflow) dialog or `/dsh-flow start`, rather than coordinating each handoff yourself.
- **Visible progress and recoverable interruptions.** Inspect the current node, Actor / Judge, execution records and BLOCK reason. Supply missing information or resolve an obstacle, then resume.

> Nodes advance **serially**; this is not a parallel task scheduler. Verification constrains the process, not the correctness of every model response. Resuming or terminating a workflow does not undo file changes, pushes or merges already performed.

## Typical use cases

| Use case | How to use it |
| --- | --- |
| Fix a bug, implement a small feature or refactor one repository | Use the default development workflow to implement, review, test and merge one Issue / PR |
| Add tests or update documentation with independent checks | Use the default workflow and state the applicable checks and acceptance criteria in the Issue |
| Deliver several tasks through a milestone | Adapt an advanced template for issue breakdown, per-issue delivery and integration acceptance |
| Coordinate changes across repositories, such as frontend and backend | Adapt a multi-repository template and explicitly identify repositories, branches and permitted operations |

Normal initialization installs only the general development workflow described below. More complex workflows are [advanced configuration examples](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/README.md>) (Chinese), not additional default installations.

## Installation and quick start

### 1. Install the plugin

Requires **Node.js ≥ 22.19 and DSH ≥ 0.2.1-rc.2**, with `dsh` and `pnpm` available. Node.js 24 is recommended.

Install the published exact version; no plugin source checkout, local build or npm login is required:

```sh
dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.2
dsh web
```

If DSH is already running, finish active tasks and stop the relevant instance first. Start or restart Web after installation, then refresh the browser. Avoid loading a development build alongside the npm version. Keep the same custom `DSH_HOME` throughout, if used.

### 2. Initialize the default workflow

In a DSH conversation with the plugin loaded, run:

```text
/dsh-flow init --dry-run
/dsh-flow init
```

This installs the **generic Manager preset** and the **`development-workflow` example**. Differing existing content is skipped by default: initialization neither overwrites custom configuration nor deletes other templates.

### 3. Start your first task

Restart DSH and create a session with **团队工作流 Manager（通用）** (the generic team-workflow Manager preset). Set the working directory to your target project and configure a usable model for the Manager. In the default template, the developer, reviewer, tester and Judge inherit that model.

The default example works with GitHub Issues / PRs. Running it also needs Git, a usable GitHub access tool such as the `gh` CLI, and repository permissions. It creates an Issue and task branch, commits, pushes and opens a PR; authorize these operations first. Merging requires a separate user confirmation. If only read-only work is permitted, adapt the template instead of starting the full delivery workflow.

```text
/dsh-flow list
/dsh-flow check development-workflow
/dsh-flow start development-workflow Fix the specified issue, then review and test the changes
```

Alternatively, click **启动工作流** (Start workflow) near the conversation input, choose a configuration and describe the task. Inspect progress with `/dsh-flow status`. A companion sidebar providing the `betterSidebar` service also adds **工作流监控** (Workflow monitor).

`check` validates configuration without sending a real model-inference request. Running the workflow uses models and may perform authorized local or remote operations. For complete installation, upgrade and troubleshooting instructions, see [Installation and first run](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/getting-started.en.md>).

## Default example workflow

The `development-workflow` installed by `init` is a five-node workflow for **one repository, one Issue and one PR**:

```text
Clarify requirements and create Issue → Implement → Independent review → Independent tests → User-confirmed merge
```

- The **Manager** clarifies requirements, records acceptance criteria and obtains user approval for the specific merge candidate. Development, review and testing are assigned to their respective roles; each node's result also requires a Judge check.
- Required fixes from review or testing, or a changed candidate revision, return to implementation and repeat review and testing. Passing results from an old candidate cannot bypass these checks.
- After explicit user approval, the Manager squash-merges, verifies the result and closes the linked Issue. The default template **does not deploy, publish or delete branches**.

Templates are starting points, not fixed policies. Adapt roles, models, nodes and acceptance criteria to your project. See the [default template source](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/development-workflow.yaml>) and [template reference](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/README.md>) (Chinese).

## Interface preview

### Visual configuration

Inspect nodes and result branches on the canvas, and edit node, role, workflow or YAML properties on the right. The screenshot shows an advanced configuration with subflows, not the default five-node template.

![Workflow configuration with connected nodes, subflow tabs and a properties panel](<docs/images/ScreenShot_workflow-config.png>)

### Start a workflow

Choose a workflow configuration and enter a task description in the current conversation. Available configurations come from your local workflow directory.

![Start-workflow dialog with a configuration selector and task description](<docs/images/ScreenShot_start_workflow.png>)

### Run monitor

The companion sidebar displays the run graph, current node, Actor / Judge and execution records. The screenshot shows an advanced workflow in **BLOCK, waiting for intervention**; it illustrates diagnostics, not a successfully delivered task.

![Workflow monitor with a subflow graph, current node, BLOCK diagnostics and execution records](<docs/images/ScreenShot_workflow_monitor.png>)

## Detailed instructions

This page covers installation and the shortest path to a first task. Follow the relevant guide for details:

| Document | Contents |
| --- | --- |
| [Installation and first run](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/getting-started.en.md>) | Prerequisites, initialization, first task, upgrades and common troubleshooting |
| [User guide](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/user-guide.md>) (Chinese) | Daily commands, model routes, BLOCK handling, recovery and termination |
| [Template reference](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/README.md>) (Chinese) | Roles, nodes, result branches, subflows and advanced templates |
| [Development guide](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/development.md>) | Source builds, tests, architecture and local packaging |
| [Updating and publishing releases](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/releasing.md>) (Chinese) | Versioning, candidate acceptance, npm publication and registry re-verification |

To [report an issue](https://github.com/huaComPj/dsh-workflow-plugin/issues/new/choose), include versions, reproduction steps and redacted errors.

## License

[MIT](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/LICENSE>) © hua0424
