/**
 * Issue #172：`workflow_set_role_model` 可选 reasoningEffort。
 *
 * 最小回归（真实 Engine + 临时 SQLite + 受控 Host，沿用 model-route-freeze seam）：
 * 显式档位落 override 库并随恢复保留、后续派发携带；省略回默认且不继承
 * Manager；同值主动设置也递增配置版本，active Role 保留会话；非法档位 fail-closed 且不留
 * 部分状态；Judge 对称；工具面透传。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { WorkflowEngine, type SubagentHost } from '../src/engine/engine.ts'
import { makeStateHost, managerRouteOf, type HostAdapters } from '../src/plugin/host.ts'
import { testParticipants } from './helpers/participants.ts'
import { makeWorkflowTools, type ToolHost } from '../src/tools/tools.ts'
import { routeToAgentOptions, type DelegationRoute, type RunState, type SpawnAgentOptions, type WorkflowConfig } from '../src/types.ts'
import { StateStore } from '../src/state/store.ts'

const CONFIG: WorkflowConfig = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles:
  worker:
    persona: Worker persona.
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
        succeeded: { criteria: The plan is complete., target: { node: work } }
    work:
      execution: { type: actor-task, role: worker, instruction: Work. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: The work is complete., target: { return: done } }
`), { workflowId: 'set-role-model-effort' })

function managerAgent(sessionId: string, provider: string, model: string): Agent {
  return {
    id: sessionId,
    options: { provider, model },
    session: { id: sessionId, header: {}, requestHeader: () => undefined, snapshotEvents: () => [] },
  } as unknown as Agent
}

/** 与 Manager 同路由且带显式档位的父会话。 */
function effortfulManager(sessionId: string): Agent {
  return {
    id: sessionId,
    options: { provider: 'provider-a', model: 'model-a' },
    session: {
      id: sessionId, header: {},
      requestHeader: () => ({ config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } }),
      snapshotEvents: () => [],
    },
  } as unknown as Agent
}

interface Spawn {
  label: string
  agentOptions: SpawnAgentOptions | undefined
}

function recordingHost(spawns: Spawn[]): SubagentHost & { observeTurnEnd(sessionId: string): void } {
  let serial = 0
  return {
    async ensureRoleActor(_run: RunState, roleKey: string, _initialText: string, model?: DelegationRoute) {
      spawns.push({ label: `role:${roleKey}`, agentOptions: routeToAgentOptions(model) })
      return { childId: `child-${++serial}`, messageId: `message-${serial}` }
    },
    async startJudge(_run: RunState, input: { judgeSessionId: string; model?: DelegationRoute }) {
      spawns.push({ label: 'judge', agentOptions: routeToAgentOptions(input.model) })
      return { judgeSessionId: input.judgeSessionId, messageId: `message-${++serial}` }
    },
    observeTurnEnd() {},
    async followupJudge(_run, _judgeSessionId, input) {
      spawns.push({ label: 'judge', agentOptions: routeToAgentOptions(input.model) })
      return { messageId: `message-${++serial}` }
    },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async retireJudge() {}, async drainJudge() {},
    async drainRoleActor() {}, async compactRoleActor() { return { ok: true } },
    async safeToInspect() { return 'safe' as const },
  }
}

function engineFor(store: StateStore, managers: Map<string, Agent>, spawns: Spawn[]): WorkflowEngine {
  const engine = new WorkflowEngine({
    async steerManager() { return { messageId: 'manager-message' } },
    async sendRoleActor(_run, roleKey, _text, model) {
      spawns.push({ label: `role:${roleKey}`, agentOptions: routeToAgentOptions(model) })
      return { messageId: `role-message-${spawns.length}` }
    },
    managerSessionSeq() { return 0 },
  }, recordingHost(spawns), { async run() { throw new Error('no programs') } }, makeStateHost(store))
  engine.cwdResolver = async () => 'cwd'
  engine.managerRoute = async managerSessionId => managerRouteOf(managers.get(managerSessionId))
  return engine
}

/** 宿主请求 options 位：插件交界输出直喂宿主正式决议函数。 */
function asHostRequested(options: SpawnAgentOptions | undefined): Parameters<typeof resolveChildAgentOptions>[1] {
  return options as unknown as Parameters<typeof resolveChildAgentOptions>[1]
}

async function advance(engine: WorkflowEngine, store: StateStore, ws: string): Promise<void> {
  const row = (await store.get(ws))!
  const caller = { sessionId: row.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: `${ws} artifact` }, caller)).ok, true)
  await engine.handleTurnEnded(ws, caller)
  const checking = (await store.get(ws))!
  assert.equal(checking.execution.phase, 'checking')
  const judge = { sessionId: checking.execution.judge!.sessionId!, turnUserMessageIds: new Set([checking.execution.judge!.messageId!]) }
  checking.execution.judge!.settled = true
  await store.updateRow(ws, checking.run, checking.stateVersion, [{ execution: checking.execution, expectedRevision: checking.execution.revision, events: [] }])
  assert.equal((await engine.handleJudgeClaim(ws, checking.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
  await engine.drive(ws)
}

test('#172: 显式档位随 override 落库、关库重开不丢、后续派发携带', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-set-effort-'))
  const managers = new Map<string, Agent>([['manager-high', effortfulManager('manager-high')]])
  const parent = managers.get('manager-high')!
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    assert.equal((await engine.startRun('ws', engine.buildInitialRun('manager-high', 'set-role-model-effort', CONFIG, 'hash'), undefined, 'root request')).ok, true)
    const set = await engine.handleSetRoleModel('ws', 'worker', 'provider-c', 'model-c', 'manager-high', 'low')
    assert.equal(set.ok, true)
    assert.deepEqual((await store.get('ws'))!.run.modelOverrides.worker,
      { provider: 'provider-c', modelId: 'model-c', reasoningEffort: 'low' })
  } finally { store.close() }
  // 关库重开：显式档位随 override 保留。
  const reopened = new StateStore(home)
  const engine2 = engineFor(reopened, managers, spawns)
  try {
    assert.deepEqual((await reopened.get('ws'))!.run.modelOverrides.worker,
      { provider: 'provider-c', modelId: 'model-c', reasoningEffort: 'low' })
    await advance(engine2, reopened, 'ws')
    const redispatched = spawns[spawns.length - 1]!
    assert.equal(redispatched.label, 'role:worker')
    assert.deepEqual(redispatched.agentOptions,
      { provider: 'provider-c', model: 'model-c', reasoningEffort: 'low' })
    assert.equal(resolveChildAgentOptions(parent, asHostRequested(redispatched.agentOptions), 1).reasoningEffort, 'low',
      '后续新建会话实际使用显式档位')
  } finally { reopened.close(); rmSync(home, { recursive: true, force: true }) }
})

test('#172: 显式档位后省略同路由：清空回默认，不继承 Manager', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-set-effort-omit-'))
  const managers = new Map<string, Agent>([['manager-high', effortfulManager('manager-high')]])
  const parent = managers.get('manager-high')!
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    assert.equal((await engine.startRun('ws', engine.buildInitialRun('manager-high', 'set-role-model-effort', CONFIG, 'hash'), undefined, 'root request')).ok, true)
    assert.equal((await engine.handleSetRoleModel('ws', 'worker', 'provider-a', 'model-a', 'manager-high', 'low')).ok, true)
    const cleared = await engine.handleSetRoleModel('ws', 'worker', 'provider-a', 'model-a', 'manager-high')
    assert.equal(cleared.ok, true)
    assert.equal(cleared.message, 'next dispatch primary saved for worker', '显式→省略必须保存并清空档位')
    const run = (await store.get('ws'))!.run
    assert.deepEqual(run.modelOverrides.worker, { provider: 'provider-a', modelId: 'model-a' })
    await advance(engine, store, 'ws')
    const requested = spawns[spawns.length - 1]!.agentOptions
    assert.deepEqual(requested, { provider: 'provider-a', model: 'model-a', reasoningEffort: undefined })
    assert.equal('reasoningEffort' in requested!, true, '派发带显式清除键')
    assert.equal(resolveChildAgentOptions(parent, asHostRequested(requested), 1).reasoningEffort, undefined,
      '与 Manager 同路由也不重新继承 high：回落模型默认')
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('#287: 同路由换档位和三元件相同的主动 set 均保存新配置版本', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-set-effort-same-'))
  const managers = new Map<string, Agent>([['manager', managerAgent('manager', 'p0', 'm0')]])
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    assert.equal((await engine.startRun('ws', engine.buildInitialRun('manager', 'set-role-model-effort', CONFIG, 'hash'), undefined, 'root request')).ok, true)
    assert.equal((await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager', 'high')).ok, true)
    const initial = (await store.get('ws'))!
    const moved = await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager', 'low')
    assert.equal(moved.ok, true)
    assert.equal(moved.message, 'next dispatch primary saved for worker')
    const low = (await store.get('ws'))!
    assert.deepEqual(low.run.modelOverrides.worker, { provider: 'p', modelId: 'm', reasoningEffort: 'low' })
    assert.equal(low.run.roleModelConfigs!.worker!.revision, initial.run.roleModelConfigs!.worker!.revision + 1)
    const again = await engine.handleSetRoleModel('ws', 'worker', ' p ', ' m ', 'manager', ' low ')
    assert.equal(again.ok, true)
    assert.equal(again.message, 'next dispatch primary saved for worker')
    const saved = (await store.get('ws'))!
    assert.deepEqual(saved.run.modelOverrides.worker, { provider: 'p', modelId: 'm', reasoningEffort: 'low' })
    assert.equal(saved.run.roleModelConfigs!.worker!.revision, low.run.roleModelConfigs!.worker!.revision + 1)
    assert.deepEqual(saved.execution, initial.execution, '连续保存不改写已登记派发')
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('#172: 非法档位 fail-closed，不留部分 override', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-set-effort-bad-'))
  const managers = new Map<string, Agent>([['manager', managerAgent('manager', 'p0', 'm0')]])
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    assert.equal((await engine.startRun('ws', engine.buildInitialRun('manager', 'set-role-model-effort', CONFIG, 'hash'), undefined, 'root request')).ok, true)
    for (const bad of ['', '   ', 'e'.repeat(65)]) {
      const rejected = await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager', bad)
      assert.equal(rejected.ok, false, `档位 ${JSON.stringify(bad)} 应拒绝`)
      assert.match(rejected.reason!, /reasoningEffort/)
    }
    assert.equal((await store.get('ws'))!.run.modelOverrides.worker, undefined, '失败不得留下部分 override')
    const nonString = await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager', 42 as unknown as string)
    assert.equal(nonString.ok, false)
    assert.equal((await store.get('ws'))!.run.modelOverrides.worker, undefined)
    // 状态机完好：合法 set 仍可成功。
    assert.equal((await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager', 'low')).ok, true)
    assert.deepEqual((await store.get('ws'))!.run.modelOverrides.worker, { provider: 'p', modelId: 'm', reasoningEffort: 'low' })
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('#287: Judge 显式档位对称；active Role 保存保留映射，下一次同 Session 派发生效', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-set-effort-judge-'))
  const managers = new Map<string, Agent>([['manager-high', effortfulManager('manager-high')]])
  const parent = managers.get('manager-high')!
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    assert.equal((await engine.startRun('ws', engine.buildInitialRun('manager-high', 'set-role-model-effort', CONFIG, 'hash'), undefined, 'root request')).ok, true)
    assert.equal((await engine.handleSetRoleModel('ws', 'judge', 'jp', 'jm', 'manager-high', 'high')).ok, true)
    const run = (await store.get('ws'))!.run
    assert.deepEqual(run.modelOverrides.judge, { provider: 'jp', modelId: 'jm', reasoningEffort: 'high' })
    await advance(engine, store, 'ws')
    const judgeRequest = spawns.find(spawn => spawn.label === 'judge')!.agentOptions
    assert.deepEqual(judgeRequest, { provider: 'jp', model: 'jm', reasoningEffort: 'high' })
    assert.equal(resolveChildAgentOptions(parent, asHostRequested(judgeRequest), 1).reasoningEffort, 'high')
    const work = (await store.get('ws'))!
    const sessionId = work.run.roleActors.worker!
    assert.ok(sessionId)
    const oldRequest = structuredClone(spawns[spawns.length - 1])
    const saved = await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager-high', 'low')
    assert.equal(saved.ok, true)
    const updated = (await store.get('ws'))!
    assert.deepEqual(updated.run.modelOverrides.worker, { provider: 'p', modelId: 'm', reasoningEffort: 'low' })
    assert.equal(updated.run.roleActors.worker, sessionId, '不删除 active Role 映射')
    assert.deepEqual(updated.execution, work.execution, '不改写当前派发或中断工作')
    assert.deepEqual(spawns[spawns.length - 1], oldRequest, '保存不会发送新请求或改写旧请求')
    const actor = { sessionId, turnUserMessageIds: new Set([work.execution.dispatch!.messageId!]) }
    assert.equal((await engine.handleClaim('ws', { result: 'succeeded', handoff: 'original dispatch result' }, actor)).ok, true,
      '设模不使旧派发授权失效')
    await engine.handleTurnEnded('ws', actor)
    const checking = (await store.get('ws'))!
    const judge = { sessionId: checking.execution.judge!.sessionId, turnUserMessageIds: new Set([checking.execution.judge!.messageId!]) }
    assert.equal((await engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'REJECT', '补齐实现', judge)).ok, true)
    await engine.drive('ws')
    const retried = (await store.get('ws'))!
    assert.equal(retried.execution.dispatch!.sessionId, sessionId, 'REJECT 后仍使用同一 Role Session')
    assert.equal(retried.execution.dispatch!.configRevision, updated.run.roleModelConfigs!.worker!.revision)
    assert.deepEqual(retried.execution.dispatch!.model, { provider: 'p', modelId: 'm', reasoningEffort: 'low' })
    assert.deepEqual(spawns[spawns.length - 1], { label: 'role:worker', agentOptions: { provider: 'p', model: 'm', reasoningEffort: 'low' } })
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('#172: 工具面透传可选 reasoningEffort', async () => {
  const calls: Array<{ roleKey: string; provider: string; modelId: string; reasoningEffort: string | undefined }> = []
  const host: ToolHost = {
    authorize: async () => ({ workspaceKey: 'ws-1' }),
    claim: async () => ({ ok: true }),
    block: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    runProgram: async () => ({ ok: true }),
    resolveProgram: async () => ({ ok: true }),
    setRoleModel: async (_ws, roleKey, provider, modelId, _caller, reasoningEffort) => {
      calls.push({ roleKey, provider, modelId, reasoningEffort })
      return { ok: true, message: 'set' }
    },
    status: async () => ({ ok: true, status: {} }),
    judgeClaim: async () => ({ ok: true }),
    respawnJudge: async () => ({ ok: true }),
    inspectGit: async () => ({ ok: true, value: null }),
    inspectGithub: async () => ({ ok: true, value: null }),
  }
  const tool = makeWorkflowTools(host).find(t => t.name === 'workflow_set_role_model')!
  const exec = {} as never
  await tool.execute({ roleKey: 'developer', provider: 'p', modelId: 'm', reasoningEffort: 'high' }, exec)
  await tool.execute({ roleKey: 'developer', provider: 'p', modelId: 'm' }, exec)
  assert.deepEqual(calls, [
    { roleKey: 'developer', provider: 'p', modelId: 'm', reasoningEffort: 'high' },
    { roleKey: 'developer', provider: 'p', modelId: 'm', reasoningEffort: undefined },
  ])
})
