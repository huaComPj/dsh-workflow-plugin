# DSH 团队工作流插件

**让 AI 团队按流程交付，而不只是轮流回答。**

中文 · [English](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/README.en.md>)

`dsh-agent-team-workflow` 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供可配置的串行团队工作流：Manager 协调任务，角色 Agent 分工执行，独立 Judge 核验结果，再进入下一步。

[安装与上手](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/getting-started.md>) · [配置模板](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/example/README.md>) · [使用手册](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/user-guide.md>) · [反馈问题](https://github.com/hua0424/dsh-workflow-plugin/issues)

## 为什么使用它

- **明确分工与验收**：为开发、审查、测试等角色指定职责和模型；执行结果通过核验后才推进。
- **把流程变成配置**：可视化编辑节点、结果分支和子流程，保存为 YAML；同一套流程可重复使用。
- **在对话中启动**：选择模板、填写任务，或用 `/dsh-flow start` 启动，不必手工协调每一轮交接。
- **出问题可暂停处理**：缺少信息或执行故障时进入 BLOCK，补充材料后恢复；状态和关键事件保存在本地。
- **看得见进度**：查看当前节点、判定和子流程。安装提供 `betterSidebar` 服务的配套侧栏后，还可使用「工作流监控」页签。

> 工作流按节点**串行推进**，不是并行任务调度器。核验能约束流程，但不保证模型输出绝对正确；恢复或终止流程也不会撤销已发生的文件修改、推送或合并。

## 界面预览

### 可视化配置

> **截图待补** — 展示「工作流配置」画布、节点连线与角色属性。

### 启动与监控

> **截图待补** — 展示「启动工作流」弹窗，以及配套侧栏中的运行进度。

[截图补充说明](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/images/README.md>)

## 适合哪些任务

| 场景 | 内置模板 |
| --- | --- |
| 单仓库、单 Issue / PR 的通用开发（默认安装） | `development-workflow` |
| 单仓库、单个任务的快速交付（进阶示例） | `coding-workflow-rapid` |
| 单仓库、拆票到里程碑的完整交付 | `coding-workflow-single` |
| 多仓库、小范围任务 | `coding-workflow-rapid-multi` |
| 多仓库、分票与里程碑交付 | `coding-workflow` |

后四份模板保留为进阶示例，不由 `init` 安装。这些是起点，不是固定规则：可按团队需要调整角色、模型、审查和验收步骤。详见[模板与配置说明](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/example/README.md>)。

## 安装与首次运行

**要求：Node.js ≥ 22.19、DSH ≥ 0.2.1-rc.2，并已配置可用模型。** 从源码构建还需要 Git 和 pnpm；推荐使用 Node.js 24。

当前尚未发布到 npm。先按[安装指南](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/getting-started.md>)运行 `pnpm run pack:release`，构建前后端并生成完整候选包，再安装本地 `.tgz`；此命令不发布、不部署或修改 DSH 配置。根目录 `npm pack` 的资源白名单也已完整，但不会自动构建，不能保证产物新鲜。

插件加载后，在 DSH 对话中执行：

```text
/dsh-flow init
```

重启 DSH，选择 **团队工作流 Manager（通用）** 新建项目会话，确认 Manager 已配置可用模型（默认模板的角色与 Judge 均继承该模型），然后检查并启动：

```text
/dsh-flow list
/dsh-flow check development-workflow
/dsh-flow start development-workflow 修复指定问题，并完成审查和测试
```

`init` 只安装通用开发工作流与通用 Manager preset，不覆盖已有差异配置，也不删除用户已有模板；备份覆盖和预演选项见[安装指南](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/getting-started.md>)。启动会调用模型，并可能按任务执行文件或远端操作，请先明确授权边界。

## 深入了解

- [使用手册](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/user-guide.md>)：命令、模型路由、恢复与故障排查。
- [配置模板](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/example/README.md>)：角色、节点、结果分支与子流程。
- [开发指南](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/development.md>)：构建、测试、架构与运行时文档入口。
- [问题反馈](https://github.com/hua0424/dsh-workflow-plugin/issues/new/choose)：附上版本、复现步骤和脱敏后的错误信息。

## 许可证

[MIT](<https://github.com/hua0424/dsh-workflow-plugin/blob/main/LICENSE>) © hua0424
