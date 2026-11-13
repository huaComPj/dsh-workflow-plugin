import { inspectionStatus, inspectionDiagnostic, safetyDiagnostic, SAFETY_BLOCK_HINT, type SafetyDiagnostic, type SafeInspection } from './safety.ts'
/** 唯一工作单 Runtime。SQLite CAS 保护短写；Host 调用始终在事务/锁之外。 */
import type { WorkflowConfig, NodeClaim, NodeDef, Target, BuiltinProgramExecution, RunState, CallFrame, ClaimCaller, NodeContextBoundary, NodeExecution, ExecutionChange, NodeExecutionEvent, ExecutionDispatch, ExecutionJudge, ResumeTarget, ProgramResult } from '../types.ts'
import { WorkflowError, LIMITS, compactBeforeReuse, declaredResults, nodeChecker, nodeOnReturn, nodeResults, normalizeModelRoute, normalizeNodeClaim, roleReuseMode, agentOptionsToRoute, readRoleDefModel, readRoleFallbackModel, roleKeysWithJudge, sameModelRoute, type SpawnAgentOptions, type DelegationRoute } from '../types.ts'
import { newNodeToken, topFrame } from '../state/invariants.ts'
import { effectiveRoleRouteStage, resolveRoleModel, roleFallbackRoute, rolePrimaryRoute, roleModelConfig } from '../roles/roles.ts'
import { validateAndNormalize, computeDefinitionHash } from '../catalog/validate.ts'
import { modelConfigState, ModelConfigConflictError } from './model-config-state.ts'
import { ACTOR_RECOVERY_INSTRUCTION, MANAGER_SUBMISSION_CONSTRAINT, runMaterialsSection } from './texts.ts'
import { DISPATCH_TIMEOUTS, DispatchTimeoutError, withTimeout } from './timeouts.ts'
import { BUILTIN_PROGRAMS } from '../programs/catalog.ts'
import { isTransientJudgeFailure, withTurnEndFailure } from '../plugin/turn-end.ts'
import { classifyActorFailure, describeActorFailure, failoverNote, type ActorFailureFacts } from './failover.ts'
import { describeActivationSettlement, shortRouteLabel, type DispatchLifecycle, type DispatchObservationRef } from '../plugin/dispatch-lifecycle.ts'
import { createRunLog, appendLine, traceEvent, jsonField, shortId } from './tracelog.ts'

export interface DispatchTargets {
  steerManager(run: RunState, text: string): Promise<{ messageId: string }>
  sendRoleActor(run: RunState, roleKey: string, text: string, model?: DelegationRoute): Promise<{ messageId: string }>
  managerSessionSeq(run: RunState): number
}
export interface JudgeSpawnInput {
  model?: DelegationRoute
  nodeToken: string
  /** 共同验收条件（可省略 = 无共同条件）。 */
  criteria: string
  /** 本次 claim 选择的节点结果名及其验收条件。 */
  result: string
  resultCriteria: string
  boundary: NodeContextBoundary
  claim: NodeClaim
  previousFeedback?: { result: 'REJECT' | 'NEED_CONTEXT'; reason: string; claim: NodeClaim }
  managerContext?: string
  cwd: string
  judgeSessionId: string
  recovery?: boolean
  /** Issue #173：该 Run 已绑定的 workspace（状态行键），算材料目录用，不猜 cwd。 */
  workspace: string
}
export type SessionAvailability = 'available' | 'missing' | 'unknown'
/**
 * 闭合探针三态（#54）：`safe` 可安全结算；`waiting` 只表示"仍在跑的已知后代"这一
 * 唯一阻碍（等待中的正常空回合）；`unsafe` 收口未知，必须 fail-closed。
 */
export type { SafeInspection } from './safety.ts'
/**
 * probeSessionIdle 的判定结果（#74）：`safe` = 探针即安全；`cold-safe` = 探针不安全
 * 但无可观测活动（冷会话）；`active` = 仍有活动；两种 stale = 对应阶段 CAS 复查失败。
 */
export type SessionIdleVerdict = 'safe' | 'cold-safe' | 'safety-stale' | 'activity-stale' | 'active'
class SafetyProbeError extends Error {
  readonly diagnostic: SafetyDiagnostic
  constructor(message: string, diagnostic: SafetyDiagnostic) { super(message); this.diagnostic = diagnostic }
}
/**
 * #243 D2：一次故障切换尝试的结果——调用点据此写收口文案，不再从「是否配置备用 /
 * 故障是否合格 / 当前阶段」三类事实重新推导（那三件事同一次尝试已经判定过）。
 * - `switched`：已切到下一路由并重新派发；
 * - `exhausted`：已无路由可切（备用用尽），故障资格由同一次尝试确认；
 * - `ineligible`：不构成切换（未配置备用、Manager、已接受 claim、故障不合格、主备同路由）。
 */
export type FailoverVerdict = 'switched' | 'exhausted' | 'ineligible'
export interface SubagentHost {
  ensureRoleActor(run: RunState, roleKey: string, initialText: string, model?: DelegationRoute): Promise<{ childId: string; messageId: string }>
  startJudge(run: RunState, input: JudgeSpawnInput): Promise<{ judgeSessionId: string; messageId: string }>
  followupJudge(run: RunState, judgeSessionId: string, input: JudgeSpawnInput): Promise<{ messageId: string }>
  judgeSessionAvailability(judgeSessionId: string): Promise<SessionAvailability>
  roleSessionAvailability(roleSessionId: string): Promise<SessionAvailability>
  retireJudge(run: RunState, judgeSessionId: string): Promise<void>
  drainJudge(run: RunState, judgeSessionId: string): Promise<void>
  /** 节点级复用（`reuse: node`）离开节点时释放会话：drain 内存驻留。失败的降级由引擎决定。 */
  drainRoleActor(run: RunState, roleKey: string): Promise<void>
  compactRoleActor(run: RunState, roleKey: string): Promise<{ ok: boolean; detail?: string }>
  /** 必须覆盖普通工具 tail、已知后台写任务及未收口后代；unknown 一律 `unsafe`。 */
  safeToInspect(sessionId: string): Promise<SafeInspection>
  /**
   * Issue #247：派发生命周期观察模块（Host Adapter 持有并装配，引擎只在发布
   * 与结算点报告事实/消费候选）。缺席 = 旧装配/测试替身，引擎退化为既有行为。
   */
  dispatchLifecycle?: DispatchLifecycle
}
export interface ProgramHost {
  run(run: RunState, programId: string, parameters: Record<string, unknown>, cwd: string): Promise<ProgramResult>
}
export interface RuntimeRow { run: RunState; execution: NodeExecution; version: number }
export interface StateHost {
  get(workspaceKey: string): Promise<RuntimeRow | undefined>
  put(workspaceKey: string, run: RunState, expectedVersion: number, changes: ExecutionChange[]): Promise<void>
  create(workspaceKey: string, run: RunState, execution: NodeExecution): Promise<number>
  listRuns(): Promise<Array<RuntimeRow & { workspaceKey: string }>>
  execution(workspaceKey: string, executionId: string): Promise<NodeExecution | undefined>
  events(workspaceKey: string, executionId: string, after?: number, limit?: number): Promise<NodeExecutionEvent[]>
  historyOwner(workspaceKey: string, executionId: string): Promise<{ runId: string; managerSessionId: string } | undefined>
}
// EngineOutcome 契约（#82 定稿，语义另见 CONTEXT.md）：成功分支的 `run` 可缺席，全仓唯一
// 「成功但无 run」的返回点是无活动 Run 的 reset 幂等成功（`no active run`，不写库/不产生事件）；
// 失败分支不带 run。新增 `run` 读取点必须处理 `undefined`（strict 编译期可拦），不得假设成功必有 Run。
export type EngineOutcome = { ok: true; run?: RunState; message: string } | { ok: false; reason: string }
export interface SaveRoleModelConfigInput {
  runId: string
  role: string
  expectedRevision: number
  requestId?: string
  primary: DelegationRoute
  fallback?: DelegationRoute
}
export type ModelConfigSaveResult = { ok: true; run: RunState; message: string; replayed: boolean }
  | { ok: false; code: string; reason: string }
export function executorSessionOf(run: RunState): string {
  const frame = topFrame(run)
  const def = frame.workflowId === run.catalogWorkflowId ? run.definitionSnapshot.workflow : run.definitionSnapshot.childWorkflows?.[frame.workflowId]
  const execution = def?.nodes[frame.nodeId]?.execution
  return execution?.type === 'actor-task' && execution.role !== 'manager' ? run.roleActors[execution.role] ?? '' : run.managerSessionId
}
const rejected = (reason: string): EngineOutcome => ({ ok: false, reason })
/**
 * #139 派发绑定 = 同一存活会话的血统归属：派发消息 ID 必须命中调用方当前
 * turn 的严格集，或命中调用方会话 up-to-call 的累积血统集（后台子代理结算
 * 通知推进一步 turn 后，派发 ID 只留在历史里）。会话不同、新派发晚于调用方
 * 快照（陈旧 visit）一律失配；settled 派发不再授予资格由各调用点另行判定。
 */
const matches = (dispatch: ExecutionDispatch | undefined, caller: ClaimCaller): boolean =>
  dispatch?.sessionId !== undefined && dispatch.sessionId === caller.sessionId && dispatch.messageId !== undefined
  && (caller.turnUserMessageIds.has(dispatch.messageId) || caller.sessionUserMessageIds?.has(dispatch.messageId) === true)
const executionHandoff = (execution: NodeExecution): string | undefined => execution.claim?.handoff
  ?? (execution.program?.result?.kind === 'PASS' || execution.program?.result?.kind === 'FAIL' ? execution.program.result.handoff : undefined)
  ?? execution.child?.result?.handoff
const change = (execution: NodeExecution, ...events: NodeExecutionEvent['type'][]): ExecutionChange => ({ execution, expectedRevision: execution.revision, events })
export const TERMINATED_REASON = 'terminated; external effects not cancelled'
/**
 * 终局裁决名由**实际目标**决定：走到 `{ return: r }` 就是本流程返回 r；否则是本节点
 * 选中的结果名 `name`（Child caller 的 `name` 是它映射的被调用流程返回名）。
 */
function decisionOf(target: Target, name: string, source: string): NonNullable<NodeExecution['returned']> {
  return 'return' in target ? { kind: 'return', name: target.return, source } : { kind: 'result', name, source }
}
/** 取某个已声明结果的验收条件；未声明即 undefined。 */
function resultDefOf(node: NodeDef | undefined, result: string): { criteria: string; target: Target } | undefined {
  if (node === undefined) return undefined
  return nodeResults(node)?.[result]
}
/**
 * Issue #214：判定摘要（语义词边界截断，上限 200 字符），通知与 status 共用。
 * 先压单行，超限则在上限内最后一个空格处断开（无空格才硬切），截断也不切碎词语。
 */
const JUDGMENT_SUMMARY_MAX = 200
function summarizeJudgment(reason: string, max: number = JUDGMENT_SUMMARY_MAX): string {
  const flat = reason.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat || '-'
  const cut = flat.slice(0, max)
  const boundary = cut.lastIndexOf(' ')
  // ponytail: 无空格（长串英文/哈希）才硬切，这是已知上限而非通用分词。
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd() || '-'
}
/**
 * Issue #214：判定对齐口径（与 invariants 同源）：judgment.claimId 与当前
 * claim.id 且 inputVersion 对齐 = 当前判定。调用方据此区分当前判定 / 历史判定 /
 * 待判定（有 claim 无对齐判定），不再靠 handoffPreview 变化推断。
 */
function alignedJudgment(e: NodeExecution): boolean {
  return e.judgment !== undefined && e.judgment.claimId === e.claim?.id && e.judgment.inputVersion === e.inputVersion
}


export class WorkflowEngine {
  cwdResolver: (run: RunState) => Promise<string> = async () => { throw new WorkflowError('cwd resolver is not wired') }
  actorActivity: (sessionId: string) => Promise<'active' | 'idle' | 'unknown'> = async () => 'unknown'
  managerRoute: (sessionId: string) => Promise<SpawnAgentOptions> = async () => ({})
  /**
   * #223：set_role_model 保存前三维校验（provider 注册 / modelId 本地列表 /
   * reasoningEffort 合法档位），与 start 矩阵同源。生产装配在 `src/index.ts`
   *（现成 `effortInfoOf` + provider-check 纯判定）；未装配时跳过（存量测试兼容）。
   * 返回 ok:false 即拒绝并展示 reason；ok:true + note 即放行并把 note
   * 注明进成功消息（fail-open：元数据查不到、无法判定 dimensions）。
   */
  validateModelRoute?: (provider: string, modelId: string, reasoningEffort?: string) => Promise<{ ok: boolean; reason?: string; note?: string }>
  traceWarn: ((message: string) => void) | undefined
  /** #216：Run 终局（completed/terminated）通知宿主适配层（动态 preset 注销等）；best-effort。 */
  runClosed: ((run: RunState) => void) | undefined
  private readonly targets: DispatchTargets
  private readonly subagents: SubagentHost
  private readonly programs: ProgramHost
  private readonly state: StateHost
  private readonly configState: StateHost
  private readonly traceWarned = new Set<string>()
  private trace(run: RunState, event: string, fields: Parameters<typeof traceEvent>[1]): void {
    if (run.traceLogPath && !appendLine(run.traceLogPath, traceEvent(event, fields))) this.warnTrace(run)
  }
  private warnTrace(run: RunState): void {
    if (this.traceWarned.has(run.runId)) return
    this.traceWarned.add(run.runId)
    try { this.traceWarn?.(`workflow trace unavailable for run ${run.runId}; SQLite remains authoritative`) } catch {}
  }
  constructor(targets: DispatchTargets, subagents: SubagentHost, programs: ProgramHost, state: StateHost) {
    this.targets = targets
    this.subagents = subagents
    this.programs = programs
    this.configState = state
    this.state = modelConfigState(state)
  }

  nodeAt(run: RunState, frame: CallFrame): NodeDef | undefined {
    const def = frame.workflowId === run.catalogWorkflowId ? run.definitionSnapshot.workflow : run.definitionSnapshot.childWorkflows?.[frame.workflowId]
    return def?.nodes[frame.nodeId]
  }
  currentNodeKind(run: RunState): NodeDef['execution']['type'] {
    const node = this.nodeAt(run, topFrame(run))
    if (!node) throw new WorkflowError('current node is missing from snapshot')
    return node.execution.type
  }
  buildInitialRun(managerSessionId: string, workflowId: string, config: WorkflowConfig, _definitionHash: string): RunState {
    const snapshot = validateAndNormalize(structuredClone(config), { workflowId })
    const currentExecutionId = newNodeToken()
    return {
      runId: newNodeToken(), managerSessionId, catalogWorkflowId: workflowId,
      definitionHash: computeDefinitionHash(snapshot), definitionSnapshot: snapshot,
      status: 'running', callStack: [{ workflowId, nodeId: snapshot.workflow.startNode, nodeToken: newNodeToken(), executionId: currentExecutionId }],
      currentExecutionId, roleActors: {}, modelOverrides: {}, blockReason: null,
    }
  }
  private newExecution(run: RunState, input: string, visit: number, predecessorId?: string): NodeExecution {
    const frame = topFrame(run)
    const execution = this.nodeAt(run, frame)?.execution
    const role = execution?.type === 'actor-task' ? execution.role : undefined
    // 边界 compact 只服务于 `reuse: continuable` 的跨节点复用。`reuse: node`（缺省）的新访问
    // 要么拿到全新会话、要么（同节点 resume 等）用的就是本访问自己的会话，没有跨节点上下文
    // 可压缩——离开节点时该会话已被 drain + 撤权。
    const roleBoundaryPrepared = role === undefined || role === 'manager'
      || roleReuseMode(run.definitionSnapshot.roles[role]) === 'node' || run.roleActors[role] === undefined
    return { runId: run.runId, ...frame, visit, revision: 0,
      input, phase: 'ready', roleBoundaryPrepared, restartPending: false, inputVersion: 1, blockReason: null, enteredAt: new Date().toISOString(),
      ...(predecessorId === undefined ? {} : { predecessorId }) }
  }
  private judgePacket(run: RunState, e: NodeExecution, cwd: string, workspace: string): JudgeSpawnInput {
    const node = this.nodeAt(run, topFrame(run))!
    // 共同条件只存在于 actor-task Node 的 checker；Program / Child Node 不派 Judge。
    const criteria = nodeChecker(node)?.config.criteria ?? ''
    // Judge 只核验共同条件与**本次 claim 所选结果**的条件，不改选结果、不遍历其他出口。
    const selected = resultDefOf(node, e.claim!.result)
    const feedback = e.judgment?.result === 'REJECT' && e.previousClaim
      ? { result: e.judgment.result, reason: e.judgment.reason, claim: { result: e.previousClaim.result, handoff: e.previousClaim.handoff } }
      : e.judgment?.result === 'NEED_CONTEXT' && e.claim
        ? { result: e.judgment.result, reason: e.judgment.reason, claim: { result: e.claim.result, handoff: e.claim.handoff } }
        : undefined
    return {
      nodeToken: e.nodeToken, criteria: String(criteria), model: e.judge!.model,
      result: e.claim!.result, resultCriteria: selected?.criteria ?? '',
      boundary: e.boundary!, claim: { result: e.claim!.result, handoff: e.claim!.handoff }, cwd, judgeSessionId: e.judge!.sessionId!,
      workspace,
      ...(feedback ? { previousFeedback: feedback } : {}),
      ...(e.resolution?.context ? { managerContext: e.resolution.context } : {}),
      ...(e.resolution?.target === 'judge' ? { recovery: true } : {}),
    }
  }
  /**
   * Issue #214：status 的 judgment 区分当前判定 / 历史判定 / 待判定（state 字段），
   * 判定均标注 visit 并携带所针对的 claimId 与 judgmentRef（executionId + visit）；
   * 全文经 history 分页按 executionId 取事件 snapshot（不新增参数/工具）。
   */
  private statusJudgment(e: NodeExecution): {
    state: 'current' | 'historical'; result: string; summary: string; claimId: string; visit: number; judgmentRef: { executionId: string; visit: number }
  } | { state: 'pending'; claimId: string } | null {
    if (alignedJudgment(e)) {
      const judgment = e.judgment!
      return { state: 'current', result: judgment.result, summary: summarizeJudgment(judgment.reason), claimId: judgment.claimId, visit: e.visit, judgmentRef: { executionId: e.executionId, visit: e.visit } }
    }
    if (e.judgment !== undefined && e.claim === undefined) {
      const judgment = e.judgment
      return { state: 'historical', result: judgment.result, summary: summarizeJudgment(judgment.reason), claimId: judgment.claimId, visit: e.visit, judgmentRef: { executionId: e.executionId, visit: e.visit } }
    }
    if (e.claim !== undefined) return { state: 'pending', claimId: e.claim.id }
    return null
  }
  async status(ws: string, caller = '', history?: { executionId: string; after?: number; limit?: number }) {
    const row = await this.state.get(ws)
    if (!row) return { ok: true, status: 'no active run' }
    const { run, execution } = row
    if (history) {
      const after = history.after ?? 0
      const limit = history.limit ?? 50
      if (!history.executionId.trim() || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        return { ok: false, reason: 'history requires executionId, after >= 0, and limit 1..50' }
      }
      try {
        const owner = await this.state.historyOwner(ws, history.executionId)
        if (!owner || owner.runId !== run.runId) return { ok: false, reason: 'workflow history execution is not in the current Run' }
        if (caller !== owner.managerSessionId) return { ok: false, reason: 'workflow history is Manager-only' }
        const events = await this.state.events(ws, history.executionId, after, limit)
        return { ok: true, status: { runId: owner.runId, history: { executionId: history.executionId, after, limit, events, nextAfter: events.length === limit ? events.at(-1)!.sequence : null } } }
      } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
    const node = run.status === 'completed' ? undefined : this.nodeAt(run, topFrame(run))
    const handoffPreview = executionHandoff(execution)?.slice(0, 500) ?? null
    return { ok: true, status: {
      runId: run.runId, catalogWorkflowId: run.catalogWorkflowId, status: run.status,
      currentFrame: run.callStack.at(-1) ?? null,
      handler: node?.execution.type === 'actor-task' ? node.execution.role : node?.execution.type ?? null,
      execution: {
        executionId: execution.executionId, workflowId: execution.workflowId, nodeId: execution.nodeId,
        nodeToken: execution.nodeToken, visit: execution.visit, phase: execution.phase,
        dispatchId: execution.dispatch?.id ?? null, claimId: execution.claim?.id ?? null, judgeId: execution.judge?.id ?? null,
        blockDiagnostic: execution.blockDiagnostic ?? null,
        hasClaim: execution.claim !== undefined, claimResult: execution.claim?.result ?? null,
        declaredResults: declaredResults(node),
        returned: execution.returned ? { kind: execution.returned.kind, name: execution.returned.name } : null,
        judgment: this.statusJudgment(execution),
        inputPreview: execution.input.slice(0, 500), handoffPreview,
        blockReason: execution.blockReason ?? run.blockReason, recoveryTarget: execution.resolution?.target ?? null,
        restartPending: execution.restartPending,
      },
      blockReason: execution.blockReason ?? run.blockReason,
      handoffPreview,
      // #235：角色路由可观察性——已切换过的角色 + 配置了备用路由但尚未切换的角色。
      // 只列与故障切换有关的角色（无备用、未切换的普通角色不出现在这里）。
      routes: this.roleRoutesView(run),
      // v3：Run 生命周期（status）与业务终局分离；终局名与来源单源来自终局工作单。
      businessReturn: run.businessReturn ? { name: run.businessReturn.name, source: run.businessReturn.source } : null,
      finalHandoffPreview: run.status === 'completed' ? handoffPreview : null,
    } }
  }
  /**
   * #235：`workflow_status.routes` 视图。列出「发生过切换/人工授权的角色」与「配置了
   * 备用路由但尚未切换的角色」（stage 缺省即 primary），让 Manager 不必猜某个角色
   * 是否参与故障切换链。无备用路由、也没有人工授权的普通角色不列入（保持状态输出
   * 精简，不新建监控面板）；#237 起主动设置（当前 primary）本身也是一条可见事实，
   * 即使该角色没有配置备用路由也列出。
   */
  private roleRoutesView(run: RunState): Array<{ role: string; stage: string; route: string; fallback: string | null; reason: string | null; autoSwitches: number }> {
    const roles = new Set(Object.keys(run.roleRoutes ?? {}))
    for (const role of roleKeysWithJudge(run.definitionSnapshot)) {
      if (readRoleFallbackModel(run.definitionSnapshot, role) !== undefined) roles.add(role)
    }
    return [...roles].sort().map((role) => {
      const state = run.roleRoutes?.[role]
      return {
        role,
        stage: state?.stage ?? 'primary',
        route: shortRouteLabel(resolveRoleModel(run, role, run.delegationRoute)) ?? 'inherited',
        fallback: shortRouteLabel(roleFallbackRoute(run, role)) ?? null,
        reason: state?.reason ?? null,
        autoSwitches: state?.autoSwitches ?? 0,
      }
    })
  }
  /**
   * #274：Judge 派发事实（实际解析到的路由 + 来源阶段）——判定安排/重建/换模各点共用
   * 同一份决策，避免各安排点自写一套后与实际 spawn 漂移（只读监控事实，不参与派发）。
   */
  private judgeRouteFacts(run: RunState) {
    return { model: resolveRoleModel(run, 'judge', run.delegationRoute), source: effectiveRoleRouteStage(run, 'judge'), configRevision: roleModelConfig(run, 'judge').revision }
  }
  async startRun(ws: string, run: RunState, configPath?: string, extraText = ''): Promise<EngineOutcome> {
    if (extraText.length > LIMITS.handoffMax) return rejected(`root input exceeds ${LIMITS.handoffMax} characters`)
    const previous = await this.state.get(ws)
    if (previous && previous.run.status !== 'completed' && previous.run.status !== 'terminated') return rejected(`workspace already has a ${previous.run.status} run`)
    if (previous?.run.status === 'terminated') {
      const previousNode = this.nodeAt(previous.run, topFrame(previous.run))
      const knownSessions = new Set<string>()
      if (previousNode?.execution.type === 'actor-task' && previousNode.execution.role !== 'manager') {
        const actorSessionId = previous.execution.dispatch?.sessionId ?? previous.run.roleActors[previousNode.execution.role]
        if (actorSessionId) knownSessions.add(actorSessionId)
      }
      if (previous.execution.judge?.sessionId) knownSessions.add(previous.execution.judge.sessionId)
      if (previous.execution.predecessorId) {
        const predecessor = await this.state.execution(ws, previous.execution.predecessorId)
        if (!await this.sameRow(ws, previous)) return rejected('workspace history changed during terminated predecessor inspection')
        if (predecessor?.judge && !predecessor.judge.settled) knownSessions.add(predecessor.judge.sessionId)
      }
      for (const sessionId of knownSessions) {
        let verdict: SessionIdleVerdict
        try { ({ verdict } = await this.probeSessionIdle(sessionId, () => this.sameRow(ws, previous))) }
        catch (error) { return rejected(error instanceof Error ? error.message : String(error)) }
        if (verdict === 'safety-stale') return rejected('workspace history changed during terminated Run safety inspection')
        if (verdict === 'activity-stale') return rejected('workspace history changed during terminated Run activity inspection')
        if (verdict === 'active') return rejected(`terminated Run session ${sessionId} is not safely closed`)
      }
    }
    // #91: 默认路由按 Run 冻结，且在创建/hash/首次派发之前写入——冻结只影响之后
    // 创建的 Role/Judge（已有 descriptor 继续用自己的路由），也不改写用户显式配置。
    // 解析不出值（Manager 不在场）时不猜：保持 undefined，由宿主 spawn 的正式继承
    // 语义从本 Run 自己的 Manager 兜底，绝不借其他 Run 的值。
    const frozen = await this.managerRoute(run.managerSessionId)
    if (frozen.provider !== undefined || frozen.model !== undefined || frozen.reasoningEffort !== undefined) {
      run.delegationRoute = agentOptionsToRoute(frozen)
    }
    // #235：主备必须是不同模型。显式 `model` 的差异已由 catalog 校验拒绝；未配
    // `model` 的角色继承本 Run 冻结的默认路由，只能在冻结之后判定——若备用与继承
    // 主路由同 provider+modelId，第一次「切换」只是换个会话重试同一模型，直接拒绝
    // 启动（fail-closed：不改 catalog，也不猜用户想要的备用模型）。
    const fallbackClash = this.fallbackClash(run)
    if (fallbackClash !== undefined) return rejected(fallbackClash)
    if (configPath) {
      const path = createRunLog(configPath, run.catalogWorkflowId, run.runId)
      if (path) run.traceLogPath = path
      else this.warnTrace(run)
    }
    try { await this.state.create(ws, run, this.newExecution(run, extraText, 1)) }
    catch (error) {
      if (error instanceof Error && error.name === 'StateConflictError') return rejected(error.message)
      throw error
    }
    this.trace(run, 'START', { workflow: run.catalogWorkflowId, run: run.runId, fmt: 3 })
    await this.drive(ws)
    const row = (await this.state.get(ws))!
    return { ok: true, run: row.run, message: row.execution.blockReason ?? 'work order started' }
  }

  /** 一次触发只登记当前需要的一个安排。并发触发由数据库 CAS 仲裁，非整Promise锁。 */
  /**
   * Issue #247：发布一次已受理派发（受理不等于执行完成），由观察模块决定
   * 是否已有可结算的终止事实。只登记真实子代理 Activation 路径（manager
   * steer 不是 activation 路径，不跟踪）；发布窗口内先到达的终态由模块
   * 归因，能归属本登记时立即结算（矩阵 B）。
   */
  private async trackDispatch(ws: string, run: RunState, e: NodeExecution, kind: 'actor' | 'judge', roleKey: string): Promise<void> {
    const lifecycle = this.subagents.dispatchLifecycle
    if (lifecycle === undefined) return
    const dispatch = kind === 'actor' ? e.dispatch : e.judge
    if (!dispatch?.sessionId || !dispatch.messageId) return
    if (kind === 'judge' && !e.claim) return
    const route = shortRouteLabel(dispatch.model)
    const ref = lifecycle.publish({
      workspaceKey: ws, runId: run.runId, executionId: e.executionId, nodeToken: e.nodeToken,
      dispatchId: dispatch.id, kind, roleKey,
      ...(route === undefined ? {} : { route }),
      sessionId: dispatch.sessionId, messageId: dispatch.messageId,
      ...(kind === 'judge' ? { claimId: e.claim!.id, inputVersion: e.inputVersion } : {}),
    })
    if (ref !== undefined) await this.settleActivation(ref)
  }
  private forgetDispatch(sessionId: string | undefined, dispatchId?: string): void {
    if (sessionId === undefined) return
    this.subagents.dispatchLifecycle?.invalidate(sessionId, dispatchId)
  }
  /**
   * #235/#236：启动期主备冲突检查——配置了 `fallbackModel` 的角色（含 Judge），
   * 其生效主路由（显式 `model`，缺省为本 Run 冻结的默认路由）与备用路由的
   * provider+modelId 必须不同。返回拒绝原因或 undefined。
   */
  private fallbackClash(run: RunState): string | undefined {
    for (const roleKey of roleKeysWithJudge(run.definitionSnapshot)) {
      const fallback = readRoleFallbackModel(run.definitionSnapshot, roleKey)
      if (fallback === undefined) continue
      if (sameModelRoute(rolePrimaryRoute(run, roleKey, run.delegationRoute), fallback)) {
        return `role "${roleKey}" fallbackModel duplicates its primary route (${fallback.provider}/${fallback.modelId})；备用模型必须与主模型 provider/modelId 不同`
      }
    }
    return undefined
  }
  async drive(ws: string, configRetries = 0): Promise<void> {
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'running') return
    const { run, execution: e, version } = row
    if (e.phase === 'ready') {
      if (e.predecessorId) {
        const predecessor = await this.state.execution(ws, e.predecessorId)
        if (!predecessor) return
        const predecessorNode = this.nodeAt(run, { workflowId: predecessor.workflowId, nodeId: predecessor.nodeId, nodeToken: predecessor.nodeToken, executionId: predecessor.executionId })
        const settled = predecessorNode?.execution.type === 'actor-task'
          ? predecessor.judge?.settled === true
          : predecessor.phase === 'exited' && predecessor.successorId === e.executionId
        if (!settled) return
      }
      const node = this.nodeAt(run, topFrame(run))!
      if (node.execution.type === 'builtin-program') {
        await this.state.put(ws, run, version, [change(e, 'program-ready')])
        await this.targets.steerManager(run, `[handoff]\n${e.input}\n\n[instruction]\n${node.execution.instruction ?? ''}\n\n[program]\n${node.execution.programId}\n请调用 node_run_program 提供当前参数；Program 结果由 Runtime 直接结算，不使用 Judge。${runMaterialsSection(ws, run.runId)}`).catch(async error => {
          const current = await this.state.get(ws)
          if (current?.version === version + 1 && current.execution.executionId === e.executionId) await this.blockRow(ws, current, `dispatch fault: ${error instanceof Error ? error.message : String(error)}`)
        })
        return
      }
      if (node.execution.type === 'child-workflow') {
        // Child 进入：调用层不派模型也不派 Judge，只把子流程的起点作为新 frame 的工作单
        // 与 caller 的 child-entered 同事务登记；子流程内部按普通节点推进。
        const child = run.definitionSnapshot.childWorkflows?.[node.execution.workflowId]
        if (!child) { await this.blockRow(ws, row, 'Child workflow is missing from the frozen snapshot'); return }
        const executionId = newNodeToken()
        e.phase = 'working'
        e.child = { workflowId: node.execution.workflowId, executionId }
        run.currentExecutionId = executionId
        run.callStack.push({ workflowId: node.execution.workflowId, nodeId: child.startNode, nodeToken: newNodeToken(), executionId })
        const first = this.newExecution(run, e.input, e.visit + 1)
        await this.state.put(ws, run, version, [change(e, 'child-entered'), { execution: first, expectedRevision: null, events: ['entered'] }])
        // #203：调用层进入子流程对 Manager 不可见，补一条结构化事件（后继派发另有事件）。
        await this.notifyNodeEvent(run, e)
        await this.drive(ws)
        return
      }
      const role = node.execution.role
      const previousDispatchSettled = e.dispatch?.settled === true
      let committedVersion = version
      try {
        e.phase = 'working'
        // #287：登记时冻结模型、档位和配置归属；Host 必须消费同一快照。
        // Manager 沿用 Run 冻结路由，来源按 primary；旧 Run 无冻结值时不写模型键。
        const dispatchModel = role === 'manager' ? run.delegationRoute : resolveRoleModel(run, role, run.delegationRoute)
        // Manager 没有人工/备用阶段（roleRoutes.manager 在 catalog 与 handleSetRoleModel 双重不可达），来源恒为首选。
        const dispatchSource = role === 'manager' ? 'primary' : effectiveRoleRouteStage(run, role)
        // #274 R1：新派发整块替换 e.dispatch——旧轮若真实派发过（有 messageId）或被 claim 引用，
        // 先按 previousClaim 同深度留档；否则后续执行记录读不到旧轮实际模型/来源。
        const staleDispatch = e.dispatch
        if (staleDispatch !== undefined && (staleDispatch.messageId !== undefined || e.previousClaim?.dispatchId === staleDispatch.id)) {
          e.previousDispatch = staleDispatch
        }
        e.dispatch = {
          id: newNodeToken(), settled: false,
          ...(dispatchModel !== undefined ? { model: dispatchModel, source: dispatchSource } : {}),
          ...(role === 'manager' ? {} : { configRevision: roleModelConfig(run, role).revision }),
          ...(role === 'manager' ? { sessionId: run.managerSessionId } : run.roleActors[role] ? { sessionId: run.roleActors[role] } : {}),
        }
        e.boundary = { dispatchedAt: Date.now(), managerFromSeq: this.targets.managerSessionSeq(run), ...(role === 'manager' ? {} : e.dispatch.sessionId ? { executorSessionId: e.dispatch.sessionId } : {}) }
        await this.state.put(ws, run, version, [change(e, 'actor-arranged')])
        committedVersion = version + 1
        let arrangedVersion = committedVersion
        if (role !== 'manager' && run.roleActors[role]) {
          if (!previousDispatchSettled) {
            const sessionId = run.roleActors[role]
            // 冷会话（activity==='unknown'：无存活进程=无未收口执行）与 resume
            // 路径同等安全，直接放行；只有仍可观测到活动的会话才是 dispatch fault。
            const { verdict, diagnostic } = await this.probeSessionIdle(sessionId, async () => (await this.stillCurrent(ws, e, arrangedVersion)) !== undefined)
            if (verdict === 'safety-stale' || verdict === 'activity-stale') return
            if (verdict === 'active') throw new SafetyProbeError('previous Role execution is not safely closed', diagnostic!)
          }
          if (!e.roleBoundaryPrepared) {
            // #198 唯一决策点：角色 `compactBeforeReuse` 关闭即跳过本次压缩调用，
            // 直接标记已准备（OR 的另一半——resume 单次逃生——由 handleResume 在
            // 恢复时直接置位并记审计，不经过这里）。存活探测在压缩之外，不随开关
            // 跳过。跳过只改内存标记，随派发落库，不额外落库。
            if (!compactBeforeReuse(run.definitionSnapshot.roles[role])) {
              e.roleBoundaryPrepared = true
            } else {
              const compact = await this.subagents.compactRoleActor(run, role)
              // #55：host 已自动重试仍失败时，BLOCK 文本必须自带恢复路径——事故里
              // Manager 是自己摸索出"换模型再 resume"的（run 295ad986）。
              if (!compact.ok) throw new WorkflowError(`node-boundary compact failed: ${compact.detail ?? 'unknown'}；Manager 可 workflow_set_role_model 切换更强模型后 node_resume 重试`)
              const current = await this.stillCurrent(ws, e, arrangedVersion)
              if (!current) return
              current.execution.roleBoundaryPrepared = true
              await this.state.put(ws, current.run, current.version, [change(current.execution)])
              e.roleBoundaryPrepared = true
              arrangedVersion = current.version + 1
              committedVersion = arrangedVersion
              if (!await this.stillCurrent(ws, e, arrangedVersion)) return
            }
          }
        }
        const correction = e.previousClaim
          ? e.judgment && e.judgment.result !== 'ACCEPT' && e.judgment.claimId === e.previousClaim.id
            ? `\n\n[最近 Judge ${e.judgment.result} 与旧 claim]\n[judge feedback]\n${e.judgment.reason}\n\n[previous claim]\nresult: ${e.previousClaim.result}\nhandoff: ${e.previousClaim.handoff}`
            : `\n\n[Manager 退回的旧 claim；无当前 Judge 反馈]\n[previous claim]\nresult: ${e.previousClaim.result}\nhandoff: ${e.previousClaim.handoff}`
          : ''
        const resolution = e.resolution?.context ? `\n\n[Manager 当前完整补充]\n${e.resolution.context}` : ''
        // #235：自动切换的说明单列一段——旧/新路由与故障原因对新 Actor 可见，
        // 同一 Session 的上下文保留，但失败后的副作用必须先核验再续作。
        const failover = e.resolution?.failover ? `\n\n[模型故障切换]\n${e.resolution.failover}` : ''
        const recovery = e.resolution?.target === 'actor' ? ACTOR_RECOVERY_INSTRUCTION : ''
        const predecessor = await this.predecessorResultContext(ws, e)
        // Issue #226：Role 派发不再追加固定提交协议——协议已随派生 preset 进入
        // system persona（压缩/冷恢复后依然有效）；Manager 派发保留 manager 变体。
        const text = `[handoff]\n${e.input}${predecessor}${this.exitContract(node)}${this.legalResults(node)}${correction}${resolution}${failover}${recovery}\n\n[instruction]\n${node.execution.instruction ?? ''}${runMaterialsSection(ws, run.runId)}${role === 'manager' ? MANAGER_SUBMISSION_CONSTRAINT : ''}`
        const sent = role === 'manager'
          ? { ...await this.targets.steerManager(run, text), childId: run.managerSessionId }
          : run.roleActors[role]
            ? { ...await this.targets.sendRoleActor(run, role, text, e.dispatch.model), childId: run.roleActors[role] }
            : await this.subagents.ensureRoleActor(run, role, text, e.dispatch.model)
        const fresh = await this.stillCurrent(ws, e, arrangedVersion)
        if (!fresh) return // 撤权不是停止；旧已知执行保留在工作单，不给它新权利。
        if (!sent.messageId || !sent.childId) throw new WorkflowError('Host returned no real dispatch identity')
        fresh.execution.dispatch!.sessionId = sent.childId
        fresh.execution.dispatch!.messageId = sent.messageId
        fresh.execution.boundary!.executorDispatchMessageId = sent.messageId
        if (role !== 'manager') {
          fresh.run.roleActors[role] = sent.childId
          fresh.execution.boundary!.executorSessionId = sent.childId
        }
        await this.state.put(ws, fresh.run, fresh.version, [change(fresh.execution)])
        // Issue #221：身份发布成功后登记待对账条目（manager steer 不是
        // activation 路径，不跟踪）。发布前到达的终态在此对账。
        if (role !== 'manager') await this.trackDispatch(ws, fresh.run, fresh.execution, 'actor', role)
        // #203：派发给 Role Actor 的 working 变化对 Manager 不可见，补一条结构化事件；
        // manager 角色的派发正文同一 turn 已 steer 给 Manager，不重复。
        if (role !== 'manager') await this.notifyNodeEvent(fresh.run, fresh.execution)
      } catch (error) { await this.dispatchFault(ws, e, error, committedVersion, configRetries) }
      return
    }
    if (e.phase !== 'checking' || !e.claim || !e.dispatch?.settled || e.judge?.messageId) return
    // checking 不等于Judge已经运行：只有精确 Actor 收口入口能置settled。
    let committedVersion = version
    try {
      const cwd = await this.cwdResolver(run)
      if (!await this.stillCurrent(ws, e, version)) return
      // #98：`continuationSessionId` 是纯同步派生，与上一次 freshness 读（355 行）之间没有 await，
      // 故这里不再重复一次读；跨 await（cwd/packet/spawn）的 CAS 复查保持原样。
      const continuationSessionId = e.resolution?.target === 'judge' && e.resolution.judgeMode === 'followup'
        ? e.resolution.judgeSessionId : undefined
      if (!e.judge) {
        e.judge = { id: newNodeToken(), sessionId: continuationSessionId ?? newNodeToken(), claimId: e.claim.id, inputVersion: e.inputVersion, settled: false, ...this.judgeRouteFacts(run) }
        await this.state.put(ws, run, version, [change(e, 'judge-arranged')])
        committedVersion = version + 1
      } else if (e.judge.claimId !== e.claim.id || e.judge.inputVersion !== e.inputVersion
        || (continuationSessionId !== undefined && e.judge.sessionId !== continuationSessionId)) return
      const packet = this.judgePacket(run, e, cwd, ws)
      const sent = continuationSessionId
        ? { ...await this.subagents.followupJudge(run, continuationSessionId, packet), judgeSessionId: continuationSessionId }
        : await this.subagents.startJudge(run, packet)
      const fresh = await this.stillCurrent(ws, e, committedVersion)
      if (!fresh) { await this.subagents.retireJudge(run, e.judge.sessionId!).catch(() => {}); return }
      if (sent.judgeSessionId !== e.judge.sessionId || !sent.messageId) throw new WorkflowError('Host returned mismatched Judge identity')
      fresh.execution.judge!.messageId = sent.messageId
      await this.state.put(ws, fresh.run, fresh.version, [change(fresh.execution)])
      // Issue #221：Judge 身份发布成功后登记待对账条目。
      await this.trackDispatch(ws, fresh.run, fresh.execution, 'judge', 'judge')
      // #203：Judge 已派发（判定中）对 Manager 不可见，补一条结构化事件。
      await this.notifyNodeEvent(fresh.run, fresh.execution)
    } catch (error) { await this.dispatchFault(ws, e, error, committedVersion, configRetries) }
  }
  /**
   * whenIdle 挂起是派发/恢复路径的已知 seam（#21 F1）：safeToInspect 内部的
   * `agent.whenIdle()` 没有任何 signal 可用，只能放弃等待并让调用方降级。
   * 等待状态（`waiting`）在恢复/派发路径上同样是"不干净"，按 fail-closed 判定但保留诊断。
   */
  private async whenIdleProbe(sessionId: string): Promise<SafeInspection> {
    try { return await withTimeout(this.subagents.safeToInspect(sessionId), DISPATCH_TIMEOUTS.whenIdle, 'whenIdle') }
    catch (error) {
      const timeout = error instanceof DispatchTimeoutError
      throw new SafetyProbeError(timeout ? error.message : 'safety probe failed', safetyDiagnostic(timeout ? 'probe_timeout' : 'probe_error', 'probe', { sessionId }))
    }
  }
  /**
   * 「探针 → activity → CAS 复查」统一 helper（#74）：5 处复用同一顺序与判定——
   * 探针 safe 直接放行，unsafe 才查 activity，只有仍可观测到活动才算 active；
   * 每次跨 await 后都经调用方 CAS 复查（`isFresh`），任一阶段过期即报对应 stale。
   * fail-closed 语义不变：各调用点的 stale/活动文案与失败动作仍由调用方决定。
   */
  private async probeSessionIdle(sessionId: string, isFresh: () => Promise<boolean>): Promise<{ verdict: SessionIdleVerdict; diagnostic?: SafetyDiagnostic }> {
    const safe = await this.whenIdleProbe(sessionId)
    if (!await isFresh()) return { verdict: 'safety-stale' }
    if (inspectionStatus(safe) === 'safe') return { verdict: 'safe' }
    const diagnostic = inspectionDiagnostic(safe, sessionId)
    const activity = await this.actorActivity(sessionId)
    if (!await isFresh()) return { verdict: 'activity-stale' }
    return { verdict: activity === 'unknown' ? 'cold-safe' : 'active', diagnostic }
  }
  /**
   * 探针超时=技术故障，不是"不安全"：降级为携带阶段名的 BLOCK 并返回 undefined；
   * 其它探针异常只保存固定 probe_error，不投影原始异常。undefined 表示已 BLOCK。
   * 只有 turn/end 结算保留 `waiting` 三态；其余路径由 probeSessionIdle 保持原二态判定。
   */
  private async safetyProbe(ws: string, row: RuntimeRow, sessionId: string, dispatchId?: string): Promise<SafeInspection | undefined> {
    try { return await this.whenIdleProbe(sessionId) }
    catch (error) {
      if (!(error instanceof SafetyProbeError)) throw error
      const fresh = await this.stillCurrent(ws, row.execution, row.version)
      if (fresh) await this.blockRow(ws, fresh, { reason: error.message, diagnostic: inspectionDiagnostic({ status: 'unsafe', diagnostic: error.diagnostic }, sessionId, dispatchId) })
    }
  }
  private async stillCurrent(ws: string, e: NodeExecution, version: number): Promise<RuntimeRow | undefined> {
    const row = await this.state.get(ws)
    return row?.run.status === 'running' && row.version === version && row.run.runId === e.runId
      && row.execution.executionId === e.executionId && row.execution.nodeToken === e.nodeToken
      && row.execution.dispatch?.id === e.dispatch?.id && row.execution.claim?.id === e.claim?.id
      && row.execution.judge?.id === e.judge?.id ? row : undefined
  }
  private async sameRow(ws: string, row: RuntimeRow): Promise<boolean> {
    const current = await this.state.get(ws)
    return current?.version === row.version && current.run.runId === row.run.runId
      && current.execution.executionId === row.execution.executionId
  }
  /** Manager-side destructive Judge handoff: drain first, then prove the same work is still current. */
  private async drainJudgeAndRevalidate(ws: string, row: RuntimeRow, judgeToDrain: ExecutionJudge | undefined): Promise<boolean> {
    if (judgeToDrain) await this.subagents.drainJudge(row.run, judgeToDrain.sessionId)
    const current = await this.state.get(ws)
    return current?.version === row.version && current.run.runId === row.run.runId
      && current.execution.executionId === row.execution.executionId
  }
  private async dispatchFault(ws: string, e: NodeExecution, error: unknown, committedVersion: number, configRetries = 0): Promise<void> {
    const row = await this.state.get(ws)
    // 配置只在新派发登记时敏感：尚未发生 Host 副作用的旧候选重读，不撤销有效工作。
    if (error instanceof ModelConfigConflictError && configRetries < 2 && row?.run.runId === e.runId && row.execution.executionId === e.executionId) {
      await this.drive(ws, configRetries + 1)
      return
    }
    // 本地候选安排可能尚未提交；只认最后成功提交的Run/visit/CAS版本。
    if (row?.run.status !== 'running' || row.run.runId !== e.runId || row.execution.executionId !== e.executionId || row.version !== committedVersion) return
    const reason = `dispatch fault: ${error instanceof Error ? error.message : String(error)}`
    await this.blockRow(ws, row, error instanceof SafetyProbeError ? { reason, diagnostic: error.diagnostic } : reason)
  }
  /**
   * Issue #203：节点 phase 变化时向 Manager 会话推送的结构化事件。
   * 字段足以判断「推进/判定中/BLOCK 及原因摘要」，Manager 全程免轮询，
   * 仅在事件缺失或需要细节时查询 workflow_status。
   * best-effort：推送失败静默（见 notifyNodeEvent），降级为现状轮询，
   * 绝不阻断主流程；不改变 workflow_status 查询语义。
   */
  private nodeEventText(run: RunState, e: NodeExecution): string {
    const oneLine = (value: string, max: number): string => value.replace(/\s+/g, ' ').trim().slice(0, max) || '-'
    const claimResult = e.claim?.result ?? e.previousClaim?.result ?? '-'
    // Issue #214：judgment 改为「verdict + ≤200 字符摘要 + judgmentRef」：有对齐判定 =
    // 当前判定；有判定但无当前 claim = 历史判定；有 claim 无对齐判定 = 待判定（不再沿用
    // 旧判定，避免与历史混淆）。全文经 workflow_status history 分页按 executionId 取事件 snapshot。
    const aligned = alignedJudgment(e)
    const judgment = aligned || (e.judgment !== undefined && e.claim === undefined)
      ? `${e.judgment!.result} ${summarizeJudgment(e.judgment!.reason)} (${aligned ? 'current' : 'historical'} ref=${e.executionId} visit=${e.visit})`
      : e.claim !== undefined ? 'pending' : '-'
    const returned = e.returned ? `${e.returned.kind}:${e.returned.name}` : '-'
    const blockReason = e.blockReason ?? run.blockReason
    return [
      `[node-event] phase=${e.phase} node=${e.workflowId}/${e.nodeId} run=${run.runId}`,
      `nodeToken=${e.nodeToken}`,
      `executionId=${e.executionId} visit=${e.visit} dispatchId=${e.dispatch?.id ?? '-'} claimId=${e.claim?.id ?? '-'} judgeId=${e.judge?.id ?? '-'}`,
      `claimResult=${claimResult} judgment=${judgment} returned=${returned}`,
      `blockReason=${blockReason ? oneLine(blockReason, 200) : '-'}`,
      ...(e.blockDiagnostic ? [`blockDiagnostic=${JSON.stringify(e.blockDiagnostic)}`] : []),
    ].join('\n')
  }
  private notifyNodeEvent(run: RunState, e: NodeExecution): Promise<void> {
    // best-effort：推送失败静默，降级为现状轮询，绝不阻断主流程。
    return (async () => { await this.targets.steerManager(run, this.nodeEventText(run, e)).catch(() => {}) })()
  }
  /**
   * BLOCK 的两处共用动作（#133 收口 D-130-02）：原因的单点截断，与统一
   * 「Workflow BLOCK: <原因>」前缀的 Manager 通知（通知失败静默——状态真源已提交）。
   * #203：通知正文首部携带结构化节点事件，BLOCK 即一次 phase 变化，不另发一条。
   * 落库本身仍留在各调用点：三处的 phase/事件前缀/trace/退役 Judge 顺序不同。
   */
  private blockReason(reason: string): string { return reason.slice(0, LIMITS.blockReasonMax) }
  private async notifyBlock(run: RunState, e: NodeExecution, blockReason: string, hint: string): Promise<void> {
    await this.targets.steerManager(run, `${this.nodeEventText(run, e)}\nWorkflow BLOCK: ${blockReason}\n${hint}`).catch(() => {})
  }
  private async blockRow(ws: string, row: RuntimeRow, reason: string | { reason: string; diagnostic: SafetyDiagnostic }, ...beforeBlock: NodeExecutionEvent['type'][]): Promise<void> {
    row.run.status = 'blocked'
    row.execution.blockReason = this.blockReason(typeof reason === 'string' ? reason : reason.reason)
    if (typeof reason === 'string') delete row.execution.blockDiagnostic
    else row.execution.blockDiagnostic = reason.diagnostic
    await this.state.put(ws, row.run, row.version, [change(row.execution, ...beforeBlock, 'blocked')])
    this.trace(row.run, 'BLOCK', { workflow: row.execution.workflowId, node: row.execution.nodeId, reason: jsonField(row.execution.blockReason, LIMITS.blockReasonMax) })
    await this.notifyBlock(row.run, row.execution, row.execution.blockReason, row.execution.blockDiagnostic ? SAFETY_BLOCK_HINT : '材料已保存；Manager 可查看 status 后选择恢复目标。')
  }
  /**
   * Issue #200：Judge 瞬时失败的单次自动重试。fresh 新会话重派（失败会话状态
   * 未知，不复用）；旧会话仅 retire 撤权（revoke authorization），不 drain——
   * drain 失败会话可能竞态，撤权已足以剥夺其提交资格（结算仍由新 Judge 的精确
   * turn 驱动）。成功则节点照常推进（无 BLOCK 落库）；重派失败则 BLOCK 并在
   * 原因中标注「已自动重试 1 次」与原始错误。不做退避（单次立即重投；多轮/指数
   * 退避不在本票范围）。
   */
  private async retryJudgeOnce(ws: string, row: RuntimeRow, turnFailure: string | undefined): Promise<void> {
    const { run, execution: e, version } = row
    const oldSessionId = e.judge!.sessionId
    e.judgeAutoRetried = true
    e.judge = { id: newNodeToken(), sessionId: newNodeToken(), claimId: e.claim!.id, inputVersion: e.inputVersion, settled: false, ...this.judgeRouteFacts(run) }
    await this.state.put(ws, run, version, [change(e, 'judge-arranged')])
    this.trace(run, 'JUDGE-RETRY', { workflow: e.workflowId, node: e.nodeId, reason: jsonField(turnFailure ?? 'transient judge failure', LIMITS.blockReasonMax) })
    await this.subagents.retireJudge(run, oldSessionId).catch(() => {})
    // Issue #247：旧 Judge 会话的登记随退役按会话失效（其迟到终态只进观察模块的
    // 有界暂存，不再进入结算）。
    this.forgetDispatch(oldSessionId)
    try {
      const cwd = await this.cwdResolver(run)
      if (!await this.stillCurrent(ws, e, version + 1)) { await this.subagents.retireJudge(run, e.judge.sessionId).catch(() => {}); return }
      const packet = this.judgePacket(run, e, cwd, ws)
      const sent = await this.subagents.startJudge(run, packet)
      const current = await this.stillCurrent(ws, e, version + 1)
      if (!current) { await this.subagents.retireJudge(run, e.judge.sessionId).catch(() => {}); return }
      if (sent.judgeSessionId !== e.judge.sessionId || !sent.messageId) throw new WorkflowError('Host returned mismatched Judge identity')
      current.execution.judge!.messageId = sent.messageId
      await this.state.put(ws, current.run, current.version, [change(current.execution)])
      // Issue #221：重试派发同样登记待对账条目（旧 Judge 会话的失效终态由
      // 世代/身份校验丢弃，不得触发第二次重试或推进）。
      await this.trackDispatch(ws, current.run, current.execution, 'judge', 'judge')
      // #203：自动重试重派 Judge 同样是判定中变化，补一条结构化事件。
      await this.notifyNodeEvent(current.run, current.execution)
    } catch (error) {
      const current = await this.state.get(ws)
      if (current?.version !== version + 1 || current.execution.executionId !== e.executionId) return
      await this.blockRow(ws, current, withTurnEndFailure(`judge auto-retry failed (已自动重试 1 次): ${error instanceof Error ? error.message : String(error)}`, turnFailure))
    }
  }
  private programParameters(execution: BuiltinProgramExecution, supplied: Record<string, unknown>): Record<string, unknown> {
    if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) throw new WorkflowError('program parameters must be an object')
    const definition = BUILTIN_PROGRAMS[execution.programId]
    if (!definition) throw new WorkflowError(`unknown program ${execution.programId}`)
    const parameters = { ...(execution.config ?? {}), ...supplied }
    const unknown = Object.keys(parameters).filter(key => !(key in definition.parameters))
    if (unknown.length) throw new WorkflowError(`unknown program parameter: ${unknown.join(', ')}`)
    for (const [key, spec] of Object.entries(definition.parameters)) {
      const value = parameters[key]
      if (value === undefined) {
        if (spec.required) throw new WorkflowError(`program parameter ${key} is required`)
      } else if (spec.type === 'string' ? typeof value !== 'string' || value.trim() === '' : typeof value !== 'number' || !Number.isFinite(value)) {
        throw new WorkflowError(`program parameter ${key} must be a ${spec.type}`)
      }
    }
    const encoded = JSON.stringify(parameters)
    if (encoded.length > LIMITS.programParametersMax) throw new WorkflowError(`program parameters must be at most ${LIMITS.programParametersMax} characters`)
    return structuredClone(parameters)
  }
  private effectiveProgramResult(result: ProgramResult, input: string): NonNullable<NonNullable<NodeExecution['program']>['result']> {
    if (result.kind === 'ERROR') {
      const reason = result.reason.trim()
      if (!reason || reason.length > LIMITS.blockReasonMax) throw new WorkflowError('Program ERROR requires a bounded reason')
      return { kind: 'ERROR', reason }
    }
    const handoff = result.handoff === undefined ? input : result.handoff.trim()
    if (!handoff || handoff.length > LIMITS.handoffMax) throw new WorkflowError(`Program handoff must be 1..${LIMITS.handoffMax} characters`)
    const reason = result.kind === 'FAIL' && result.reason?.trim() ? result.reason.trim().slice(0, LIMITS.blockReasonMax) : undefined
    return { kind: result.kind, handoff, ...(reason ? { reason } : {}) }
  }
  /**
   * v3 唯一推进入口：把「已确认的节点结果/流程返回」按静态 Target 原子交接。
   * 每次推进恰好走一条边、创建一个后继；没有优先级路由、没有默认路由。
   * 流程返回发生在子流程时沿调用链逐层 pop：每层按**本层** `onReturn` 映射得到上一层
   * 的 Target（允许重命名），各层退出、frame pop、后继登记或 Root 终局同一次事务提交。
   */
  private async advanceKnownResult(ws: string, row: RuntimeRow, kind: 'result' | 'return', name: string, handoff: string, ...events: NodeExecutionEvent['type'][]): Promise<EngineOutcome> {
    const { run, execution: e, version } = row
    const node = this.nodeAt(run, topFrame(run))!
    const target: Target | undefined = kind === 'result' ? resultDefOf(node, name)?.target : { return: name }
    if (!target) {
      e.phase = 'settling'
      delete e.blockDiagnostic
      e.blockReason = this.blockReason(`result "${name}" has no configured Target`)
      run.status = 'blocked'
      await this.state.put(ws, run, version, [change(e, ...events, 'blocked')])
      await this.notifyBlock(run, e, e.blockReason, '材料已保存；Manager 核查后可显式恢复。')
      return { ok: true, run, message: e.blockReason }
    }
    // `reuse: node` 的会话生命周期止于节点：先 drain 会话（失败降级为仅撤权，不阻塞推进），
    // 再删映射；映射删除随节点推进在同一次 state.put 落库。旧会话由 authz 的精确比对失权。
    const released = await this.releaseNodeScopedActor(run, node)
    const at = new Date().toISOString()
    e.phase = 'exited'
    e.exitedAt = at
    e.returned = decisionOf(target, name, e.executionId)
    const changes = [change(e, ...events, 'exited')]
    let exited = e
    let next: Target = target
    let nextName = name
    let terminalVisit = e.visit
    while ('return' in next && run.callStack.length > 1) {
      const returnName = next.return
      run.callStack.pop()
      const parentFrame = topFrame(run)
      const parent = await this.state.execution(ws, parentFrame.executionId)
      const parentNode = this.nodeAt(run, parentFrame)
      const mapped = parentNode === undefined ? undefined : nodeOnReturn(parentNode)?.[returnName]
      if (!parent || parentNode?.execution.type !== 'child-workflow' || mapped === undefined
        || parent.phase !== 'working' || !parent.child || parent.child.result) throw new WorkflowError('stale or corrupt Child return')
      // 返回来源链：本层 caller 记录子流程终局工作单的 executionId 与 handoff 原文（不重摘要、不追加第二份）。
      parent.child.result = { terminalExecutionId: exited.executionId, handoff }
      parent.phase = 'exited'
      parent.exitedAt = at
      // 本层 caller 的裁决名是**被调用流程实际返回的名字**（映射键），不是最底层结果名。
      parent.returned = decisionOf(mapped, returnName, parent.executionId)
      terminalVisit = Math.max(terminalVisit, parent.visit)
      changes.push(change(parent, 'child-returned', 'exited'))
      exited = parent
      next = mapped
      nextName = returnName
    }
    let completedReturn: string | undefined
    if ('return' in next) {
      // Root 流程返回 = Run 的业务终局；Run 状态只表示执行已结束，业务返回单独记录。
      // handoff 仍是终局工作单上的原文，不另存一份镜像。
      completedReturn = next.return
      run.status = 'completed'
      run.currentExecutionId = exited.executionId
      run.callStack = []
      run.businessReturn = { name: completedReturn, source: exited.executionId }
    } else {
      run.currentExecutionId = newNodeToken()
      const frame = topFrame(run)
      frame.nodeId = next.node
      frame.nodeToken = newNodeToken()
      frame.executionId = run.currentExecutionId
      // 直接前驱是刚退出的 caller（本层映射的实际出口）：后继的控制上下文据此给出该 Child 返回名。
      const successor = this.newExecution(run, handoff, terminalVisit + 1, exited.executionId)
      for (const entry of changes) entry.execution.successorId = successor.executionId
      changes.push({ execution: successor, expectedRevision: null, events: ['entered'] })
    }
    await this.state.put(ws, run, version, changes)
    this.trace(run, 'ROUTE', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result: kind === 'return' ? `return:${name}` : name, target: 'node' in next ? next.node : `return:${next.return}` })
    if (released) this.trace(run, 'RELEASE', { workflow: e.workflowId, role: released.role, drained: released.drained })
    if (completedReturn !== undefined) {
      this.traceWarned.delete(run.runId)
      // #216：Run 终局通知（动态 preset 注销等），best-effort。
      try { this.runClosed?.(run) } catch { /* 终局通知失败不影响推进结果 */ }
      // 业务返回名逐字呈现：cancelled 之类的业务终局不被一概渲染成交付成功。
      const chain = exited === e ? '' : `；经 Child 逐层映射：${nextName}`
      const terminal = `workflow "${run.catalogWorkflowId}" 业务终局：${completedReturn}（节点结果：${name}${chain}；run ${run.runId}）。Run 状态 completed 表示执行已结束，业务返回见上；handoff 为终局工作单原文。\n\n[handoff]\n${handoff}`
      // #203：终局本身就是 Manager 可见的通知，首部携带结构化事件，不另发一条。
      await this.targets.steerManager(run, `${this.nodeEventText(run, exited)}\n${terminal}`).catch(() => {})
    } else {
      // #203：节点退出（推进到后继）对 Manager 不可见，补一条结构化事件。
      await this.notifyNodeEvent(run, e)
    }
    return { ok: true, run, message: `${kind === 'return' ? 'return ' : ''}${name} committed` }
  }
  /**
   * v3 派发控制上下文：共同条件与全部合法结果条件同源取自**冻结快照**（磁盘配置
   * 修改不影响活动 Run）；本 Actor 只提交一个结果。
   */
  private exitContract(node: NodeDef): string {
    const criteria = nodeChecker(node)?.config.criteria ?? ''
    return criteria === '' ? '' : `\n\n[验收合同·共同条件]\n${criteria}`
  }
  private legalResults(node: NodeDef): string {
    const names = declaredResults(node)
    if (names.length === 0) return ''
    const entries = names.map(name => `- ${name}：${resultDefOf(node, name)!.criteria}`).join('\n')
    return `\n\n[合法结果与各自条件]\n${entries}\n本次只能选择一个结果提交（互斥出口）。`
  }
  /**
   * 直接前驱的已确认结果由插件提供（Actor 提交的是节点结果名，Program 是 PASS/FAIL），
   * 不从 handoff 文本猜测、也不允许 Actor 伪造。Root 首次派发没有前驱，段落省略。
   */
  private async predecessorResultContext(ws: string, e: NodeExecution): Promise<string> {
    if (e.predecessorId === undefined) return ''
    const predecessor = await this.state.execution(ws, e.predecessorId)
    if (predecessor?.returned === undefined) return ''
    return `\n\n[直接前驱结果]\n前驱节点 ${predecessor.nodeId} 已确认结果：${predecessor.returned.name}（kind: ${predecessor.returned.kind}）`
  }
  /**
   * 直接前驱的待收口 Judge（转交的门）。Actor 前驱就是它自己的 Judge；Child caller 自身
   * 没有 Judge，转交的门在子流程终局工作单上——两层及以上连续返回时沿
   * `child.result.terminalExecutionId` 逐层下探到真正有 Judge 的那张工作单。
   */
  private async transferJudge(ws: string, predecessor: NodeExecution): Promise<{ owner: NodeExecution; judge: ExecutionJudge } | undefined> {
    const seen = new Set<string>()
    let current: NodeExecution | undefined = predecessor
    while (current !== undefined && !seen.has(current.executionId)) {
      seen.add(current.executionId)
      if (current.judge) return { owner: current, judge: current.judge }
      const terminalId: string | undefined = current.child?.result?.terminalExecutionId
      current = terminalId === undefined ? undefined : await this.state.execution(ws, terminalId)
    }
    return undefined
  }
  /**
   * `reuse: node` 离开节点时的会话释放：drain 内存驻留（best-effort——失败降级为仅撤权，
   * 绝不阻塞节点推进），并删除映射使旧会话失权（authz 按 roleActors 精确比对）。
   * 映射删除由调用方随节点推进并进同一次 state.put。
   */
  private async releaseNodeScopedActor(run: RunState, node: NodeDef): Promise<{ role: string; drained: boolean } | undefined> {
    const role = node.execution.type === 'actor-task' ? node.execution.role : undefined
    if (role === undefined || role === 'manager' || run.roleActors[role] === undefined) return undefined
    if (roleReuseMode(run.definitionSnapshot.roles[role]) !== 'node') return undefined
    let drained = true
    try { await this.subagents.drainRoleActor(run, role) } catch { drained = false }
    delete run.roleActors[role]
    return { role, drained }
  }
  async handleClaim(ws: string, claim: NodeClaim, caller: ClaimCaller): Promise<EngineOutcome> {
    try { claim = normalizeNodeClaim(claim) } catch (error) { return rejected(String(error)) }
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'running') return rejected('no running work order')
    const e = row.execution
    if (e.phase !== 'working' || e.claim || !matches(e.dispatch, caller)) return rejected('当前调用无法绑定到一个已 dispatch 的 Node')
    // v3：结果名必须在**当前冻结节点**声明中；运行时枚举校验先于任何状态写入，
    // 非法提交既不消费派发资格也不留下部分状态。
    const node = this.nodeAt(row.run, topFrame(row.run))
    const declared = declaredResults(node)
    if (!declared.includes(claim.result)) {
      return rejected(declared.length === 0
        ? `${node?.execution.type ?? 'current'} node declares no results; node_claim is not applicable`
        : `unknown result "${claim.result}"; declared results: ${declared.join(', ')}`)
    }
    e.claim = { ...claim, id: newNodeToken(), dispatchId: e.dispatch!.id }
    e.phase = 'checking'
    // lease消费就是该事务中的phase/claim更新；失败不改内存权威，没有第二本lease book。
    await this.state.put(ws, row.run, row.version, [change(e, 'claim')])
    this.trace(row.run, 'CLAIM', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result: claim.result, handoff: jsonField(claim.handoff, LIMITS.handoffMax) })
    // #203：Actor 已提交结果（checking）对 Manager 不可见，补一条结构化事件。
    await this.notifyNodeEvent(row.run, e)
    return { ok: true, run: row.run, message: 'claim saved; waiting for Actor safe settlement' }
  }
  async handleJudgeClaim(ws: string, token: string, result: 'ACCEPT' | 'REJECT' | 'NEED_CONTEXT', reason: string, caller: ClaimCaller): Promise<EngineOutcome> {
    reason = reason.trim()
    if (!['ACCEPT', 'REJECT', 'NEED_CONTEXT'].includes(result) || !reason || reason.length > LIMITS.reasonMax) return rejected('invalid Judge result/reason')
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'running') return rejected('no running work order')
    const { run, execution: e, version } = row
    const alreadyJudged = e.judgment !== undefined && e.judgment.claimId === e.claim?.id && e.judgment.inputVersion === e.inputVersion
    if (e.nodeToken !== token || e.phase !== 'checking' || !e.claim || !e.judge || alreadyJudged
      || e.judge.claimId !== e.claim.id || e.judge.inputVersion !== e.inputVersion || !matches(e.judge, caller)) return rejected('stale or unbound Judge submission')
    if (e.resolution?.target === 'judge') {
      delete e.resolution.judgeMode
      delete e.resolution.judgeSessionId
    }
    if (result === 'REJECT') {
      const rejectedClaim = e.claim
      const rejectedJudge = e.judge
      e.previousClaim = rejectedClaim
      e.previousJudge = rejectedJudge
      e.judgment = {
        result, reason, claimId: rejectedClaim.id, judgeDispatchId: rejectedJudge.id,
        judgeSessionId: rejectedJudge.sessionId!, inputVersion: rejectedJudge.inputVersion,
      }
      delete e.claim
      delete e.judge
      // Issue #200：REJECT 回到 ready 是全新检查轮次，自动重试预算重置。
      delete e.judgeAutoRetried
      e.phase = 'ready'
      e.inputVersion++
      if (e.resolution?.context) e.resolution = { target: 'actor', context: e.resolution.context, inputVersion: e.inputVersion }
      else delete e.resolution
      await this.state.put(ws, run, version, [change(e, 'judgment')])
      this.trace(run, 'JUDGE', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result, reason: jsonField(reason, LIMITS.reasonMax), judge: shortId(rejectedJudge.sessionId!) })
      await this.subagents.retireJudge(run, rejectedJudge.sessionId!).catch(() => {})
      // #203：REJECT 回到 ready 是 Manager 可见的判定结论，补一条结构化事件（后继重派发另有事件）。
      await this.notifyNodeEvent(run, e)
      await this.drive(ws)
      return { ok: true, run, message: 'REJECT committed; Actor correction prepared' }
    }
    if (result === 'NEED_CONTEXT') {
      const judge = e.judge
      delete e.previousJudge
      delete e.previousClaim
      e.judgment = {
        result, reason, claimId: e.claim.id, judgeDispatchId: judge.id,
        judgeSessionId: judge.sessionId!, inputVersion: judge.inputVersion,
      }
      delete e.blockDiagnostic
      e.blockReason = this.blockReason(`Judge NEED_CONTEXT: ${reason}`)
      run.status = 'blocked'
      await this.state.put(ws, run, version, [change(e, 'judgment', 'blocked')])
      this.trace(run, 'JUDGE', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result, reason: jsonField(reason, LIMITS.reasonMax), judge: shortId(judge.sessionId!) })
      await this.subagents.retireJudge(run, judge.sessionId!).catch(() => {})
      await this.notifyBlock(run, e, e.blockReason, '请用 node_resume target=judge 提供完整当前补充；已保存 claim 不会丢失。')
      return { ok: true, run, message: 'NEED_CONTEXT committed; Manager context required' }
    }
    delete e.previousJudge
    delete e.previousClaim
    const judgeSessionId = e.judge.sessionId
    e.judgment = {
      result, reason, claimId: e.claim.id, judgeDispatchId: e.judge.id,
      judgeSessionId, inputVersion: e.judge.inputVersion,
    }
    const graphResult = e.claim.result
    const advanced = await this.advanceKnownResult(ws, row, 'result', graphResult, e.claim.handoff, 'judgment')
    this.trace(run, 'JUDGE', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result, reason: jsonField(reason, LIMITS.reasonMax), judge: shortId(judgeSessionId) })
    await this.subagents.retireJudge(run, judgeSessionId).catch(() => {})
    // 后继只由Judge的精确、安全turn settlement驱动，绝不在自身提交Turn里drain。
    return advanced
  }

  /**
   * Host 必须退出append回调再调用；caller只带该turn/end对应Turn的消息ID。
   * `turnFailure` 是该 Turn 的非正常结束诊断（#29/#24 O1），作用于「回合无产出」的
   * 两条 BLOCK（Actor 与 Judge）：正常结束/无诊断时不追加任何文字，成功路径零噪音。
   * `failureFacts` 是同一 Turn 的结构化失败事实（#235）：故障切换资格按 code/status
   * 判定，不解析诊断文本。
   */
  async handleTurnEnded(ws: string, caller: ClaimCaller, turnFailure?: string, failureFacts?: ActorFailureFacts): Promise<EngineOutcome | undefined> {
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'running') return
    let e = row.execution
    if (e.phase === 'ready' && e.predecessorId) {
      const predecessor = await this.state.execution(ws, e.predecessorId)
      const transfer = predecessor === undefined ? undefined : await this.transferJudge(ws, predecessor)
      if (!transfer || !matches(transfer.judge, caller) || transfer.judge.settled) return
      const settledSafe = await this.safetyProbe(ws, row, caller.sessionId, transfer.judge.id)
      if (settledSafe === undefined) return
      // #54：Judge 结算路径没有"等待并行子代理"语义——waiting 在此仍是收口未知，
      // 与 unsafe 同样 BLOCK（本 PR 未改变该行为，仅保留折叠）。
      const fresh = await this.stillCurrent(ws, e, row.version)
      if (!fresh) return
      if (inspectionStatus(settledSafe) !== 'safe') { await this.blockRow(ws, fresh, { reason: 'Judge/known tools not safely closed', diagnostic: inspectionDiagnostic(settledSafe, caller.sessionId, transfer.judge.id) }); return }
      transfer.judge.settled = true
      await this.state.put(ws, fresh.run, fresh.version, [change(transfer.owner)])
      this.forgetDispatch(caller.sessionId, transfer.judge.id)
      await this.drive(ws)
      return
    }
    const actor = matches(e.dispatch, caller) && !e.dispatch!.settled
    const judge = matches(e.judge, caller) && !e.judge!.settled
    if (!actor && !judge) return
    const safe = await this.safetyProbe(ws, row, caller.sessionId, actor ? e.dispatch!.id : e.judge!.id)
    if (safe === undefined) return
    const fresh = await this.stillCurrent(ws, e, row.version)
    if (!fresh) return
    e = fresh.execution
    // #54：该会话的 turn 以空回合结束、但仍有 running 子代理 → 它是在等并行子代理，
    // 不是异常闭合。不结算、不 BLOCK：claim 绑定与 nodeToken 保持有效，等子代理
    // 完成后的下一回合照常提交 node_claim（绑定不再被解除，#54 的"claim 被拒后同
    // turn 自恢复"兜底因此不需要）。
    // ponytail: 只覆盖"期望中的等待"；子代理永不 settle 时 Run 留在 working，
    // 由 Manager 经 workflow_status + node_block/node_resume 兜底，不做等待超时。
    if (inspectionStatus(safe) === 'waiting') return
    if (inspectionStatus(safe) === 'unsafe') { await this.blockRow(ws, fresh, { reason: 'Actor/Judge or known tools not safely closed', diagnostic: inspectionDiagnostic(safe, caller.sessionId, actor ? e.dispatch!.id : e.judge!.id) }); return }
    if (actor && e.phase === 'checking') {
      e.dispatch!.settled = true
      await this.state.put(ws, fresh.run, fresh.version, [change(e)])
      this.forgetDispatch(e.dispatch?.sessionId, e.dispatch?.id)
      await this.drive(ws)
    } else if (actor && e.phase === 'working') {
      // #235：先尝试「单备用模型」安全恢复（旧执行已收口 + 无已接受 claim 才重派）；
      // 不合格故障或已无可用路由时保持现行 BLOCK。
      if (await this.tryFailover(ws, fresh, failureFacts) === 'switched') return
      this.forgetDispatch(e.dispatch?.sessionId, e.dispatch?.id)
      await this.blockRow(ws, fresh, withTurnEndFailure('actor-turn-ended-without-result', turnFailure))
    } else if (judge && e.phase === 'checking') {
      // #236：配置了 Judge 备用路由时，合格故障且已安全收口就直接切 B——不再叠加
      // #200 的同主模型 fresh 重试；B 终止失败直接 BLOCK，不追加插件级自动重试。
      if (roleFallbackRoute(fresh.run, 'judge') !== undefined
        || (e.judge?.configRevision ?? 0) !== roleModelConfig(fresh.run, 'judge').revision) {
        const verdict = await this.tryJudgeFailover(ws, fresh, failureFacts)
        if (verdict === 'switched') return
        this.forgetDispatch(e.judge?.sessionId, e.judge?.id)
        // #243 D2：切换尝试已判定过「有没有备用 / 故障是否合格 / 预算是否用尽」，收口
        // 文案直接取它的结论；不再从阶段与故障资格重推（额度等不合格故障即使当前阶段
        // 是 fallback，也不能误报成「备用路由用尽」）。
        await this.blockRow(ws, fresh, withTurnEndFailure(verdict === 'exhausted'
          ? 'judge turn ended without judge_claim (备用模型已用尽，不再自动重试)'
          : 'judge turn ended without judge_claim', turnFailure))
        return
      }
      // Issue #200：瞬时失败有界自动重试 1 次（fresh 新会话重派）；已重试过或非瞬时
      // （4xx 等）直接 BLOCK。fail-closed/只读不变量不变。
      if (isTransientJudgeFailure(turnFailure) && !e.judgeAutoRetried) await this.retryJudgeOnce(ws, fresh, turnFailure)
      else if (e.judgeAutoRetried) {
        this.forgetDispatch(e.judge?.sessionId, e.judge?.id)
        await this.blockRow(ws, fresh, withTurnEndFailure('judge turn ended without judge_claim (已自动重试 1 次)', turnFailure))
      } else {
        this.forgetDispatch(e.judge?.sessionId, e.judge?.id)
        await this.blockRow(ws, fresh, withTurnEndFailure('judge turn ended without judge_claim', turnFailure))
      }
    }
  }
  /** #287：合格故障按登记配置归属恢复；旧轮故障首派新主不扣预算，新主→当前备→BLOCK。 */
  private async tryFailover(ws: string, row: RuntimeRow, facts: ActorFailureFacts | undefined, configRetries = 0): Promise<FailoverVerdict> {
    const { run, execution: e } = row
    const node = this.nodeAt(run, topFrame(run))
    if (node?.execution.type !== 'actor-task') return 'ineligible'
    const role = node.execution.role
    // Manager 没有备用链；Judge 的备用路由属 #236（本节点不切换，保留同模型重试）。
    if (role === 'manager') return 'ineligible'
    if (e.claim !== undefined) return 'ineligible'
    const verdict = classifyActorFailure(facts)
    if (facts === undefined || !verdict.eligible) return 'ineligible'
    const config = roleModelConfig(run, role)
    const superseded = (e.dispatch?.configRevision ?? 0) !== config.revision
    const fallback = roleFallbackRoute(run, role)
    const stage = effectiveRoleRouteStage(run, role)
    if (!superseded && stage === 'fallback') return 'exhausted'
    const next = superseded || stage === 'manual' ? 'primary' : 'fallback'
    if (next === 'fallback' && (fallback === undefined || sameModelRoute(config.primary, fallback))) return 'ineligible'
    const from = shortRouteLabel(e.dispatch?.model) ?? 'unknown'
    const target = next === 'primary' ? config.primary : fallback!
    const to = shortRouteLabel(target) ?? 'unknown'
    // 旧配置的在途失败只触发新主模型首派，不消耗新配置恢复预算。
    const autoSwitches = (run.roleRoutes?.[role]?.autoSwitches ?? 0) + (superseded ? 0 : 1)
    const reason = `${verdict.kind} ${describeActorFailure(facts)}`
    const oldSessionId = e.dispatch?.sessionId
    const oldDispatchId = e.dispatch?.id
    e.dispatch!.settled = true
    // 仅兼容旧 Run 的 manual 状态；新配置的当前主模型不会退回冻结定义。
    if (stage === 'manual') delete run.modelOverrides[role]
    run.roleRoutes = { ...(run.roleRoutes ?? {}), [role]: { stage: next, reason, autoSwitches } }
    // 派发代际更新不等于会话换代；正常 node/continuable 生命周期仍由既有边界负责。
    e.phase = 'ready'
    e.inputVersion += 1
    e.resolution = {
      target: 'actor',
      // decision 是审计短标记（resolution 需要 context 或 decision 二者之一）；
      // 面向 Actor 的人类说明走 failover 段，不占 Manager 的 context 位。
      decision: `auto-failover ${verdict.kind} → ${next}`,
      failover: failoverNote({ role, from, to, target: next, facts, kind: verdict.kind, autoSwitches, exhausted: next === 'fallback' }),
      inputVersion: e.inputVersion,
    }
    try { await this.state.put(ws, run, row.version, [change(e, 'model-changed')]) }
    catch (error) {
      if (!(error instanceof ModelConfigConflictError) || configRetries >= 2) throw error
      const current = await this.state.get(ws)
      if (current?.run.status !== 'running' || current.run.runId !== run.runId
        || current.execution.nodeToken !== e.nodeToken || current.execution.dispatch?.id !== oldDispatchId) return 'switched'
      return this.tryFailover(ws, current, facts, configRetries + 1)
    }
    this.forgetDispatch(oldSessionId, oldDispatchId)
    this.trace(run, 'MODEL-FALLBACK', {
      workflow: e.workflowId, node: e.nodeId, role,
      from: jsonField(from, LIMITS.modelIdMax), to: jsonField(to, LIMITS.modelIdMax),
      stage: next, switch: autoSwitches, reason: jsonField(reason, LIMITS.blockReasonMax),
    })
    // 成功切换主动通知 Manager（无需批准）；best-effort，绝不阻断重派。
    await this.targets.steerManager(run, `${this.nodeEventText(run, e)}\nWorkflow MODEL FALLBACK: role=${role} ${from} → ${to}（${next}，本轮第 ${autoSwitches} 次自动切换，原因 ${reason}）\n该角色已用新路由重新派发，无需批准；后续合格故障仍按当前配置的有限主备轮次处理。`).catch(() => {})
    await this.drive(ws)
    return 'switched'
  }
  /**
   * #236：Judge 单备用模型的安全恢复（A→B→BLOCK，与 Actor 同构但判定材料不变）。
   *
   * 前提由调用点保证：Judge 的本 Turn 已结束且会话已安全收口（unsafe/waiting 在更早
   * 分支 BLOCK/return），执行仍在 `checking` 且 claim/judge 均有效。切换只换派发
   * 路由：claim、判定材料、冻结 criteria 与 inputVersion 原样保留，新 Judge 继续判
   * 同一个 claim（不补做 Actor 的工作），旧会话只撤权（不在 Judge 自己的判定调用里
   * drain 自己）。
   *
   * 预算与普通角色独立（`roleRoutes.judge`）并随 Run 行持久化：node_resume/Host 重启
   * 都不刷新；切到 B 后本 Run 后续判定保持 B，B 再失败直接 BLOCK（不叠加插件级重试，
   * 也不回到 A）。返回 `switched` 表示已切 B 并重派；`exhausted`（备用用尽）/`ineligible`
   * （未配置备用、故障不合格、主备同路由等）交回 BLOCK 路径。
   */
  private async tryJudgeFailover(ws: string, row: RuntimeRow, facts: ActorFailureFacts | undefined, configRetries = 0): Promise<FailoverVerdict> {
    const { run, execution: e, version } = row
    if (e.phase !== 'checking' || !e.claim || !e.judge) return 'ineligible'
    const verdict = classifyActorFailure(facts)
    if (facts === undefined || !verdict.eligible) return 'ineligible'
    const config = roleModelConfig(run, 'judge')
    const superseded = (e.judge.configRevision ?? 0) !== config.revision
    const fallback = roleFallbackRoute(run, 'judge')
    const stage = effectiveRoleRouteStage(run, 'judge')
    if (!superseded && stage === 'fallback') return 'exhausted'
    const next = superseded || stage === 'manual' ? 'primary' : 'fallback'
    if (next === 'fallback' && (fallback === undefined || sameModelRoute(config.primary, fallback))) return 'ineligible'
    const target = next === 'primary' ? config.primary : fallback!
    const from = shortRouteLabel(e.judge.model) ?? 'unknown'
    const to = shortRouteLabel(target) ?? 'unknown'
    const autoSwitches = (run.roleRoutes?.judge?.autoSwitches ?? 0) + (superseded ? 0 : 1)
    const reason = `${verdict.kind} ${describeActorFailure(facts)}`
    const previousSessionId = e.judge.sessionId
    const previousJudgeId = e.judge.id
    // 仅兼容旧 manual 状态；新配置切备后保持当前备用。
    if (stage === 'manual') delete run.modelOverrides.judge
    run.roleRoutes = { ...(run.roleRoutes ?? {}), judge: { stage: next, reason, autoSwitches } }
    // 判定材料与 inputVersion 不变：新 Judge 判同一 claim，旧会话的迟到提交/Turn 结算
    // 因 e.judge 身份失配被丢弃（预算不会被扣第二次）。判定中不刷新同模型重试预算。
    e.judge = { id: newNodeToken(), sessionId: previousSessionId, claimId: e.claim.id, inputVersion: e.inputVersion, settled: false, model: target, source: next, configRevision: config.revision }
    try { await this.state.put(ws, run, version, [change(e, 'model-changed', 'judge-arranged')]) }
    catch (error) {
      if (!(error instanceof ModelConfigConflictError) || configRetries >= 2) throw error
      const current = await this.state.get(ws)
      if (current?.run.status !== 'running' || current.run.runId !== run.runId
        || current.execution.nodeToken !== e.nodeToken || current.execution.judge?.id !== previousJudgeId) return 'switched'
      return this.tryJudgeFailover(ws, current, facts, configRetries + 1)
    }
    this.forgetDispatch(previousSessionId, previousJudgeId)
    this.trace(run, 'MODEL-FALLBACK', {
      workflow: e.workflowId, node: e.nodeId, role: 'judge',
      from: jsonField(from, LIMITS.modelIdMax), to: jsonField(to, LIMITS.modelIdMax),
      stage: next, switch: autoSwitches, reason: jsonField(reason, LIMITS.blockReasonMax),
    })
    // 成功切换主动通知 Manager（无需批准）；best-effort，绝不阻断重派。
    await this.targets.steerManager(run, `${this.nodeEventText(run, e)}\nWorkflow MODEL FALLBACK: role=judge ${from} → ${to}（${next}，本轮第 ${autoSwitches} 次自动切换，原因 ${reason}）\nJudge 已用新路由重新派发判定同一 claim，无需批准；后续合格故障仍按当前配置的有限主备轮次处理。`).catch(() => {})
    try {
      const cwd = await this.cwdResolver(run)
      if (!await this.stillCurrent(ws, e, version + 1)) { await this.subagents.retireJudge(run, e.judge.sessionId).catch(() => {}); return 'switched' }
      const packet = this.judgePacket(run, e, cwd, ws)
      const message = await this.subagents.followupJudge(run, previousSessionId, packet)
      const sent = { judgeSessionId: previousSessionId, ...message }
      const current = await this.stillCurrent(ws, e, version + 1)
      if (!current) { await this.subagents.retireJudge(run, e.judge.sessionId).catch(() => {}); return 'switched' }
      if (sent.judgeSessionId !== e.judge.sessionId || !sent.messageId) throw new WorkflowError('Host returned mismatched Judge identity')
      current.execution.judge!.messageId = sent.messageId
      await this.state.put(ws, current.run, current.version, [change(current.execution)])
      await this.trackDispatch(ws, current.run, current.execution, 'judge', 'judge')
      await this.notifyNodeEvent(current.run, current.execution)
      return 'switched'
    } catch (error) {
      const current = await this.state.get(ws)
      if (current?.version !== version + 1 || current.execution.executionId !== e.executionId) return 'switched'
      await this.blockRow(ws, current, withTurnEndFailure(`judge failover dispatch failed (备用路由 ${to}): ${error instanceof Error ? error.message : String(error)}`, undefined))
      return 'switched'
    }
  }
  /**
   * Issue #247：消费一次已归属的派发终止观察（由 `subagent/end` 经 setImmediate
   * 转交，以及发布对账时由 trackDispatch 直接调用）。归属、世代匹配、发布窗口
   * 暂存与去重都由观察模块完成；本方法只判断候选是否仍指向当前工作单，并决定
   * 是否 fail-closed BLOCK：
   * - 工作单已推进/替换/BLOCK/终止，或派发身份已不符 → 候选作废，不影响当前状态；
   * - 已接受的 claim / 已提交的业务交接永不撤销（矩阵 E 的执行完成情形只清登记）；
   * - 明确失败且无可用 turn/end → 技术故障 BLOCK，保留 execution/claim/handoff（矩阵 A）；
   * - 正常 completed 不是失败；不因空消息/idle/耗时推断失败（矩阵 D）；
   * - Judge 不做第二次自动重试：无 turn/end 兜底直接 BLOCK（矩阵 F）。
   */
  async settleActivation(observation: DispatchObservationRef): Promise<void> {
    const lifecycle = this.subagents.dispatchLifecycle
    if (lifecycle === undefined) return
    const candidate = await lifecycle.consume(observation)
    if (candidate === undefined) return
    try {
      const ws = candidate.workspaceKey
      const row = await this.state.get(ws)
      if (!row || row.run.status !== 'running' || row.execution.executionId !== candidate.executionId
        || row.execution.nodeToken !== candidate.nodeToken) return
      const e = row.execution
      const sessionId = candidate.sessionId
      if (candidate.kind === 'actor') {
        const dispatch = e.dispatch
        if (!dispatch || dispatch.id !== candidate.dispatchId || dispatch.sessionId !== sessionId || dispatch.settled
          || e.claim?.dispatchId === candidate.dispatchId || e.phase !== 'working') return
      } else {
        const judge = e.judge
        if (!judge || judge.id !== candidate.dispatchId || judge.sessionId !== sessionId || judge.settled
          || judge.claimId !== candidate.claimId || judge.inputVersion !== candidate.inputVersion || e.phase !== 'checking') return
      }
      // 明确的执行失败证据（activation.result 终态）优先于终态边。
      if (candidate.outcome !== 'failed') {
        // 矩阵 D：正常 completed 不是失败；不因空消息、idle 或耗时推断失败。
        if (candidate.end.stopReason === 'completed') return
        // 矩阵 E：执行已完成、仅清理失败 → 不是"Actor 无结果失败"，只清登记，
        // 不 BLOCK、不撤销 claim/交接。
        if (candidate.outcome === 'completed') return
      }
      await this.blockRow(ws, row, describeActivationSettlement(candidate))
    } finally {
      // 异步处理结束后精确失效原登记：替换后的新登记不受影响。
      lifecycle.release(observation)
    }
  }
  async handleBlock(ws: string, token: string | undefined, reason: string, caller: ClaimCaller): Promise<EngineOutcome> {
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'running') return rejected('no current running Node/token')
    // #212：Actor 无 token 显式 BLOCK——与 node_claim 的派发 lease 绑定同构：
    // 仅当前未 settled 派发的本人、working 期且无 pending claim 时受理，
    // blockReason 为业务原因而非 actor-turn-ended-without-result。
    if (token === undefined) {
      const e = row.execution
      if (e.phase !== 'working' || e.claim || e.dispatch?.settled || !matches(e.dispatch, caller)) {
        return rejected('tokenless node_block requires the current unsettled dispatch in working phase without a pending claim')
      }
    } else if (row.execution.nodeToken !== token) return rejected('no current running Node/token')
    reason = reason.trim()
    if (!reason || reason.length > LIMITS.blockReasonMax) return rejected('invalid block reason')
    const node = this.nodeAt(row.run, topFrame(row.run))
    // Manager 是 Run 的 owner：只有当当前 Node 不是 manager 自己的 actor-task 时才算「控制者」。
    const control = row.run.managerSessionId === caller.sessionId
      && !(node?.execution.type === 'actor-task' && node.execution.role === 'manager')
    if (!control && (row.execution.phase !== 'working' || !matches(row.execution.dispatch, caller))) return rejected('unbound dispatch')
    await this.blockRow(ws, row, reason)
    return { ok: true, run: row.run, message: 'blocked' }
  }
  async handleRestartReconcile(): Promise<void> {
    for (const row of await this.state.listRuns()) {
      if (row.run.status === 'completed' || row.run.status === 'terminated' || row.execution.restartPending) continue
      try {
        row.execution.restartPending = true
        if (row.run.status === 'running') await this.blockRow(row.workspaceKey, row, 'host restarted; saved work retained; Manager resume must confirm the recovery target', 'interrupted')
        else await this.state.put(row.workspaceKey, row.run, row.version, [change(row.execution, 'interrupted')])
      } catch (error) { this.traceWarn?.(`restart reconciliation failed: ${String(error)}`) }
    }
  }
  async handleResume(ws: string, token: string, context: string, caller: string, target: ResumeTarget = 'auto', skipCompact = false): Promise<EngineOutcome> {
    context = context.trim()
    if (!context || context.length > LIMITS.resolutionMax || !['auto', 'actor', 'judge'].includes(target)) return rejected('invalid resolution context/target')
    // #198：单次逃生只认显式 `true`（缺省 false；非布尔由工具层拒绝）。
    const skip = skipCompact === true
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'blocked' || row.execution.nodeToken !== token) return rejected('node_resume requires the current BLOCK/token')
    const { run, execution: e, version } = row
    if (caller !== run.managerSessionId) return rejected('node_resume is Manager-only')
    const node = this.nodeAt(run, topFrame(run))
    if (!node || e.phase === 'exited') return rejected('resume target is not applicable to this execution')
    let recoveredPredecessor: NodeExecution | undefined
    if (e.phase === 'ready' && e.predecessorId) {
      const predecessor = await this.state.execution(ws, e.predecessorId)
      const transfer = predecessor === undefined ? undefined : await this.transferJudge(ws, predecessor)
      if (!await this.sameRow(ws, row)) return rejected('stale resume request after predecessor inspection')
      if (transfer && !transfer.judge.settled) {
        // 转交的门（Actor 前驱自己的 Judge，或 Child caller 子流程终局工作单的 Judge）在重启
        // 现场允许 Manager 确认后补收口：该终局必须已 ACCEPT 且恰好登记了本后继。
        const owner = transfer.owner
        const terminalAccepted = owner.phase === 'exited' && owner.successorId === e.executionId
          && owner.judgment?.result === 'ACCEPT' && owner.judgment.claimId === owner.claim?.id
          && owner.judgment.judgeDispatchId === owner.judge?.id
        if (!e.restartPending || !terminalAccepted) return rejected('predecessor Judge is not safely settled; keep BLOCK until its activity is resolved')
        owner.judge!.settled = true
        this.forgetDispatch(owner.judge?.sessionId, owner.judge?.id)
        recoveredPredecessor = owner
      }
    }
    if (node.execution.type === 'child-workflow') {
      // Child 调用层没有 Actor/Judge：只有「尚未进入子流程的 ready caller」可恢复；进入后
      // 当前工作单就是子流程栈顶，恢复走子流程自己的节点。
      if (target !== 'auto' || e.phase !== 'ready' || e.child) return rejected('Child resume requires an unentered ready caller and target=auto')
      e.inputVersion++
      e.resolution = { target: 'child', context, inputVersion: e.inputVersion }
      e.restartPending = false
      e.blockReason = null
      delete e.blockDiagnostic
      e.nodeToken = newNodeToken()
      topFrame(run).nodeToken = e.nodeToken
      run.status = 'running'
      run.blockReason = null
      await this.state.put(ws, run, version, [change(e, 'manager-context', 'resumed'), ...(recoveredPredecessor ? [change(recoveredPredecessor)] : [])])
      await this.drive(ws)
      return { ok: true, run, message: `Child caller resume committed; driver invoked${skip ? ' (skipCompact ignored for child resume)' : ''}` }
    }
    if (node.execution.type !== 'actor-task') return rejected('Program recovery requires node_run_program or node_resolve_program')
    const resolvedTarget: Exclude<ResumeTarget, 'auto'> = target === 'auto'
      ? e.phase === 'checking' && e.claim && e.dispatch?.settled && e.judgment?.result !== 'ACCEPT' ? 'judge' : 'actor'
      : target
    const role = node.execution.role
    let replaceRole = false
    if (role !== 'manager' && run.roleActors[role] && (resolvedTarget === 'actor' || !e.dispatch?.settled)) {
      const sessionId = run.roleActors[role]
      const { verdict } = await this.probeSessionIdle(sessionId, () => this.sameRow(ws, row))
      if (verdict === 'safety-stale') return rejected('stale resume request after Role safety inspection')
      if (verdict === 'activity-stale') return rejected('stale resume request after Role activity inspection')
      if (verdict === 'active') return rejected('previous Role execution is not safely closed')
      if (verdict === 'cold-safe' && resolvedTarget === 'actor') {
        const availability = await this.subagents.roleSessionAvailability(sessionId)
        if (!await this.sameRow(ws, row)) return rejected('stale resume request after Role Session inspection')
        replaceRole = availability === 'missing'
      }
    }
    const oldJudge = e.judge
    const oldJudgeSessionId = oldJudge?.sessionId
    let judgeMode: 'followup' | 'fresh' | undefined
    let judgeSessionId: string | undefined
    // #198：单次逃生是否实际生效（仅 actor 目标且此前未准备时置位并记审计）。
    let skippedCompact = false
    if (resolvedTarget === 'judge') {
      if (e.phase !== 'checking' || !e.claim || !e.dispatch || e.judgment?.result === 'ACCEPT') return rejected('judge resume requires an effective claim without a business conclusion')
      // auto never takes this branch while unsettled; explicit target=judge is the Manager's takeover decision.
      if (!e.dispatch.settled) {
        e.dispatch.settled = true
        this.forgetDispatch(e.dispatch.sessionId, e.dispatch.id)
      }
      const sameJudgeNeedContext = oldJudge !== undefined && e.judgment?.result === 'NEED_CONTEXT'
        && e.judgment.claimId === e.claim.id && e.judgment.inputVersion === e.inputVersion
        && e.judgment.judgeDispatchId === oldJudge.id && e.judgment.judgeSessionId === oldJudge.sessionId
      const restartRecovery = e.restartPending
      const historicalNeedContext = e.judgment?.result === 'NEED_CONTEXT' && e.previousJudge?.claimId === e.claim.id
        && e.judgment.judgeDispatchId === e.previousJudge.id && e.judgment.judgeSessionId === e.previousJudge.sessionId
      const unjudgedCurrent = oldJudge !== undefined && (e.judgment === undefined
        || e.judgment.claimId !== e.claim.id || e.judgment.inputVersion !== e.inputVersion)
      const judgeToContinue = sameJudgeNeedContext ? oldJudge
        : historicalNeedContext && !oldJudge ? e.previousJudge
          : restartRecovery && unjudgedCurrent ? oldJudge : undefined
      if ((restartRecovery || sameJudgeNeedContext) && judgeToContinue) {
        // #287：路由更新由 Host 在下次入队前应用，不再因换模制造 fresh 会话。
        const availability = await this.subagents.judgeSessionAvailability(judgeToContinue.sessionId)
        if (!await this.sameRow(ws, row)) return rejected('stale judge resume request after Judge Session inspection')
        if (availability !== 'missing') {
          const { verdict } = await this.probeSessionIdle(judgeToContinue.sessionId, () => this.sameRow(ws, row))
          if (verdict === 'safety-stale') return rejected('stale judge resume request after Judge safety inspection')
          if (verdict === 'activity-stale') return rejected('stale judge resume request after Judge activity inspection')
          // 原条件 !restartRecovery || activity !== 'unknown'：探针 safe 直接放行；
          // 冷会话仅 restart 恢复放行，active 一律拒绝。
          if (verdict === 'active' || (verdict === 'cold-safe' && !restartRecovery)) return rejected('previous Judge turn is not safely closed')
          judgeMode = 'followup'
          judgeSessionId = judgeToContinue.sessionId
        } else {
          try {
            if (!await this.drainJudgeAndRevalidate(ws, row, oldJudge ?? judgeToContinue)) return rejected('stale judge resume request after missing Judge drain')
          } catch (error) { return rejected(`Judge drain failed: ${error instanceof Error ? error.message : String(error)}`) }
          judgeMode = 'fresh'
        }
      } else {
        const judgeToDrain = oldJudge ?? (e.previousJudge?.claimId === e.claim.id ? e.previousJudge : undefined)
        if (judgeToDrain) {
          try {
            if (!await this.drainJudgeAndRevalidate(ws, row, judgeToDrain)) return rejected('stale judge resume request after Judge drain')
          } catch (error) { return rejected(`Judge drain failed: ${error instanceof Error ? error.message : String(error)}`) }
        }
        judgeMode = 'fresh'
      }
      if (sameJudgeNeedContext && oldJudge) e.previousJudge = oldJudge
      delete e.judge
      // Issue #200：Manager 显式恢复是新的人工尝试，自动重试预算重置。
      delete e.judgeAutoRetried
    } else {
      // v3：每个已声明结果都有静态 Target，因此不存在"已 ACCEPT 但没有出口边"的状态；
      // 只有尚可回到 Actor 重新提交的阶段才能 actor resume。
      const canReturnActor = e.phase === 'ready' || (e.phase === 'working' && !e.claim)
        || (e.phase === 'checking' && !!e.claim && e.judgment?.result !== 'ACCEPT')
      if (!canReturnActor) return rejected('actor resume would overwrite a transferable conclusion')
      const relatedClaimId = e.claim?.id ?? e.previousClaim?.id
      const judgeToDrain = oldJudge ?? (e.previousJudge?.claimId === relatedClaimId ? e.previousJudge : undefined)
      if (judgeToDrain) {
        try {
          if (!await this.drainJudgeAndRevalidate(ws, row, judgeToDrain)) return rejected('stale actor resume request after Judge drain')
        } catch (error) { return rejected(`Judge drain failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
      if (e.claim) {
        const returnedClaim = e.claim
        const currentFeedback = e.judgment?.result === 'NEED_CONTEXT' && e.judgment.claimId === returnedClaim.id && e.judgment.inputVersion === e.inputVersion
          && oldJudge !== undefined && e.judgment.judgeDispatchId === oldJudge.id && e.judgment.judgeSessionId === oldJudge.sessionId
        const historicalFeedback = e.judgment?.claimId === returnedClaim.id && e.judgment.inputVersion < e.inputVersion
          && e.previousJudge !== undefined && e.judgment.judgeDispatchId === e.previousJudge.id
          && e.judgment.judgeSessionId === e.previousJudge.sessionId
        e.previousClaim = returnedClaim
        if (currentFeedback && oldJudge) e.previousJudge = oldJudge
        else if (!historicalFeedback) { delete e.judgment; delete e.previousJudge }
      }
      delete e.claim
      delete e.judge
      // Issue #200：回到 ready 是全新检查轮次，自动重试预算重置。
      delete e.judgeAutoRetried
      e.phase = 'ready'
      // #198 单次逃生：仅 actor 目标生效；此前尚未准备才实际跳过并记审计标记
      // （本恢复的置位随同一次状态落库，drive 不再重复压缩；已准备时无压缩可跳，
      // 不留痕）。judge（含 auto 落到 judge）忽略该参数。
      if (skip && !e.roleBoundaryPrepared) {
        e.roleBoundaryPrepared = true
        skippedCompact = true
      }
    }
    if (replaceRole) {
      delete run.roleActors[role]
      // Fresh replacement has no prior cross-Node context to compact; same-execution correction must not compact it later.
      e.roleBoundaryPrepared = true
    }
    e.inputVersion++
    e.resolution = {
      target: resolvedTarget, context, inputVersion: e.inputVersion,
      ...(skippedCompact ? { skipCompact: true as const } : {}),
      ...(resolvedTarget === 'judge' ? { judgeMode: judgeMode!, ...(judgeSessionId ? { judgeSessionId } : {}) } : {}),
    }
    if (resolvedTarget === 'judge') {
      e.judge = {
        id: newNodeToken(), sessionId: judgeSessionId ?? newNodeToken(), claimId: e.claim!.id,
        inputVersion: e.inputVersion, settled: false, ...this.judgeRouteFacts(run),
      }
    }
    e.restartPending = false
    e.blockReason = null
    delete e.blockDiagnostic
    e.nodeToken = newNodeToken()
    topFrame(run).nodeToken = e.nodeToken
    run.status = 'running'
    run.blockReason = null
    await this.state.put(ws, run, version, [
      change(e, 'manager-context', 'resumed', ...(resolvedTarget === 'judge' ? ['judge-arranged' as const] : [])),
      ...(recoveredPredecessor ? [change(recoveredPredecessor)] : []),
    ])
    if (oldJudgeSessionId) await this.subagents.retireJudge(run, oldJudgeSessionId).catch(() => {})
    await this.drive(ws)
    // #198 回执：实际跳过/忽略参数都在消息里明示，恢复记录（resolution.skipCompact）只记实际跳过。
    const skipNote = skippedCompact ? ' (boundary compact skipped for this resume)'
      : skip && resolvedTarget === 'judge' ? ' (skipCompact ignored for judge resume)' : ''
    return { ok: true, run, message: `resume ${resolvedTarget} committed; driver invoked${skipNote}` }
  }
  async handleRespawnJudge(ws: string, token: string, reason = '', caller = ''): Promise<EngineOutcome> {
    reason = reason.trim()
    if (reason.length > LIMITS.reasonMax) return rejected(`reason exceeds ${LIMITS.reasonMax} characters`)
    const row = await this.state.get(ws)
    if (!row || !['running', 'blocked'].includes(row.run.status) || row.execution.nodeToken !== token) return rejected('judge_respawn requires the current Node/token')
    const { run, execution: e, version } = row
    if (caller !== run.managerSessionId) return rejected('judge_respawn is Manager-only')
    if (this.nodeAt(run, topFrame(run))?.execution.type !== 'actor-task' || e.phase !== 'checking' || !e.claim
      || !e.dispatch?.settled || e.judgment?.result === 'ACCEPT') return rejected('judge_respawn requires an effective settled claim without a business conclusion')
    const oldJudge = e.judge
    let arrangedId = ''
    try {
      // 派发前的准入检查：cwd 不可用时在 drain 与安排落库之前失败（不 drain、不提交新安排）；
      // 失败仍按既有 dispatchFault → BLOCK 落库，不是"状态零变更"。
      await this.cwdResolver(run)
      const judgeToDrain = oldJudge ?? (e.previousJudge?.claimId === e.claim.id ? e.previousJudge : undefined)
      if (!await this.drainJudgeAndRevalidate(ws, row, judgeToDrain)) return rejected('stale respawn request after Judge drain')
      const currentFeedback = oldJudge !== undefined && e.judgment?.result === 'NEED_CONTEXT'
        && e.judgment.claimId === e.claim.id && e.judgment.inputVersion === e.inputVersion
        && e.judgment.judgeDispatchId === oldJudge.id && e.judgment.judgeSessionId === oldJudge.sessionId
      e.inputVersion++
      if (currentFeedback && oldJudge) e.previousJudge = oldJudge
      e.resolution = {
        target: 'judge', inputVersion: e.inputVersion, judgeMode: 'fresh',
        ...(e.resolution?.context ? { context: e.resolution.context } : {}),
        decision: reason || 'Manager requested Judge respawn',
      }
      e.restartPending = false
      const arranged: ExecutionJudge = { id: newNodeToken(), sessionId: newNodeToken(), claimId: e.claim.id, inputVersion: e.inputVersion, settled: false, ...this.judgeRouteFacts(run) }
      arrangedId = arranged.id
      e.judge = arranged
      // Issue #200：Manager 显式重建是新的人工尝试，自动重试预算重置。
      delete e.judgeAutoRetried
      e.blockReason = null
      delete e.blockDiagnostic
      run.status = 'running'
      run.blockReason = null
      await this.state.put(ws, run, version, [change(e, 'judge-respawned', 'judge-arranged')])
    } catch (error) {
      // 本段失败点都在派发移交 driver 之前：cwd 准入、drain、安排落库（state.put）；
      // 三者失败均交给 dispatchFault → BLOCK，版本未推进故语义与移除自建派发前一致。
      await this.dispatchFault(ws, e, error, version)
      return rejected(`Judge respawn failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // #98：派发执行统一进入唯一 driver（首次/resume-followup/respawn 同一实现）；
    // driver 是 void + 持久 BLOCK 的，不能机械当成功返回——按落库结果回报：
    // 已发布 messageId 才算提交成功，BLOCK 与 CAS 丢失都要让 Manager 看得见。
    await this.drive(ws)
    const after = await this.state.get(ws)
    if (after === undefined || after.run.runId !== run.runId || after.execution.executionId !== e.executionId) {
      return rejected('stale respawn request after dispatch')
    }
    const published = after.execution.judge
    if (published === undefined || published.id !== arrangedId) return rejected('stale respawn request after dispatch')
    if (after.run.status !== 'running') {
      return rejected(`Judge respawn failed: ${after.run.blockReason ?? after.execution.blockReason ?? 'run is no longer running'}`)
    }
    if (!published.messageId) return rejected('stale respawn result')
    return { ok: true, run: after.run, message: `Judge respawn committed${reason ? `: ${reason}` : ''}` }
  }
  async handleRunProgram(ws: string, token: string, supplied: Record<string, unknown>, caller: string): Promise<EngineOutcome> {
    const row = await this.state.get(ws)
    if (!row || !['running', 'blocked'].includes(row.run.status) || row.execution.nodeToken !== token) return rejected('node_run_program requires the current Node/token')
    const { run, execution: e } = row
    if (caller !== run.managerSessionId) return rejected('node_run_program is Manager-only')
    const node = this.nodeAt(run, topFrame(run))
    if (!node || node.execution.type !== 'builtin-program' || !['ready', 'working', 'settling'].includes(e.phase)) return rejected('current execution is not a runnable Program')
    if (run.status === 'running' && e.program && !e.program.result) return rejected('Program invocation is already in progress')
    let parameters: Record<string, unknown>
    try { parameters = this.programParameters(node.execution, supplied) } catch (error) { return rejected(error instanceof Error ? error.message : String(error)) }
    if (run.status === 'blocked') {
      e.nodeToken = newNodeToken()
      topFrame(run).nodeToken = e.nodeToken
    }
    e.program = { id: newNodeToken(), parameters }
    e.phase = 'working'
    e.restartPending = false
    e.blockReason = null
    delete e.blockDiagnostic
    run.status = 'running'
    run.blockReason = null
    await this.state.put(ws, run, row.version, [change(e, 'program-arranged')])
    const arrangedVersion = row.version + 1
    const invocationId = e.program.id
    let result: ProgramResult
    try {
      const cwd = await this.cwdResolver(run)
      const current = await this.state.get(ws)
      if (!current || current.version !== arrangedVersion || current.run.status !== 'running'
        || current.execution.executionId !== e.executionId || current.execution.program?.id !== invocationId) return rejected('stale Program invocation before effect')
      result = await this.programs.run(run, node.execution.programId, parameters, cwd)
    } catch (error) {
      const current = await this.state.get(ws)
      if (current?.version === arrangedVersion && current.run.status === 'running'
        && current.execution.executionId === e.executionId && current.execution.program?.id === invocationId) {
        await this.blockRow(ws, current, `Program result unknown; inspect before retry or resolution: ${error instanceof Error ? error.message : String(error)}`)
      }
      return rejected('Program result is unknown; Manager inspection required')
    }
    const current = await this.state.get(ws)
    if (!current || current.version !== arrangedVersion || current.run.status !== 'running'
      || current.execution.executionId !== e.executionId || current.execution.program?.id !== invocationId) return rejected('stale Program result ignored')
    let normalized: NonNullable<NonNullable<NodeExecution['program']>['result']>
    try { normalized = this.effectiveProgramResult(result, current.execution.input) } catch (error) {
      await this.blockRow(ws, current, `Program result unknown; inspect before retry or resolution: ${error instanceof Error ? error.message : String(error)}`)
      return rejected('invalid Program result; Manager inspection required')
    }
    current.execution.program!.result = normalized
    if (normalized.kind === 'ERROR') {
      current.execution.phase = 'settling'
      await this.blockRow(ws, current, `Program ERROR: ${normalized.reason}`, 'program-result')
      return { ok: true, run: current.run, message: current.execution.blockReason! }
    }
    try {
      const advanced = await this.advanceKnownResult(ws, current, 'result', normalized.kind, normalized.handoff, 'program-result')
      if (advanced.ok && advanced.run?.status === 'running') await this.drive(ws)
      return advanced
    } catch (error) {
      const after = await this.state.get(ws)
      if (after?.version === arrangedVersion && after.run.status === 'running'
        && after.execution.executionId === e.executionId && after.execution.program?.id === invocationId) {
        delete after.execution.program.result
        await this.blockRow(ws, after, `Program result commit unknown; inspect before retry or resolution: ${error instanceof Error ? error.message : String(error)}`)
      }
      return rejected('Program result commit failed; Manager inspection required')
    }
  }
  async handleResolveProgram(ws: string, token: string, result: 'PASS' | 'FAIL', reason: string, caller: string): Promise<EngineOutcome> {
    reason = reason.trim()
    if (!reason || reason.length > LIMITS.blockReasonMax || !['PASS', 'FAIL'].includes(result)) return rejected('invalid Program resolution')
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'blocked' || row.execution.nodeToken !== token) return rejected('node_resolve_program requires the current BLOCK/token')
    if (caller !== row.run.managerSessionId) return rejected('node_resolve_program is Manager-only')
    const node = this.nodeAt(row.run, topFrame(row.run))
    if (node?.execution.type !== 'builtin-program' || !row.execution.program || !['working', 'settling'].includes(row.execution.phase)) return rejected('current execution has no Program result to resolve')
    const prior = row.execution.program.result
    const handoff = prior && prior.kind !== 'ERROR' ? prior.handoff : row.execution.input
    row.execution.program.result = { kind: result, handoff, reason }
    row.execution.blockReason = null
    delete row.execution.blockDiagnostic
    row.execution.restartPending = false
    row.run.status = 'running'
    row.run.blockReason = null
    const advanced = await this.advanceKnownResult(ws, row, 'result', result, handoff, 'program-resolved')
    if (advanced.ok && advanced.run?.status === 'running') await this.drive(ws)
    return advanced
  }
  async handleSetRoleModel(ws: string, role: string, provider: string, model: string, caller: string, reasoningEffort?: string): Promise<EngineOutcome> {
    const row = await this.configState.get(ws)
    if (!row || row.run.status === 'completed' || row.run.status === 'terminated') return rejected('workflow_set_role_model requires the current active Run')
    if (caller !== row.run.managerSessionId) return rejected('workflow_set_role_model is Manager-only')
    const config = roleModelConfig(row.run, role)
    const saved = await this.handleSaveRoleModelConfig(ws, {
      runId: row.run.runId, role, expectedRevision: config.revision,
      primary: { provider, modelId: model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
      ...(config.fallback === undefined ? {} : { fallback: config.fallback }),
    })
    return saved.ok ? saved : rejected(saved.reason)
  }

  /** #288：共享配置原子服务，不代表 Manager 身份；人类入口的鉴权只在 RPC 传输层。 */
  async handleSaveRoleModelConfig(ws: string, input: SaveRoleModelConfigInput): Promise<ModelConfigSaveResult> {
    const fail = (code: string, reason: string): ModelConfigSaveResult => ({ ok: false, code, reason })
    const { runId, role, expectedRevision, requestId } = input
    let primary: ReturnType<typeof normalizeModelRoute>
    let fallback: ReturnType<typeof normalizeModelRoute> | undefined
    const normalize = (route: DelegationRoute): ReturnType<typeof normalizeModelRoute> => {
      if (typeof route?.provider !== 'string' || typeof route.modelId !== 'string'
        || (route.reasoningEffort !== undefined && typeof route.reasoningEffort !== 'string')) throw new WorkflowError('provider/modelId/reasoningEffort must be strings')
      return normalizeModelRoute(route.provider, route.modelId, route.reasoningEffort)
    }
    try {
      primary = normalize(input.primary)
      fallback = input.fallback === undefined ? undefined : normalize(input.fallback)
    } catch (error) { return fail('invalid-route', error instanceof Error ? error.message : String(error)) }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return fail('invalid-payload', 'expectedRevision must be a nonnegative integer')
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.trim() === '' || requestId.length > 128)) return fail('invalid-payload', 'requestId must contain 1..128 characters')
    const key = JSON.stringify({ primary, fallback })
    const inspect = (row: RuntimeRow | undefined): ModelConfigSaveResult | undefined => {
      if (!row || row.run.runId !== runId) return fail('target-not-found', 'exact Run is no longer current; reload without fallback')
      if (!['running', 'blocked'].includes(row.run.status)) return fail('read-only', 'terminal Run is read-only')
      if (role !== 'judge' && !Object.hasOwn(row.run.definitionSnapshot.roles, role)) return fail('invalid-payload', `unknown role "${role}"`)
      const config = roleModelConfig(row.run, role)
      const receipt = config.receipt
      if (requestId !== undefined && receipt?.requestId === requestId) {
        if (receipt.expectedRevision === expectedRevision && config.revision === expectedRevision + 1
          && JSON.stringify({ primary: receipt.primary, fallback: receipt.fallback }) === key) return { ok: true, run: row.run, message: '下次新派发生效', replayed: true }
        return fail('conflict', 'requestId was already used for a different configuration')
      }
      if (config.revision !== expectedRevision) return fail('conflict', 'model configuration changed during validation; reload and retry')
      return undefined
    }
    const initial = await this.configState.get(ws)
    const initialResult = inspect(initial)
    if (initialResult) return initialResult
    const notes: string[] = []
    if (this.validateModelRoute !== undefined) {
      for (const route of [primary, ...(fallback === undefined ? [] : [fallback])]) {
        try {
          const verdict = await this.validateModelRoute(route.provider, route.modelId, route.reasoningEffort)
          if (!verdict.ok) return fail('invalid-route', verdict.reason ?? 'model route rejected')
          if (verdict.note) notes.push(verdict.note)
        } catch (error) { return fail('invalid-route', `model route validation failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }
    // ponytail: 三次短 CAS 重试容忍工作单/其他角色 churn；同角色配置变化须显式重载。
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.configState.get(ws)
      const result = inspect(current)
      if (result) return result
      const config = { primary, ...(fallback === undefined ? {} : { fallback }), revision: expectedRevision + 1,
        ...(requestId === undefined ? {} : { receipt: { requestId, expectedRevision, primary, ...(fallback === undefined ? {} : { fallback }) } }) }
      current!.run.roleModelConfigs = { ...(current!.run.roleModelConfigs ?? {}), [role]: config }
      current!.run.modelConfigRevision = (current!.run.modelConfigRevision ?? 0) + 1
      current!.run.modelOverrides[role] = primary
      current!.run.roleRoutes = { ...(current!.run.roleRoutes ?? {}), [role]: { stage: 'primary', reason: requestId === undefined ? 'manager-set' : 'human-set', autoSwitches: 0 } }
      try { await this.configState.put(ws, current!.run, current!.version, []) }
      catch (error) {
        const latest = await this.configState.get(ws)
        const changed = inspect(latest)
        if (changed) return changed
        if (latest!.version === current!.version) return fail('save-failed', error instanceof Error ? error.message : String(error))
        continue
      }
      this.trace(current!.run, 'MODEL', { workflow: current!.execution.workflowId, role, provider: jsonField(primary.provider, LIMITS.providerMax), model: jsonField(primary.modelId, LIMITS.modelIdMax), ...(primary.reasoningEffort === undefined ? {} : { reasoningEffort: jsonField(primary.reasoningEffort, LIMITS.reasoningEffortMax) }) })
      return { ok: true, run: current!.run, message: `next dispatch primary saved for ${role}${requestId === undefined ? '' : '；下次新派发生效'}${notes.length ? `（${notes.join('；')}）` : ''}`, replayed: false }
    }
    return fail('conflict', 'Run remained busy; reload and retry')
  }
  /**
   * `rootSession` 是 host 边界（`src/commands/dsh-flow.ts` 的 `isRootCommandAgent`）判定
   * 的会话性质快照，engine 只消费不重算。#30：执行主体从「当初 start 的 Manager 会话」
   * 放宽为「同 workspace 的任意顶层会话」——Run 永久绑定 managerSessionId 且无 takeover，
   * 原会话被 fork/删除/重启后合法用户会永久失去 reset 权。安全边界保留：工作流内部参与者
   * （Role Actor / Judge / 派发 subagent）拒绝，防止工作流会话杀掉自己的 Run。
   */
  async handleReset(ws: string, rootSession: boolean): Promise<EngineOutcome> {
    if (!rootSession) return rejected('reset requires a root session; workflow Actor/Judge/subagent Sessions are not authorized')
    const row = await this.state.get(ws)
    if (!row) return { ok: true, message: 'no active run' }
    if (row.run.status !== 'running' && row.run.status !== 'blocked') return rejected('reset requires the current active Run')
    const judgeSessionId = row.execution.judge?.sessionId
    row.run.status = 'terminated'
    row.run.blockReason = TERMINATED_REASON
    row.execution.restartPending = false
    delete row.execution.blockDiagnostic
    row.execution.blockReason = TERMINATED_REASON
    row.execution.nodeToken = newNodeToken()
    topFrame(row.run).nodeToken = row.execution.nodeToken
    await this.state.put(ws, row.run, row.version, [change(row.execution, 'terminated')])
    if (judgeSessionId) await this.subagents.retireJudge(row.run, judgeSessionId).catch(() => {})
    // #216：reset 即 Run 终局，同样通知宿主释放资源（动态 preset 等）。
    try { this.runClosed?.(row.run) } catch { /* 终局通知失败不影响 reset 结果 */ }
    this.traceWarned.delete(row.run.runId)
    return { ok: true, run: row.run, message: `${TERMINATED_REASON}; saved Run history retained` }
  }
}
