# 插件发现与收录查证：官方索引协议、社区精选与本项目下一步

> 原始调查记录：2026-11-06（北京时间）。调查快照形成时仅调查、撰写本文，尚未 push、修改 GitHub description/topics、创建 PR/Issue、发布新 npm 版本或 GitHub Release、安装插件或启动 Web/部署；后续已执行事项见下面的状态与回执。
> 对象：npm 包 `dsh-agent-team-workflow`；GitHub 仓库 `hua0424/dsh-workflow-plugin`。两者名字不同不构成收录障碍，关键在包的 `repository` 与实际仓库对应。

> **执行状态（2026-11-06）**：仓库已迁为 `huaComPj/dsh-workflow-plugin`，既有提交、源码元数据和当前 README 链接已推送；About、主页与 Topics（含 `dsh-plugin`）已设置。迁仓修复版 npm `0.2.1-rc.2` 已发布并通过公开 registry 安装复验，`latest` / `next` 均指向该版本。社区收录 [PR #12625](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12625) 已提交；不把提交 PR 当作已收录。下文旧 owner 与原始调查时点的状态保留为历史，不代表当前待办。

## 本次执行回执

- **源码基线**：[bdc430c](https://github.com/huaComPj/dsh-workflow-plugin/commit/bdc430c32892f5c7e34fd7fc39289d4ab8eae9a6)；包名仍为 `dsh-agent-team-workflow`，作者、运行逻辑及依赖不变，主要更新 repository / bugs / homepage、版本与发行说明。
- **发行结果**：npm [0.2.1-rc.2](https://www.npmjs.com/package/dsh-agent-team-workflow/v/0.2.1-rc.2)；公开 tgz 为 261162 字节、46 个文件，SHA256 `d2333e1e3dc6a167dc4d1d9c101a09624485f72df0d519b8fa7a6020c7125af7`，完整 sha512 integrity 与已验收候选一致。首次发布及随后 latest 更新分别需要用户完成 npm 认证，均已完成；没有覆盖 rc.1 或绕过 2FA。
- **验证**：typecheck + 894/894 + T3/E2E 受控 smoke；独立 real-Host 回归入口 5/5；Standards / Spec 独立审查各 0 findings。最终 tgz 与公开 registry 分别使用全新的隔离 Web profile 安装，公开版 downloaded 3 / reused 0，46/46 安装文件哈希一致，12/12 安装检查通过。
- **实际边界**：Windows、Node 24.16.0、安装宿主 DSH 0.2.1-rc.5；命令激活使用 production Host Context / CommandRuntime / AgentLoop，engine 的 Actor / Judge / compact 为受控接缝。未新增真实 LLM、HTTP/browser GUI、完整进程重启或跨平台/全版本矩阵验收，未改真实用户 profile。
- **迁仓关联复验**：原版上游 `probe-npm.mjs` 在只含该仓库的隔离输入上运行，匹配 npm 包名、版本 rc.2、有效发布时间及 `engines.dsh >=0.2.1-rc.2`；这是对关联规则的实跑，不是社区生产索引已经更新。
- **社区投稿**：[PR #12625](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12625)，head `2c71af302fc937e47ecd4120f03f4d23377448b8`，仅新增 `data/plugins/huaComPj__dsh-workflow-plugin.yml` 的 6 行，不改生成 README。投稿前条目全量结构校验 9112 条 / 0 problems，上游四组测试 24/24 PASS。真实 Submission gate 需由上游 Actions 执行，本地未以缺令牌或选中 1 个目标冒称 gate 通过。
- **后续门禁**：PR check、Submission gate、维护者审核/合并、目录/CDN 构建与最终市场 / Discover 可见性，分别核验；CI 通过也不等于官方认证或已收录。用户仍需添加第三方索引。

当前临时候选与明细位于 `.scratch/npm-rc2-2cc371e659a742c3bf87e07fe85586a1/`（Git ignored）；公开 npm 版本、源码提交、PR 及本文结论是跨 Run 接续依据，不能只依赖该临时目录。

## 一、结论先行

**当前不存在“按某种方式发布 GitHub 仓库，就会被 DeepSeek Harness 官方自动收录”的机制或承诺。** 最新官方默认分支文档明确写着：

- “**DSH 不内置任何索引源。**”——[官方用户指南 L19–L23](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/plugin-market.zh.md#L19-L23)。
- “**目前没有官方插件索引；发现标签页只列出用户添加的索引源。**”——[官方实验组合包说明 L52–L56](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/plugin-market-bundle/README.zh.md#L52-L56)。

因此必须区分两条渠道：

1. **官方 DSH 提供索引格式、Discover 页面、`plugin_market` 工具和参考生成器。** 维护者把包名或 Git URL 明确加入某个索引的来源清单，再托管生成的 JSON；用户添加这个索引 URL 后才能搜到。这里的自动化是“从明确清单生成/更新索引”，不是“全网自动扫描 topics”。
2. **`awesome-dsh-plugin/awesome-dsh-plugin` 是社区精选目录。** 按其贡献指南提一份 YAML 的 PR，经过 CI 和维护者审核、合并后，目录/网站/社区 `dsh-market` 才自动更新。其 npm 包关联也是“已在目录里的插件再关联 npm”，不是“发 npm 即自动入选”。

**另一个容易混淆的“官方发现入口”确实存在：官方 README 链接 GitHub topic 页面，并写“为你的插件仓库添加 `dsh-plugin` 话题，便于被发现”。** 因此添加该 topic 能让用户沿官方 README 的 GitHub 主题入口发现仓库；但它只是 topic 入口，不是自动加入官方内置索引，也不代表官方审核/认证。[官方中文 README L50](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/README.zh.md#L50)、[英文原文 L46](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/README.md#L46)：“Add the dsh-plugin topic to your plugin repository for discoverability.”

`awesome-dsh-plugin` 和 `dsh-market` 是另外的 GitHub owner；不能因名称、页面出现在 DSH 内，或兼容官方格式，就推定 DeepSeek 官方运营或背书。社区生成器也自称“Community-curated”，官方则明确索引为第三方内容：[社区索引标识 L101–L107](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/lib/market-index.mjs#L101-L107)、[官方信任边界 L34](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/plugin-market.zh.md#L34)。未查证这些组织的法律/人员关系，不作“官方关联”断言。

**本项目最有价值的下一步：先授权同步已经存在的公开文档/发布提交与 npm 状态，再补仓库简介和 `dsh-plugin` topic，随后向社区精选提交一个 `workflow` 条目。不要为“官方自动收录”改名、迁仓、制造提交数、专门补 Release，或再造一个市场插件。**

## 二、证据范围与可复验快照

先通过 GitHub API 读取了用户指定的 `contributing.md` **全文**，再跟随其入口查看数据格式、submission gate、npm probe、索引构建与网站工作流；官方部分读取最新远端默认分支文档及对应实现，没有用本地已安装 DSH 代替最新远端。

| 来源 | 本次锁定版本与用途 |
|---|---|
| `deepseek-ai/deepseek-harness` | 默认分支 `master`，`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`；提交时间 `2026-11-04T08:40:00Z`；查询约 `2026-11-06T13:04+08:00`。[版本 API](https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159) |
| `awesome-dsh-plugin/awesome-dsh-plugin` | 默认分支 `main`，`51d50de9c8243deba503e3e074d670666731c13c`；提交时间 `2026-11-05T23:37:01Z`。[版本 API](https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/commits/51d50de9c8243deba503e3e074d670666731c13c) |
| `dsh-market/dsh-market` | 默认分支 `main`，`19641d22a69b63063bb9b67a5f67a0dcb72703a0`；提交时间 `2026-11-05T20:37:23Z`。[版本 API](https://api.github.com/repos/dsh-market/dsh-market/commits/19641d22a69b63063bb9b67a5f67a0dcb72703a0) |
| 本项目远端 | `main` 为 `45742c7ccd6fd8eccd1dae8fccbc0a881956e16d`，公开 manifest 版本仍 `0.2.0`。[公开 manifest](https://github.com/hua0424/dsh-workflow-plugin/blob/45742c7ccd6fd8eccd1dae8fccbc0a881956e16d/package.json) |
| 本项目本地 | 调查前 HEAD 为 `7e206ec6a24aaec8bc799828d78fe127a8d3a014`，工作树干净；本地既有文档提交尚未 push（父调查也确认）。本文是本次唯一主动写入的项目文件。 |
| npm registry | `dsh-agent-team-workflow@0.2.1-rc.1` 已公开；`latest`、`next` 均指向该版本；发布时间 `2026-11-06T02:30:55.395Z`。[版本元数据](https://registry.npmjs.org/dsh-agent-team-workflow/0.2.1-rc.1)、[packument](https://registry.npmjs.org/dsh-agent-team-workflow) |
| GitHub 自身迁移规则 | `github/docs` 默认分支快照 `17d6ee52f965e7c46f74b4339d5fa1ad6f4f4493`，用于迁仓/改名风险，不作为 DSH 收录规则。 |

GitHub 仓库元数据、registry、索引线上结果会变化；正文规则引用固定 SHA，现状引用 API 时以上述调查时间为边界。所有 GitHub 调查均为非交互读取，`gh` 使用完整 `repos/<owner>/<repo>/...`；未读取凭据内容。一次 raw 内容响应错误地加了 `--jq` 导致 JSON 解析失败，随后用 raw 正常读取；不是来源不可用，也未据此下结论。

## 三、渠道 A：官方 DSH 的发现与发布究竟如何工作

### 3.1 没有内置官方目录，索引是用户显式配置的

官方指南要求启用“实验性插件 → 自定义插件索引”，然后在发现页面添加索引 URL；索引属于当前 profile。实现中的 `indexes` 默认就是空数组，搜索和读取仅针对配置中的索引：

- [默认空索引配置 L111–L113](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/plugin-market/src/index.ts#L111-L113)：`indexes: z.array(...).default([])`。
- [未配置源时的处理 L363–L371](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/plugin-market/src/index.ts#L363-L371)、[读取配置中的源 L386–L395](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/plugin-market/src/index.ts#L386-L395)。

参考生成器“读取一份由 npm 包名和 Git 仓库 URL 组成的纯文本列表”，每行一个条目；生成后通过 https 发布，让用户添加 URL：[用法 L5–L27](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/README.zh.md#L5-L27)。对应实现是逐行解析显式来源，不是 GitHub topic/npm 搜索：[来源解析 L23–L38](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/src/sources.ts#L23-L38)、[按确切 npm 名读取 registry L49–L52](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/src/fetchers.ts#L49-L52)。

**可以向某个社区索引维护者提 PR，但那是该索引的治理流程，不是向官方 DSH 提 PR 就自动入选。** 本次查到的官方渠道没有官方收录表单或官方索引 PR 入口；这一结论限于已查的当前官方市场/发布文档及读取、生成实现，不推断其他桌面发行版或未来版本。

### 3.2 官方协议、参考生成器与安装门槛不是同一层

| 事项 | 当前查证规则与原文/实现 |
|---|---|
| 索引格式硬字段 | 插件 `name`、至少一个 `versions`；每版本精确 SemVer、Unix 秒 `publishTimestamp`、`source`。Git source 必须固定 40 位 commit；npm source 可带 registry。[官方格式 L117–L137](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/plugin-market.zh.md#L117-L137) |
| 参考生成器的 `dsh.bundle` | “只有 `package.json` 声明了 `dsh.bundle`、其 `patch` 是一个文件路径或文件路径列表、且没有设置 `private: true` 的版本才会列出。”[说明 L44–L48](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/README.zh.md#L44-L48)；[判定实现 L56–L74](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/src/packages.ts#L56-L74) |
| npm 版本过滤 | 从显式指定包的 registry 文档列未弃用、非私有、有 bundle、有发布时间的版本；最高列出版本 tarball 的包名与版本必须匹配。[原文 L48](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/README.zh.md#L48)、[过滤实现 L156–L173](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/src/generate.ts#L156-L173) |
| npm `keywords` | “用于发现插件的**可选**字符串数组”；参考生成器复制最高版本 manifest 的 keywords；错误类型只警告、省略字段，保留包。不要求特定 `dsh-plugin` 关键词。[原文 L60](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/README.zh.md#L60)、[实现 L215–L225](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/src/metadata.ts#L215-L225) |
| GitHub topics | 不参与上述官方“显式来源 → 生成索引 → 读取配置索引”路径。没有 topic 不是该官方协议/生成器拒收条件。`dsh-plugin` topic 是下述社区目录的要求。 |
| description | 官方索引 `title`、`description` 均可选；展示来自 locale 或 package manifest 回退，不取 GitHub About description 作为必填字段。[格式 L119–L124](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/plugin-market.zh.md#L119-L124)、[生成器展示字段 L58](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/README.zh.md#L58) |
| GitHub Release、Git tag | **GitHub Release 不必需；Git tag 也不是绝对必需。** Git 来源按发布 tag 和默认分支列版本；默认分支可单独提供当前版本，tag 名称/manifest 版本须匹配。[原文 L49–L54](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/README.zh.md#L49-L54)。实现用 `git ls-remote ... HEAD refs/tags/*`，不是 GitHub Releases API：[L168–L176](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/src/fetchers.ts#L168-L176)、[候选版本 L204–L219](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/src/generate.ts#L204-L219) |
| npm 发布 | **不是通用必需条件。** 官方支持直接 Git 安装。TypeScript 源码安装要有自包含构建/prepare，并由用户明确允许构建；预构建 npm/tarball 可避免此授权。[官方发布指南 L161–L186](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.zh.md#L161-L186) |
| 预发布版 | 不是一概排除。卡片优先最高兼容非预发布版；没有任何非预发布版时推荐最高兼容预发布版；详情可安装兼容的旧版/预发布版。[官方指南 L28–L34](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/plugin-market.zh.md#L28-L34) |
| DSH 兼容性 | `engines.dsh` 或 host peers 限制可运行版本。参考生成器会跳过无效/不可满足的范围；安装仍独立检查。不能因索引出现就认定安装验收通过。[生成规则 L56](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/plugin-market-generator/README.zh.md#L56)、[安装规则 L137](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/plugin-market.zh.md#L137) |

手写一个符合格式的 JSON 与“参考生成器会接纳某个来源”也不等价；前者是索引格式，后者还做 manifest/版本筛选。两者均不等于官方安全审查。

### 3.3 对本项目可采用的官方协议步骤

不必立即自建索引。成本最低的是下节社区目录已有的 format-1 索引：被收录、npm 关联及构建成功后，用户显式添加它即可在官方 Discover 中搜到。

如未来确有独立分发索引的需求（另行授权），才考虑：

1. 在某个索引维护者的输入列表明确加入 `dsh-agent-team-workflow`（npm）或确切 Git URL。
2. 生成/验证 format-1 JSON；若自行托管，遵守 UTF-8、默认 128 MiB 上限、HTTP 2xx 且不经重定向等读取约束：[索引发布 L37–L43](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/plugin-market.zh.md#L37-L43)。
3. 使用者在相应 profile 添加可信索引 URL；搜索包名、标题、关键词，核对推荐版本与 DSH 兼容范围。
4. 确认安装来源之后再安装/执行。索引读取不代替安装授权，更不代替真实运行验收。

## 四、渠道 B：社区精选 → 网站、dsh-market、兼容官方 Discover 的索引

### 4.1 投稿的具体门槛

贡献指南：[原始入口（最新 main）](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，本报告逐条引用调查锁定 SHA。

| 门槛 | 必需/推荐及证据 |
|---|---|
| 提交数据而不是手改 README | 一个 `data/plugins/<owner>__<repo>.yml`，包含正确 `url`、`name`、`category`、单行 `description.en`；中文可省略。原文：“That one file is the whole submission.” README 合并后生成。[L5–L26](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L5-L26)。这里“只有 description.en 必填”是相对翻译字段，不是可以省掉 url/name/category。 |
| 可安装 manifest | 指向的根包/子包要声明 `dsh.bundle`，仅 `dsh.client` 不够。[L56–L76](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L56-L76)。实现会拒绝根入口实际不含 bundle、却只在其他子目录找到 bundle 的错链：[gate L280–L349](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/check-submission.mjs#L280-L349)。 |
| 有真实可用代码、维护中 | 不收占位/README-only；归档、消失、长期停更会被标记后复核移除。[L78–L86](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L78-L86)。 |
| 仓库年龄至少 1 天 | 必需；**无提交数门槛**。原文“at least 1 day old”“There is no commit-count bar”。[L79–L81](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L79-L81)；实现 `MIN_AGE_DAYS = 1`，明确删除旧 `MIN_COMMITS=10`：[L21–L30](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/check-submission.mjs#L21-L30)。不要照旧 CI 注释/成功摘要误报“10 commits”。 |
| GitHub `dsh-plugin` topic | 贡献规则明确要求：“Add the dsh-plugin topic to your repo.”[L83](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L83)。当前已读 submission check 的主体检查 manifest、archive、age；不应将 topic 要求描述成“官方自动爬虫开关”或断言 CI 必然自动代补。[gate L352–L412](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/check-submission.mjs#L352-L412)。 |
| 准确描述、合理分类 | 无营销词；描述中的数字、命令、API 会对代码核验；分类不精确可由维护者调整。[L84–L103](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L84-L103)。本插件适合 `workflow`；已有同类覆盖/真实差异由维护者审核，不因名称新颖就保证通过。 |
| CI 与人工审核 | “A green CI run is the precondition, not the decision.” 维护者阅读源码、核对声明、重复覆盖与可疑行为；列表不等于安全审计。[L90–L107](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L90-L107)。纯依赖聚合包不单独收录，但具有配置/协调行为的 bundle 可按普通插件审查。 |
| 每 PR 最多 3 条 | CI 前置限制；本项目只需 1 条。[L148–L165](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L148-L165)。 |
| npm 发布 | **精选收录可选**：“listing is unaffected either way”。用于展示/排序下载量及优先预构建安装。[L234–L242](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L234-L242)。 |
| npm 自动关联 | 已发布包的 `repository` 必须指向收录仓库。**不要手填 `npm:` 键**，会被拒绝；registry 自动关联。[L240–L242](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L240-L242)、[允许字段/未知键校验 L155–L180](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/lib/entries.mjs#L155-L180)。 |
| GitHub Release | **并非普遍硬门槛**。不发 npm 时推荐 Release 预构建 `.tgz`；若仓库根本不能源码安装，则该分发后备是必需的。`tarball:` 可选，限定 GitHub 自有 Release 托管 https `.tgz`。[L117–L132](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L117-L132)。本项目已经发 npm，不应把“没有 Release”当作当前收录硬缺口。 |
| 图标与截图 | 图标可选，GitHub 托管位图，省略用作者头像；截图可选但推荐，在本仓库 package.json 旁放 `screenshots.json`，1–8 张，不能越出目录，绝对 URL 仅 GitHub https；不声明时 README 抽图回退。[L188–L223](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L188-L223)。 |
| 官方 host 包依赖 | 指南在“Recommended”下建议 `@deepseek-ai/*` 用 peers 而非 runtime dependencies，并提示 prerelease range 陷阱。[L117–L144](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L117-L144)。这不是收录硬门槛，也不是要求本项目新增 peers 或把现行 host devDependencies 移入 dependencies；本项目按既定 dev-only + 已实测 host fallback 运行，不能仅为曝光破坏依赖边界。若以后确需调整，须另行设计并验证 prerelease SemVer、安装解析和真实 Host 兼容。 |

### 4.2 “自动”发生在什么位置

1. **PR 合并之后**，README 从 YAML 生成，站点构建部署。工作流在 `main` push、README 同步完成、每天 `02:23 UTC` 等条件触发；cron 是计划而非 SLA：[构建触发 L3–L43](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/.github/workflows/build-site.yml#L3-L43)。
2. npm probe 只对**已列出条目**，先读 GitHub `package.json.name`，再取 registry；用 `latest` 对应 manifest 的 `repository`（缺省时 top-level 回退）反向对应仓库，并取 `latest`、发布时间等。这条映射不是靠 npm keywords：[probe 说明 L3–L21](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/probe-npm.mjs#L3-L21)、[实际解析 L115–L134](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/probe-npm.mjs#L115-L134)。
3. 社区 `dsh-market` 明说它是市场 app、不是 catalog；投稿应向 awesome 目录，不是它自己的仓库；描述通常一天内采集，不是官方保证：[README L134–L136](https://github.com/dsh-market/dsh-market/blob/19641d22a69b63063bb9b67a5f67a0dcb72703a0/README.md#L134-L136)。安装目标优先 npm，其次 Release tarball，再 GitHub 源码：[实现 L495–L517](https://github.com/dsh-market/dsh-market/blob/19641d22a69b63063bb9b67a5f67a0dcb72703a0/src/sources.ts#L495-L517)。
4. **同一精选目录导出的 format-1 索引有额外覆盖边界**：必须有 npm 映射、确切 version、整数发布时间；GitHub-only 条目目前不导出，不代表官方 format-1 本身不能表达 Git。导出代码还会验证每条记录：[L115–L145](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/lib/market-index.mjs#L115-L145)。它不把包 keywords 复制过来，而由标题、描述、分类等提供展示/检索信息，不能假定补 npm 关键词就自动增强该社区索引。
5. 用户仍需添加社区提供的 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，才会在官方 Discover/`plugin_market` 搜到该源内条目。可选镜像为 `https://awesome-dsh-plugin.com/index.json`、`https://dshmarket.com/index.json`。[社区明确说明 L11–L15](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/README.md#L11-L15)。不能说“PR 合并后所有官方用户自动看到”。
6. npm catalog 发布在 nightly/manual 路径，不在每次 push 都发布；因此网站可先更新，npm/CDN 副本有合理延迟：[工作流 L258–L287](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/.github/workflows/build-site.yml#L258-L287)。

### 4.3 本项目投稿草稿（尚未创建任何外部文件/PR）

拟新增的唯一条目名（迁移后）：`data/plugins/huaComPj__dsh-workflow-plugin.yml`。

```yaml
url: https://github.com/huaComPj/dsh-workflow-plugin
name: huaComPj/dsh-workflow-plugin
category: workflow
description:
  en: Configurable serial agent-team workflows with Manager coordination, role actors, independent judging, and a visual workflow editor.
  zh: 可配置的串行智能体团队工作流，提供 Manager 协调、角色执行、独立判定与可视化工作流编辑器。
```

这是**待确认的保守文案**，不是已获维护者批准的声明；提交前逐项对照公开代码/README，避免将独立 Judge 夸大成“安全审计/保证正确”。不写工具数量、宿主版本全覆盖、官方自动收录、未经验证的性能或安全保证。不填 `npm:`，不手改两个生成 README。图标可后补；无需等全套截图/品牌重做才投稿。

## 五、本仓库真实差距与推荐曝光优先级

现状 API：[仓库元数据](https://api.github.com/repos/hua0424/dsh-workflow-plugin)、[topics](https://api.github.com/repos/hua0424/dsh-workflow-plugin/topics)、[releases](https://api.github.com/repos/hua0424/dsh-workflow-plugin/releases)、[公开 manifest](https://github.com/hua0424/dsh-workflow-plugin/blob/45742c7ccd6fd8eccd1dae8fccbc0a881956e16d/package.json)、[npm 版本](https://registry.npmjs.org/dsh-agent-team-workflow/0.2.1-rc.1)。

- 仓库公开、未 archived；创建于 `2026-08-24T09:49:14Z`，已超过一天。仓库年龄不是当前问题。
- GitHub About 的 `description`、homepage 为空；topics 为 `[]`；无 GitHub Releases。这影响外观/主题发现，但不能混称官方拒收。
- 当前远端根 manifest 已有 `dsh.bundle.patch`、正确包名与 `repository`、`engines.dsh: >=0.2.1-rc.2`，但版本仍 `0.2.0`。本地已存在的 `7e206ec` 与新安装/发布文档尚未公开；npm 已是 `0.2.1-rc.1`。源码、发布产物和说明目前不同步，投稿前值得优先修正。
- npm 已公开 rc1，`latest`/`next` 均 rc1，`repository` 正确指向仓库，具备社区自动 npm 映射基础。当前 keywords 为 `dsh`、`deepseek-harness`、`cordis`、`plugin`、`agent-workflow`、`workflow`、`multi-agent`、`team-workflow`。没有 `dsh-plugin` **npm keyword** 不构成本文查到的硬门槛；真正欠缺的是社区规则要求的同名 **GitHub topic**。
- 对锁定的 awesome 完整 tree 查询结果 `truncated: false`，路径中没有 `hua0424`/本项目名匹配，即未发现该 owner 的标准条目文件。[树 API](https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/git/trees/51d50de9c8243deba503e3e074d670666731c13c?recursive=1)。父任务还直接读取了线上 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`：2026-11-06 快照 `format=1`、插件共 4704 条，精确筛选 `name == dsh-agent-team-workflow` 得 0 条。此为当时线上状态，不是永久总数或门槛。这不穷尽历史 PR、待审核投稿或别名收录；实际提交前仍需查重复条目及开放 PR。
- 包版本 `0.2.1-rc.1` 与 host 下限 `0.2.1-rc.2` 属于不同产品的版本，不要求两者字符串相等。仅因包是 rc 不需要为收录伪装稳定版。

| 优先级 | 建议动作 | 作用与边界 |
|---|---|---|
| P0 | 用户授权后，检查并 push 现有本地发布/安装文档提交，使公开 README、源码版本与 npm rc1 对齐 | 审核者能在远端看懂真实安装入口与兼容下限；不为调查自动 push、不另发版本掩盖差异。 |
| P1 | 设置准确 GitHub description、README homepage，并添加 `dsh-plugin` topic；可辅以 `deepseek-harness`、`agent-workflow`、`multi-agent` 等真实主题 | `dsh-plugin` 满足社区投稿规则，其余属于可见性建议；不承诺 GitHub 搜索排名。可用简介：`Configurable serial agent-team workflows for DeepSeek Harness, with Manager coordination, role actors, independent judging, and a visual editor.` |
| P1 | 向 awesome 目录提单 YAML `workflow` 条目 PR | 最直接进入社区网站/市场受众的路径；需 CI 与人工审核，不能保证合并。 |
| P1 | 合并后确认 npm 自动关联和 format-1 索引，再给使用者说明添加社区索引 URL | 可让使用者在官方 Discover 中搜索，但属于用户选择第三方源，不是官方预装/认证。 |
| P2 | 保持 README 首屏可理解：用途、适合谁、准确安装命令、host 下限、最小示例、任务/判定边界 | 增加“看见后能懂”的转化；复用刚完成的文档，避免重复建文档体系。 |
| P2 | 添加一张清晰流程/监控界面图及可选 `screenshots.json`、方形图标 | 改善社区卡片展示，不是硬门槛；截图不得泄露凭据、私有 Issue、用户内容。 |
| P3 | 后续正常发版时维护 npm description/keywords、变更摘要；确有价值再做 GitHub Release | keywords 用于 npm 与支持它的索引检索；`dsh-plugin` 可作为补充但不保证自动入选。不要为了修改历史 npm metadata 复用已经发布版本号。Release 可提高可追溯性，但不是此次收录必须项。 |
| 暂不建议 | 改仓库名、迁组织、重做品牌、独立建立索引服务 | 没有证据这些是收录前提；当前投入明显不如简介/topic/投稿。 |

## 六、仓库迁移/改名风险：不应为了曝光先搬家

现有 `hua0424/dsh-workflow-plugin` 与 npm `dsh-agent-team-workflow` 已通过 registry `repository` 对应，无须为了名字一致迁仓。

若以后确需改名/转移（另行授权）：

1. GitHub 一般会重定向旧 Web/Git URL，但不应把它当作所有依赖系统的永久兼容保证。GitHub 官方建议更新已有 clone 的 remote；旧地址重新建仓会删除重定向；Pages 不在普通迁移重定向保证内。[GitHub 转移规则 L61–L69](https://github.com/github/docs/blob/17d6ee52f965e7c46f74b4339d5fa1ad6f4f4493/content/repositories/creating-and-managing-repositories/transferring-a-repository.md#L61-L69)、[改名规则 L15–L42](https://github.com/github/docs/blob/17d6ee52f965e7c46f74b4339d5fa1ad6f4f4493/content/repositories/creating-and-managing-repositories/renaming-a-repository.md#L15-L42)。
2. 社区条目 filename 必须与 URL 对应；迁移会要求更新 URL、name、条目文件名。npm probe 当前直接对 repository 字符串做仓库身份对应，不把 GitHub 301 当作 package repository 字符串已经同步。已缓存映射、老 npm 版本 metadata、站点/CDN 副本可能短期分叉：[entry 校验 L184–L192](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/lib/entries.mjs#L184-L192)、[probe L120–L128](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/scripts/probe-npm.mjs#L120-L128)。
3. 应协调更新未来发布的 `repository`、homepage、bugs、README 安装命令、社区 entry、截图/Release 地址及使用者公告；不要假设迁 GitHub 仓库会自动迁 npm 包身份/版本。GitHub 链接重定向不等于 npm package 改名，也不等于用户添加的 index URL 改了。
4. 迁移会改变源码/Git 安装身份及可能的构建授权键；需重验现有安装、更新与来源匹配，不在本次文档调查中承诺无缝。保留历史 PR/Issue/版本证据，避免另建全新仓库导致来源、年龄、历史与后续安全判断割裂。

结论：**当前先用原仓库提升可搜性，收益更直接、风险更低。**

## 七、仍需授权、实际验收与未知项

### 7.1 本次没有做、后续必须明确授权的操作

- push 本地既有提交；修改任何源文件/README/截图或 npm manifest。
- GitHub About/topics/homepage 写入；fork/分支/PR/Issue、回应审核评论等外部写入。
- 新 npm 发布、dist-tag 变动、Git tag 或 GitHub Release/资产上传。父任务给出的现 rc1 候选源码基线是 `3dae890d2effb71a26ea6c89f9358778e8804991`（tree 前缀 `d6fe9654`），`7e206ec` 只是后续安装/发布文档更新；未来若为 rc1 补 tag/Release，应核对并指向真实源码基线，附已验收 tgz，标记 prerelease，不能拿当前 HEAD 重打包后冒充同一 rc1 再发。此基线来自父任务已有发布证据，本文未另行重打包验证。
- 启用或安装实验插件、给实际 profile 添加第三方索引；任何真实插件安装、构建脚本授权、重启或部署。
- 迁移/改名/删除仓库、修改 npm 包身份。本文没有给这些操作新增授权。

### 7.2 真正完成曝光应如何验收

1. **公开材料一致性**：GitHub `main` SHA、公开 README 安装说明、包名/版本、npm repository/engines 与批准的发布对应；保留 registry integrity 与候选比对证据。父任务已确认现有 registry integrity 与本地候选一致，本文不重新做二进制或安装验收。
2. **投稿完成不等于收录完成**：记录 PR URL、最终 CI、维护者反馈、merge SHA；检查目录里确实出现正确条目。CI 绿不是维护者批准。
3. **网站与社区市场**：站点能按仓库名/包名/工作流描述找到正确插件，npm install target 确实是 `dsh-agent-team-workflow`；检查 README/图标/截图是否有缺链，不能只看 PR merged。
4. **format-1 兼容索引**：实际拉取推荐 CDN 索引，确认 name、version、publishTimestamp、source、engines 正确。网站更新不代表 npm/CDN 已更新；按计划构建完成后复验，遇失败保留错误与版本，不做无条件等待承诺。
5. **官方 Discover 搜索（需使用者/测试 profile 授权）**：明确当前 DSH 版本和 profile；启用自定义索引，添加第三方 URL，按包名及描述词查找，核对来源。只有配置了该源的用户应期待看到它。
6. **安装与真实运行另验**：在隔离测试 profile 安装精确 npm 版本，检查 bundle 注册、host 兼容、基本命令/只读页面，再按项目既有受控与真实 Host 测试入口验证工作流；不得在正在运行的宿主 profile 上未经授权改插件。市场可见不等于插件行为正确。

### 7.3 明确未知/不作保证

- 维护者是否接受本项目相对现有条目的差异、审核排期、最终分类及合并时间：**未知**，由其人工审查决定。
- npm/GitHub 搜索排名、何时进入推荐、能带来多少用户：**未知**；没有证据可以保证曝光效果。
- 第三方目录维护者是否会主动发现某个 topic 下的仓库并 editorial 收录：贡献指南允许维护者主动收录，但没有对本项目的自动发现 SLA；不能将 topic 当成投稿替代品。[主动精选说明 L88](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/51d50de9c8243deba503e3e074d670666731c13c/contributing.md#L88)。
- 本次没有穷尽所有开放 PR/讨论/各桌面分发版，也没有验证实际在线 CDN 此刻是否已有别名条目；在发新投稿前做去重。
- 当前官方默认分支不内置索引，不代表未来版本或第三方客户端永远如此；若版本/发行物改变，应重查它实际配置，不能将本文结论不带版本地外推。
- 是否“官方推荐/认证/安全审计”：当前证据不支持。官方仅校验索引格式，社区列入也明确不等于安全审计；对外宣传应避免这些词。

## 八、后续只读复验示例

以下是可以复验的读取命令，**不是本次新增的写操作授权**：

```powershell
# 所有 gh 调用使用完整仓库身份；无交互、无外部写。
gh api repos/deepseek-ai/deepseek-harness --jq '.default_branch'
gh api repos/deepseek-ai/deepseek-harness/commits/master --jq '.sha'
gh api repos/deepseek-ai/deepseek-harness/contents/docs/user/guide/plugin-market.zh.md -H 'Accept: application/vnd.github.raw+json'
gh api repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/contributing.md -H 'Accept: application/vnd.github.raw+json'
gh api repos/huaComPj/dsh-workflow-plugin --jq '{description,homepage,topics,private,archived,created_at}'
gh api repos/huaComPj/dsh-workflow-plugin/commits/main --jq '.sha'
gh api repos/huaComPj/dsh-workflow-plugin/releases --jq '[.[] | {tag_name,published_at,prerelease}]'
Invoke-RestMethod https://registry.npmjs.org/dsh-agent-team-workflow/0.2.1-rc.1
```

**最终判断：先补“公开材料一致 + 社区硬要求 + 精准投稿”，再验证各渠道可见性；不追求不存在的“官方自动收录开关”。**
