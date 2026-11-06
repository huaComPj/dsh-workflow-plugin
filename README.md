# DSH 团队工作流插件

**让 AI 团队按流程交付，而不只是轮流回答。**

中文 · [English](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/README.en.md>)

`dsh-agent-team-workflow` 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供可配置的**串行团队工作流**：Manager 协调任务，角色 Agent 分工执行，独立 Judge 核验结果，再进入下一步。

## 主要功能

- **角色分工与独立核验**：按流程安排开发、审查、测试等角色；Judge 根据当前节点的验收条件核验结果，未通过就不能沿通过路径推进。
- **可视化配置**：编辑节点、结果分支、角色属性和子流程，保存为 YAML；工作流可以复用，也可以按项目调整。
- **按角色选择模型**：默认继承 Manager 的模型，也可为不同角色和 Judge 单独配置模型与思考档位。
- **在对话中启动**：通过「启动工作流」弹窗或 `/dsh-flow start` 提交任务，不必手工协调每轮交接。
- **进度可见、异常可处理**：查看当前节点、Actor / Judge、执行记录和 BLOCK 原因；补充信息或处理障碍后可恢复推进。

> 工作流按节点**串行推进**，不是并行任务调度器。核验能约束流程，但不保证模型输出绝对正确；恢复或终止流程不会撤销已发生的文件修改、推送或合并。

## 典型使用场景

| 场景 | 使用方式 |
| --- | --- |
| 单仓库修复 Bug、实现小功能或重构 | 使用默认开发流程，围绕一个 Issue / PR 完成实现、审查、测试与合并 |
| 补测试、修改文档等需要独立检查的任务 | 使用默认流程，在 Issue 中写清楚适用检查与验收标准 |
| 多个任务按里程碑交付 | 按需采用进阶模板，组织拆票、逐票交付和集成验收 |
| 前后端等跨仓库联动 | 按需采用多仓库模板，并明确各仓库、分支与操作授权 |

普通安装只初始化下文的通用开发流程；复杂流程是[进阶配置示例](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/README.md>)，不是默认自动安装项。

## 安装与快速使用

### 1. 安装插件

需要 **Node.js ≥ 22.19、DSH ≥ 0.2.1-rc.2**，并有可用的 `dsh`、`pnpm` 命令；推荐 Node.js 24。

安装已发布的准确版本，无需克隆本插件源码、自己构建或登录 npm：

```sh
dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.2
dsh web
```

已有 DSH 实例时，先结束活动任务并停止对应实例；安装后启动或重启 Web，再刷新浏览器。已有开发版时避免与 npm 版重复加载；使用自定义 `DSH_HOME` 时，全程保持一致。

### 2. 初始化默认工作流

在已加载插件的 DSH 对话中执行：

```text
/dsh-flow init --dry-run
/dsh-flow init
```

这会安装 **通用 Manager preset** 和 **`development-workflow` 示例工作流**。已有不同内容默认跳过，不覆盖自定义配置，也不删除其他模板。

### 3. 启动第一个任务

重启 DSH，选择 **团队工作流 Manager（通用）** 新建会话，把工作目录设为你的目标项目，并为 Manager 配置可用模型。默认模板的开发、审查、测试角色及 Judge 均继承该模型。

默认示例围绕 GitHub Issue / PR 工作，运行前还需具备 Git、可用的 GitHub 访问工具（如 `gh` CLI）和仓库权限。它会创建 Issue、任务分支，提交、推送并创建 PR，需先获得这些操作的授权；合并另经用户确认。若只允许只读操作，应先调整模板，不要直接启动完整交付流程。

```text
/dsh-flow list
/dsh-flow check development-workflow
/dsh-flow start development-workflow 修复指定问题，并完成审查和测试
```

也可点击输入区的「启动工作流」，选择配置并描述任务。启动后用 `/dsh-flow status` 查看进度；安装提供 `betterSidebar` 服务的配套侧栏后，还可打开「工作流监控」。

`check` 只检查配置，不发送真实模型推理请求；实际运行会调用模型，并可能执行获准的本地或远端操作。完整安装、升级与排障步骤见[安装与上手](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/getting-started.md>)。

完整操作可跟随[默认工作流任务示例](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/development-workflow-walkthrough.md>)：在可写演示仓库完善贡献指南，逐步确认授权、检查与合并候选。

## 默认示例工作流

`init` 安装的 `development-workflow` 是一个**单仓库、单 Issue、单 PR** 的五节点流程：

```text
澄清需求并建 Issue → 开发实现 → 独立审查 → 独立测试 → 人工确认后合并
```

- **Manager** 负责澄清需求、记录验收标准，并在最后向用户确认具体合并候选；开发、审查和测试分别由相应角色执行，各节点结果还需 Judge 核验。
- 审查或测试发现必修问题，或候选修订发生变化时，回到实现并重新走审查、测试；不能用旧候选的通过结论跳过检查。
- 最后取得用户明确确认后，以 squash 合并并核验结果、关闭关联 Issue；默认模板**不部署、不发布、不删除分支**。

模板是起点，不是固定策略。角色、模型、节点与验收条件都可按项目调整；具体配置见[默认模板源码](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/development-workflow.yaml>)和[模板与配置说明](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/README.md>)。

## 界面预览

### 可视化配置

在画布上查看节点与结果分支，在右侧编辑节点、角色、流程或 YAML。图中展示的是包含子流程的进阶配置，不是默认五节点模板。

![工作流配置：节点连线、子流程切换与右侧属性面板](<docs/images/ScreenShot_workflow-config.png>)

### 启动工作流

在当前会话中选择工作流配置、填写任务描述后启动；可选配置由你的本地工作流目录决定。

![启动工作流：配置选择与任务描述弹窗](<docs/images/ScreenShot_start_workflow.png>)

### 运行监控

配套侧栏展示运行图、当前节点、Actor / Judge 与执行记录。图中为进阶流程的 **BLOCK 等待处理** 状态，用于展示诊断信息，并非已成功交付的示例。

![工作流监控：子流程运行图、当前节点、BLOCK 原因与执行记录](<docs/images/ScreenShot_workflow_monitor.png>)

## 详细操作说明

首页只保留安装与最短使用路径，详细操作按需查阅：

| 文档 | 内容 |
| --- | --- |
| [安装与上手](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/getting-started.md>) | 环境准备、初始化、第一次运行、升级与常见排障 |
| [使用手册](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/user-guide.md>) | 日常命令、模型路由、BLOCK 处理、恢复与终止 |
| [模板与配置说明](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/example/README.md>) | 角色、节点、结果分支、子流程和进阶模板 |
| [开发指南](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/development.md>) | 源码构建、测试、架构与本地打包 |
| [更新与发布](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/docs/releasing.md>) | 升版、候选验收、npm 发布与发布后复验 |

遇到问题可[提交 Issue](https://github.com/huaComPj/dsh-workflow-plugin/issues/new/choose)，附上版本、复现步骤和脱敏后的错误信息。

## 许可证

[MIT](<https://github.com/huaComPj/dsh-workflow-plugin/blob/main/LICENSE>) © hua0424
