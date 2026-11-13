import { inspectionStatus } from '../src/engine/safety.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  judgeAdmissionInWorkOrder, makeParticipantIndex, participantInWorkOrder, workOrderMayAwaitTurn,
  type WorkOrderFacts,
} from '../src/plugin/participants.ts'

/**
 * #99 参与者索引：发现/关联/重启修复/观察引用寿命的单元级证据。
 * 纯策略（工作单事实 → 参与身份/授权）与寿命（保留/释放/证据不洗白）分两组。
 */

function facts(overrides: Partial<WorkOrderFacts> = {}): WorkOrderFacts {
  return {
    runStatus: 'running', phase: 'checking', managerSessionId: 'manager', roleActors: {},
    judgeJudgedCurrentClaim: false, predecessorSettlementPending: false, ...overrides,
  }
}

function mkAgent(id: string, opts: { parent?: string; status?: string; pendingInbox?: boolean; whenIdle?: () => Promise<void> } = {}): Agent {
  return {
    id,
    status: opts.status ?? 'idle',
    session: { id, header: opts.parent === undefined ? {} : { parentSession: opts.parent } },
    inbox: { nextTurn: opts.pendingInbox === true ? [{}] : [], nextStep: [] },
    whenIdle: opts.whenIdle ?? (async () => {}),
  } as unknown as Agent
}

/** 受控装配：内存服务 + 可注入的工作单行；探针/兜底扫都被计数以便复查。 */
function harness(rows: Array<[string, WorkOrderFacts]> = []) {
  const rowMap = new Map(rows)
  const agents = new Map<string, Agent>()
  const descendants = new Map<string, unknown[]>()
  const jobs: Array<{ id?: string; status: string; owner?: string; detail?: string }> = []
  const probes: string[] = []
  const scans: string[] = []
  type SettledEvent = { type: 'settled'; job: { id?: string; status?: string; owner?: string; detail?: string }; cause: string }
  let onSettled: ((event: SettledEvent) => void) | undefined
  let dispose: (() => void) | undefined
  const index = makeParticipantIndex({
    agents: { get: id => agents.get(String(id)), list: () => [...agents.values()] },
    subagents: { listDescendants: async id => (descendants.get(String(id)) ?? []) as never },
    jobs: {
      list: () => jobs as never,
      events: { subscribe: (_filter: unknown, listener: (event: SettledEvent) => void) => { onSettled = listener; return () => { onSettled = undefined } } },
    },
    effect: factory => { dispose = factory() },
  }, {
    workspaceKeyOf: async cwd => cwd === undefined || cwd.trim() === '' ? undefined : cwd,
    facts: async ws => { probes.push(ws); return rowMap.get(ws) },
    factsBySession: async sessionId => {
      scans.push(sessionId)
      for (const [workspaceKey, rowFacts] of rowMap) {
        if (rowFacts.judgeSessionId === sessionId) return { workspaceKey, facts: rowFacts }
      }
      return undefined
    },
  })
  return {
    index, agents, rowMap, jobs, probes, scans, descendants,
    emitSettled: (job: SettledEvent['job']) => onSettled?.({ type: 'settled', cause: 'teardown', job }),
    orphan: (owner: Agent) => onSettled?.({ type: 'settled', job: { owner: String(owner.id), detail: 'cancel threw during teardown; work may be orphaned: boom' }, cause: 'teardown' }),
    settled: (cause: string, detail: string | undefined, ownerId: string | undefined) => onSettled?.({ type: 'settled', job: { owner: ownerId, detail }, cause }),
    dispose: () => dispose?.(),
  }
}

test('#99 AC5：参与身份与 Judge 授权只由当前工作单事实判定', () => {
  const row = facts({ managerSessionId: 'mgr', roleActors: { worker: 'role-a' }, judgeSessionId: 'judge-a', dispatchSessionId: 'role-a' })
  assert.deepEqual(participantInWorkOrder(row, 'mgr'), { kind: 'manager' })
  assert.deepEqual(participantInWorkOrder(row, 'role-a'), { kind: 'role', roleKey: 'worker' })
  assert.deepEqual(participantInWorkOrder(row, 'judge-a'), { kind: 'judge' })
  assert.equal(participantInWorkOrder(row, 'stranger'), undefined)

  // Judge 授权：running + checking + 尚未对本 claim 出结果，三者缺一不可。
  assert.equal(judgeAdmissionInWorkOrder(row, 'judge-a'), true)
  assert.equal(judgeAdmissionInWorkOrder(facts({ ...row, judgeJudgedCurrentClaim: true }), 'judge-a'), false)
  assert.equal(judgeAdmissionInWorkOrder(facts({ ...row, phase: 'working' }), 'judge-a'), false)
  assert.equal(judgeAdmissionInWorkOrder(facts({ ...row, runStatus: 'terminated' }), 'judge-a'), false, 'Reset/terminated 后旧 Judge 不再有权利')
  assert.equal(judgeAdmissionInWorkOrder(facts({ ...row, runStatus: 'blocked' }), 'judge-a'), false, 'BLOCK 后旧 Judge 不再有权利')
  assert.equal(judgeAdmissionInWorkOrder(row, 'role-a'), false, 'Role Actor 不是 Judge')

  // 收口归因：参与身份之外还必须覆盖 `ready` + predecessorId 那条前驱 Judge 分支。
  assert.equal(workOrderMayAwaitTurn(row, 'role-a'), true)
  assert.equal(workOrderMayAwaitTurn(row, 'stranger'), false)
  assert.equal(workOrderMayAwaitTurn(facts({ phase: 'ready', predecessorSettlementPending: true }), 'stranger'), true)
})

test('#99 AC1：1000 次无关 Session churn 只保留 id 级事实，完整 Agent 立即释放', async () => {
  const h = harness()
  for (let i = 0; i < 1000; i++) {
    const id = `unrelated-${i}`
    h.agents.set(id, mkAgent(id))
    h.index.observeTurnEnd(id)
    assert.equal(h.index.stats().exactAgents, 1, '结算窗口内只持有当代引用')
    assert.equal(h.index.stats().provisional, 1)
    assert.equal(await h.index.resolveTurn(id, `C:/ws-${i}`), `C:/ws-${i}`)
    h.agents.delete(id)
    assert.equal(h.index.stats().exactAgents, 0, '判定无关后立即释放完整 Agent 引用')
  }
  const stats = h.index.stats()
  assert.equal(stats.releaseUnrelated, 1000, '可复查计数：1000 次释放')
  assert.equal(stats.exactAgents, 0)
  assert.equal(stats.provisional, 0)
  assert.equal(stats.retainDecisions, 0)
  assert.equal(stats.realpathCalls, 1000)
  // #99 AC7：无关 churn 每个 turn/end 只探一次单行工作单，不再全表扫。
  assert.equal(stats.rowProbes, 1000)
  assert.equal(stats.scanFallbacks, 0)
})

test('#99 AC7：内存路由命中的参与者不探工作单；无关 Session 不再触发全表扫', async () => {
  const h = harness([['C:/ws', facts({ roleActors: { worker: 'role-a' } })]])
  h.agents.set('role-a', mkAgent('role-a'))
  h.index.rememberRole('role-a', 'worker', 'C:/ws')
  h.index.observeTurnEnd('role-a')
  assert.equal(await h.index.resolveTurn('role-a', 'C:/ws'), 'C:/ws')
  assert.deepEqual(h.probes, [], '派发/准入时已记录路由，结算不再读工作单')
  assert.equal(h.index.stats().realpathCalls, 0)
  assert.equal(h.index.stats().exactAgents, 1, '参与者的当代引用保留：宿主 dispose 后仍要能精确收口')
  assert.equal(h.index.stats().retainDecisions, 1)

  const other = harness([['C:/ws', facts()]])
  other.agents.set('stranger', mkAgent('stranger'))
  other.index.observeTurnEnd('stranger')
  assert.equal(await other.index.resolveTurn('stranger', 'C:/ws'), 'C:/ws')
  assert.deepEqual(other.probes, ['C:/ws'], '只探一次单行读')
  assert.equal(other.scans.length, 0, 'cwd 能解析时不再兜底全表扫')
  assert.equal(other.index.stats().releaseUnrelated, 1)
})

test('#99 M-1：探测路由（工具调用探 cwd / 父会话继承）不单独构成参与证据', async () => {
  // authorize() 的 workspace 探测与被拒调用者、父会话之子的继承路由都只是"位置"。
  const h = harness([['C:/ws', facts({ roleActors: { worker: 'role-a' } })]])
  for (let i = 0; i < 1000; i++) {
    const id = `probe-${i}`
    h.agents.set(id, mkAgent(id))
    h.index.rememberWorkspace(id, 'C:/ws', 'probe')
    h.index.observeTurnEnd(id)
    assert.equal(h.index.stats().exactAgents, 1, '结算窗口内只持有当代引用')
    assert.equal(await h.index.resolveTurn(id, undefined), 'C:/ws', '探测路由仍用来定位 workspace')
    h.agents.delete(id)
    assert.equal(h.index.stats().exactAgents, 0, '工作单不引用它 → 完整 Agent 引用立即释放')
  }
  const stats = h.index.stats()
  assert.equal(stats.releaseUnrelated, 1000, '可复查计数：1000 次释放')
  assert.equal(stats.retainDecisions, 0)
  assert.equal(stats.exactAgents, 0)
  assert.equal(stats.provisional, 0)
  assert.equal(stats.routes, 1000, '路由仍按 id 级事实保留（授权修复用）')
  assert.equal(stats.realpathCalls, 0, '探测路由定位 workspace，省掉 realpath')
  assert.equal(stats.rowProbes, 1000, '每个 turn/end 仍只探一次单行工作单')
  assert.equal(stats.scanFallbacks, 0)

  // 同一批探测路由，一旦工作单行引用它就必须升级为参与证明并保留（反向判据）。
  h.agents.set('role-a', mkAgent('role-a'))
  h.index.rememberWorkspace('role-a', 'C:/ws', 'probe')
  h.index.observeTurnEnd('role-a')
  assert.equal(await h.index.resolveTurn('role-a', undefined), 'C:/ws')
  assert.equal(h.index.stats().exactAgents, 1, '行引用它 → adopt 升级成参与证明')
  assert.equal(h.index.roleOf('role-a'), 'worker')
  assert.equal(h.index.stats().retainDecisions, 1)
  h.index.observeTurnEnd('role-a')
  await h.index.resolveTurn('role-a', undefined)
  assert.equal(h.index.stats().rowProbes, 1001, '升级后不再重复探工作单')

  // Manager 启动时记下的参与证明路由（commandHost.start 路径）同样不探工作单。
  const mgr = harness([['C:/ws', facts({ managerSessionId: 'mgr' })]])
  mgr.agents.set('mgr', mkAgent('mgr'))
  mgr.index.rememberWorkspace('mgr', 'C:/ws', 'participation')
  mgr.index.observeTurnEnd('mgr')
  assert.equal(await mgr.index.resolveTurn('mgr', undefined), 'C:/ws')
  assert.deepEqual(mgr.probes, [], '派发时记下的路由仍是参与证明')
  assert.equal(mgr.index.stats().realpathCalls, 0)
  assert.equal(mgr.index.stats().exactAgents, 1)
  // 探测写入不回退已记下的参与证明（角色注册与 subagent/start 到达顺序不保证）。
  mgr.index.rememberWorkspace('mgr', 'C:/ws', 'probe')
  mgr.index.observeTurnEnd('mgr')
  assert.equal(await mgr.index.resolveTurn('mgr', undefined), 'C:/ws')
  assert.deepEqual(mgr.probes, [], '探测写入不会抹掉参与事实')
})

test('#99 AC3：异步注册竞态与冷恢复——cwd 推导不出时按 Session 兜底找到 Judge 行', async () => {
  // 冷恢复：内存路由为空（宿主重启），Judge 的 cwd 也读不出来 → 只能按行兜底。
  const h = harness([['C:/ws', facts({ judgeSessionId: 'judge-cold' })]])
  h.agents.set('judge-cold', mkAgent('judge-cold'))
  h.index.observeTurnEnd('judge-cold')
  assert.equal(await h.index.resolveTurn('judge-cold', undefined), 'C:/ws')
  assert.deepEqual(h.scans, ['judge-cold'])
  assert.equal(h.index.judgeWorkspaceOf('judge-cold'), 'C:/ws', '重启修复把 Judge 准入一并补回')
  assert.equal(h.index.workspaceOf('judge-cold'), 'C:/ws')
  assert.equal(h.index.stats().exactAgents, 1)

  // 注册竞态：判定时行已指向该 Judge（running/checking 未判），授权即时成立；
  // 一旦本 claim 的结论落库，同一 Session 不再有权利（AC5）。
  assert.equal(judgeAdmissionInWorkOrder(h.rowMap.get('C:/ws')!, 'judge-cold'), true)
  const judged = facts({ judgeSessionId: 'judge-cold', judgeJudgedCurrentClaim: true })
  assert.equal(judgeAdmissionInWorkOrder(judged, 'judge-cold'), false)
  assert.deepEqual(participantInWorkOrder(judged, 'judge-cold'), { kind: 'judge' }, '参与身份与授权是两件事：出过结论就不再有权利，但行仍引用它')
})

test('#99 AC2：同 Session ID 的另一代 Agent 不共享证据；宿主自然 dispose 后仍能精确收口', async () => {
  const h = harness()
  const first = mkAgent('role-a')
  h.agents.set('role-a', first)
  h.index.rememberRole('role-a', 'worker', 'C:/ws')
  h.index.observeTurnEnd('role-a')
  assert.equal(inspectionStatus(await h.index.safeToInspect('role-a')), 'safe')

  // 宿主自然 dispose：registry 里没有这一代了，但精确引用仍在 → 仍能判定收口。
  h.agents.delete('role-a')
  assert.equal(inspectionStatus(await h.index.safeToInspect('role-a')), 'safe', 'recorded exact Agent survives cold release')

  // 同 id 换成另一代：不得拿旧一代的证据给新一代背书，fail-closed。
  const second = mkAgent('role-a')
  h.agents.set('role-a', second)
  assert.equal(inspectionStatus(await h.index.safeToInspect('role-a')), 'unsafe', 'a different live generation is not this generation evidence')

  // 新一代自己的 turn/end 才重新定格事实，并且此后只认这一代。
  h.index.observeTurnEnd('role-a')
  h.agents.delete('role-a')
  assert.equal(inspectionStatus(await h.index.safeToInspect('role-a')), 'safe')
})

test('#99 AC4：orphan 证据跨 descriptor/job 行消失存活，且只由插件卸载清空', async () => {
  const h = harness()
  const actor = mkAgent('actor')
  const branch = mkAgent('branch', { parent: 'actor' })
  const leaf = mkAgent('leaf', { parent: 'branch' })
  for (const agent of [actor, branch, leaf]) h.agents.set(agent.id, agent)
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'safe')

  // 后代 descriptor 消失 + middle Agent 不可观测之后，orphan 事实仍必须钉住父 Role。
  h.orphan(leaf)
  h.descendants.set('actor', [])
  h.agents.delete('branch')
  h.agents.delete('leaf')
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'unsafe', 'known ancestry survives an unavailable middle Agent')

  // job 行消失不能洗白；无关 churn 的释放也不能洗掉 tombstone。
  h.jobs.length = 0
  h.agents.set('stranger', mkAgent('stranger'))
  h.index.observeTurnEnd('stranger')
  await h.index.resolveTurn('stranger', 'C:/elsewhere')
  assert.equal(h.index.stats().releaseUnrelated, 1)
  assert.equal(h.index.stats().tombstones, 3, 'actor/branch/leaf 三代都保留 tombstone')
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'unsafe', 'removing job snapshots cannot erase orphan evidence')

  // Reset 后新 start 也不能继承旧结论：证据只在插件卸载时清空，且清空后不再给 pass。
  h.dispose()
  assert.equal(h.index.stats().exactAgents, 0)
  assert.equal(h.index.stats().tombstones, 0)
  h.agents.delete('actor')
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'unsafe', 'disposal releases retained references; nothing grants a pass afterwards')
})

test('#190 三重匹配：teardown 抛错结算进 tombstone，普通 teardown 与 producer/kill 不误判', async () => {
  const h = harness()
  const actor = mkAgent('actor')
  h.agents.set('actor', actor)
  h.index.observeTurnEnd('actor')

  // 合规 teardown 结算（cancel 未抛错，无 orphan 子串）：不起因不算，只缺子串即放行。
  h.settled('teardown', undefined, 'actor')
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'safe', 'plain teardown settlement without the orphan detail is not an orphan')

  // producer/kill 结算即使带上可疑 detail：起因不对，一律不误判。
  h.settled('producer', 'cancel threw during teardown; work may be orphaned: late flush', 'actor')
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'safe', 'producer settlement is never an orphan')
  h.settled('kill', 'cancel threw during teardown; work may be orphaned: race', 'actor')
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'safe', 'kill settlement is never an orphan')
  assert.equal(h.index.stats().tombstones, 0, '误判场景不得建 tombstone')

  // teardown 抛错结算：三重全中，进 tombstone。
  h.settled('teardown', 'cancel threw during teardown; work may be orphaned: boom', 'actor')
  assert.equal(h.index.stats().tombstones, 1)
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'unsafe', 'teardown-throw settlement enters the tombstone')
})

test('#99 AC3：后代 pending inbox / 非终态 job 仍让收口 fail-closed（判据未被寿命改造削弱）', async () => {
  const h = harness()
  const actor = mkAgent('actor')
  h.agents.set('actor', actor)
  h.index.observeTurnEnd('actor')
  h.descendants.set('actor', [
    { kind: 'child', id: 'child', parentId: 'actor', depth: 1, activity: 'running' },
  ])
  const child = mkAgent('child', { parent: 'actor', pendingInbox: true })
  h.agents.set('child', child)
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'waiting', '唯一阻碍是仍在跑的已知后代 = 等待')

  h.jobs.push({ status: 'stopping', owner: 'actor' })
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'unsafe', '未终态 job 仍是收口未知')
  h.jobs.length = 0
  h.descendants.set('actor', [
    { kind: 'diagnostic', id: 'child', parentId: 'actor', depth: 1 },
  ])
  assert.equal(inspectionStatus(await h.index.safeToInspect('actor')), 'unsafe', 'diagnostic 后代一律 fail-closed')
})

test('#99 寿命边界：探针失败不是"可释放"的证据（fail-closed 保留）', async () => {
  const agents = new Map<string, Agent>()
  const index = makeParticipantIndex({
    agents: { get: id => agents.get(String(id)), list: () => [...agents.values()] },
    subagents: { listDescendants: async () => [] },
    jobs: { list: () => [], events: { subscribe: () => () => {} } },
    effect: () => {},
  }, {
    workspaceKeyOf: async cwd => cwd,
    facts: async () => { throw new Error('store read failed') },
    factsBySession: async () => undefined,
  })
  agents.set('actor', mkAgent('actor'))
  index.observeTurnEnd('actor')
  await assert.rejects(index.resolveTurn('actor', 'C:/ws'), /store read failed/)
  assert.equal(index.stats().exactAgents, 1, '读工作单失败时保留证据，不当作无关 Session 释放')
  assert.equal(index.stats().releaseUnrelated, 0)
})
test('#294：waiting 后代不能掩盖 owner job，诊断只携带有界标识与状态', async () => {
  const h = harness()
  h.agents.set('actor', mkAgent('actor'))
  h.agents.set('child', mkAgent('child', { parent: 'actor', status: 'running' }))
  h.descendants.set('actor', [{ kind: 'child', id: 'child', parentId: 'actor', activity: 'running' }])
  h.jobs.push({ id: 'job-294', status: 'stopping', owner: 'actor', detail: 'secret=never-output https://private.invalid prompt body' })
  assert.deepEqual(await h.index.safeToInspect('actor'), {
    status: 'unsafe', diagnostic: { reasonCode: 'job_active', type: 'job', sessionId: 'actor', jobId: 'job-294', owner: 'actor', state: 'stopping' },
  })
})
test('#294：busy/inbox/diagnostic/代际/异常分别给出稳定且脱敏的原因', async () => {
  const check = async (h: ReturnType<typeof harness>, code: string) => {
    const result = await h.index.safeToInspect('actor')
    assert.equal(typeof result, 'object')
    if (typeof result === 'string') throw new Error('missing diagnostic')
    assert.equal(result.diagnostic.reasonCode, code)
    assert.equal(result.status, 'unsafe')
    assert.doesNotMatch(JSON.stringify(result), /private|never-output|prompt|body|secret=/)
  }
  const h = harness()
  await check(h, 'session_missing')
  h.agents.set('actor', mkAgent('actor', { status: 'running' }))
  await check(h, 'session_busy')
  h.agents.set('actor', mkAgent('actor', { pendingInbox: true }))
  await check(h, 'inbox_pending')
  h.agents.set('actor', mkAgent('actor'))
  h.descendants.set('actor', [{ kind: 'diagnostic', id: 'child', parentId: 'actor', reason: 'secret=never-output https://private.invalid prompt body' }])
  await check(h, 'descendant_diagnostic')
  h.descendants.clear()
  h.index.observeTurnEnd('actor')
  h.agents.set('actor', mkAgent('actor'))
  await check(h, 'generation_changed')
  h.index.observeTurnEnd('actor')
  h.jobs.push({ id: 'job-orphan', status: 'failed', owner: 'actor', detail: 'work may be orphaned: secret=never-output' })
  await check(h, 'job_orphaned')
  h.jobs.length = 0
  h.orphan(h.agents.get('actor')!)
  await check(h, 'job_orphaned')
  const bad = harness()
  bad.agents.set('actor', mkAgent('actor', { whenIdle: async () => { throw new Error('secret=never-output https://private.invalid prompt body') } }))
  await check(bad, 'probe_error')
})

test('#294：不完整或含凭据的对象标识不截断成貌似精确的 ID', async () => {
  const h = harness()
  h.agents.set('actor', mkAgent('actor'))
  for (const id of ['x'.repeat(129), 'ghp_123456789secret', 'https://private.invalid']) {
    h.jobs.splice(0, h.jobs.length, { id, owner: 'actor', status: 'running' })
    assert.deepEqual(await h.index.safeToInspect('actor'), { status: 'unsafe', diagnostic: {
      reasonCode: 'job_active', type: 'job', sessionId: 'actor', owner: 'actor', state: 'running', identityUnavailable: true,
    } })
  }
})
test('#294：首个 registry 探针抛错也不泄露异常或失去 fail-closed', async () => {
  const h = harness()
  h.agents.get = () => { throw new Error('secret=never-output https://private.invalid') }
  assert.deepEqual(await h.index.safeToInspect('actor'), { status: 'unsafe', diagnostic: { reasonCode: 'probe_error', type: 'probe', sessionId: 'actor' } })
})


test('#294 P2：真实 orphan settled 事件前后保留同一可定位 job 来源', async () => {
  const h = harness()
  h.agents.set('actor', mkAgent('actor'))
  const job = { id: 'job-orphan-294', owner: 'actor', status: 'failed', detail: 'work may be orphaned: secret=never-output' }
  h.jobs.push(job)
  const expected = { status: 'unsafe', diagnostic: { reasonCode: 'job_orphaned', type: 'job', sessionId: 'actor', jobId: job.id, owner: 'actor', state: 'failed' } }
  assert.deepEqual(await h.index.safeToInspect('actor'), expected)
  h.emitSettled(job)
  assert.deepEqual(await h.index.safeToInspect('actor'), expected)
  h.jobs.length = 0
  assert.deepEqual(await h.index.safeToInspect('actor'), expected, 'job 行移除不能洗白或丢失已确认的事件来源')
  h.agents.delete('actor')
  assert.deepEqual(await h.index.safeToInspect('actor'), expected, '根owner Agent消失仍保留原job来源')
  assert.doesNotMatch(JSON.stringify(await h.index.safeToInspect('actor')), /never-output|detail/)
})


test('#294 P2：后代 orphan 来源跨 descriptor/Agent/job 消失保留，返回副本不能改缓存', async () => {
  const h = harness()
  h.agents.set('actor', mkAgent('actor'))
  h.agents.set('branch', mkAgent('branch', { parent: 'actor' }))
  h.agents.set('leaf', mkAgent('leaf', { parent: 'branch' }))
  h.descendants.set('actor', [{ kind: 'child', id: 'branch', parentId: 'actor', activity: 'running' }, { kind: 'child', id: 'leaf', parentId: 'branch', activity: 'running' }])
  const job = { id: 'leaf-orphan-job', owner: 'leaf', status: 'failed', detail: 'work may be orphaned: secret=never-output' }
  h.jobs.push(job)
  const expected = { status: 'unsafe', diagnostic: { reasonCode: 'job_orphaned', type: 'job', sessionId: 'leaf', jobId: job.id, owner: 'leaf', state: 'failed' } }
  assert.deepEqual(await h.index.safeToInspect('actor'), expected)
  h.emitSettled(job)
  assert.deepEqual(await h.index.safeToInspect('actor'), expected, '祖先诊断指向真正leaf owner，不伪造actor job')
  h.descendants.clear()
  h.jobs.length = 0
  h.agents.delete('leaf')
  h.agents.delete('branch')
  assert.deepEqual(await h.index.safeToInspect('leaf'), expected, '真正owner本身消失仍保留原来源')
  assert.deepEqual(await h.index.safeToInspect('actor'), expected)
  h.agents.delete('actor')
  const result = await h.index.safeToInspect('actor')
  assert.deepEqual(result, expected, '连被检查的Agent也已消失时仍保留已知来源')
  if (typeof result === 'string') throw new Error('missing diagnostic')
  result.diagnostic.jobId = 'tampered'
  result.diagnostic.owner = 'tampered'
  assert.deepEqual(await h.index.safeToInspect('actor'), expected, '公开结果不可修改缓存来源')
  h.agents.set('new-session', mkAgent('new-session'))
  assert.equal(inspectionStatus(await h.index.safeToInspect('new-session')), 'safe', '不污染不同Session/owner')
})

test('#294 P2：缓存的 orphan 事件来源同样拒绝非法/长/secret标识且不留 raw detail', async () => {
  for (const id of ['x'.repeat(129), 'ghp_123456789secret', 'https://private.invalid']) {
    const h = harness()
    h.agents.set('actor', mkAgent('actor'))
    h.emitSettled({ id, owner: 'actor', status: 'failed', detail: 'work may be orphaned: secret=never-output' })
    assert.deepEqual(await h.index.safeToInspect('actor'), { status: 'unsafe', diagnostic: {
      reasonCode: 'job_orphaned', type: 'job', sessionId: 'actor', owner: 'actor', state: 'failed', identityUnavailable: true,
    } })
    const child = harness()
    child.agents.set(id, mkAgent(id))
    child.emitSettled({ id: 'safe-job', owner: id, status: 'failed', detail: 'work may be orphaned: secret=never-output' })
    assert.deepEqual(await child.index.safeToInspect(id), { status: 'unsafe', diagnostic: {
      reasonCode: 'job_orphaned', type: 'job', jobId: 'safe-job', state: 'failed', identityUnavailable: true,
    } })
  }
})
test('#294 P2：根第二次 whenIdle await 到达的后代 orphan 不退化为 session_missing', async () => {
  const h = harness()
  let idleChecks = 0
  const job = { id: 'await-orphan-job', owner: 'child', status: 'failed', detail: 'work may be orphaned: secret=never-output' }
  h.agents.set('actor', mkAgent('actor', { whenIdle: async () => {
    if (++idleChecks === 2) {
      h.emitSettled(job)
      h.agents.delete('child')
    }
  } }))
  h.agents.set('child', mkAgent('child', { parent: 'actor' }))
  h.descendants.set('actor', [{ kind: 'child', id: 'child', parentId: 'actor', activity: 'running' }])
  assert.deepEqual(await h.index.safeToInspect('actor'), { status: 'unsafe', diagnostic: {
    reasonCode: 'job_orphaned', type: 'job', sessionId: 'child', jobId: job.id, owner: 'child', state: 'failed',
  } })
  assert.equal(idleChecks, 2)
  assert.equal(h.agents.has('child'), false)
})
