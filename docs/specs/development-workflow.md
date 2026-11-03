# 通用入门工作流与统一初始化

状态：用户于 2026-10-28 确认，作为本次实现验收依据。

## 目标与范围

初始化只提供一个便于学习和定制的 `development-workflow`，不再区分最小集和全量集。面向 GitHub 单仓库、单个需求、单 Issue、单 PR；无需额外安装或调用技能，节点指令直接包含精简的工作方法。

## 五节点合同

| 节点 | 执行者 | 完成条件与去向 |
| --- | --- | --- |
| create-issue | Manager | 逐轮澄清需求，用户确认范围、验收与开发操作授权后创建 Issue → implement |
| implement | developer | 默认分支上创建任务分支，最小实现、必要测试、自检，提交推送并创建 PR → review |
| review | reviewer | 独立审查符合性、正确性、安全与规范；通过 → test，产品必修项 → implement |
| test | tester | 对已审查提交独立运行项目检查与 Issue 验收；通过 → merge，产品缺陷 → implement |
| merge | Manager | 展示已验候选及证据，获得人工确认后 squash 合入默认分支，核验并关 Issue → delivered |

- 返工复用同一分支和 PR，并重新经过 review、test。候选 base/head 变化沿 `stale` 返回 implement，不继承旧批准。
- 合并确认绑定已审查、测试的确切候选；紧邻执行核对修订并使用 head 条件保护。无法原子锁住目标分支，合并后需核验实际起点；结果不明或不符时暂停，不能虚报交付或盲目重试。
- 环境、权限、冲突、范围争议或仓库禁止 squash 时暂停；不绕过保护，不把基础设施故障当代码返工。
- 所有角色与 Judge 继承 Manager 模型，角色使用默认节点级会话。create-issue 和 merge 由 Manager 承担用户问答。
- 证据写入 Issue，handoff 保留仓库、Issue/PR、分支、修订及证据链接。不规定额外报告目录或 Milestone。
- 保护已有用户改动；不强推、不自动删除分支、不发布、不部署。恢复前核验已有副作用，复用已创建/合并/关闭的对象。

## 初始化合同

- 默认与唯一安装集合：现有通用 Manager preset + `development-workflow`。
- 删除 `--full`：传入时明确报未知参数且不写入；保留 `--dry-run`、`--force` 与仓库脚本的 `--home`。
- 保留现有幂等、差异默认跳过、force 先备份、预演零写入及安装校验行为。
- 不清理用户已有 catalog；旧四份复杂模板在仓库保留为进阶示例，不再自动安装。
- bundle 仅携带新模板；可替换生成产物中受管理的 `resources/workflows`，不得触碰用户 `workflows` 或其他资源。

## 验收

1. 新模板通过现有 v3 解析和静态校验：恰好五节点、结果分支明确，只有 merge 可以返回 delivered。
2. 正常链、review/test 产品返工、review/test/merge 候选漂移都由回归测试约束；无硬编码模型、跨节点复用或技能调用依赖。
3. 默认初始化仅生成新模板及 Manager；用户旧模板保持不变；拒绝 `--full`，force/dry-run/备份/幂等与源校验安全性回归通过。
4. 隔离 bundle 构建与初始化可用，旧 bundle 模板资源不会残留到新产物；不会删除用户 catalog 或无关资源。
5. 中英文首页、安装指南、命令帮助与示例索引统一更新；完整 `pnpm run verify` 通过。

## 非目标

不修改引擎、状态格式或技能供应系统；不引入多仓、拆票、Milestone、自动部署或新的全局配置。真实 GitHub 写入和模型工作流执行不属于本轮自动测试；模板语义测试不等于真实模型行为保证。
