/**
 * Issue #287：设模只影响之后新登记的 Judge 派发。
 *
 * NEED_CONTEXT 后 resume 沿用同一 Session，经 Host 输入应用新模型；
 * 换模不额外 fresh，已登记派发和前序判定材料保持原样。
 *
 * 真实 Engine + 临时 SQLite + 受控 Host（与 runtime-work-order.test.ts 的
 * recoveryHarness 同 seam，本文件只取 NEED_CONTEXT→resume 所需最小面）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { routeToAgentOptions, type SpawnAgentOptions } from '../src/types.ts'

const CONFIG = {
  schemaVersion: 'agent-workflow/v3' as const, roles: { worker: { persona: 'Worker' } }, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', returns: ['done'], nodes: { plan: {
    execution: { type: 'actor-task' as const, role: 'manager', instruction: 'Plan' },
    checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } },
    results: { succeeded: { criteria: 'The plan is complete.', target: { return: 'done' } } },
  } } },
}

function harness(config: typeof CONFIG = CONFIG) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-judge-model-'))
  const store = new StateStore(home)
  const messages: Array<{ sessionId: string; messageId: string; text: string }> = []
  const judgeStarts: string[] = []
  const judgeFollowups: string[] = []
  const drains: string[] = []
  // 记录 Engine 已冻结的 Host 输入，不从可变 Run 重算请求路由。
  const judgeAgentOptions: Array<SpawnAgentOptions | undefined> = []
  const send = (sessionId: string, _text: string) => {
    const messageId = `judge-model-message-${messages.length + 1}`
    messages.push({ sessionId, messageId, text: 'Judge' })
    return { messageId }
  }
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { return send('manager', text) },
    async sendRoleActor(run, role, text) { return send(run.roleActors[role]!, text) },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, _role, text) { return { childId: 'worker-session', ...send('worker-session', text) } },
    async startJudge(_run, input) {
      judgeStarts.push(input.judgeSessionId)
      judgeAgentOptions.push(routeToAgentOptions(input.model))
      return { judgeSessionId: input.judgeSessionId, ...send(input.judgeSessionId, 'Judge') }
    },
    async followupJudge(_run, judgeSessionId, input) {
      judgeFollowups.push(judgeSessionId)
      judgeAgentOptions.push(routeToAgentOptions(input.model))
      return send(judgeSessionId, input.claim.handoff)
    },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async retireJudge() {},
    async drainJudge(_run, judgeSessionId) { drains.push(judgeSessionId) },
    async drainRoleActor() {},
    async compactRoleActor() { return { ok: true } },
    async safeToInspect() { return 'safe' as const },
  }, { async run() { throw new Error('no programs') } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  engine.actorActivity = async () => 'unknown'
  const caller = (dispatch: { sessionId?: string; messageId?: string }) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  return {
    home, judgeStarts, judgeFollowups, drains, judgeAgentOptions, caller,
    get engine() { return engine },
    get store() { return store },
    async row() { return (await store.get('ws'))! },
    async start() { return engine.startRun('ws', engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, 'root request') },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

/** 走到 NEED_CONTEXT BLOCK：claim → turn-end（spawn Judge）→ Judge NEED_CONTEXT。 */
async function blockNeedContext(h: ReturnType<typeof harness>, expectedJudgeModel?: Record<string, string>) {
  await h.start()
  const actor = h.caller((await h.row()).execution.dispatch!)
  assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'claim awaiting context' }, actor)).ok, true)
  await h.engine.handleTurnEnded('ws', actor)
  const checking = await h.row()
  assert.equal(checking.execution.phase, 'checking')
  const oldJudge = structuredClone(checking.execution.judge)!
  // 已登记 Judge 派发记录冻结路由（无 override 时即 def 或 Run 冻结值）。
  assert.deepEqual(oldJudge.model, expectedJudgeModel ?? (await h.row()).run.delegationRoute ?? {})
  assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'NEED_CONTEXT', '旧模型额度耗尽，需要Manager处理', h.caller(oldJudge))).ok, true)
  assert.equal((await h.row()).run.status, 'blocked')
  return oldJudge
}

test('#287：Judge 换模后 resume 在同一 Session followup，已登记派发不变', async () => {
  const h = harness()
  try {
    const oldJudge = await blockNeedContext(h)
    const blocked = await h.row()
    const oldOptions = structuredClone(h.judgeAgentOptions[0])
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'new-provider', 'new-model', 'manager')).ok, true)
    const saved = await h.row()
    assert.equal(saved.run.status, 'blocked', '保存不自动解除 BLOCK')
    assert.deepEqual(saved.execution, blocked.execution, '保存不改写已登记 Judge、claim 或历史反馈')
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '已换新模型，重判。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.status, 'running')
    assert.equal(resumed.execution.resolution?.judgeMode, 'followup')
    assert.equal(resumed.execution.judge?.sessionId, oldJudge.sessionId)
    assert.deepEqual(resumed.execution.judge?.model, { provider: 'new-provider', modelId: 'new-model' })
    assert.equal(resumed.execution.judge?.configRevision, saved.run.roleModelConfigs?.judge?.revision)
    assert.deepEqual(h.drains, [], '模型变化不释放原会话')
    assert.deepEqual(h.judgeFollowups, [oldJudge.sessionId])
    assert.equal(h.judgeStarts.length, 1)
    assert.deepEqual(h.judgeAgentOptions[0], oldOptions, '旧请求模型不变')
    assert.deepEqual(h.judgeAgentOptions[1], { provider: 'new-provider', model: 'new-model', reasoningEffort: undefined })
    assert.equal(resumed.execution.claim?.handoff, 'claim awaiting context')
    assert.equal(resumed.execution.previousJudge?.sessionId, oldJudge.sessionId)
    assert.equal(resumed.execution.judgment?.reason, '旧模型额度耗尽，需要Manager处理')
    assert.equal((await h.engine.handleJudgeClaim('ws', resumed.execution.nodeToken, 'ACCEPT', '旧派发不得提交', h.caller(oldJudge))).ok, false)
    assert.equal((await h.engine.handleJudgeClaim('ws', resumed.execution.nodeToken, 'ACCEPT', '新模型核验通过', h.caller(resumed.execution.judge!))).ok, true)
    assert.equal((await h.row()).run.status, 'completed')
  } finally { h.close() }
})

test('#22 对照：无模型变更时 resume 仍 followup 复用原 Judge 会话', async () => {
  const h = harness()
  try {
    const oldJudge = await blockNeedContext(h)
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '补充事实已核实，续接原Judge。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.execution.resolution?.judgeMode, 'followup')
    assert.equal(resumed.execution.judge?.sessionId, oldJudge.sessionId)
    assert.equal(h.judgeFollowups.length, 1)
    assert.equal(h.judgeStarts.length, 1)
    assert.deepEqual(h.drains, [], 'followup 不释放原会话')
  } finally { h.close() }
})

test('#287：Judge 省略档位后同 Session followup 清除 high；同值 set 也递增配置版本', async () => {
  const provider = 'j-provider'
  const modelId = 'j-model'
  const config = structuredClone(CONFIG)
  config.judgeRole.model = { provider, modelId, reasoningEffort: 'high' }
  const h = harness(config)
  try {
    const oldJudge = await blockNeedContext(h, { provider, modelId, reasoningEffort: 'high' })
    // set 同 P/M：override 整体替换为干净路由（无 effort 键），不删键、不合并旧档位。
    const set = await h.engine.handleSetRoleModel('ws', 'judge', provider, modelId, 'manager')
    assert.equal(set.ok, true)
    assert.deepEqual((await h.row()).run.modelOverrides.judge, { provider, modelId })
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '已清空档位，重判。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.status, 'running')
    assert.equal(resumed.execution.resolution?.judgeMode, 'followup')
    assert.equal(resumed.execution.judge?.sessionId, oldJudge.sessionId)
    assert.deepEqual(resumed.execution.judge?.model, { provider, modelId })
    assert.deepEqual(h.drains, [])
    assert.deepEqual(h.judgeFollowups, [oldJudge.sessionId])
    assert.equal(h.judgeStarts.length, 1)
    assert.equal(h.judgeAgentOptions[0]?.reasoningEffort, 'high', '旧派发档位保持不变')
    const redispatched = h.judgeAgentOptions[h.judgeAgentOptions.length - 1]!
    assert.equal('reasoningEffort' in redispatched!, true, 'Judge followup 派发带显式清除键')
    assert.equal(redispatched!.reasoningEffort, undefined)
    // 同值设置也建立新配置归属，但不能改写已经登记的派发。
    const again = await h.engine.handleSetRoleModel('ws', 'judge', provider, modelId, 'manager')
    assert.equal(again.ok, true)
    assert.equal(again.message, 'next dispatch primary saved for judge')
    const saved = await h.row()
    assert.equal(saved.run.roleModelConfigs!.judge!.revision, resumed.run.roleModelConfigs!.judge!.revision + 1)
    assert.deepEqual(saved.execution, resumed.execution)
  } finally { h.close() }
})
