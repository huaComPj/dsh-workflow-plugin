/**
 * Issue #235 验收：Role Actor 单备用模型安全恢复闭环
 * （规格 docs/specs/role-model-fallback.md，ADR-0004）。
 *
 * seam：真实 Engine + 临时 SQLite（绝不触真实 DSH home）+ 受控 Host。替身只记录
 * 每次 spawn 的 agentOptions，路由取值直接消费生产决策函数 `resolveRoleModel`，
 * 不复刻优先级。故障事实用生产投影 `turnEndFailure` / `turnEndFailureFacts` 从
 * Host 的 `turn/end` 结构构造，避免测试自造一套分类语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, CatalogValidationError } from '../src/catalog/validate.ts'
import { checkCatalogProviders, collectRoleRoutes } from '../src/catalog/provider-check.ts'
import { classifyActorFailure, describeActorFailure } from '../src/engine/failover.ts'
import { WorkflowEngine, type JudgeSpawnInput, type SubagentHost } from '../src/engine/engine.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { makeDispatchLifecycle, type DispatchLifecycle } from '../src/plugin/dispatch-lifecycle.ts'
import { turnEndFailure, turnEndFailureFacts, type TurnEndFact } from '../src/plugin/turn-end.ts'
import { judgeSpawnPlan, resolveRoleModel, roleFallbackRoute } from '../src/roles/roles.ts'
import { StateStore } from '../src/state/store.ts'
import { routeToAgentOptions, sameRouteIdentity, type RunState, type SpawnAgentOptions, type WorkflowConfig } from '../src/types.ts'
import { businessEqual, loadDraft, previewDraft, redo, setJudgeFallbackModel, setJudgeModel, setRoleFallbackModel, undo } from '../src/editor/draft.ts'
import { serializeLayout } from '../src/editor/layout.ts'
import { buildClientBundle, bundleSources } from '../web-client/build.mjs'

function load(yaml: string, workflowId = 'role-model-fallback'): WorkflowConfig {
  return validateAndNormalize(parseCatalogConfig(yaml), { workflowId })
}

const CATALOG = (roles: string): string => `
schemaVersion: agent-workflow/v3
roles:
${roles}
judgeRole:
  persona: Judge persona.
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: Plan is complete., target: { node: work } }
    work:
      execution: { type: actor-task, role: worker, instruction: Work. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: Work is complete., target: { return: done } }
`

const CONFIG = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: primary, modelId: primary-model }
    fallbackModel: { provider: backup, modelId: backup-model }
  plain:
    persona: Plain persona.
    model: { provider: primary, modelId: primary-model }`))

// ---- catalog 校验：配置形状与主备差异 ----

test('#235 备用路由随归档 schema 归一，键序落在主模型之后', () => {
  const config = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: p1, modelId: m1 }
    fallbackModel: { provider: p2, modelId: m2, reasoningEffort: "  high  " }`))
  assert.deepEqual(config.roles.worker!.fallbackModel, { provider: 'p2', modelId: 'm2', reasoningEffort: 'high' })
  assert.deepEqual(Object.keys(config.roles.worker!), ['persona', 'model', 'fallbackModel', 'reuse', 'compactBeforeReuse'])
})

test('#235 主备只有档位不同不构成备用路由，静态拒绝', () => {
  assert.throws(() => load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: p1, modelId: m1, reasoningEffort: low }
    fallbackModel: { provider: p1, modelId: m1, reasoningEffort: high }`)), (error: unknown) => {
    assert.ok(error instanceof CatalogValidationError)
    assert.match(error.message, /worker" fallbackModel must differ from model by provider\/modelId/)
    return true
  })
})

test('#235 不同 provider 的同名 modelId 是合法备用路由', () => {
  const config = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: p1, modelId: same-model }
    fallbackModel: { provider: p2, modelId: same-model }`))
  assert.equal(config.roles.worker!.fallbackModel!.provider, 'p2')
})

test('#235 备用路由档位空白值防御性拒绝（Judge 同规则，#236）', () => {
  const handBuilt = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: p1, modelId: m1 }`))
  handBuilt.roles.worker!.fallbackModel = { provider: 'p2', modelId: 'm2', reasoningEffort: '   ' }
  assert.throws(() => validateAndNormalize(handBuilt, { workflowId: 'w' }), CatalogValidationError, /fallbackModel reasoningEffort must be a non-empty string/)

  handBuilt.judgeRole.fallbackModel = { provider: 'p2', modelId: 'm2', reasoningEffort: '   ' }
  assert.throws(() => validateAndNormalize(handBuilt, { workflowId: 'w' }), CatalogValidationError, /judgeRole fallbackModel reasoningEffort must be a non-empty string/)

  // #236：judgeRole.fallbackModel 已被 schema 接受，主备同路由由 catalog 校验拒绝。
  const parsed = load(`
schemaVersion: agent-workflow/v3
roles:
  worker: { persona: W. }
judgeRole:
  persona: Judge persona.
  model: { provider: p1, modelId: m1 }
  fallbackModel: { provider: p2, modelId: m2 }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: Plan is complete., target: { return: done } }
`)
  assert.deepEqual(parsed.judgeRole.fallbackModel, { provider: 'p2', modelId: 'm2' })
  assert.deepEqual(Object.keys(parsed.judgeRole), ['persona', 'model', 'fallbackModel'])

  const clash = load(CATALOG(`  worker:
    persona: Worker persona.`))
  clash.judgeRole.model = { provider: 'p1', modelId: 'm1' }
  clash.judgeRole.fallbackModel = { provider: 'p1', modelId: 'm1', reasoningEffort: 'high' }
  assert.throws(() => validateAndNormalize(clash, { workflowId: 'w' }), CatalogValidationError, /judgeRole fallbackModel must differ from model by provider\/modelId/)
})

// ---- 故障资格判定：只按结构化事实分类，不解析 message ----

test('#235 只有 5xx / 429 / 网络 / 请求超时算合格故障', () => {
  assert.deepEqual(classifyActorFailure({ code: 'SERVER', status: 503 }), { eligible: true, kind: 'server-5xx' })
  assert.deepEqual(classifyActorFailure({ code: 'UPSTREAM', status: 502 }), { eligible: true, kind: 'server-5xx' })
  assert.deepEqual(classifyActorFailure({ code: 'RATE_LIMIT', status: 429 }), { eligible: true, kind: 'rate-limited' })
  assert.deepEqual(classifyActorFailure({ code: 'TIMEOUT' }), { eligible: true, kind: 'request-timeout' })
  assert.deepEqual(classifyActorFailure({ code: 'TRANSPORT' }), { eligible: true, kind: 'network-transport' })
})

test('#235 认证/额度/参数/上下文/工具/来源不明一律不合格（fail-closed）', () => {
  assert.deepEqual(classifyActorFailure({ code: 'QUOTA', status: 402 }), { eligible: false, kind: 'quota-exhausted' })
  assert.deepEqual(classifyActorFailure({ code: 'ACCOUNT_QUOTA' }), { eligible: false, kind: 'quota-exhausted' })
  assert.deepEqual(classifyActorFailure({ code: 'AUTH', status: 401 }), { eligible: false, kind: 'auth-failed' })
  assert.deepEqual(classifyActorFailure({ code: 'INVALID_CREDENTIAL' }), { eligible: false, kind: 'auth-failed' })
  assert.deepEqual(classifyActorFailure({ code: 'INVALID_REQUEST', status: 400 }), { eligible: false, kind: 'invalid-request' })
  assert.deepEqual(classifyActorFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }), { eligible: false, kind: 'context-window' })
  assert.deepEqual(classifyActorFailure({ code: 'IMAGE_OFFLOAD_REQUIRED' }), { eligible: false, kind: 'image-offload' })
  assert.deepEqual(classifyActorFailure({ code: 'UNKNOWN' }), { eligible: false, kind: 'unclassified' })
  assert.deepEqual(classifyActorFailure({ code: 'SOMETHING_NEW', status: 418 }), { eligible: false, kind: 'http-418' })
  assert.deepEqual(classifyActorFailure(undefined), { eligible: false, kind: 'unstructured' })
})

test('#235 诊断串只记 code/status，不落 message 正文', () => {
  assert.equal(describeActorFailure({ code: 'SERVER', status: 503 }), 'code=SERVER status=503')
  assert.equal(describeActorFailure({ code: 'TIMEOUT' }), 'code=TIMEOUT')
})

// ---- 路由阶段解析 ----

test('#235 resolveRoleModel：主/备/人工三态各自生效，缺省状态保持旧优先级', () => {
  const run = new WorkflowEngine(
    { async steerManager() { return { messageId: 'm' } }, async sendRoleActor() { return { messageId: 'm' } }, managerSessionSeq() { return 0 } },
    {} as SubagentHost, { async run() { throw new Error('no programs') } }, { async get() { return undefined }, async put() {}, async create() { return 1 }, async listRuns() { return [] }, async execution() { return undefined }, async events() { return [] }, async historyOwner() { return undefined } },
  ).buildInitialRun('manager', 'role-model-fallback', CONFIG, 'hash')
  const frozen = { provider: 'frozen', modelId: 'frozen-model' }
  assert.deepEqual(resolveRoleModel(run, 'worker', frozen), { provider: 'primary', modelId: 'primary-model' })

  run.roleRoutes = { worker: { stage: 'fallback' } }
  assert.deepEqual(resolveRoleModel(run, 'worker', frozen), { provider: 'backup', modelId: 'backup-model' })

  run.roleRoutes = { worker: { stage: 'manual' } }
  run.modelOverrides.worker = { provider: 'manual', modelId: 'manual-model' }
  assert.deepEqual(resolveRoleModel(run, 'worker', frozen), { provider: 'manual', modelId: 'manual-model' })

  // 旧 Run：没有 roleRoutes 但带 override → 按人工轮解释（不回退到主模型）。
  run.roleRoutes = undefined
  assert.deepEqual(resolveRoleModel(run, 'worker', frozen), { provider: 'manual', modelId: 'manual-model' })
})

test('#235 备用路由进入启动前静态校验行（误配阻断启动）', () => {
  assert.deepEqual(collectRoleRoutes(CONFIG).map(route => route.role), ['worker', 'worker（备用模型）', 'plain', 'judge'])
  const missing = checkCatalogProviders('role-model-fallback', CONFIG, ['primary'])
  assert.equal(missing.ok, false)
  const backup = missing.rows.find(row => row.role === 'worker（备用模型）')!
  assert.equal(backup.ok, false)
  assert.match(backup.reason, /backup.*未在当前 profile 注册/)
  const accepted = checkCatalogProviders('role-model-fallback', CONFIG, ['primary', 'backup'])
  assert.equal(accepted.ok, true)
})

test('#287 active Role 保存下一派发主模型，保留会话、备用和在途事实，每次保存独立开轮', async () => {
  const h = harness()
  try {
    await h.start()
    await h.toWorker()
    const before = await h.row()
    const saved = await h.engine.handleSetRoleModel('ws', 'worker', 'manual', 'C', 'manager', 'high')
    assert.equal(saved.ok, true, JSON.stringify(saved))
    const after = await h.row()
    assert.deepEqual(after.execution, before.execution, '配置不是工作单变更，也不撤销旧派发')
    assert.deepEqual(after.run.roleActors, before.run.roleActors)
    assert.deepEqual(after.run.definitionSnapshot, before.run.definitionSnapshot)
    assert.deepEqual(resolveRoleModel(after.run, 'worker', after.run.delegationRoute), { provider: 'manual', modelId: 'C', reasoningEffort: 'high' })
    assert.equal(roleFallbackRoute(after.run, 'worker')?.modelId, 'backup-model')
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'manual', 'C', 'manager')).ok, true)
    const repeated = await h.row()
    assert.equal(resolveRoleModel(repeated.run, 'worker', repeated.run.delegationRoute).reasoningEffort, undefined)
    assert.equal(repeated.run.roleModelConfigs?.worker.revision, 2)
    assert.equal(repeated.run.roleRoutes?.worker.autoSwitches, 0)
  } finally { h.close() }
})

for (const role of ['worker', 'judge'] as const) {
  test(`#287 ${role} 旧 A 失败先派新 C，同 Session C→B→BLOCK，重开不刷新预算`, async () => {
    const config = structuredClone(CONFIG)
    config.judgeRole.model = { provider: 'primary', modelId: 'primary-model' }
    config.judgeRole.fallbackModel = { provider: 'backup', modelId: 'backup-model' }
    const h = harness(config)
    try {
      await h.start()
      const old = role === 'worker' ? await h.toWorker() : await h.toChecking()
      assert.equal((await h.engine.handleSetRoleModel('ws', role, 'manual', 'C', 'manager')).ok, true)
      h.reopen()
      await h.engine.handleTurnEnded('ws', old, FAILOVER_503.text, FAILOVER_503.facts)
      const primary = await h.row()
      const dispatch = role === 'worker' ? primary.execution.dispatch! : primary.execution.judge!
      assert.equal(dispatch.sessionId, old.sessionId)
      assert.equal(dispatch.model?.modelId, 'C')
      assert.equal(primary.run.roleRoutes?.[role].autoSwitches, 0, '旧故障不扣新链预算')
      assert.equal(h.spawns.at(-1)?.agentOptions?.model, 'C', '实际发送消费登记快照')
      h.reopen()
      const current = { sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) }
      await h.engine.handleTurnEnded('ws', current, FAILOVER_503.text, FAILOVER_503.facts)
      const backup = await h.row()
      const fallbackDispatch = role === 'worker' ? backup.execution.dispatch! : backup.execution.judge!
      assert.equal(fallbackDispatch.sessionId, old.sessionId)
      assert.equal(fallbackDispatch.model?.modelId, 'backup-model')
      assert.equal(backup.run.roleRoutes?.[role].autoSwitches, 1)
      h.reopen()
      await h.engine.handleTurnEnded('ws', { sessionId: fallbackDispatch.sessionId!, turnUserMessageIds: new Set([fallbackDispatch.messageId!]) }, FAILOVER_503.text, FAILOVER_503.facts)
      assert.equal((await h.row()).run.status, 'blocked')
      assert.equal((await h.engine.handleSetRoleModel('ws', role, 'manual', 'C', 'manager')).ok, true)
      assert.equal((await h.row()).run.roleRoutes?.[role].stage, 'primary')
      assert.equal((await h.row()).run.roleModelConfigs?.[role].revision, 2)
    } finally { h.close() }
  })
}

for (const role of ['worker', 'judge'] as const) {
  test(`#287 ${role} 当前 Run 的 C/D 配置不回落冻结 A/B，设模保留 D`, async () => {
    const config = structuredClone(CONFIG)
    config.judgeRole.model = { provider: 'primary', modelId: 'primary-model' }
    config.judgeRole.fallbackModel = { provider: 'backup', modelId: 'backup-model' }
    const h = harness(config)
    try {
      await h.start()
      const initial = await h.row()
      // 持久化端口准备当前 Run 配置；人类写 RPC 属 #288，不在这里伪造新公开入口。
      const run = structuredClone(initial.run)
      run.roleModelConfigs = { [role]: { primary: { provider: 'current', modelId: 'C' }, fallback: { provider: 'current', modelId: 'D' }, revision: 1 } }
      run.modelConfigRevision = 1
      await h.store.updateRow('ws', run, initial.stateVersion, [])
      const old = role === 'worker' ? await h.toWorker() : await h.toChecking()
      assert.equal((await h.engine.handleSetRoleModel('ws', role, 'current', 'C', 'manager')).ok, true)
      assert.deepEqual(roleFallbackRoute((await h.row()).run, role), { provider: 'current', modelId: 'D' })
      await h.engine.handleTurnEnded('ws', old, FAILOVER_503.text, FAILOVER_503.facts)
      let row = await h.row()
      const primary = role === 'worker' ? row.execution.dispatch! : row.execution.judge!
      assert.equal(primary.model?.modelId, 'C', '旧修订故障先尝试新主配置')
      await h.engine.handleTurnEnded('ws', { sessionId: primary.sessionId!, turnUserMessageIds: new Set([primary.messageId!]) }, FAILOVER_503.text, FAILOVER_503.facts)
      row = await h.row()
      const fallback = role === 'worker' ? row.execution.dispatch! : row.execution.judge!
      assert.equal(fallback.model?.modelId, 'D')
      assert.equal(fallback.sessionId, old.sessionId)
      assert.equal(h.spawns.at(-1)?.agentOptions?.model, 'D')
      h.reopen()
      assert.equal(resolveRoleModel((await h.row()).run, role).modelId, 'D')
      await h.engine.handleTurnEnded('ws', { sessionId: fallback.sessionId!, turnUserMessageIds: new Set([fallback.messageId!]) }, FAILOVER_503.text, FAILOVER_503.facts)
      assert.equal((await h.row()).run.status, 'blocked')
      assert.deepEqual((await h.row()).run.definitionSnapshot, initial.run.definitionSnapshot)
    } finally { h.close() }
  })
}

// ---- 引擎：真实 Runtime 接缝 ----

interface Spawn { label: string; agentOptions?: SpawnAgentOptions; text?: string }

function endOf(reason: unknown): { text: string | undefined; facts: { code: string; status?: number } | undefined } {
  const events: TurnEndFact[] = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'u-dispatch' } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason } },
  ]
  return { text: turnEndFailure(events, events[2]!), facts: turnEndFailureFacts(events[2]!) }
}

const FAILOVER_503 = endOf({ kind: 'error', error: { message: 'upstream exploded', code: 'SERVER', status: 503 } })
const QUOTA_402 = endOf({ kind: 'error', error: { message: 'insufficient balance', code: 'QUOTA', status: 402 } })

function harness(config: WorkflowConfig = CONFIG, traceDir?: string, lifecycle?: DispatchLifecycle) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-role-fallback-'))
  const spawns: Spawn[] = []
  const messages: string[] = []
  let serial = 0
  let store = new StateStore(home)

  function build(forStore: StateStore): WorkflowEngine {
    const subagents: SubagentHost = {
      async ensureRoleActor(run, roleKey, initialText, model) {
        spawns.push({ label: `role:${roleKey}`, agentOptions: routeToAgentOptions(model ?? resolveRoleModel(run, roleKey, run.delegationRoute)), text: initialText })
        const childId = `child-${++serial}`
        lifecycle?.noteStart(childId, `epoch-${childId}`)
        return { childId, messageId: `message-${serial}` }
      },
      async startJudge(run: RunState, input: JudgeSpawnInput) {
        spawns.push({ label: 'judge', agentOptions: routeToAgentOptions(input.model ?? judgeSpawnPlan(run, run.delegationRoute).agentOptions) })
        return { judgeSessionId: input.judgeSessionId, messageId: `message-${++serial}` }
      },
      async followupJudge(_run, _session, input) { spawns.push({ label: 'judge', agentOptions: routeToAgentOptions(input.model!) }); return { messageId: `message-${++serial}` } },
      async judgeSessionAvailability() { return 'available' as const },
      async roleSessionAvailability() { return 'available' as const },
      async retireJudge() {},
      async drainJudge() {},
      async drainRoleActor() {},
      async compactRoleActor() { throw new Error('no cross-node boundary in this fixture') },
      async safeToInspect() { return 'safe' as const },
      ...(lifecycle === undefined ? {} : { dispatchLifecycle: lifecycle }),
    }
    const engine = new WorkflowEngine({
      async steerManager(_run, text) { messages.push(text); return { messageId: 'manager-message' } },
      async sendRoleActor(_run, roleKey, text, model) { spawns.push({ label: `send:${roleKey}`, text, ...(model ? { agentOptions: routeToAgentOptions(model) } : {}) }); return { messageId: `message-${++serial}` } },
      managerSessionSeq() { return 0 },
    }, subagents, { async run() { throw new Error('no programs') } }, makeStateHost(forStore))
    engine.cwdResolver = async () => 'cwd'
    return engine
  }

  let engine = build(store)
  const h = {
    home, spawns, messages,
    get store() { return store },
    get engine() { return engine },
    async row() { return (await store.get('ws'))! },
    async start() {
      const run = engine.buildInitialRun('manager', 'role-model-fallback', config, 'hash')
      const configPath = traceDir ? join(traceDir, 'role-model-fallback.yaml') : undefined
      const outcome = await engine.startRun('ws', run, configPath, 'root request')
      assert.equal(outcome.ok, true, JSON.stringify(outcome))
      const row = await h.row()
      return { sessionId: row.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    },
    /** 把执行推进到 worker 节点的 working 派发，返回该派发的 caller。 */
    async toWorker() {
      const plan = await h.row()
      const planCaller = { sessionId: plan.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([plan.execution.dispatch!.messageId!]) }
      assert.equal((await engine.handleClaim('ws', { result: 'succeeded', handoff: 'plan handoff' }, planCaller)).ok, true)
      await engine.handleTurnEnded('ws', planCaller)
      const checking = await h.row()
      assert.equal(checking.execution.phase, 'checking')
      const judge = { sessionId: checking.execution.judge!.sessionId!, turnUserMessageIds: new Set([checking.execution.judge!.messageId!]) }
      checking.execution.judge!.settled = true
      await store.updateRow('ws', checking.run, checking.stateVersion, [{ execution: checking.execution, expectedRevision: checking.execution.revision, events: [] }])
      assert.equal((await engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
      await engine.drive('ws')
      return h.caller()
    },
    async caller() {
      const row = await h.row()
      return { sessionId: row.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    },
    /** #236：推进到判定中（claim 已接受、Judge 已派发），返回 Judge 的派发 caller。 */
    async toChecking() {
      const plan = await h.row()
      const planCaller = { sessionId: plan.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([plan.execution.dispatch!.messageId!]) }
      assert.equal((await engine.handleClaim('ws', { result: 'succeeded', handoff: 'plan handoff' }, planCaller)).ok, true)
      await engine.handleTurnEnded('ws', planCaller)
      const checking = await h.row()
      assert.equal(checking.execution.phase, 'checking')
      assert.ok(checking.execution.judge!.messageId, '判定已派发')
      return { sessionId: checking.execution.judge!.sessionId!, turnUserMessageIds: new Set([checking.execution.judge!.messageId!]) }
    },
    /** #243：trace 是 best-effort 文件派生产物（无 traceLogPath 即 no-op），只在传入 traceDir 时可读。 */
    trace(): string {
      if (!traceDir) return ''
      const dir = join(traceDir, 'role-model-fallback')
      return existsSync(dir) ? readdirSync(dir).map(name => readFileSync(join(dir, name), 'utf8')).join('') : ''
    },
    /** 关库重开：同一 home 新建 Store/Engine（预算与激活路由必须来自持久化行）。 */
    reopen() {
      store.close()
      store = new StateStore(home)
      engine = build(store)
    },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
  return h
}

function lastRoleSpawn(spawns: Spawn[]): Spawn {
  const spawn = spawns.filter(entry => entry.label === 'role:worker' || entry.label === 'send:worker').at(-1)
  assert.ok(spawn, 'role:worker spawn expected')
  return spawn
}

test('#235 5xx 且已安全收口：自动切备用并重派，Manager 收到通知而非批准请求', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    const failedSession = (await h.row()).execution.dispatch!.sessionId
    const before = h.spawns.length
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)

    const row = await h.row()
    assert.equal(row.run.status, 'running', '切换后继续运行，不是 BLOCK')
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.nodeId, 'work')
    assert.equal(row.execution.blockReason, null)
    assert.deepEqual(row.run.roleRoutes, { worker: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })
    assert.equal(row.run.roleActors.worker, failedSession, '#287 路由更新保留同一 Session')

    const respawn = h.spawns.slice(before)
    assert.equal(respawn.length, 1, '只重新派发一次')
    assert.equal(respawn[0]!.label, 'send:worker')
    assert.equal(respawn[0]!.agentOptions?.provider, 'backup')
    assert.equal(respawn[0]!.agentOptions?.model, 'backup-model')
    assert.equal(respawn[0]!.agentOptions?.reasoningEffort, undefined, '省略档位 = 备用模型默认档位')
    assert.match(respawn[0]!.text!, /\[模型故障切换\]/)
    assert.match(respawn[0]!.text!, /\[中断恢复\]/)
    assert.match(respawn[0]!.text!, /code=SERVER status=503/)
    assert.doesNotMatch(respawn[0]!.text!, /upstream exploded/, '诊断脱敏：不带错误正文')

    const notices = h.messages.filter(message => message.includes('Workflow MODEL FALLBACK'))
    assert.equal(notices.length, 1, '一次切换只通知一次（多生命周期信号不重复切换）')
    assert.match(notices[0]!, /Workflow MODEL FALLBACK: role=worker primary\/primary-model → backup\/backup-model（fallback，本轮第 1 次自动切换，原因 server-5xx code=SERVER status=503）/)
    assert.match(notices[0]!, /无需批准/)
    assert.deepEqual((await h.store.events('ws', row.execution.executionId)).map(event => event.type).slice(-2), ['model-changed', 'actor-arranged'])

    const status = await h.engine.status('ws', 'manager')
    assert.equal(status.ok, true)
    const routes = (status as { status: { routes: Array<Record<string, unknown>> } }).status.routes
    assert.deepEqual(routes, [{ role: 'worker', stage: 'fallback', route: 'backup/backup-model', fallback: 'backup/backup-model', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 }])
  } finally { h.close() }
})

test('#247 同装 lifecycle + fallback：生命周期信号与安全收口正反交错，不双扣预算、不凭 lifecycle-only 授路由', async () => {
  const lifecycle = makeDispatchLifecycle()
  const h = harness(CONFIG, undefined, lifecycle)
  try {
    await h.start()
    const worker = await h.toWorker()
    const before = await h.row()
    const primarySession = before.execution.dispatch!.sessionId!
    const spawnsBefore = h.spawns.length
    // 反序一：终态先被观察，宿主 turn/end 随后到达并安全收口到备用路由。
    const early = lifecycle.noteEnd(primarySession, { runId: `epoch-${primarySession}`, stopReason: 'error', provider: 'primary' })
    assert.notEqual(early, undefined)
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    let row = await h.row()
    assert.equal(row.run.status, 'running', '安全收口成功，不因早到终态 BLOCK')
    assert.deepEqual(row.run.roleRoutes.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    const switched = h.spawns.slice(spawnsBefore)
    assert.equal(switched.length, 1, '只重派一次')
    assert.equal(switched[0]!.agentOptions?.provider, 'backup')
    // 延后转交的旧终态：旧派发登记已精确失效，迟到的结算不得二次扣预算或改工作单。
    await h.engine.settleActivation(early!)
    row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.run.roleRoutes.worker!.autoSwitches, 1, '不双扣预算')
    assert.equal(h.spawns.length, spawnsBefore + 1, '不因旧信号再派发')
    const newSession = row.execution.dispatch!.sessionId!
    assert.equal(newSession, primarySession)
    assert.equal((await h.store.events('ws', row.execution.executionId)).filter(event => event.type === 'blocked').length, 0)
    // 正序：新派发受理后先接受 claim，再收到生命周期终态；阶段已离开 working，
    // 终态不得撤 claim、不得改派、不得把安全收口变成技术 BLOCK。
    const claimCaller = { sessionId: newSession, turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: '保留的现场' }, claimCaller)).ok, true)
    const claimed = await h.row()
    assert.equal(claimed.execution.phase, 'checking')
    assert.equal(claimed.execution.claim?.result, 'succeeded')
    const ref = lifecycle.noteEnd(newSession, { runId: `epoch-${newSession}`, stopReason: 'error' })
    assert.notEqual(ref, undefined)
    await h.engine.settleActivation(ref!)
    const after = await h.row()
    assert.equal(after.run.status, 'running', '判定中迟到的生命周期终态不越权 BLOCK')
    assert.equal(after.execution.claim?.result, 'succeeded', 'claim 不被撤')
    assert.equal(after.execution.claim?.handoff, '保留的现场')
    assert.deepEqual(after.run.roleRoutes.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    assert.equal(h.spawns.length, spawnsBefore + 1, '不额外派发')
    assert.equal(h.messages.filter(message => message.includes('Workflow MODEL FALLBACK')).length, 1)
    assert.equal((await h.store.events('ws', after.execution.executionId)).filter(event => event.type === 'blocked').length, 0)
  } finally { h.close() }
})

test('#235 已执行外部写后故障：材料保留事实，新执行先核验再续作（不盲目重复）', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    // 上一执行（主路由）已经做过外部写（推送分支、合并 PR、改文件）——这些副作用
    // 不随 turn/end 失败回滚，切换后必须让新执行先核验，而不是从材料里“看不出就重做”。
    const before = await h.row()
    const materials = before.execution.input

    // F-2：配置了备用但尚未切换的角色也可见（stage=primary），不必猜是否参与切换链。
    const beforeStatus = (await h.engine.status('ws', 'manager')) as { status: { routes: Array<Record<string, unknown>> } }
    assert.deepEqual(beforeStatus.status.routes, [{ role: 'worker', stage: 'primary', route: 'primary/primary-model', fallback: 'backup/backup-model', reason: null, autoSwitches: 0 }])

    const spawnsBefore = h.spawns.length
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)

    const row = await h.row()
    assert.equal(row.run.status, 'running', '合格故障 + 安全收口 → 切换而不是 BLOCK')
    const dispatch = h.spawns.slice(spawnsBefore).at(-1)!
    assert.equal(dispatch.label, 'send:worker')
    const text = dispatch.text!
    // 恢复材料保留事实：节点原始材料仍在派发正文里。
    assert.ok(text.includes(materials), '节点材料原样保留')
    assert.equal(row.execution.input, materials, '切换不改写节点材料')
    assert.equal(row.execution.inputVersion, before.execution.inputVersion + 1)
    // 新执行先核验既有外部操作结果，而不是盲目重复。
    assert.match(text, /\[模型故障切换\]/)
    assert.match(text, /先用工具核验已执行外部操作的真实结果/)
    assert.match(text, /已完成的不要重复执行/)
    assert.match(text, /无法核验或存在不确定副作用时保持 BLOCK/)
    assert.match(text, /\[中断恢复\]/)
  } finally { h.close() }
})

test('#235 备用也失败 → BLOCK；node_resume 与关库重开都不刷新预算', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    const onBackup = await h.caller()
    await h.engine.handleTurnEnded('ws', onBackup, FAILOVER_503.text, FAILOVER_503.facts)

    let row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /^actor-turn-ended-without-result \| turn-end reason=error code=SERVER status=503/)
    assert.deepEqual(row.run.roleRoutes, { worker: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })
    const token = row.execution.nodeToken

    // 关库重开：激活路由与预算来自持久化行。
    h.reopen()
    row = await h.row()
    assert.deepEqual(row.run.roleRoutes, { worker: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })

    const before = h.spawns.length
    assert.equal((await h.engine.handleResume('ws', token, '重试一次，先核验实际完成情况', 'manager', 'actor')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.execution.phase, 'working')
    assert.equal(resolveRoleModel(resumed.run, 'worker', resumed.run.delegationRoute).provider, 'backup', 'resume 仍走备用，不刷新回主模型')
    assert.deepEqual(resumed.run.roleRoutes, { worker: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })
    // 追加断言：复用同一备用会话（不重新物化到主模型）。
    assert.equal(h.spawns.slice(before).filter(entry => entry.label === 'role:worker').length, 0)

    // 备用再次合格故障：预算已耗尽，直接 BLOCK（不消耗别的路由）。
    const retry = await h.caller()
    await h.engine.handleTurnEnded('ws', retry, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
  } finally { h.close() }
})

test('#235 不合格故障（额度耗尽）保留 BLOCK，不消耗路由预算', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    const before = h.spawns.length
    await h.engine.handleTurnEnded('ws', worker, QUOTA_402.text, QUOTA_402.facts)
    const row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /code=QUOTA status=402/)
    assert.equal(row.run.roleRoutes, undefined)
    assert.equal(h.spawns.length, before, '不额外派发/不重试主模型')
    assert.equal(row.execution.dispatch?.settled, false, '失败派发保持原状，未伪造收口')
  } finally { h.close() }
})

test('#235 已接受 claim 后失败：仍按既有语义判定（不切换、不撤销 claim）', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'work handoff' }, worker)).ok, true)
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    const row = await h.row()
    assert.equal(row.run.roleRoutes, undefined, 'claim 已接受 → 不切换路由')
    assert.equal(row.execution.claim?.result, 'succeeded', '已接受 claim 不被撤销')
    const judge = h.spawns.filter(entry => entry.label === 'judge').at(-1)
    assert.ok(judge, '判定照旧派发（claim 已接受 → 走 Judge，不换模）')
  } finally { h.close() }
})

test('#235 无备用路由的角色完全保持旧行为', async () => {
  const noFallback = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: primary, modelId: primary-model }`))
  const h = harness(noFallback)
  try {
    await h.start()
    const worker = await h.toWorker()
    const before = h.spawns.length
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    const row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /^actor-turn-ended-without-result \| turn-end reason=error code=SERVER status=503/)
    assert.equal(row.run.roleRoutes, undefined)
    assert.equal(h.spawns.length, before)
  } finally { h.close() }
})

test('#287 Manager 显式设置当前主模型：C → 保留的备用 → BLOCK，不回冻结 A', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    await h.engine.handleTurnEnded('ws', worker, QUOTA_402.text, QUOTA_402.facts)
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'primary', 'primary-model', 'manager')).ok, true)
    assert.equal((await h.row()).run.roleRoutes?.worker?.stage, 'primary')
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'manual', 'manual-model', 'manager')).ok, true)
    const configured = await h.row()
    assert.equal((await h.engine.handleResume('ws', configured.execution.nodeToken, '换模型后继续', 'manager', 'actor')).ok, true)
    assert.equal(lastRoleSpawn(h.spawns).agentOptions?.provider, 'manual')
    await h.engine.handleTurnEnded('ws', await h.caller(), FAILOVER_503.text, FAILOVER_503.facts)
    const backup = await h.row()
    assert.equal(backup.run.status, 'running')
    assert.deepEqual(backup.run.roleRoutes?.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    assert.equal(backup.run.roleModelConfigs?.worker.primary.modelId, 'manual-model')
    assert.equal(lastRoleSpawn(h.spawns).agentOptions?.provider, 'backup')
    await h.engine.handleTurnEnded('ws', await h.caller(), FAILOVER_503.text, FAILOVER_503.facts)
    assert.equal((await h.row()).run.status, 'blocked')
    assert.equal((await h.row()).run.roleRoutes?.worker?.autoSwitches, 1)
  } finally { h.close() }
})

test('#235 继承主路由时备用与之相同：启动即拒绝（冻结后才能判定）', async () => {
  const clash = load(CATALOG(`  worker:
    persona: Worker persona.
    fallbackModel: { provider: inherited, modelId: inherited-model }`))
  const h = harness(clash)
  try {
    h.engine.managerRoute = async () => ({ provider: 'inherited', model: 'inherited-model' })
    const run = h.engine.buildInitialRun('manager', 'role-model-fallback', clash, 'hash')
    const outcome = await h.engine.startRun('ws', run, undefined, 'root request')
    assert.equal(outcome.ok, false)
    assert.match((outcome as { reason: string }).reason, /worker" fallbackModel duplicates its primary route \(inherited\/inherited-model\)/)
  } finally { h.close() }
})

// ---- #236：Judge 独立备用模型与安全判定恢复 ----

/** Judge 主/备可分别声明（省略 = 继承 Run 冻结的 Manager 路由）。 */
function judgeConfig(options: { primary?: boolean; fallback?: boolean } = {}): WorkflowConfig {
  const config = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: primary, modelId: primary-model }`))
  if (options.primary !== false) config.judgeRole.model = { provider: 'jprimary', modelId: 'jprimary-model' }
  if (options.fallback !== false) config.judgeRole.fallbackModel = { provider: 'jbackup', modelId: 'jbackup-model' }
  return config
}

function judgeSpawns(spawns: Spawn[], from: number): Spawn[] {
  return spawns.slice(from).filter(entry => entry.label === 'judge')
}

test('#236 配置 Judge 备用：判定中 5xx 直接切 B 判同一 claim，不叠加同模型重试', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    const judging = await h.toChecking()
    const before = await h.row()
    const claimId = before.execution.claim!.id
    const inputVersion = before.execution.inputVersion
    const oldJudgeSession = before.execution.judge!.sessionId
    const spawnsBefore = h.spawns.length

    await h.engine.handleTurnEnded('ws', judging, FAILOVER_503.text, FAILOVER_503.facts)

    const row = await h.row()
    assert.equal(row.run.status, 'running', '合格故障 + 已安全收口 → 切 B，不是 BLOCK')
    assert.equal(row.execution.phase, 'checking')
    assert.equal(row.execution.blockReason, null)
    assert.equal(row.execution.judgeAutoRetried, undefined, '不叠加 #200 的同模型重试预算')
    assert.deepEqual(row.run.roleRoutes, { judge: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })
    // 同一 claim / 同一 inputVersion / 材料不变：新 Judge 判同一份材料，不补做 Actor 工作。
    assert.equal(row.execution.claim!.id, claimId)
    assert.equal(row.execution.inputVersion, inputVersion)
    assert.equal(row.execution.input, before.execution.input)
    assert.equal(row.execution.judge!.claimId, claimId)
    assert.equal(row.execution.judge!.inputVersion, inputVersion)
    assert.equal(row.execution.judge!.sessionId, oldJudgeSession, '#287 同会话按新派发判同一 claim')
    assert.deepEqual(row.execution.judge!.model, { provider: 'jbackup', modelId: 'jbackup-model' })

    const respawn = judgeSpawns(h.spawns, spawnsBefore)
    assert.equal(respawn.length, 1, '只切一次：不先同模型重试、不重复派发')
    assert.equal(respawn[0]!.agentOptions?.provider, 'jbackup')
    assert.equal(respawn[0]!.agentOptions?.model, 'jbackup-model')
    assert.equal(respawn[0]!.agentOptions?.reasoningEffort, undefined, '省略档位 = 备用模型默认档位')

    const notices = h.messages.filter(message => message.includes('Workflow MODEL FALLBACK'))
    assert.equal(notices.length, 1, '切换主动通知 Manager 一次')
    assert.match(notices[0]!, /role=judge jprimary\/jprimary-model → jbackup\/jbackup-model（fallback，本轮第 1 次自动切换，原因 server-5xx code=SERVER status=503）/)
    assert.doesNotMatch(notices[0]!, /upstream exploded/, '诊断脱敏：不带错误正文')
    assert.deepEqual((await h.store.events('ws', row.execution.executionId)).map(event => event.type).slice(-2), ['model-changed', 'judge-arranged'])

    const status = (await h.engine.status('ws', 'manager')) as { status: { routes: Array<Record<string, unknown>> } }
    assert.deepEqual(status.status.routes, [{
      role: 'judge', stage: 'fallback', route: 'jbackup/jbackup-model', fallback: 'jbackup/jbackup-model',
      reason: 'server-5xx code=SERVER status=503', autoSwitches: 1,
    }])

    // 旧 Judge 会话的迟到提交与重复 turn-end 都失权：不重复判定、不重复扣预算。
    const staleJudge = { sessionId: oldJudgeSession, turnUserMessageIds: new Set(['stale-turn']) }
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'REJECT', 'stale verdict', staleJudge)).ok, false)
    await h.engine.handleTurnEnded('ws', staleJudge, FAILOVER_503.text, FAILOVER_503.facts)
    const after = await h.row()
    assert.deepEqual(after.run.roleRoutes, row.run.roleRoutes, '迟到信号不消耗第二次预算')
    assert.equal(after.execution.judge!.sessionId, row.execution.judge!.sessionId)
    assert.equal(after.execution.phase, 'checking')

    // 新 Judge ACCEPT 照常推进：已接受 judgment 不撤销、不重复判定。
    const judgeCaller = { sessionId: after.execution.judge!.sessionId!, turnUserMessageIds: new Set([after.execution.judge!.messageId!]) }
    assert.equal((await h.engine.handleJudgeClaim('ws', after.execution.nodeToken, 'ACCEPT', 'verified', judgeCaller)).ok, true)
    await h.engine.drive('ws')
    const advanced = await h.row()
    assert.equal(advanced.execution.nodeId, 'work')
    assert.equal(advanced.run.status, 'running')
    assert.deepEqual((await h.store.events('ws', after.execution.executionId)).map(event => event.type).filter(type => type === 'judgment').length, 1)
  } finally { h.close() }
})

test('#236 未配置 Judge 备用：保留 #200 的同模型重试一次，再失败 BLOCK', async () => {
  const h = harness(judgeConfig({ fallback: false }))
  try {
    await h.start()
    const judging = await h.toChecking()
    const spawnsBefore = h.spawns.length
    await h.engine.handleTurnEnded('ws', judging, FAILOVER_503.text, FAILOVER_503.facts)

    let row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.judgeAutoRetried, true, '旧行为：同模型 fresh 重试一次')
    assert.equal(row.run.roleRoutes, undefined, '未配置备用 → 不引入人工恢复链')
    const respawn = judgeSpawns(h.spawns, spawnsBefore)
    assert.equal(respawn.length, 1)
    assert.equal(respawn[0]!.agentOptions?.provider, 'jprimary', '重试仍在主模型')
    assert.equal(h.messages.filter(message => message.includes('Workflow MODEL FALLBACK')).length, 0)

    const retry = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) }
    await h.engine.handleTurnEnded('ws', retry, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /judge turn ended without judge_claim \(已自动重试 1 次\)/)
    assert.equal(row.run.roleRoutes, undefined)
  } finally { h.close() }
})

test('#236 Judge 备用也失败 → BLOCK；node_resume 与关库重开都不刷新预算', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await h.toChecking(), FAILOVER_503.text, FAILOVER_503.facts)
    const switched = await h.row()
    assert.equal(switched.execution.judge!.model?.provider, 'jbackup')
    const onBackup = { sessionId: switched.execution.judge!.sessionId!, turnUserMessageIds: new Set([switched.execution.judge!.messageId!]) }
    await h.engine.handleTurnEnded('ws', onBackup, FAILOVER_503.text, FAILOVER_503.facts)

    let row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /judge turn ended without judge_claim \(备用模型已用尽，不再自动重试\)/)
    assert.match(row.execution.blockReason!, /code=SERVER status=503/)
    assert.deepEqual(row.run.roleRoutes, { judge: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })
    const token = row.execution.nodeToken
    const spawnsBefore = h.spawns.length

    // 关库重开：激活路由/来源/预算来自持久化行，不刷新。
    h.reopen()
    row = await h.row()
    assert.deepEqual(row.run.roleRoutes, { judge: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })

    assert.equal((await h.engine.handleResume('ws', token, '继续判定，先核验既有材料', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.status, 'running')
    assert.equal(resumed.execution.phase, 'checking')
    assert.equal(resumed.execution.claim!.id, row.execution.claim!.id, 'resume 判同一 claim')
    assert.deepEqual(resumed.run.roleRoutes, { judge: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } }, 'resume 不刷新预算')
    const judgeRespawns = judgeSpawns(h.spawns, spawnsBefore)
    assert.ok(judgeRespawns.length >= 1)
    assert.equal(judgeRespawns.at(-1)!.agentOptions?.provider, 'jbackup', 'resume 仍走备用，不自动回主模型')

    // B 再次合格故障：预算耗尽，直接 BLOCK（不回到 A、不叠加插件级重试）。
    const backOnBackup = { sessionId: resumed.execution.judge!.sessionId!, turnUserMessageIds: new Set([resumed.execution.judge!.messageId!]) }
    await h.engine.handleTurnEnded('ws', backOnBackup, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /备用模型已用尽/)
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
  } finally { h.close() }
})

test('#236 不合格故障不换 Judge：额度耗尽保留 BLOCK，不消耗路由预算', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    const judging = await h.toChecking()
    const spawnsBefore = h.spawns.length
    await h.engine.handleTurnEnded('ws', judging, QUOTA_402.text, QUOTA_402.facts)
    const row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /judge turn ended without judge_claim \| turn-end reason=error code=QUOTA status=402/)
    assert.equal(row.run.roleRoutes, undefined)
    assert.equal(row.execution.judgeAutoRetried, undefined, '不消耗同模型重试预算，也不换模')
    assert.equal(h.spawns.length, spawnsBefore, '不额外派发')
    assert.equal(h.messages.filter(message => message.includes('Workflow MODEL FALLBACK')).length, 0)
  } finally { h.close() }
})

test('#236 Judge 继承主路由并单独配置备用：主备相同启动即拒绝，不同则生效', async () => {
  // 继承路由 = Run 冻结的 Manager 路由；备用与之相同无法构成备用路由（冻结后才能判定）。
  const clash = judgeConfig({ primary: false })
  const h = harness(clash)
  try {
    h.engine.managerRoute = async () => ({ provider: 'jbackup', model: 'jbackup-model' })
    const run = h.engine.buildInitialRun('manager', 'role-model-fallback', clash, 'hash')
    const outcome = await h.engine.startRun('ws', run, undefined, 'root request')
    assert.equal(outcome.ok, false)
    assert.match((outcome as { reason: string }).reason, /role "judge" fallbackModel duplicates its primary route \(jbackup\/jbackup-model\)/)
  } finally { h.close() }

  const inherited = judgeConfig({ primary: false })
  const ok = harness(inherited)
  try {
    ok.engine.managerRoute = async () => ({ provider: 'frozen', model: 'frozen-model' })
    const run = ok.engine.buildInitialRun('manager', 'role-model-fallback', inherited, 'hash')
    assert.equal((await ok.engine.startRun('ws', run, undefined, 'root request')).ok, true)
    // 配置了备用但尚未切换的 Judge 同样可见（stage=primary，route=继承的冻结路由）。
    const status = (await ok.engine.status('ws', 'manager')) as { status: { routes: Array<Record<string, unknown>> } }
    assert.deepEqual(status.status.routes, [{
      role: 'judge', stage: 'primary', route: 'frozen/frozen-model', fallback: 'jbackup/jbackup-model',
      reason: null, autoSwitches: 0,
    }])
  } finally { ok.close() }
})

test('#236 Judge 的 REJECT/NEED_CONTEXT 不是切换依据，也不消耗路由预算', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    const judging = await h.toChecking()
    const before = await h.row()
    // 材料不足 → 保留 BLOCK（NEED_CONTEXT 不是故障，不换模）。
    assert.equal((await h.engine.handleJudgeClaim('ws', before.execution.nodeToken, 'NEED_CONTEXT', '需要更多证据', judging)).ok, true)
    const needContext = await h.row()
    assert.equal(needContext.run.status, 'blocked')
    assert.match(needContext.execution.blockReason!, /Judge NEED_CONTEXT/)
    assert.equal(needContext.run.roleRoutes, undefined)

    // 补证恢复后 REJECT：进入修正轮，仍不换模、不消耗预算。
    assert.equal((await h.engine.handleResume('ws', needContext.execution.nodeToken, '补齐证据后重判', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    const judgeCaller = { sessionId: resumed.execution.judge!.sessionId!, turnUserMessageIds: new Set([resumed.execution.judge!.messageId!]) }
    assert.equal((await h.engine.handleJudgeClaim('ws', resumed.execution.nodeToken, 'REJECT', '不通过', judgeCaller)).ok, true)
    await h.engine.drive('ws')
    const rejected = await h.row()
    // REJECT 后引擎把同一节点重新派给 Actor（修正轮），故 phase 回到 working。
    assert.equal(rejected.execution.phase, 'working')
    assert.equal(rejected.execution.judgment!.result, 'REJECT')
    assert.equal(rejected.run.roleRoutes, undefined)
    assert.equal(rejected.execution.judgeAutoRetried, undefined)
    assert.equal(h.messages.filter(message => message.includes('Workflow MODEL FALLBACK')).length, 0)
  } finally { h.close() }
})


const EDITOR_CONFIG = `
schemaVersion: agent-workflow/v3
roles:
  developer:
    persona: Build it.
    model: { provider: p1, modelId: m1 }
judgeRole:
  persona: Judge it.
workflow:
  startNode: a
  returns: [done]
  nodes:
    a:
      execution: { type: actor-task, role: manager, instruction: Do it. }
      checker: { checkerId: judge.claim-correct }
      results:
        ok: { criteria: Done., target: { return: done } }
`

test('#235 编辑器：设置/清除/撤销备用模型，保存-重载业务等价', () => {
  const loaded = loadDraft('fallback', EDITOR_CONFIG)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  const session = loaded.session

  assert.equal(setRoleFallbackModel(session, 'developer', { provider: 'p2', modelId: 'm2', reasoningEffort: 'high' }).ok, true)
  assert.deepEqual(session.draft.config.roles.developer!.fallbackModel, { provider: 'p2', modelId: 'm2', reasoningEffort: 'high' })
  assert.equal(undo(session), true)
  assert.equal(session.draft.config.roles.developer!.fallbackModel, undefined)

  assert.equal(setRoleFallbackModel(session, 'developer', { provider: 'p2', modelId: 'm2' }).ok, true)
  const preview = previewDraft(session)
  assert.deepEqual(preview.problems, [])
  assert.match(preview.yaml, /fallbackModel:\n\s+provider: p2\n\s+modelId: m2/)
  const reloaded = loadDraft('fallback', preview.yaml, serializeLayout(session.draft.config, session.draft.layout))
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded))
  if (!reloaded.ok) throw new Error('unreachable')
  assert.ok(businessEqual(session.draft.config, reloaded.session.draft.config))

  assert.equal(setRoleFallbackModel(session, 'developer', undefined).ok, true)
  assert.equal(session.draft.config.roles.developer!.fallbackModel, undefined)
  assert.equal(setRoleFallbackModel(session, 'missing', undefined).ok, false)
  assert.equal(setRoleFallbackModel(session, 'developer', { provider: 'p2', modelId: '' }).ok, false)
})

test('#235 GUI：Role 面板区分主/备用模型并披露无限重试限制', () => {
  const bundle = bundleSources().panel
  assert.match(bundle, /title: '主模型'/)
  assert.match(bundle, /title: '备用模型（可选）'/)
  assert.match(bundle, /应用备用模型/)
  assert.match(bundle, /清除备用模型/)
  assert.match(bundle, /无限重试则收不到终止失败，本角色 fallback 不会被触发/)
})

test('#236 编辑器：Judge 备用模型设置/清除/撤销，保存-重载业务等价且键序稳定', () => {
  const loaded = loadDraft('judge-fallback', EDITOR_CONFIG)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  const session = loaded.session

  assert.equal(setJudgeModel(session, { provider: 'p1', modelId: 'm1' }).ok, true)
  assert.equal(setJudgeFallbackModel(session, { provider: 'p2', modelId: 'm2', reasoningEffort: 'high' }).ok, true)
  assert.deepEqual(session.draft.config.judgeRole.fallbackModel, { provider: 'p2', modelId: 'm2', reasoningEffort: 'high' })
  assert.deepEqual(Object.keys(session.draft.config.judgeRole), ['persona', 'model', 'fallbackModel'])
  assert.equal(undo(session), true)
  assert.equal(session.draft.config.judgeRole.fallbackModel, undefined)
  assert.equal(redo(session), true)
  assert.deepEqual(session.draft.config.judgeRole.fallbackModel, { provider: 'p2', modelId: 'm2', reasoningEffort: 'high' })

  const preview = previewDraft(session)
  assert.deepEqual(preview.problems, [])
  assert.match(preview.yaml, /judgeRole:\n\s+persona: Judge it\.\n\s+model:\n\s+provider: p1\n\s+modelId: m1\n\s+fallbackModel:\n\s+provider: p2\n\s+modelId: m2\n\s+reasoningEffort: high/)
  const reloaded = loadDraft('judge-fallback', preview.yaml, serializeLayout(session.draft.config, session.draft.layout))
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded))
  if (!reloaded.ok) throw new Error('unreachable')
  assert.ok(businessEqual(session.draft.config, reloaded.session.draft.config))

  // 清除 = 整键省略：Judge 回到「同模型重试一次」的旧行为。
  assert.equal(setJudgeFallbackModel(session, undefined).ok, true)
  assert.equal(session.draft.config.judgeRole.fallbackModel, undefined)
  assert.equal(setJudgeFallbackModel(session, { provider: 'p2', modelId: '' }).ok, false)
  assert.equal(previewDraft(session).problems.length, 0)
})

// ---- #237 回归按 #287 更新：主动设模重开当前主备轮次（C → B → BLOCK） ----

/** plan(manager) → work(worker) → work2(worker)：验证人工 C 成功后跨节点保持。 */
const CHAIN_CONFIG = load(`
schemaVersion: agent-workflow/v3
roles:
  worker:
    persona: Worker persona.
    model: { provider: primary, modelId: primary-model }
    fallbackModel: { provider: backup, modelId: backup-model }
judgeRole:
  persona: Judge persona.
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: Plan is complete., target: { node: work } }
    work:
      execution: { type: actor-task, role: worker, instruction: Work. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: Work is complete., target: { node: work2 } }
    work2:
      execution: { type: actor-task, role: worker, instruction: Work again. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: Work is complete., target: { return: done } }
`)

/** 当前 Judge 派发的 caller（模拟该 Judge 的 Turn 结束/判定提交）。 */
async function judgeCaller(h: ReturnType<typeof harness>): Promise<{ sessionId: string; turnUserMessageIds: Set<string> }> {
  const row = await h.row()
  return { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) }
}

/** 让当前节点以「Turn 已结束 + Judge ACCEPT」推进一格，返回新节点派发 caller。 */
async function acceptNode(h: ReturnType<typeof harness>): Promise<{ sessionId: string; turnUserMessageIds: Set<string> }> {
  const caller = await h.caller()
  assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'node handoff' }, caller)).ok, true)
  await h.engine.handleTurnEnded('ws', caller)
  const checking = await h.row()
  assert.equal(checking.execution.phase, 'checking')
  const judge = await judgeCaller(h)
  checking.execution.judge!.settled = true
  await h.store.updateRow('ws', checking.run, checking.stateVersion, [{ execution: checking.execution, expectedRevision: checking.execution.revision, events: [] }])
  assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
  await h.engine.drive('ws')
  return h.caller()
}

function routesOf(status: unknown): Array<Record<string, unknown>> {
  return (status as { status: { routes: Array<Record<string, unknown>> } }).status.routes
}

test('#237 Actor 人工换模：C→B→BLOCK，失败设置不授予预算，再次设置才重置（#287）', async () => {
  const h = harness()
  try {
    await h.start()
    // C=A 同样保存当前 Run 主模型，不再插入一次冻结 A 重试。
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'primary', 'primary-model', 'manager')).ok, true)
    let row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    const worker = await h.toWorker()
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'primary')
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.dispatch!.sessionId, worker.sessionId, '切备保留 durable Session')
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'backup')

    h.reopen()
    row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    const blockedAt = h.spawns.length
    await h.engine.handleTurnEnded('ws', await h.caller(), FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.equal(h.spawns.length, blockedAt, 'B 失败不自动回 A/C，也不追加派发')

    // 非法路由 / 非 Manager 设置不部分修改配置、预算或历史。
    const beforeInvalid = structuredClone(row)
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', '', '', 'manager')).ok, false)
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'manual', 'manual-model', 'not-manager')).ok, false)
    assert.deepEqual(await h.row(), beforeInvalid)

    // C=B 也开新轮；当前主备相同，不凭空回原冻结 A 或重复派 B。
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'backup', 'backup-model', 'manager')).ok, true)
    row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    assert.equal(row.run.roleModelConfigs?.worker.revision, 2)
    assert.equal((await h.engine.handleResume('ws', row.execution.nodeToken, '换回备用模型再试', 'manager', 'actor')).ok, true)
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'backup')
    const blockedAgain = h.spawns.length
    await h.engine.handleTurnEnded('ws', await h.caller(), FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.equal(h.spawns.length, blockedAgain)
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
  } finally { h.close() }
})

test('#237 Actor 人工 C 成功后跨节点继续用 C，之后合格故障才切 B（#287）', async () => {
  const h = harness(CHAIN_CONFIG)
  try {
    await h.start()
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'manual', 'manual-model', 'manager')).ok, true)
    await h.toWorker()
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'manual', 'C 生效')

    // C 正常 → 节点推进到 work2 仍用 C（不因一次成功回 A，也不结束人工轮）。
    await acceptNode(h)
    let row = await h.row()
    assert.equal(row.execution.nodeId, 'work2')
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'manual', '跨节点保持 C')
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    assert.deepEqual(routesOf(await h.engine.status('ws', 'manager')), [{
      role: 'worker', stage: 'primary', route: 'manual/manual-model', fallback: 'backup/backup-model',
      reason: 'manager-set', autoSwitches: 0,
    }], '人工阶段在状态里可解释')

    // 重开：人工阶段与 override 来自持久化行。
    h.reopen()
    row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    assert.deepEqual(row.run.modelOverrides.worker, { provider: 'manual', modelId: 'manual-model' })

    // work2 上当前主模型 C 合格故障 → 保留的备用 B。
    await h.engine.handleTurnEnded('ws', await h.caller(), FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.execution.nodeId, 'work2')
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'backup')
  } finally { h.close() }
})

test('#237 Judge 人工换模：C→B→BLOCK，重开不刷新，B 失败不再自动重试（#287）', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'jmanual', 'jmanual-model', 'manager')).ok, true)
    let row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    assert.deepEqual(routesOf(await h.engine.status('ws', 'manager')), [{
      role: 'judge', stage: 'primary', route: 'jmanual/jmanual-model', fallback: 'jbackup/jbackup-model',
      reason: 'manager-set', autoSwitches: 0,
    }])
    const judging = await h.toChecking()
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'jmanual')
    const claimId = (await h.row()).execution.claim!.id
    await h.engine.handleTurnEnded('ws', judging, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    assert.deepEqual(row.run.roleModelConfigs?.judge.primary, { provider: 'jmanual', modelId: 'jmanual-model' })
    assert.deepEqual(row.execution.judge!.model, { provider: 'jbackup', modelId: 'jbackup-model' })
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'jbackup')
    assert.equal(row.execution.judge!.sessionId, judging.sessionId, '切备仍判同一 Session 中的同一 claim')
    assert.equal(row.execution.claim!.id, claimId)
    const staleJudge = await judgeCaller(h)

    h.reopen()
    assert.deepEqual((await h.row()).run.roleRoutes?.judge, row.run.roleRoutes?.judge)
    const spawnsBeforeBlock = h.spawns.length
    await h.engine.handleTurnEnded('ws', await judgeCaller(h), FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /judge turn ended without judge_claim \(备用模型已用尽，不再自动重试\)/)
    assert.equal(h.spawns.length, spawnsBeforeBlock)
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })

    const reset = await h.engine.handleSetRoleModel('ws', 'judge', 'jmanual', 'jmanual-model', 'manager')
    assert.equal(reset.ok, true)
    assert.equal(reset.message, 'next dispatch primary saved for judge')
    row = await h.row()
    assert.equal(row.run.roleModelConfigs?.judge.revision, 2)
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    // 每次同值保存仍开独立轮次，但保存本身不重派或解除 BLOCK。
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'jmanual', 'jmanual-model', 'manager')).ok, true)
    assert.equal((await h.row()).run.roleModelConfigs?.judge.revision, 3)
    assert.equal((await h.row()).run.status, 'blocked')
    assert.equal(h.spawns.length, spawnsBeforeBlock)
    assert.equal((await h.engine.handleResume('ws', row.execution.nodeToken, '人工换新模型后重判', 'manager', 'judge')).ok, true)
    row = await h.row()
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'jmanual', '显式 Judge resume 的新判定使用当前主模型')
    assert.deepEqual(row.execution.judge!.model, { provider: 'jmanual', modelId: 'jmanual-model' })
    const resumed = structuredClone(row.execution)
    await h.engine.handleTurnEnded('ws', staleJudge, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.deepEqual(row.execution, resumed, '旧派发迟到 Turn 不覆盖新轮次')
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
  } finally { h.close() }
})

test('#237 Judge 人工换模：C=A、C=B 仍各开独立轮次（#287）', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'jprimary', 'jprimary-model', 'manager')).ok, true)
    const judging = await h.toChecking()
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'jprimary')
    await h.engine.handleTurnEnded('ws', judging, FAILOVER_503.text, FAILOVER_503.facts)
    let row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 }, 'C=A 失败直接切 B，不重复 A')
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'jbackup')
    await h.engine.handleTurnEnded('ws', await judgeCaller(h), FAILOVER_503.text, FAILOVER_503.facts)
    assert.equal((await h.row()).run.status, 'blocked')

    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'jbackup', 'jbackup-model', 'manager')).ok, true)
    row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    assert.equal(row.run.roleModelConfigs?.judge.revision, 2)
    assert.equal((await h.engine.handleResume('ws', row.execution.nodeToken, '人工指定备用模型再判', 'manager', 'judge')).ok, true)
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'jbackup')
    const beforeFailure = h.spawns.length
    await h.engine.handleTurnEnded('ws', await judgeCaller(h), FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'blocked', '主备同路由时不自动回冻结 A 或再次派 B')
    assert.equal(h.spawns.length, beforeFailure)
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
  } finally { h.close() }
})

test('#237 人工轮中不合格故障不换模：额度耗尽 BLOCK，恢复后仍在人工 C 阶段', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'jmanual', 'jmanual-model', 'manager')).ok, true)
    await h.engine.handleTurnEnded('ws', await h.toChecking(), QUOTA_402.text, QUOTA_402.facts)
    let row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /code=QUOTA status=402/)
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 }, '不合格故障不推进阶段、不消耗预算')
    assert.equal(row.execution.judgeAutoRetried, undefined)
    assert.equal(h.messages.filter(message => message.includes('Workflow MODEL FALLBACK')).length, 0)

    // Manager 显式恢复不刷新轮次；后续合格故障才切当前备用 B。
    assert.equal((await h.engine.handleResume('ws', row.execution.nodeToken, '额度已恢复，继续判定', 'manager', 'judge')).ok, true)
    row = await h.row()
    assert.deepEqual(row.execution.judge!.model, { provider: 'jmanual', modelId: 'jmanual-model' })
    await h.engine.handleTurnEnded('ws', await judgeCaller(h), FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
  } finally { h.close() }
})

test('#237 Judge 人工 C 成功后跨节点继续用 C（判定成功不结束人工轮）', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'jmanual', 'jmanual-model', 'manager')).ok, true)
    const planSpawnsBefore = h.spawns.length
    const planJudge = await h.toChecking()
    assert.equal(judgeSpawns(h.spawns, planSpawnsBefore)[0]!.agentOptions?.provider, 'jmanual')
    const planRow = await h.row()
    planRow.execution.judge!.settled = true
    await h.store.updateRow('ws', planRow.run, planRow.stateVersion, [{ execution: planRow.execution, expectedRevision: planRow.execution.revision, events: [] }])
    assert.equal((await h.engine.handleJudgeClaim('ws', planRow.execution.nodeToken, 'ACCEPT', 'verified', planJudge)).ok, true)
    await h.engine.drive('ws')
    assert.equal((await h.row()).execution.nodeId, 'work')

    // work 节点再次判定：仍用 C，人工阶段保持。
    const workSpawnsBefore = h.spawns.length
    await h.toChecking()
    assert.equal(judgeSpawns(h.spawns, workSpawnsBefore)[0]!.agentOptions?.provider, 'jmanual', '跨节点保持 C')
    const workRow = await h.row()
    assert.deepEqual(workRow.run.roleRoutes?.judge, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    assert.deepEqual(workRow.execution.judge!.model, { provider: 'jmanual', modelId: 'jmanual-model' })
  } finally { h.close() }
})

test('#237 再次人工设置（即使值相同）重置轮次：旧 B 失败先派 C，不扣新预算（#287）', async () => {
  const h = harness()
  try {
    await h.start()
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'manual', 'manual-model', 'manager')).ok, true)
    await h.toWorker()
    await h.engine.handleTurnEnded('ws', await h.caller(), FAILOVER_503.text, FAILOVER_503.facts)
    let row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    const oldBackup = await h.caller()
    const oldDispatch = structuredClone(row.execution.dispatch)
    const beforeSave = h.spawns.length
    // 活动派发可保存同值主模型；旧登记事实不变，保存不隐式重派。
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'manual', 'manual-model', 'manager')).ok, true)
    row = await h.row()
    assert.equal(row.run.roleModelConfigs?.worker.revision, 2)
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    assert.deepEqual(row.execution.dispatch, oldDispatch)
    assert.equal(h.spawns.length, beforeSave)
    await h.engine.handleTurnEnded('ws', oldBackup, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.execution.dispatch!.sessionId, oldBackup.sessionId)
    assert.equal(row.execution.dispatch!.model?.provider, 'manual')
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'manual')
    assert.equal(row.run.roleRoutes?.worker.autoSwitches, 0, '旧 B 失败不消耗新 C 的备用机会')
    await h.engine.handleTurnEnded('ws', await h.caller(), FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'backup')
    await h.engine.handleTurnEnded('ws', await h.caller(), FAILOVER_503.text, FAILOVER_503.facts)
    assert.equal((await h.row()).run.status, 'blocked')
  } finally { h.close() }
})

test('#237 Judge 备用阶段的 BLOCK 文案按故障成因区分：额度耗尽不报“备用模型已用尽”', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    // 先走到 B（A 的合格故障直接切 B），再让 B 遇到不合格故障（额度耗尽）。
    await h.engine.handleTurnEnded('ws', await h.toChecking(), FAILOVER_503.text, FAILOVER_503.facts)
    let row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    await h.engine.handleTurnEnded('ws', await judgeCaller(h), QUOTA_402.text, QUOTA_402.facts)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /judge turn ended without judge_claim(?!.*备用模型已用尽)/)
    assert.match(row.execution.blockReason!, /code=QUOTA status=402/)
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 }, '不合格故障不消耗预算')
    assert.equal(h.messages.filter(message => message.includes('Workflow MODEL FALLBACK')).length, 1)
  } finally { h.close() }
})

test('#237 备用路由进入启动前静态校验行：Judge 备用同样被误配阻断（#236 review A4）', () => {
  const config = judgeConfig()
  assert.deepEqual(collectRoleRoutes(config).map(route => route.role), ['worker', 'judge', 'judge（备用模型）'])
  const missing = checkCatalogProviders('role-model-fallback', config, ['primary', 'jprimary'])
  assert.equal(missing.ok, false)
  const backup = missing.rows.find(row => row.role === 'judge（备用模型）')!
  assert.equal(backup.ok, false)
  assert.match(backup.reason, /jbackup.*未在当前 profile 注册/)
  const accepted = checkCatalogProviders('role-model-fallback', config, ['primary', 'jprimary', 'jbackup'])
  assert.equal(accepted.ok, true)
})

test('#236 GUI：Judge 面板独立提供主/备用模型两分区与恢复语义披露', () => {
  const bundle = bundleSources().panel
  // Judge 区自带备用控件（与 Role 区同一套 ModelFields，前缀隔离不串主模型）。
  assert.match(bundle, /function JudgeSection\(props\)/)
  assert.match(bundle, /onFallbackModel: applyJudgeFallbackModel/)
  assert.match(bundle, /onClearFallbackModel: clearJudgeFallbackModel/)
  assert.match(bundle, /仅用于 Judge 判定遇到明确瞬时故障/)
  assert.match(bundle, /不再先用主模型重试一次/)
  assert.match(bundle, /清除后 Judge 保留原有行为：瞬时失败同模型重试一次/)
  assert.match(bundle, /fallbackProvider: judge\.fallbackModel\?\.provider/)
  // 编辑器镜像与 server 同语义（保存/回读 effort 不丢失）。
  assert.match(bundleSources().edits, /function setJudgeFallbackModelEdit\(state, model\)/)
})

// ---- #243：人工设置在途归因（R1）与 Role/Judge 双故障独立性（S4） ----

function dualConfig(): WorkflowConfig {
  const config = judgeConfig()
  config.roles.worker!.fallbackModel = { provider: 'backup', modelId: 'backup-model' }
  return config
}

test('#243 R1 在途判定期间人工设 C：旧 A 失败归因实际 A，先派 C 不扣预算（#287）', async () => {
  const traceDir = mkdtempSync(join(tmpdir(), 'workflow-role-fallback-trace-'))
  const h = harness(judgeConfig(), traceDir)
  try {
    await h.start()
    const judging = await h.toChecking()
    const before = await h.row()
    const dispatched = structuredClone(before.execution.judge!)
    assert.deepEqual(dispatched.model, { provider: 'jprimary', modelId: 'jprimary-model' })
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'manual', 'manual-model', 'manager')).ok, true)
    const arranged = await h.row()
    assert.deepEqual(arranged.run.roleRoutes?.judge, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    assert.deepEqual(arranged.execution.judge, dispatched, '保存不重写在途模型及 configRevision')

    await h.engine.handleTurnEnded('ws', judging, FAILOVER_503.text, FAILOVER_503.facts)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'primary', reason: 'server-5xx code=SERVER status=503', autoSwitches: 0 })
    assert.deepEqual(row.run.roleModelConfigs?.judge.primary, { provider: 'manual', modelId: 'manual-model' })
    assert.deepEqual(row.execution.judge!.model, { provider: 'manual', modelId: 'manual-model' })
    assert.equal(row.execution.judge!.sessionId, judging.sessionId)
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'manual')
    const notices = h.messages.filter(message => message.includes('Workflow MODEL FALLBACK'))
    assert.equal(notices.length, 1)
    assert.match(notices[0]!, /role=judge jprimary\/jprimary-model → manual\/manual-model（primary，本轮第 0 次自动切换，原因 server-5xx code=SERVER status=503）/)
    assert.doesNotMatch(notices[0]!, /manual\/manual-model →|人工路由未实派/, '来源取登记的实际 A，不用最新 C 或中性占位')
    assert.match(h.trace(), /MODEL-FALLBACK .*role=judge from="jprimary\/jprimary-model" to="manual\/manual-model" stage=primary switch=0/)
    assert.doesNotMatch(h.trace(), /MODEL-FALLBACK .*from="manual\/manual-model"/)
  } finally { h.close(); rmSync(traceDir, { recursive: true, force: true }) }
})

test('#243 MF-1 在途判定期间人工设同模型异档位 C：from 不得写成含 effort 的 C 标签（#287）', async () => {
  const traceDir = mkdtempSync(join(tmpdir(), 'workflow-role-fallback-trace-'))
  const h = harness(judgeConfig(), traceDir)
  try {
    await h.start()
    const judging = await h.toChecking()
    const dispatched = structuredClone((await h.row()).execution.judge!)
    assert.deepEqual(dispatched.model, { provider: 'jprimary', modelId: 'jprimary-model' })
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'jprimary', 'jprimary-model', 'manager', 'high')).ok, true)
    assert.deepEqual((await h.row()).execution.judge, dispatched, '保存不重写旧登记事实')
    const spawnsBefore = h.spawns.length
    await h.engine.handleTurnEnded('ws', judging, FAILOVER_503.text, FAILOVER_503.facts)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'primary', reason: 'server-5xx code=SERVER status=503', autoSwitches: 0 })
    assert.deepEqual(row.execution.judge!.model, { provider: 'jprimary', modelId: 'jprimary-model', reasoningEffort: 'high' })
    const notices = h.messages.filter(message => message.includes('Workflow MODEL FALLBACK'))
    assert.equal(notices.length, 1)
    assert.match(notices[0]!, /role=judge jprimary\/jprimary-model → jprimary\/jprimary-model\/high（primary，本轮第 0 次自动切换/)
    assert.doesNotMatch(notices[0]!, /jprimary\/jprimary-model\/high →/, '旧失败来源不继承最新 effort')
    assert.match(h.trace(), /MODEL-FALLBACK .*role=judge from="jprimary\/jprimary-model" to="jprimary\/jprimary-model\/high" stage=primary switch=0/)
    assert.doesNotMatch(h.trace(), /MODEL-FALLBACK .*from="jprimary\/jprimary-model\/high"/)
    const respawn = judgeSpawns(h.spawns, spawnsBefore)
    assert.equal(respawn.length, 1)
    assert.equal(respawn[0]!.agentOptions?.provider, 'jprimary')
    assert.equal(respawn[0]!.agentOptions?.model, 'jprimary-model')
    assert.equal(respawn[0]!.agentOptions?.reasoningEffort, 'high', '新登记 C 实际应用新 effort')
    assert.equal(row.execution.judge!.sessionId, judging.sessionId)
  } finally { h.close(); rmSync(traceDir, { recursive: true, force: true }) }
})

test('#243 MF-1 反向锁：C 真的实派时 from 就是带 effort 的 C 标签（收紧谓词不误判）', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    // 开新一轮前先设 C：本次判定派发在 C 上，失败发生在这条真实路由上。
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'jmanual', 'jmanual-model', 'manager', 'high')).ok, true)
    const spawnsBefore = h.spawns.length
    await h.engine.handleTurnEnded('ws', await h.toChecking(), FAILOVER_503.text, FAILOVER_503.facts)
    const row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    const notices = h.messages.filter(message => message.includes('Workflow MODEL FALLBACK'))
    assert.equal(notices.length, 1)
    assert.match(notices[0]!, /role=judge jmanual\/jmanual-model\/high → jbackup\/jbackup-model（fallback，本轮第 1 次自动切换/)
    assert.doesNotMatch(notices[0]!, /人工路由未实派/, 'C 实派时不得退化成中性标注')
    assert.equal(judgeSpawns(h.spawns, spawnsBefore).at(-1)!.agentOptions?.provider, 'jbackup')
  } finally { h.close() }
})

test('#243 MF-1 sameRouteIdentity 三元件全等：缺席键 ≠ 显式键', () => {
  assert.equal(sameRouteIdentity({ provider: 'p', modelId: 'm' }, { provider: 'p', modelId: 'm' }), true)
  assert.equal(sameRouteIdentity({ provider: 'p', modelId: 'm', reasoningEffort: 'high' }, { provider: 'p', modelId: 'm', reasoningEffort: 'high' }), true)
  assert.equal(sameRouteIdentity({ provider: 'p', modelId: 'm' }, { provider: 'p', modelId: 'm', reasoningEffort: 'high' }), false,
    '同一模型的另一档位是另一条路由')
  assert.equal(sameRouteIdentity(undefined, { provider: 'p', modelId: 'm' }), false)
})

test('#243 R1 推广：备用阶段运行中人工设 C，旧 B 失败归因 B，新 C 不扣预算（#287）', async () => {
  const h = harness(judgeConfig())
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await h.toChecking(), FAILOVER_503.text, FAILOVER_503.facts)
    let row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    const oldBackup = await judgeCaller(h)
    const dispatched = structuredClone(row.execution.judge)
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'manual', 'manual-model', 'manager')).ok, true)
    row = await h.row()
    assert.equal(row.execution.phase, 'checking')
    assert.deepEqual(row.execution.judge, dispatched)
    await h.engine.handleTurnEnded('ws', oldBackup, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'running')
    const notices = h.messages.filter(message => message.includes('Workflow MODEL FALLBACK'))
    assert.equal(notices.length, 2)
    assert.match(notices[1]!, /role=judge jbackup\/jbackup-model → manual\/manual-model（primary，本轮第 0 次自动切换/)
    assert.deepEqual(row.run.roleRoutes?.judge, { stage: 'primary', reason: 'server-5xx code=SERVER status=503', autoSwitches: 0 })
    assert.deepEqual(row.execution.judge!.model, { provider: 'manual', modelId: 'manual-model' })
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'manual')
    assert.equal(row.execution.judge!.sessionId, oldBackup.sessionId)
  } finally { h.close() }
})

test('#243 R1 Actor 在途保存 C 不替换旧派发，旧有效 claim 仍被接受（#287）', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    const before = await h.row()
    assert.equal(before.run.roleActors.worker, before.execution.dispatch!.sessionId)
    const spawnsBefore = h.spawns.length
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'manual', 'manual-model', 'manager')).ok, true)
    let row = await h.row()
    assert.deepEqual(row.execution, before.execution, '旧派发、模型和 configRevision 均不被保存改写')
    assert.deepEqual(row.run.roleActors, before.run.roleActors)
    assert.equal(h.spawns.length, spawnsBefore)
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: '旧 A 的有效提交' }, worker)).ok, true)
    const claimed = await h.row()
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.execution.phase, 'checking')
    assert.deepEqual(row.execution.claim, claimed.execution.claim, '保存及旧 Turn 故障不撤销已接受的结果')
    assert.deepEqual(row.execution.dispatch, { ...claimed.execution.dispatch, settled: true }, 'Turn 收口只更新 settled，不改原模型与配置归属')
    assert.equal(row.run.roleModelConfigs?.worker.primary.modelId, 'manual-model')
    assert.equal(row.run.roleRoutes?.worker.autoSwitches, 0)
  } finally { h.close() }
})

test('#243 S4 单 Run 内 Role 与 Judge 双故障切换相互独立（预算、路由、通知各自成链）', async () => {
  const h = harness(dualConfig())
  try {
    await h.start()
    const worker = await h.toWorker()
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'primary')

    // ① 角色故障：worker 主模型 5xx → 切备用。
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    let row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.deepEqual(row.run.roleRoutes, { worker: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } },
      '角色切换不碰 Judge 的预算表')
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'backup')
    assert.deepEqual(resolveRoleModel(row.run, 'judge', row.run.delegationRoute), { provider: 'jprimary', modelId: 'jprimary-model' },
      '角色切备用不影响 Judge 主路由')

    // ② 角色继续在备用上提交 claim，判定派发走 Judge 自己的主模型。
    const workerCaller = await h.caller()
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'work handoff' }, workerCaller)).ok, true)
    await h.engine.handleTurnEnded('ws', workerCaller)
    row = await h.row()
    assert.equal(row.execution.phase, 'checking')
    assert.equal(judgeSpawns(h.spawns, 0).at(-1)!.agentOptions?.provider, 'jprimary')

    // ③ Judge 故障：判定主模型 5xx → 切备用；角色预算与阶段原样保留。
    await h.engine.handleTurnEnded('ws', await judgeCaller(h), FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.deepEqual(row.run.roleRoutes, {
      worker: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 },
      judge: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 },
    }, '两条预算各自消耗一次，互不借用')
    assert.deepEqual(resolveRoleModel(row.run, 'worker', row.run.delegationRoute), { provider: 'backup', modelId: 'backup-model' })
    assert.deepEqual(resolveRoleModel(row.run, 'judge', row.run.delegationRoute), { provider: 'jbackup', modelId: 'jbackup-model' })

    const notices = h.messages.filter(message => message.includes('Workflow MODEL FALLBACK'))
    assert.equal(notices.length, 2, '每条链各通知一次，不重复')
    assert.match(notices[0]!, /role=worker primary\/primary-model → backup\/backup-model（fallback，本轮第 1 次自动切换/)
    assert.match(notices[1]!, /role=judge jprimary\/jprimary-model → jbackup\/jbackup-model（fallback，本轮第 1 次自动切换/)

    // ④ 备用 Judge 判定通过：Run 正常收口，两条链的终局不被对方改写。
    const accepted = await judgeCaller(h)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', accepted)).ok, true)
    await h.engine.drive('ws')
    const done = await h.row()
    assert.equal(done.run.status, 'completed')
    assert.equal(done.execution.returned?.name, 'done')
    assert.deepEqual(done.run.roleRoutes, row.run.roleRoutes, '终局不重置任何一条预算/阶段')
  } finally { h.close() }
})

// ---- #274 R1：监控事实（每轮实际 model/source）在真实派发链路与关库重开后都可读 ----

test('#274 R1 主→备自动切换：新旧两轮 model/source 都在 execution 行，重开仍可读', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    let row = await h.row()
    assert.equal(row.execution.dispatch!.source, 'primary')
    assert.deepEqual(row.execution.dispatch!.model, { provider: 'primary', modelId: 'primary-model' })
    const primaryId = row.execution.dispatch!.id

    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.dispatch!.source, 'fallback')
    assert.deepEqual(row.execution.dispatch!.model, { provider: 'backup', modelId: 'backup-model' })
    assert.notEqual(row.execution.dispatch!.id, primaryId)
    // F-01：被覆盖的旧轮按 previousClaim 同深度留档，不丢事实。
    assert.equal(row.execution.previousDispatch?.id, primaryId)
    assert.equal(row.execution.previousDispatch?.source, 'primary')
    assert.deepEqual(row.execution.previousDispatch?.model, { provider: 'primary', modelId: 'primary-model' })
    assert.ok(row.execution.previousDispatch?.messageId, '旧轮真实派发过（有 messageId）才留档')

    const fallbackId = row.execution.dispatch!.id
    h.reopen()
    row = await h.row()
    assert.equal(row.execution.dispatch!.id, fallbackId)
    assert.equal(row.execution.dispatch!.source, 'fallback')
    assert.deepEqual(row.execution.dispatch!.model, { provider: 'backup', modelId: 'backup-model' })
    assert.equal(row.execution.previousDispatch?.id, primaryId)
    assert.equal(row.execution.previousDispatch?.source, 'primary')
  } finally { h.close() }
})

test('#274 R1 BLOCK 中人工换模：未实派设置不改写已记录轮次，resume 重派按当前 primary 且旧轮留档（#287）', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    const onBackup = await h.caller()
    await h.engine.handleTurnEnded('ws', onBackup, FAILOVER_503.text, FAILOVER_503.facts)
    let row = await h.row()
    assert.equal(row.run.status, 'blocked')
    const recorded = row.execution.dispatch!.id
    assert.equal(row.execution.dispatch!.source, 'fallback')

    // 安排（尚未实派）C：只写 Run 配置，不改写已记录的那一轮。
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'manual-co', 'manual-model', 'manager')).ok, true)
    row = await h.row()
    assert.equal(row.execution.dispatch!.id, recorded)
    assert.equal(row.execution.dispatch!.source, 'fallback')
    assert.equal(row.execution.dispatch!.configRevision, 0, '保存新配置不改写已登记轮次归属')
    assert.deepEqual(row.execution.dispatch!.model, { provider: 'backup', modelId: 'backup-model' })

    // resume 后新一轮实派 C：来源 primary；被覆盖的备用轮留档。
    const token = row.execution.nodeToken
    assert.equal((await h.engine.handleResume('ws', token, '换更强模型重试', 'manager', 'actor')).ok, true)
    row = await h.row()
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.dispatch!.source, 'primary')
    assert.deepEqual(row.execution.dispatch!.model, { provider: 'manual-co', modelId: 'manual-model' })
    assert.equal(row.execution.dispatch!.configRevision, 1)
    assert.equal(h.spawns.at(-1)!.agentOptions?.provider, 'manual-co')
    assert.equal(row.execution.previousDispatch?.id, recorded)
    assert.equal(row.execution.previousDispatch?.source, 'fallback')
    assert.equal(row.execution.previousDispatch?.configRevision, 0)
  } finally { h.close() }
})

test('#274 R1 Manager 退回后重派：previousDispatch 正是被退回 claim 引用的那一轮', async () => {
  const h = harness()
  try {
    await h.start()
    await h.toWorker()
    const worker = await h.caller()
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'work handoff' }, worker)).ok, true)
    await h.engine.handleTurnEnded('ws', worker)
    let claimed = await h.row()
    assert.equal(claimed.execution.phase, 'checking')
    const judge = { sessionId: claimed.execution.judge!.sessionId!, turnUserMessageIds: new Set([claimed.execution.judge!.messageId!]) }
    const returnedDispatchId = claimed.execution.claim!.dispatchId
    assert.equal((await h.engine.handleJudgeClaim('ws', claimed.execution.nodeToken, 'NEED_CONTEXT', '需要补充材料', judge)).ok, true)

    // Manager 退回到同一 Actor 重新提交（actor resume）：被退回的 claim 与它引用的派发都要留档。
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '补充材料后重新提交', 'manager', 'actor')).ok, true)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.previousClaim?.id, claimed.execution.claim!.id, '被退回的 claim 留档')
    assert.equal(row.execution.previousDispatch?.id, returnedDispatchId, '被退回 claim 引用的旧派发不悬空')
    assert.equal(row.execution.previousDispatch?.source, 'primary')
    assert.deepEqual(row.execution.previousDispatch?.model, { provider: 'primary', modelId: 'primary-model' })
    assert.ok(row.execution.dispatch, '新派发已安排')
    assert.notEqual(row.execution.dispatch!.id, returnedDispatchId)
  } finally { h.close() }
})

test('#274 R1 C=A 的人工设置按当前 primary 记录来源与独立配置修订（#287）', async () => {
  const h = harness()
  try {
    await h.start()
    // 与 worker 主模型同值：仍保存独立配置修订，实派来源是当前 primary。
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'primary', 'primary-model', 'manager')).ok, true)
    await h.toWorker()
    const row = await h.row()
    assert.equal(row.execution.dispatch!.source, 'primary')
    assert.deepEqual(row.execution.dispatch!.model, { provider: 'primary', modelId: 'primary-model' })
    assert.equal(row.execution.dispatch!.configRevision, 1)
    assert.equal(row.run.roleModelConfigs?.worker.revision, 1)
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'primary', reason: 'manager-set', autoSwitches: 0 })
  } finally { h.close() }
})
