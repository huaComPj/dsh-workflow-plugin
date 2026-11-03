# 安装与上手

[返回首页](<../README.md>) · [English](<getting-started.en.md>)

本指南使用**源码构建 → 本地 bundle 安装**。当前尚未发布 npm 包；不要把按包名安装当作已经可用的分发渠道。

## 1. 准备环境

- Node.js **≥ 22.19**、DSH **≥ 0.2.1-rc.2**；推荐 Node.js 24。
- Git、pnpm、`dsh` 命令可用；DSH 中已配置至少一个可用模型。
- 使用 Web profile。模型调用计费由所选 provider 决定。
- 使用自定义 `DSH_HOME` 时，在安装、初始化和启动 DSH 时保持同一设置。

```sh
node --version
dsh --version
pnpm --version
```

升级已有安装时，先让活动任务结束，再停止对应 DSH 实例。下面的安装命令会修改 Web profile；构建和显式 `--out` 生成本身不会部署到真实 profile。

## 2. 构建并安装插件

在准备存放源码的目录中，**逐条运行**下列命令；任何一步失败就停止，不要继续安装旧产物。

```sh
git clone https://github.com/hua0424/dsh-workflow-plugin.git
cd dsh-workflow-plugin
pnpm install
pnpm run build
node web-client/build.mjs
node scripts/deploy-web.mjs --out ../dsh-workflow-bundle
```

`../dsh-workflow-bundle` 必须是专用于此插件的输出目录，首次使用空目录。生成器会替换其内部构建文件，**不要指向源码目录、DSH home 或 profile 根目录**。

从当前源码目录安装刚生成的 bundle：

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

保留该 bundle 目录，作为本地依赖的来源。安装完成后启动或重启 DSH Web，并刷新浏览器：

```sh
dsh web
```

> **当前打包限制**
>
> - 根 [package.json](<../package.json>) 的发布清单未包含 init 资源，也没有自动构建钩子。不要直接安装 Git 源码或根目录的 `npm pack` 产物。
> - [bundle 生成器](<../scripts/deploy-web.mjs>)会带上前后端产物、Manager preset 和通用开发工作流模板，但当前生成的 manifest 不带 `engines`。请自行核对上述 Node / DSH 版本，不要依赖自动兼容性拦截。
> - 不带 `--out` 的部署脚本写入默认用户目录下的开发 bundle，且不负责首次安装所需的依赖和 profile 注册；不用于本指南的首次安装。

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

- **更新插件**：保留自己的配置，更新源码后重新构建前后端、生成专用 bundle，再通过插件管理命令安装更新；重启 DSH 并刷新页面。不要假定源码改动会自动更新已加载插件。
- **命令不存在 / 界面未出现**：确认安装的是 `web` profile，前端构建成功，插件已加载，并已重启与刷新。
- **init 提示缺资源**：重新生成完整 bundle，不要只复制后端或使用根目录打包结果。
- **模板无效 / 路由不可用**：看 `list`、`check` 的诊断，按[配置参考](<example/README.md>)修正；不要直接启动未知路由。
- **需要指定初始化目录**：在源码仓库使用 `node scripts/dsh-workflow-init.mjs --home <目录> --dry-run`；去掉 `--dry-run` 才写入。它与对话命令共享语义，但不是全局可执行命令，也不安装插件包。

更多操作见[使用手册](<user-guide.md>)；开发验证与发布前限制见[开发指南](<development.md>)。
