# 程序更新后如何重新发布 npm 包

[首页](<../README.md>) · [普通用户安装](<getting-started.md>) · [开发与测试](<development.md>)

本指南面向维护者。普通用户只需按安装指南运行 `dsh plugin --profile web add ...`，不需要源码、npm 账号或自行打包。

**流程：完成变更 → 新版本 → 固定源码 → 验证并打包 → 验收同一 tgz → 发布 → 从 registry 复验。** 以下命令是操作说明，不代表自动授权发布、推送、覆盖配置或重启宿主。命令以 **PowerShell 7** 为例，除明确说明外在仓库根目录逐段执行；任何一步失败都应停止，不要继续发布旧产物。不要一次粘贴执行整个文档。

## 1. 选择新版本和渠道

`dsh-agent-team-workflow@0.2.1-rc.1` 已发布。**同名同版本不能覆盖**，修改代码、包内 README 或仓库元数据后，都要选择一个未发布的新版本。

| 用途 | 版本示例 | dist-tag |
| --- | --- | --- |
| 新候选版 | `0.2.1-rc.3` | `next` |
| 正式版 | `0.2.1` | `latest`（也可先用 `next` 验证，再提升） |

当前发行目标为 `0.2.1-rc.2`，用于修正 GitHub 迁仓后的 npm `repository` 关联；用户已选择在该版本通过验收并发布后同步 `latest` / `next`，随后提交市场 PR。这是本次明确授权的渠道选择，不表示发布或复验已完成。上表是后续版本的示例，不表示已经发布；插件版本与 DSH 宿主版本独立，不要为了数字相同而升版。维护者应根据实际变更选择版本，破坏性变更需说明迁移与兼容性。

```powershell
# 后续新版本示例；替换为真正要发布的未发布版本，不是覆盖 rc.1 或 rc.2。
$version = '0.2.1-rc.3'
$tag = 'next'
npm view "dsh-agent-team-workflow@$version" version --registry=https://registry.npmjs.org/
```

如果返回版本，不能再次使用该版本。E404 只说明这次查不到该版本，不证明账号有发布权限；网络、认证或其他错误也不能当作“版本可用”。

## 2. 修改版本、说明与兼容性

先完成代码、测试和审查，保护工作区已有改动；不要把无关 WIP 或凭据纳入发行。版本及发行元数据以根 [package.json](<../package.json>) 为单源：

```powershell
npm version $version --no-git-tag-version
if ($LASTEXITCODE -ne 0) { throw '升版失败' }
```

这会修改版本文件，但不创建 Git commit/tag。检查差异；若修改依赖，应同步维护项目现有的 pnpm lockfile，不要另引入 npm lockfile 或把宿主 API 移入运行依赖。

同步检查：

- README、中英文安装指南中的准确版本命令及更新说明。
- Node / DSH 的 `engines` 与实际验证矩阵；不要把一个平台通过写成全平台保证。
- 若 GitHub 仓库迁移，更新 `repository`、`homepage`、`bugs` 及 README/文档链接。npm 包名不必随仓库改名，旧版包中的链接也不会自动更新。
- 运行依赖保留 `yaml` / `zod`；宿主包仍是开发依赖，由已安装 DSH 在运行时解析。

在正常开发审查流程中将本次变更与版本一同提交。下面从这个**已确认、工作区干净的 commit**生成候选；本指南不自动 commit/push。GitHub 同步、Git tag 或 Release 可用于溯源，但不是 npm 能下载包的技术前提。

## 3. 从干净源码生成候选

直接在旧工作区构建可能残留已删除模块的编译文件。推荐归档当前 commit 到新临时目录，避免混入旧 `lib`、运行数据或未提交文件。

```powershell
$repo = (Get-Location).Path
$state = git -C $repo status --porcelain
if ($LASTEXITCODE -ne 0 -or $state) { throw '先处理并确认工作区改动，不要自动丢弃 WIP' }
$commit = git -C $repo rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw '读取 commit 失败' }
$case = Join-Path $env:TEMP ('dsh-workflow-release-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $case 'source'
New-Item -ItemType Directory -Path $source | Out-Null
git -C $repo archive --format=tar -o "$case/source.tar" $commit
if ($LASTEXITCODE -ne 0) { throw '归档失败' }
tar -xf "$case/source.tar" -C $source
if ($LASTEXITCODE -ne 0) { throw '解包源码失败' }
Set-Location $source
```

在干净源码中逐项验证：

```powershell
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw '开发依赖安装失败' }
pnpm run verify
if ($LASTEXITCODE -ne 0) { throw '源码验收失败' }
pnpm run test:real-host
if ($LASTEXITCODE -ne 0) { throw '真实 Host 测试入口失败' }
pnpm run pack:release
if ($LASTEXITCODE -ne 0) { throw '候选打包失败' }

$version = (Get-Content ./package.json -Raw | ConvertFrom-Json).version
$tgz = Join-Path $source ".scratch/dsh-agent-team-workflow-$version.tgz"
Get-FileHash -LiteralPath $tgz -Algorithm SHA256
tar -tzf $tgz
if ($LASTEXITCODE -ne 0) { throw '无法读取候选包' }
```

`pack:release` 已存在于项目中：后端构建 → 客户端构建 → `deploy-web.mjs --out .scratch/release` → `npm pack`。它不发布、不部署真实 profile。不要用没有构建保证的根目录 `npm pack` 替代，也不要调用不带 `--out` 的部署脚本来发布 npm。

`verify`、受控 smoke、脚本化模型的真实 Host 测试、外部真实模型和浏览器体验是不同证据，报告必须分开。缺少必要验证时应记录缺口并停止对应发布门禁，不能把环境失败当作通过。

## 4. 验收这个 tgz，而不是另一份重构建

检查实际包清单至少包含：

- `lib/index.js` 及运行模块、`web-client/dist/client.js`。
- `cordis.patch.yml`、`resources/preset-manager.patch.yml`。
- `resources/workflows/development-workflow.yaml`（当前唯一默认模板）。
- `package.json` 的名称、版本、exports、dsh 声明、engines 和元数据，以及 README、LICENSE。
- 不包含真实 DSH 配置、凭据、数据库、会话日志、其他旧 tgz 或临时验收数据。

包文件数会随代码变化，**不要把首发的 46 文件当作永远不变的硬编码标准**。

使用仓库外、也不是构建源码子目录的临时 DSH home/profile。以下 `home-tgz` 与 `$source` 是兄弟目录，避免运行时误用源码 `node_modules`：

```powershell
$previousHome = $env:DSH_HOME
try {
    $env:DSH_HOME = Join-Path $case 'home-tgz'
    dsh --profile web --dump-config
    if ($LASTEXITCODE -ne 0) { throw '临时 profile 初始化失败' }
    $target = 'file:' + ($tgz -replace '\\', '/')
    dsh plugin --profile web add $target
    if ($LASTEXITCODE -ne 0) { throw 'tgz 安装失败' }
    dsh --profile web --dump-config
    if ($LASTEXITCODE -ne 0) { throw '安装后配置加载失败' }
} finally {
    $env:DSH_HOME = $previousHome
}
```

配置加载成功还不等于全部功能通过。使用上述临时 home 在验收主机上启动 Web，检查客户端加载，再在 DSH 对话执行：

```text
/dsh-flow init --dry-run
/dsh-flow init
/dsh-flow init
/dsh-flow list
/dsh-flow check development-workflow
```

确认：dry-run 零写、首次资源完整、重复初始化幂等、用户差异配置默认跳过、需要覆盖时先备份；不要在真实配置上试 `--force`。按改动范围补编辑器、受控流程终局和 SQLite 重开检查；GUI 或真实模型未测时必须明确写出。

启动验收实例时保持临时 `DSH_HOME`，例如在**无同端口实例的验收主机**新开 PowerShell：

```powershell
# 将此处替换成上面输出的实际临时 home 路径，不要使用真实 home。
$env:DSH_HOME = 'C:/替换成实际路径/home-tgz'
dsh web
```

关闭验收实例后再继续发布。不要另起服务器替换正在使用的 GUI，也不要自动重启用户宿主。

记录 commit、版本、Node/DSH/平台、tgz SHA256/文件清单、各项结果与边界。保留这份 tgz；后续构建若改变了包的字节，就必须重新验收，不能沿用旧批准。

## 5. 登录并公开发布

仅维护者需要在 [npm 官网](https://www.npmjs.com/signup) 注册、验证邮箱并配置 2FA。不要将密码、验证码或 token 写进仓库、报告或命令参数；按 CLI 提示在浏览器完成认证。

```powershell
npm login --registry=https://registry.npmjs.org/
if ($LASTEXITCODE -ne 0) { throw '登录失败' }
npm whoami --registry=https://registry.npmjs.org/
if ($LASTEXITCODE -ne 0) { throw '无法确认发布账号' }
```

核对账号具有这个包的发布权限、候选仍是已验收文件、`$version` 与 `$tag` 正确。**只有获准公开发布后**执行：

```powershell
npm publish "$tgz" --tag $tag --access public --registry=https://registry.npmjs.org/
if ($LASTEXITCODE -ne 0) { throw '发布失败或状态不确定，先查询，不要盲目重试' }
```

候选版默认显式用 `next`，避免误把候选推进 `latest`；同步 `latest` 必须另有明确授权并通过准确版本验收（本次选择见 §1）。npm 账号配置可能要求额外浏览器/2FA 确认。发布失败时先保存脱敏错误并查询 registry；不要因为查询暂时 404 就重复发布、删除包或立即重打另一份同版本产物。

## 6. 检查 registry 与发布包身份

```powershell
npm view "dsh-agent-team-workflow@$version" version dist.integrity --json --registry=https://registry.npmjs.org/
if ($LASTEXITCODE -ne 0) { throw '尚未确认版本可见，先排查或稍后复查' }
npm view dsh-agent-team-workflow dist-tags --json --registry=https://registry.npmjs.org/
if ($LASTEXITCODE -ne 0) { throw '读取 tag 失败' }

# 使用本地已验收 tgz 计算 npm 的 SHA512 integrity，再与 registry 对比。
$integrity = node -e "console.log('sha512-'+require('node:crypto').createHash('sha512').update(require('node:fs').readFileSync(process.argv[1])).digest('base64'))" "$tgz"
if ($LASTEXITCODE -ne 0) { throw '计算 integrity 失败' }
$distJson = npm view "dsh-agent-team-workflow@$version" dist --json --registry=https://registry.npmjs.org/
if ($LASTEXITCODE -ne 0) { throw '读取 registry integrity 失败' }
$dist = $distJson | ConvertFrom-Json
if ($dist.integrity -cne $integrity) { throw '公开包与本地候选不一致，停止后续推广' }
```

刚发布时查询可能暂时不可见，但 E404 也可能是名称/版本/registry 或权限问题；不能仅凭它断定原因。先查准确版本及发布命令结果，不要循环重发。

## 7. 从 registry 在另一个干净 home 安装

不能用第 4 步的 file 依赖或已有安装代替此步骤：

```powershell
$previousHome = $env:DSH_HOME
$previousRegistry = $env:npm_config_registry
$previousStore = $env:npm_config_store_dir
try {
    $env:DSH_HOME = Join-Path $case 'home-registry'
    $env:npm_config_registry = 'https://registry.npmjs.org/'
    $env:npm_config_store_dir = Join-Path $case 'registry-store'
    dsh --profile web --dump-config
    if ($LASTEXITCODE -ne 0) { throw 'registry 验收 profile 初始化失败' }
    dsh plugin --profile web add "dsh-agent-team-workflow@$version"
    if ($LASTEXITCODE -ne 0) { throw 'registry 准确版本安装失败' }
    dsh --profile web --dump-config
    if ($LASTEXITCODE -ne 0) { throw 'registry 安装后配置加载失败' }
} finally {
    $env:DSH_HOME = $previousHome
    $env:npm_config_registry = $previousRegistry
    $env:npm_config_store_dir = $previousStore
}
```

在 `home-registry` 重复第 4 步的初始化和功能检查，核对实际安装文件与已验收包一致，并记录结果。普通用户不需要 npm 登录；安装准确版本不依赖 `latest`/`next` 指向哪里。

## 8. 正式推广、用户更新及回退

通常在**正式版本号**对应的包已验收且获准推广时设置 `latest`；候选版只有在用户明确选择该渠道且该准确版本已发布、验收通过后才可设置（本次 rc.2 的选择见 §1）。下面以新正式版 `0.2.1` 为例；必须先发布并验收该版本，不能对尚不存在的版本执行：

```powershell
npm dist-tag add dsh-agent-team-workflow@0.2.1 latest --registry=https://registry.npmjs.org/
if ($LASTEXITCODE -ne 0) { throw '调整 latest 失败' }
```

dist-tag 是可变指针，不会改变版本号或包内容。将 `0.2.1-rc.3` 指向 `latest` 不会使它变成 `0.2.1`；候选转正式需要发布新版本，不是改名或覆盖原包。调整 tag 不需要重新构建已发布的同一版本。

用户结束活动任务并停止对应实例后，通过 `dsh plugin --profile web add dsh-agent-team-workflow@准确新版本` 更新；重启并刷新。需要更新内置资源时先 `init --dry-run`；差异配置默认跳过，备份后再决定是否 `--force`。开发版和 npm 版不能同时注册加载。

故障回退优先明确安装已验证的旧版本，**先核对状态库/配置格式兼容性并备份**；不能保证降级包可读取新版写入的数据。`latest` 如需回指旧版，按单独授权操作。不要把 `npm unpublish`、删配置、删数据库或全局清理当作常规回退。

## 9. 什么叫这次发布完成

- [ ] 新版本与源码基线明确，必要测试/审查及兼容性说明齐全。
- [ ] 同一 tgz 完成内容审计、隔离安装与适用功能验收，校验值可追溯。
- [ ] registry 精确版本、integrity 和预期 tag 核对通过。
- [ ] 从 registry 的新 home/profile 安装、初始化与适用功能复验通过。
- [ ] README/安装命令/更新说明同步；源码及文档链接可用，或已明确待迁移事项。
- [ ] 未覆盖的 GUI、真实模型或平台矩阵如实列出；所有外部发布、tag、部署行为均有明确授权。

只改源码文档不要求立即再发 npm；但想更新 npm 包自带 README 或程序内容，就必须以新版本走本流程。已发布 `0.2.1-rc.1` 中的文件不会随 GitHub 文档变化自动更新。
