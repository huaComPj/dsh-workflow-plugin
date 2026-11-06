# 安装与上手

[返回首页](<../README.md>) · [English](<getting-started.en.md>)

推荐从 npm 安装已公开发布的 **`dsh-agent-team-workflow@0.2.1-rc.1`**；该版本已通过官方 registry 全新安装复验。普通安装无需克隆源码、构建或准备本地 tgz，也无需 npm 登录。源码开发与本地打包见[开发指南](<development.md>)，维护者发布流程见[发布指南](<releasing.md>)。

## 1. 准备环境

- Node.js **≥ 22.19**、DSH **≥ 0.2.1-rc.2**；推荐 Node.js 24。
- `dsh`、pnpm 命令可用；首次安装不要求 Git 或插件源码。
- 使用 Web profile。**运行工作流前**须在 DSH 中配置至少一个可用模型；安装插件本身不要求先配置模型。模型调用计费由所选 provider 决定。
- 使用自定义 `DSH_HOME` 时，在安装、初始化、每次启动或重启 DSH、升级和排障时全程保持同一设置。

```sh
node --version
dsh --version
pnpm --version
```

兼容下限声明保持为上述版本；本次全新安装实测环境为 **Windows + Node.js 24.16.0 + DSH 0.2.1-rc.5**，不代表已验证全部操作系统、Node 与 DSH 版本组合。

升级或从开发版切换时，先让活动任务结束，再停止对应 DSH 实例。若 Web profile 已注册开发 bundle（如 `wfdev`）或本地源码版，先核对并停用旧开发版注册，再切换到 npm 包，**不要同时加载两份插件实例**。保留自定义 preset、工作流配置和状态数据，不要为切换而删除用户资源。下面的安装命令会修改所选 Web profile。

## 2. 从 npm 安装插件

在任意目录执行，不需要进入源码仓库：

```sh
dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.1
```

命令失败就停止，先排查错误；不要继续假定安装成功。需要明确使用官方 npm registry 时，仅为本次命令设置环境变量，不修改用户全局 npm/pnpm 配置：

**PowerShell（在子进程中临时设置，退出后不影响当前环境）**

```powershell
pwsh -NoProfile -Command '$env:npm_config_registry = "https://registry.npmjs.org"; dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.1'
```

**macOS / Linux shell（仅作用于这条命令）**

```sh
npm_config_registry=https://registry.npmjs.org dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.1
```

以上是同一安装操作的替代写法，选择一种即可。自定义 `DSH_HOME` 必须已在当前环境中设置，子进程会继承它。安装完成后启动或重启 DSH Web，并刷新浏览器：

```sh
dsh web
```

> **包内容与安装边界**
>
> - 发布包包含编译后的后端、Web 客户端、Cordis patch、Manager preset、唯一默认模板 `development-workflow`、README 与 MIT LICENSE。运行依赖仅 `yaml` / `zod`，宿主包不随插件安装。
> - 安装与 `init` 是独立写配置步骤；安装 npm 包不会替你完成下节初始化。
> - 本地 tgz、源码构建和开发部署不是普通安装前提；需要这些方式时见[开发指南](<development.md>)。不要把打包命令当作安装或部署命令。

## 3. 初始化模板与 Manager

在已加载插件的 DSH 对话中，先预演，再安装：

```text
/dsh-flow init --dry-run
/dsh-flow init
```

统一只安装通用 Manager preset 与 `development-workflow`（通用开发工作流）。文件落在当前 DSH home 的配置补丁和 `workflows` 目录下，默认 home 为 `~/.dsh`。

| 选项 | 行为 |
| --- | --- |
| 无选项 | 安装通用 Manager preset 与通用开发工作流；已有不同内容默认跳过并提示差异 |
| `--dry-run` | 只预览，不写入 |
| `--force` | 同目录生成 `.bak-<timestamp>` 备份，再覆盖差异内容 |

不要用 `--force` 作为日常检查命令，它会覆盖自定义配置。`--full` 已删除，传入会报未知参数。已有其他模板不会被删除；原四份复杂模板保留为[进阶示例](<example/README.md>)，可按需手工复制，旧协议模板和组合演示也不在安装范围内。

重启 DSH 后，新建一个使用 **团队工作流 Manager（通用）** preset 的会话，将工作目录设为你要处理的项目，而不是插件源码目录。

## 4. 配置并启动第一个任务

1. 打开侧栏「工作流配置」，选择当前 DSH home 下的 `workflows` 目录，打开通用开发工作流。
2. 默认各角色与 Judge 均继承 Manager 模型，不需要额外模型配置或技能。确认 Manager 路由可用；如需分配不同模型，再配置 `provider`、`modelId` 和可选 `reasoningEffort` 并保存。
3. 在 Manager 对话中检查模板：

   ```text
   /dsh-flow list
   /dsh-flow check development-workflow
   ```

   `check` 是静态配置检查，不会发送真实推理请求；通过不等于 provider 一定可用。

4. 明确任务范围、验收标准，以及是否允许提交、推送或合并。点击输入区「启动工作流」，或执行：

   ```text
   /dsh-flow start development-workflow 修复指定问题，并完成审查和测试
   ```

5. 用 `/dsh-flow status` 查看进度。若安装了提供 `betterSidebar` 服务的配套侧栏，还可打开「工作流监控」。没有该侧栏不会影响命令和配置编辑器。

一个项目工作区最多一个活动 Run。BLOCK 表示等待处理，不等于任务完成；恢复、终止及外部副作用的边界见[使用手册](<user-guide.md>)。

## 更新与排障

- **更新插件**：先确认目标新版本已在 npm 发布，保留自己的配置，让活动任务结束并停止对应 DSH 实例，再用 `dsh plugin --profile web add 包名@准确版本` 安装该版本，随后重启 DSH 并刷新页面。当前已存在的准确版本示例是 `dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.1`（已有同版本时是重装，不是升级）；将来升级应使用届时确已发布的新版本，不照抄不存在的版本号。
- **命令不存在 / 界面未出现**：确认安装的是 `web` profile，安装与启动使用相同 `DSH_HOME`，插件已加载且没有开发版双实例，并已重启与刷新。
- **init 提示缺资源**：核对已加载的插件版本与安装错误，重新安装已发布的完整 npm 包并重启；不要只复制后端，也不要用旧开发版替代发布包。
- **模板无效 / 路由不可用**：看 `list`、`check` 的诊断，按[配置参考](<example/README.md>)修正；不要直接启动未知路由。
- **需要源码开发或离线本地包**：见[开发指南](<development.md>)，不属于首次 npm 安装步骤。

更多操作见[使用手册](<user-guide.md>)；源码验证与打包见[开发指南](<development.md>)；npm 发布维护见[发布指南](<releasing.md>)。
