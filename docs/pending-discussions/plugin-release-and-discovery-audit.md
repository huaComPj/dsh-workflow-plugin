# 插件发布、说明与发现路径审计

- 日期：2026-11-06（研究时点；远端规则和目录会继续变化）。
- 对象：`dsh-agent-team-workflow`；GitHub：[`huaComPj/dsh-workflow-plugin`](https://github.com/huaComPj/dsh-workflow-plugin)。
- 源码适用基线：`15e3c0a023f28330c07981a8a72afd986ae9c144`，提交时间 `2026-11-06T20:11:41+08:00`。
- 已发布包适用版本：`0.2.1-rc.2`；包源码基线 `bdc430c32892f5c7e34fd7fc39289d4ab8eae9a6`，不是上面的新文档 HEAD。
- 本轮授权：**只读审计与研究，仅新增本报告；没有修改产品、其他文档、图片、GitHub 配置、remote 或社区条目，没有 commit / push / publish / Release / 评论，也没有启动服务。** 后文都是待授权建议，不是执行记录。
- 研究分工：本报告核对官方规则与社区源码；父会话独立核对实际 HTTP 入口、npm 页面/完整 packument、当前 About/topics/Release 与本地资料，随后可追加实测结果。标为“交接基线”的远端状态不冒充本 worker 本轮重新验证。

## 后续核实与实施更新（2026-11-06）

本节更新在原始只读审计之后形成，避免把当时的待确认项当作当前缺陷：

- **npm 页面已实际确认正常显示 README**：[包页面](https://www.npmjs.com/package/dsh-agent-team-workflow) 的标题为 `dsh-agent-team-workflow - npm`，README article 的标题是“DSH 团队工作流插件”；当前版本为 rc.2，安装命令、英文入口与新仓库地址正确。页面仍显示 rc.2 原稿的“截图待补”，README 图片数为 0，不是空白说明页。此前 registry 字段为空与 Cloudflare 阻挡的记录保留为排查过程，不能继续当作网页缺 README 的依据。
- 用户已授权复用现有图片；根 `screenshots.json` 已在本地新增，按配置→启动→监控列出同三张原图，未改图。它仍须推送、社区收录和后续采集才能影响市场展示，本地创建不代表已经生效。
- 已基于现有 init 默认模板新增本地完整任务说明 `docs/example/development-workflow-walkthrough.md`，并接入中英文首页、安装指南与示例索引；没有新增 YAML 或真正执行示例中的 GitHub 写操作。
- Issue 模板的 DSH 下限和发行指南的过时状态文案已在本地修正，实际包版本仍为 `0.2.1-rc.2`，没有发包、调整标签或创建 Release。
- 本报告仍是此前未提交的研究记录，不自动混入上述实施提交。原始分级建议在下面保留作为决策背景；当前完成项以上述新鲜记录为准。

## 一、结论：不缺一套新宣传文档，缺的是入口一致性与下一版分发收尾

已有中英文首页、上手、使用、开发、发布说明与三张真实截图，**不建议再建官网、复制一套安装教程，或为“曝光”立即制造新版本**。最小后续行动只有三组：

1. **P0：把源码新说明与已发布 rc.2 区分清楚，消除版本提示冲突。** 不覆盖旧包，不把 `latest` 解释成 stable，不把 CI 绿灯说成社区已收录。
2. **P1：下一次获准发版时，让新首页及其依赖真正进入发行链；社区合并后核对实际目录数据。** 若希望三张现有图片出现在 `dshmarket` 的普通卡片缩略图，而不仅是详情页，另行授权自仓截图声明即可，不需要改原图。
3. **P2：视需要做一个辨识图标、一次干净演示和有溯源的 Release。** 这些有助理解/辨认，但不是 npm 安装门槛，也没有曝光或转化保证。

优先级含义：P0 是避免错误操作/错误承诺，不表示现在必须发包；P1 是下一次维护时最值得做的小项；P2 是可延后，不阻塞当前精确版本安装。

## 二、适用事实与已做事项

| 事实 | 证据与核验边界 | 结论 |
| --- | --- | --- |
| 新首页已含中英入口、功能/场景、准确版本安装、初始化、五节点流程、授权边界和三张截图 | 本轮读取 [README 源码固定版本](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/README.md#L1-L118)；本地 `git rev-parse HEAD` 与该 SHA 一致 | 已做，不再要求重写一套 README |
| 包已有 description、repository、homepage、bugs、keywords、MIT 和 Node/DSH engines | 本轮读取 [manifest 固定版本](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/package.json#L81-L104) | 元数据字段不缺，不应堆更多近义关键词 |
| 已有 `dsh.bundle` 与 Web client 声明 | [manifest](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/package.json#L20-L27) | 不需要为过社区门槛重复设计安装格式 |
| rc.2 已公开，`latest` / `next` 均指 rc.2；包内 46 files、registry 隔离验收 12 checks 已完成 | **交接基线**，由父会话核验材料；本轮不重复整套 npm/安装检查 | 不因文档更新否定这份特定版本验收；46 不是未来版本固定文件数 |
| 已发布 rc.2 的包只带原 README，未带英文 README / 截图；源码新文档已在另一 SHA | **交接基线**；本轮另以当前打包脚本验证其形成原因，见下文 | 已发布文件不随 GitHub push 自动变化 |
| 社区 PR [#12625](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12625) 此前 OPEN、无 review，check / Submission gate 全绿 | **交接基线，非本轮新鲜状态查询** | 已投稿，不另开重复 PR；人工评审、合并、采集仍是外部等待 |
| 原图含对话背景、费用及 diagnostics，已获用户明确授权 push，要求不改图片 | 本任务明确给定的约束；本轮未处理图片 | 不再提出必须打码或重拍才可继续；新演示图只列可选后续 |

## 三、分级建议（少而精）

### P0-1：统一“已发布版本 / 当前源码 / 下一版”的用语，修正剩余版本提示

**当前证据**

- 新首页安装命令锁定 `@0.2.1-rc.2`，并标明 Node ≥22.19、DSH ≥0.2.1-rc.2：[README:34–41](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/README.md#L34-L41)。
- [发布说明:11–18](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/docs/releasing.md#L11-L18) 仍以 rc.1 已发布、rc.2 为“当前发行目标”并提醒“不是已完成”叙述当时流程；对新读者，需清楚标出这是历史授权/流程背景，而不是当前 rc.2 尚未发布。
- 父会话直接读取 [Issue 模板:8](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/.github/ISSUE_TEMPLATE.md#L8)，仍提示 DSH `>= 0.2.0-rc.2`；[manifest:81–84](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/package.json#L81-L84) 实际声明 `>= 0.2.1-rc.2`。这是已证实的文档冲突，可能误导反馈与排障，不表示插件兼容下限需要改动。
- npm 明确：dist-tag 是版本标签；默认发布/无精确版本安装与 `latest` 有关。**`latest` 指向 `0.2.1-rc.2` 不会把 rc 变成正式版。** 参考 [dist-tags 官方说明](https://docs.npmjs.com/adding-dist-tags-to-packages/) 和 [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。

**最小行动（需另授权）**：只修发布指南当前状态、Issue 模板宿主下限；继续保留精确版本安装、rc 标记与真实验收范围。不要借此修改渠道，不要重复验收未变的旧产物，也不要把历史授权当本轮发版授权。

**复验方法**：对照 manifest 的 `version` / `engines`、首页精确安装命令、模板要求及发布指南的状态措辞；需要确认渠道时只读 `npm view dsh-agent-team-workflow dist-tags --json --registry=https://registry.npmjs.org/`。所有结论标注查询时间。

### P1-1：下一次发版再分发新 README，并同时解决它依赖的图片/英文入口

**当前证据与机制**

1. npm 官方明确：**package 页面 README 只有发布新版本时更新**。修改 GitHub 的 README 不会覆盖已发布版本：[About package README files](https://docs.npmjs.com/about-package-readme-files/)。同名同版本不能重复使用，即使 unpublish 也不能恢复这个版本号：[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。因此不应尝试“覆盖 rc.2 README”、重发同版本或删包补文档。
2. 本项目不是直接把仓库根目录原样发布。`pack:release` 先构建，再 staging，最后 pack staging：[manifest:39](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/package.json#L39)。
3. staging 的 [bundle manifest:47–48](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/scripts/deploy-web.mjs#L47-L48) 维护自己的 `files`；[复制逻辑:88–90](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/scripts/deploy-web.mjs#L88-L90) 只复制 `README.md`、`LICENSE` 两份文档。因此**只改根 `package.json.files` 无法把英文 README / 图片送进 staging**。
4. 新 README 的英文和详细文档使用绝对 GitHub 链接，而三张图使用 `docs/images/...` 相对路径：[README:92–104](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/README.md#L92-L104)。英文入口依赖网络但不必为了“点击能访问”把整套英文文档装到本地；包内/离线图片则不能靠不存在的相对文件保证。
5. npm 的 README、LICENSE 自动包含规则只作用于 **pack 输入目录里实际存在的文件**，不会从仓库其他位置寻找缺失文件：[package.json files 规则](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files)。

**最小行动（下次计划发版时二选一）**：

- 若目标是完整包内展示：对 staging copy 与 bundle allowlist 一起做小改动，纳入英文 README（如确需包内提供）和三张图，维护相对路径；**不要为营销把整个 docs、测试、诊断日志塞进包**。
- 若目标只是在线 npm 介绍清楚：保留英文/详细文档绝对链接，并给截图使用经核对的绝对 GitHub 图片地址。仍需新版本才能更新 npm README。是否采用该方案取决于实际 npm 页面链接/图片渲染实测，不能仅凭 tarball 缺图断言线上一定破图。

不必立刻发版；与下一次已授权、已验证的维护版本合并办理。必须选择未发布版本、固定源码、构建并验收**同一 tgz**，发布后核对 registry integrity 与隔离安装。项目已有 [发布流程](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/docs/releasing.md)，复用即可，不另造发布系统。

**复验方法**：查看候选 tgz 的 README 原文和 `tar -tzf` 清单；逐个核对 README 中相对图片/文件是否在 tarball 中，或绝对 URL 是否可达；查看 npm 页实际渲染和中英入口。`npm view ... readme` 为空只代表该查询返回值为空，**不能单独证明 npm 网页无 README**；由父会话独立做完整 packument/页面对照。

### P1-2：合并后验证社区的实际发现链；如果想要卡片缩略图，再加可选截图声明

**社区规则（已读一手贡献指南）**

- 投稿源是 `data/plugins/<owner>__<repo>.yml`；只改自己的条目，README 是生成物。
- 要求真实代码、`dsh.bundle`、仓库至少一天、活跃维护、`dsh-plugin` topic、准确且非营销的一句话描述和合适分类。英文描述必需，中文可选；已有中英描述不必删减重写。
- CI 绿灯只是前置，维护者还会读代码、核对功能声明、分类和重复性；收录不等于安全审计。
- npm 可选；有 npm 包时从 registry 自动建立关联，**已发布包的 `repository` 要指回被收录仓库**，不要添加未定义的 `npm:` YAML 字段。
- 来源：[contributing.md 固定研究版本](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md)。

**截图并不是“README 有图 ⇒ 所有卡片都有图”**：

| 消费端 | 当前源码行为 | 对本插件的实际含义 |
| --- | --- | --- |
| GitHub 首页 | 直接渲染当前 README 的相对图片 | 三张图已做；不需 npm 发版才能更新 GitHub 首页 |
| `dshmarket` 普通插件详情 | 优先 catalog 声明的截图；否则打开详情时抓 GitHub `README.md`，按语义筛选图片 | 现有三图具备被详情 fallback 选中的条件，但受链接、筛选、网络和客户端版本影响，不保证每张必显 |
| `dshmarket` 普通插件卡片缩略图 | `CardShot` **只用 catalog 的 curated screenshots**，不为每张普通卡片抓 README | 仅有 README 图，不会自动生成这一行卡片缩略图 |
| 官方内建 Discover | 使用 format-1 索引，见下一项；与 `dshmarket` 不是同一个 UI | 不承诺三图/社区 icon 自动进入官方内建卡片 |

以上客户端行为来自 [market-data.ts](https://github.com/dsh-market/dsh-market/blob/19641d22a69b63063bb9b67a5f67a0dcb72703a0/src/client/market-data.ts) 的 `pluginScreenshotCandidates` / `extractReadmeImageCandidates` / `safeScreenshots`，以及 [MarketSection.tsx](https://github.com/dsh-market/dsh-market/blob/19641d22a69b63063bb9b67a5f67a0dcb72703a0/src/client/MarketSection.tsx) 的 `ScreenshotStrip` / `CardShot` / `OwnerAvatar`。这是该 SHA 的消费端行为，不等于用户当前安装的任何旧版市场都支持。

**最小可选行动（需另授权）**：在自己仓库的 `package.json` 旁新增 `screenshots.json`，按“配置→启动→监控”列出现有三个相对路径，不改图片。它允许 1–8 张、相对路径不得越出插件目录；绝对 URL 必须是获准的 GitHub HTTPS 托管。无需再向社区旧 `data/screenshots.json` 添键或另开截图 PR。当前本地未发现 `screenshots.json`；本轮只建议、不创建。

采集源代码按 `HEAD` 读自仓声明，覆盖旧 registry 截图数据，过滤已证实 404/410 的图，再输出 `plugins.json.screenshots`：[probe-screenshots.mjs](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/probe-screenshots.mjs)、[build-site.mjs](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/build-site.mjs)。社区上限八张，当前 `dshmarket` 客户端安全列表上限六张，本插件三张不冲突。

**复验方法**：PR 合并后，分别检查社区 README/网站分类页、`https://awesome-dsh-plugin.com/plugins.json` 中本仓条目的 `npm`、`version`、`screenshots`；再在支持该逻辑的 `dshmarket` 打开普通卡片与安装详情，区分两者。没有 catalog 截图字段时，不把详情页 fallback 成功错报成卡片缩略图成功。

**外部等待**：PR review/merge、社区构建、npm 映射采集、CDN/客户端刷新。贡献指南说下一 nightly 获取，源码更细：当前构建 [workflow](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/.github/workflows/build-site.yml) 设置每日 `02:23 UTC`，也有 push/同步 README 后构建；截图 probe 在每次 build 运行，而 npm/README 等完整探测主要在 nightly/manual 运行。**定时计划不是时效 SLA**，失败、限流、缓存可推迟生效，不能承诺合并立刻在每端出现。

### P1-3：区分官方 Discover、社区网站和 `dshmarket`，给一个可复验入口，不另建市场

- DSH `0.2.1-rc.2` 官方指南说明：先打开实验性“自定义插件市场”，再到 Plugins → Discover 添加索引；**DSH 不内置任何索引源**。`plugin_market` 是只读发现工具，安装仍需用户确认：[官方版本固定指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/guide/plugin-market.zh.md)。因此不能写“发布 npm 后自动进所有 DSH 用户默认市场”。
- 社区 README 给出的索引入口是 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，同时有 `https://awesome-dsh-plugin.com/index.json` 等镜像；推荐 CDN 是该社区的网络策略，不是 npm 包自身的必需依赖：[社区 README](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/README.md)。
- 当前社区 [format-1 生成器](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/lib/market-index.mjs) 要求条目已有 npm 映射、精确版本、发布时间；从已采集 `latest` manifest 填 `engines.dsh`。它截短描述至 160 字符，并**没有把社区 `icon` / `screenshots` 映射进当前 format-1 输出**。这是此生成器的现状，不是官方索引格式不支持 icon。
- 当前 npm 采集器优先读取 `versions[dist-tags.latest].repository`，再回退顶层 repository，以识别迁仓后的关联：[probe-npm.mjs](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/probe-npm.mjs)。已有 rc.2 迁仓修正不需要为了社区关联再伪造新包名/新仓库。

**最小行动**：合并并采集后，读一次索引中本包的条目，确认版本、发布时间、兼容范围和安装 source；需要给用户介绍时，只添加一条“可选市场发现”路径，主安装入口继续保留精确 `dsh plugin --profile web add dsh-agent-team-workflow@0.2.1-rc.2`。不需要自建索引服务或新的推广站。

**复验方法**：从上述 index URL 读取 `plugins`，按 `name == dsh-agent-team-workflow` 精确筛选；核对 `versions[].version`、`publishTimestamp`、`source`、`engines.dsh`。在对应 DSH 版本中启用/添加可信索引后再搜索；没启用、没添加源、版本不兼容、CDN 陈旧和未被采集是不同原因，不一律判定为插件不可安装。

### P1-4：About / topics 只补真实入口，不堆关键词

**规则与证据**：GitHub topics 用于分类、点击关联主题和按 `topic:` 搜索，主题名需小写字母/数字/连字符，最多 20 个，并非排名保证：[GitHub topics 官方说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)。社区要求 `dsh-plugin`，它有明确发现/收录用途，优先于泛泛的“SEO”。仓库 description / homepage 是独立于 npm 的 GitHub 仓库元数据：[Repositories REST API](https://docs.github.com/en/rest/repos/repos#update-a-repository)。

**父会话本轮实测：已做，无需重复修改。** [GitHub API](https://api.github.com/repos/huaComPj/dsh-workflow-plugin) / `gh repo view` 显示 About 已说明 serial team workflows、Manager、role actors、independent judging、visual editor；homepage 为新仓库 `#readme`；topics 已有 8 个，含必需的 `dsh-plugin`，以及 agent-workflow、ai-agents、cordis、deepseek-harness、multi-agent、typescript、workflow。npm 也已有 description / homepage / keywords；两端元数据独立，不能据此承诺排名。

**最小建议（仅缺项才做）**：核对 `dsh-plugin` 是否已设；About 用一句准确功能描述和仓库 README/上手入口即可。例如“可视化配置的 DSH 串行团队工作流，支持角色分工、独立 Judge 核验与 BLOCK 恢复”。不要称“并行多 Agent 调度器”或“自动保证交付正确”，不承诺增加 topic 就提升搜索排名或安装率。

**复验方法**：只读 `gh api repos/huaComPj/dsh-workflow-plugin --jq '{description,homepage,topics}'`，再点击 `https://github.com/topics/dsh-plugin` 或用 `repo:huaComPj/dsh-workflow-plugin topic:dsh-plugin` 检查索引可见性；搜索索引刷新可能滞后。本轮没有设置这些字段。

### P2：图标、演示图、Release 均可延后；按真正用途补，不为存在而做

1. **图标**：社区可选 `icon:` 是 GitHub 托管位图（PNG/JPG/JPEG/WebP），约 96px 显示，缺省回退作者头像；SVG/第三方图床不接受：[贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#icon--optional--可选)。若难区分再补一张清晰方图，只改自己的条目。**README 放 logo、GitHub 社交预览、社区 icon、官方索引 icon 是不同字段，不会自动互通。** GitHub 社交预览只定义他处分享仓库链接时的配图：[官方说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)。
2. **干净演示**：现有原图保持不变；若后续要降低理解成本，可另做一个默认五节点流程的“启动→通过→完成”演示，注明 DSH/插件版本与是否真实模型，区分默认模板与进阶 BLOCK 示例。现在 README 已明确 BLOCK 图不是成功交付，不能把它改说成完成案例。没有必要马上重拍三张或制作宣传视频。
3. **Release / 更新简介**：GitHub Release 是基于 tag 的软件、说明与可选资产分发：[官方说明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。它能固定“这个包来自哪个 commit、改了什么、兼容范围、已测/未测什么”，是维护便利，不是 npm 下载或精确安装的前置条件；社区规则也把 npm 和预构建 GitHub tarball 作为不同安装路径。已有 npm 预构建包时，不必为了收录补重复 Release asset。
4. **若未来发布 Release**：rc 仍标 prerelease；Release tag 应指向该包真正源码基线，不要把只有新文档的 HEAD 冒认成旧 rc.2 构建来源。可用短发行说明包含版本、兼容性、主要变化、精确安装命令、已验收/未覆盖边界与源码 SHA。真正 stable 必须另有新版本及对应验收，不能仅把 rc 标签切到 `latest`。

**复验方法**：图标在约 96px 与加载失败时看回退；演示记录真实版本和完成状态；Release 比对 tag commit、package version、tarball integrity 和验收记录。是否当前已有 Release、About 是否为空，由父会话追加；不将“没有 Release”本身列为安装故障。

## 四、哪些不用再做，哪些只能等

### 已做，不重复

- 不重写新中英文 README，不再从源码构建开始教普通用户安装。
- 不重新发布 rc.2、不删包、不调整 `latest` / `next`，不以渠道名宣称 stable。
- 不重复注册包名、建新仓库、改变 remote，或提交同一个社区收录 PR。
- 不因没有 npm 包内图片就一概判定运行时安装失败；文档可读性与插件可加载是不同验收。
- 不补一个“必须有”的图标/Release/官网；这些不是当前 npm 安装门槛。
- 不因 GraphQL `licenseInfo` 单次为空就报缺许可证。父会话已做 REST / LICENSE 对照；仓库与包已有 MIT 声明，若仍有识别差异应按字段差异描述，不自动改许可证。
- 不顺从社区通用 `peerDependencies` 建议而擅改本项目的宿主依赖架构。项目当前有明确的 devDependencies / profile fallback 约束，且该版本已验收；是否改依赖属于独立兼容性工作，不是发现路径优化。

### 外部等待 / 条件执行

- 社区维护者 review 与合并：CI 绿灯不代替人工判断，没有保证时间。不刷 PR、不推空提交、不连续催评。若收到具体修正要求，先核对后在同 PR 修改并按其规则留一次说明；**本轮没有评论授权**。
- 合并后的站点/registry mapping/索引采集、CDN 和客户端缓存刷新：按产物核对，不以“合并成功”替代“所有消费端已更新”。
- npm 新文档：等下一次**另获授权**的新版本；不能用 GitHub 文档 push 覆盖已发布包。
- 用户实际使用与反馈：本轮没有新增安装人群测试，也没有统计曝光、独立用户或留存。

## 五、为什么不能保证曝光、下载与安装率

- **可发现是路径，不是结果**：topic、About、社区分类/索引让用户有机会找到，是否搜索到、排第几、是否点击，依赖平台索引、用户查询、候选竞争与消费端排序。官方文档没有给本插件曝光 SLA。
- **metadata 的作用有边界**：npm 官方只说 description / keywords 有助 npm search 发现：[package.json metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)。没有“加词=升排名=增下载”的定量承诺。现有八个相关关键词足够，堆同义词会降低准确性。
- **下载计数不是独立用户或成功安装**：社区当前网站按近 30 天 npm downloads 等信息排序，代码对“没有测量/没有 npm”与 0 分开：[build-site.mjs](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/build-site.mjs)。这证明一种展示规则，不证明下载等于活跃用户、成功初始化或任务交付；本轮没有建立可用于推断转化率的数据。
- **安装质量需按版本和环境看**：已有特定环境 rc.2 隔离验收不能推广成所有 OS、所有 DSH、所有模型与网络都成功；README/图片展示也不是完整运行验收。
- 不刷下载、星标或重复投稿，不拿“最新/最强/保证成功”替代功能说明；未来若观察改进效果，只做自然流量下的前后窗口观察，记录版本、采集时间和外部变化，不将相关性说成因果。

## 六、父会话实测补充与最短行动顺序

### 已证实的入口状态（2026-11-06）

- **npm 发布与关联已完成**：官方 registry 的 `latest` / `next` 均为 `0.2.1-rc.2`，repository / homepage / bugs 已指新仓库；无需重发当前包或再调整标签。来源：[完整 packument](https://registry.npmjs.org/dsh-agent-team-workflow)。
- **当前 README 展示需优先确认**：同一完整 packument（HTTP 200，Accept: application/json）的 `readme` 是空字符串、`readmeFilename` 为空，最新版本 manifest 未含 readme；`npm view ... readme --json` 同为空。实际 registry 安装目录内 README 存在，但仍是 rc.2 原稿，包含“截图待补”；此包字节在前序验收中与候选一致。当前新版中英首页和图片只在 GitHub 源码中，不能据此推断 npm 网页一定正常或一定空白。
- **网页核验受限，不当作产品故障**：对 [npm 页面](https://www.npmjs.com/package/dsh-agent-team-workflow) 的直接 HTTP 请求返回 403 / Cloudflare；独立 agent 浏览器也停在安全验证页。已提示用户可在 agent 浏览器手工验证，未绕过、未读取账号凭据。页面渲染结论暂为“未验证”，不是“缺 README 已定案”。复验：通过验证后看页面 README / 图片 / 英文入口，必要时与新候选包、registry 字段对照。
- **许可证不缺**：仓库 REST 返回 `license.spdx_id=MIT`，远端 [LICENSE](https://github.com/huaComPj/dsh-workflow-plugin/blob/15e3c0a023f28330c07981a8a72afd986ae9c144/LICENSE) 存在且为标准 MIT。GraphQL 单次 licenseInfo=null 是对照差异，不应变成“需改许可证”的建议。
- **投稿仍待人工审核**：[PR #12625](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12625) 当前 OPEN、无 review，check / Submission gate 都为 SUCCESS。PR 合并与索引更新仍未发生在本次已证范围内。
- **暂无截图声明文件**：本地 basename glob `screenshots.json` 未命中；三张图片已在 GitHub README 引用。是否补声明是卡片展示的小增强，不是当前包安装缺陷。

### 建议下一轮只处理这些小项

1. **先人工确认 npm 页说明是否正常**；字段为空是优先检查线索，不能据此直接改发布流程或把安装成功判失败。
2. **小修版本文案**：Issue 模板的宿主下限与发布指南的“发行目标/尚未完成”措辞；保留真正兼容下限、候选标记与原验收边界。
3. **若要社区卡片有图**：新增自仓 `screenshots.json`，按三图顺序声明并核路径；无需改原图、重复投稿或伪造成功截图。
4. **减少首次使用犹豫**：在已有上手指南追加一个可复制的任务示例，写清仓库占位、验收、GitHub 写入授权、人工合并确认，以及何处看 BLOCK。可另补一张默认五节点的成功运行示例；避免再建一套教程，也不宣称模型成本固定。
5. **到下一次授权维护版本再一次性整理 npm 展示**：新 README、图片链接/打包策略、英文入口及更易懂的一句话 description 一起核验。现有 description 合法但偏内部协议术语；可候选改成 “Configurable serial agent-team workflows for DeepSeek Harness, with a visual editor and independent result verification.”，不是本轮已修改字段。
6. **等待合并后再做生产索引验证**，可选 Release / 图标 / 社交预览后置。自然观察 GitHub 点击/clone、npm downloads 和用户反馈；它们的统计口径不同，下载次数不能直接算成功安装率，不新增未经授权的插件遥测。

## 七、证据与复验备注

- 官方规则：npm Docs、GitHub Docs；社区规则/行为：awesome-dsh-plugin 官方仓库与 `dsh-market` 自身源码；宿主行为：DSH `dsh-v0.2.1-rc.2` 官方指南，未用搜索摘要替代关键源码规则。
- 社区研究固定版本：awesome `51d50de9c8243deba503e3e074d670666731c13c`（2026-11-05）；dsh-market `19641d22a69b63063bb9b67a5f67a0dcb72703a0`（2026-11-05）。未来主分支可能变化，复查时先固定新 SHA。
- 本地代码通过图工具定位后读取原文件；索引提示 metadata_changed，故打包结论以实际读取的 `scripts/deploy-web.mjs` 为准，未把旧图返回当当前源码。
- 环境小插曲：最初猜测的 `deepseek-ai/awesome-dsh-plugin` API 为 404，随后由实际社区 repo 核实正确身份；一次远端源码请求 EOF、一次 raw 文本误加 JSON `--jq` 导致解析失败，均用正确仓库/原文方式完成窄范围复查。它们不是插件缺陷，不影响最终引用的成功读取证据。
- 未做：实际推广修改、发版/评论、浏览器截图、真实模型/全平台回归、社区合并后的显示验收；没有读取 token。父会话负责追加它独立实测到的入口状态与差异，本 worker 完成后停止修改本文件，避免并发覆盖。
