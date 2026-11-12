import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
// 0.1.5 起 SessionProjectionRegistry 由 mountAgentLoopTestDependencies 内置挂载。
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SubagentRuntime, { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as CordisLoader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { scanCatalog } from '../src/catalog/loader.ts'
import { WORKFLOW_DISPATCH_SOURCE } from '../src/message-sources.ts'
import { makeDispatchTargets, makeSubagentHost, type HostAdapters } from '../src/plugin/host.ts'
import { RolePresetBook } from '../src/plugin/presets.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import type { NodeExecution, NodeExecutionEvent, RunState } from '../src/types.ts'
import { testParticipants } from './helpers/participants.ts'
import { DISPATCH_TIMEOUTS } from '../src/engine/timeouts.ts'
import { JUDGE_REQUIRED_TOOLS } from '../src/roles/roles.ts'
import type { WebRoute } from '../src/editor/rpc.ts'
import { MODEL_CONFIG_RPC_CHANNEL, type projectModelConfig } from '../src/monitor/model-config.ts'

const MODEL = 'scripted-a30'
const SUMMARY = 'A30 COMPACT CHECKPOINT: first Role visit completed and its accepted handoff is authoritative.'
const OLD_SURFACE = 'OLD_ROLE_SURFACE '

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 31, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(id: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(id)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 37, outputTokens: 9 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function readOnlyFixtureTool(name: 'read' | 'glob' | 'grep' | 'read_image') {
  return defineTool({
    name,
    description: `A30 controlled read-only ${name} surface placeholder.`,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() { return 'A30 read-only fixture' },
  })
}

function blockText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return ''
  const value = block as { type?: string; text?: unknown; content?: unknown }
  if (value.type === 'text' && typeof value.text === 'string') return value.text
  return Array.isArray(value.content) ? value.content.map(blockText).join('\n') : ''
}

function messageText(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content).map(blockText).join('\n')
}

function lastNodeToken(text: string): string {
  const matches = [...text.matchAll(/"nodeToken"\s*:\s*"([^"]+)"/g)]
  const token = matches.at(-1)?.[1]
  if (!token) throw new Error('scripted adapter could not find workflow_status nodeToken')
  return token
}

class A30Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly roleRequests: GenerateOptions[] = []
  readonly compactionRequests: GenerateOptions[] = []
  readonly resumeGate = Promise.withResolvers<void>()
  readonly firstRoleReleased = Promise.withResolvers<void>()
  readonly secondRoleStarted = Promise.withResolvers<void>()
  readonly trace: string[] = []
  /** #216：Judge 请求的实际工具面快照（deny 收敛断言）。 */
  readonly judgeSurfaces: string[][] = []
  roleSessionId: string | undefined
  blockedSeen = false
  private managerClaimed = false
  private managerStatusRequested = false
  private managerResumed = false
  private firstRoleClaimed = false
  private firstRoleJudgeReleased = false
  private roleAwaitingStatus = false
  private secondRoleInterrupted = false
  private resumedRoleClaimed = false
  private call = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.purpose === 'compaction') {
      this.compactionRequests.push(options)
      yield* textChunks(SUMMARY)
      return
    }

    const tools = new Set((options.tools ?? []).map(tool => tool.name))
    const text = messageText(options)
    const sessionId = String(options.sessionId ?? '')
    this.trace.push(`${sessionId}:${options.purpose ?? 'turn'}:first=${text.includes('FIRST_ROLE_VISIT')}:second=${text.includes('SECOND_ROLE_VISIT')}:resume=${text.includes('Manager confirmed the interrupted Role turn')}:status=${/\"nodeId\"\s*:\s*\"second-role\"/.test(text)}:${[...tools].join(',')}:${text.slice(-120)}`)
    let chunks: StreamChunk[]

    if (tools.has('judge_claim') && !tools.has('node_claim')) {
      this.judgeSurfaces.push([...tools])
      if (this.firstRoleClaimed && !this.firstRoleJudgeReleased && this.compactionRequests.length === 0) {
        await this.firstRoleReleased.promise
        this.firstRoleJudgeReleased = true
      }
      const token = text.match(/"nodeToken": "([^"]+)"/)?.[1]
      if (!token) throw new Error('Judge packet omitted nodeToken')
      chunks = toolChunks(`a30-call-${++this.call}`, 'judge_claim', {
        nodeToken: token,
        result: 'ACCEPT',
        reason: 'Scripted read-only Judge accepts the recorded handoff for Host integration verification.',
      })
    } else if (sessionId === 'a30-manager') {
      if (!this.managerClaimed && text.includes('Kickoff the isolated A30 Host scenario.')) {
        this.managerClaimed = true
        chunks = toolChunks(`a30-call-${++this.call}`, 'node_claim', { result: 'succeeded', handoff: OLD_SURFACE.repeat(60),
        })
      } else if (text.includes('Workflow BLOCK: actor-turn-ended-without-result') && !this.managerStatusRequested) {
        this.blockedSeen = true
        await this.resumeGate.promise
        this.managerStatusRequested = true
        chunks = toolChunks(`a30-call-${++this.call}`, 'workflow_status', {})
      } else if (this.managerStatusRequested && !this.managerResumed && /"status"\s*:\s*"blocked"/.test(text)) {
        this.managerResumed = true
        chunks = toolChunks(`a30-call-${++this.call}`, 'node_resume', {
          nodeToken: lastNodeToken(text),
          resolutionContext: 'Manager confirmed the interrupted Role turn is closed and authorizes the same execution to continue.',
          target: 'actor',
        })
      } else {
        chunks = textChunks('Manager observed a Host lifecycle notice; no workflow mutation is needed.')
      }
    } else if (tools.has('node_claim')) {
      this.roleSessionId ??= sessionId
      assert.equal(sessionId, this.roleSessionId, 'both Role visits and resume must use one durable Session')
      this.roleRequests.push(options)
      if (!this.roleAwaitingStatus) {
        this.roleAwaitingStatus = true
        chunks = toolChunks(`a30-call-${++this.call}`, 'workflow_status', {})
      } else {
        this.roleAwaitingStatus = false
        const nodeMatches = [...text.matchAll(/"nodeId"\s*:\s*"([^"]+)"/g)]
        const nodeId = nodeMatches.at(-1)?.[1]
        if (!this.firstRoleClaimed) {
          assert.equal(nodeId, 'first-role')
          this.firstRoleClaimed = true
          chunks = toolChunks(`a30-call-${++this.call}`, 'node_claim', { result: 'succeeded', handoff: 'first Role visit accepted handoff',
          })
        } else if (!this.secondRoleInterrupted && nodeId === 'second-role') {
          this.secondRoleInterrupted = true
          this.secondRoleStarted.resolve()
          await new Promise<void>(resolve => {
            if (options.signal?.aborted) resolve()
            else options.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          assert.equal(options.signal?.aborted, true)
          return
        } else if (!this.resumedRoleClaimed && this.secondRoleInterrupted && nodeId === 'second-role'
          && /"status"\s*:\s*"running"/.test(text)) {
          this.resumedRoleClaimed = true
          chunks = toolChunks(`a30-call-${++this.call}`, 'node_claim', { result: 'succeeded', handoff: 'second Role visit completed after Host interrupt and same-execution resume',
          })
        } else {
          chunks = textChunks('Role observed a non-work lifecycle notice.')
        }
      }
    } else {
      chunks = textChunks('No workflow action required.')
    }
    yield* chunks
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out after ${timeoutMs}ms`)
}

function commandJson(execution: Awaited<ReturnType<CommandRuntime['execute']>>): Record<string, any> {
  assert.ok(execution)
  assert.equal(execution.result.kind, 'success', execution.result.kind === 'error' ? execution.result.text : undefined)
  assert.ok(execution.result.text)
  return JSON.parse(execution.result.text)
}

/** #247 真实宿主契约测试的最小组合：只挂子代理生命周期需要的宿主服务。 */
async function mountSubagentContractHost(ctx: Context, options: {
  workspace: string
  sessions: string
  presetId: string
  adapter: LlmAdapter
}): Promise<void> {
  await mountAgentLoopTestDependencies(ctx)
  ctx.provide('workingDirectory', {
    defaultDirectory: options.workspace,
    get: (session: { header: { cwd?: string } }) => session.header.cwd ?? options.workspace,
    ensure: (agent: { session: { header: { cwd?: string } } }) =>
      Promise.resolve(agent.session.header.cwd ?? options.workspace),
    set: () => Promise.resolve(),
  })
  await ctx.plugin(CordisLoader.Loader)
  await ctx.plugin(AgentPresetRegistry, { default: options.presetId })
  await ctx.get('agentPresets').register({ id: options.presetId, plugins: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: options.sessions, compression: 'none', packChunks: false })
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(BasicCompactionEngine, { auto: false })
  await ctx.plugin(LocalJobRegistry, {})
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter([MODEL], options.adapter)
}

/** #247 A4：首 turn 可控挂起，用于在运行中再次受理同一 child。 */
class A4WarmDispatchAdapter extends LlmAdapter {
  calls = 0
  readonly firstTurnStarted = Promise.withResolvers<void>()
  readonly gate = Promise.withResolvers<void>()
  readonly turnTexts: string[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.turnTexts.push(messageText(options))
    if (this.calls === 1) {
      this.firstTurnStarted.resolve()
      await this.gate.promise
    }
    yield* textChunks(`A4 reply ${this.calls}`)
  }
}

/** #247 A5：只产出文本、不涉及工作流工具。 */
class A5ReplyAdapter extends LlmAdapter {
  calls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield* textChunks(`A5 reply ${this.calls}: ${messageText(options).slice(-40)}`)
  }
}

/** #287：脚本只控制模型响应，路由/档位/上下文均经真实 Host request 观测。 */
class A287ModelAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly firstStarted = Promise.withResolvers<void>()
  readonly releaseFirst = Promise.withResolvers<void>()

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 },
      reasoning: { efforts: ['high', 'low'].map(id => ({ id: ReasoningEffortId(id), name: id })) } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (String(options.sessionId) === 'a287-manager') { yield* textChunks('Manager observes the child completion.'); return }
    this.requests.push(options)
    if (this.requests.length === 1) {
      this.firstStarted.resolve()
      await this.releaseFirst.promise
      yield* toolChunks('a287-probe', 'route_probe', {})
    } else {
      yield* textChunks(`A287 reply ${this.requests.length}`)
    }
  }
}

test('A287 real DSH Host applies frozen Role/Judge models before warm/cold dispatch without rewriting old steps', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-a287-model-'))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapter = new A287ModelAdapter()
  try {
    await mountSubagentContractHost(ctx, { workspace, sessions: join(home, 'sessions'), presetId: 'a287-base', adapter })
    const nextProvider = 'scripted-a287-other'
    ctx.llm.registerAdapter([nextProvider], adapter)
    ctx.tools.register(defineTool({ name: 'route_probe', description: 'Finish the old dispatch second step.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'old dispatch probe finished' } }))
    const manager = await ctx.agentLoop.create(SessionId('a287-manager'), { provider: MODEL, model: 'manager' }, { cwd: workspace })
    const definition = validateAndNormalize(parseCatalogConfig(`schemaVersion: agent-workflow/v3
roles:
  worker: { reuse: continuable, persona: Complete the isolated work. }
judgeRole: { persona: Verify the isolated handoff. }
workflow:
  startNode: work
  returns: [done]
  nodes:
    work:
      execution: { type: actor-task, role: manager, instruction: Work. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Correct. } }
      results:
        succeeded: { criteria: Complete., target: { return: done } }
`), { workflowId: 'a287' })
    const run: RunState = { runId: crypto.randomUUID(), managerSessionId: manager.id, catalogWorkflowId: 'a287',
      definitionHash: 'isolated-host', definitionSnapshot: definition, status: 'running',
      callStack: [{ workflowId: 'a287', nodeId: 'work', nodeToken: crypto.randomUUID() }],
      roleActors: {}, modelOverrides: {}, blockReason: null, currentExecutionId: 'a287-execution' }
    const adapters: HostAdapters = { ctx, managerAgentOf: () => manager, presets: new RolePresetBook(),
      registerRoleActorSession() {}, registerJudgeSession() {}, revokeJudgeSession() {} }
    const host = makeSubagentHost(adapters, testParticipants(ctx))
    const targets = makeDispatchTargets(adapters)
    const first = await host.ensureRoleActor(run, 'worker', 'A287 FIRST_DISPATCH', { provider: MODEL, modelId: 'model-a', reasoningEffort: 'high' })
    run.roleActors.worker = first.childId
    const starts: string[] = []
    const ends: string[] = []
    ctx.on('subagent/start', info => { if (String(info.id) === first.childId) starts.push(String(info.runId)) })
    ctx.on('subagent/end', info => { if (String(info.id) === first.childId) ends.push(String(info.runId)) })
    await adapter.firstStarted.promise
    const originalPrefix = JSON.stringify(ctx.agents.get(SessionId(first.childId))!.session.snapshotEvents())
    const sendTimeout = DISPATCH_TIMEOUTS.send
    DISPATCH_TIMEOUTS.send = 10
    try {
      await assert.rejects(targets.sendRoleActor(run, 'worker', 'A287 MUST_NOT_QUEUE', { provider: MODEL, modelId: 'timed-out-route' }), /timeout.*stage "send"/)
    } finally { DISPATCH_TIMEOUTS.send = sendTimeout }
    assert.equal(adapter.requests.length, 1, 'a blocked model switch cannot dispatch before the old turn is idle')
    const route = { provider: nextProvider, modelId: 'model-c' }
    const second = targets.sendRoleActor(run, 'worker', 'A287 SECOND_DISPATCH', route)
    // 传入后改变源对象不能改变已经登记的派发快照；旧 turn 的下一步也仍使用 A/high。
    route.modelId = 'should-not-leak'
    adapter.releaseFirst.resolve()
    await second
    await waitFor(async () => adapter.requests.length >= 3 && ends.length >= 1 ? true : undefined)
    assert.deepEqual(adapter.requests.slice(0, 3).map(request => [request.provider, request.model, request.reasoningEffort]),
      [[MODEL, 'model-a', 'high'], [MODEL, 'model-a', 'high'], [nextProvider, 'model-c', undefined]])
    assert.match(messageText(adapter.requests[2]!), /A287 FIRST_DISPATCH/)
    assert.match(messageText(adapter.requests[2]!), /A287 reply 2/)
    assert.match(messageText(adapter.requests[2]!), /A287 SECOND_DISPATCH/)
    assert.ok(adapter.requests.every(request => String(request.sessionId) === first.childId))
    assert.equal(starts.length, 0, 'the first followup must select C inside the existing warm residency epoch')
    assert.equal(ctx.agents.get(SessionId(first.childId)), undefined, 'next queue must exercise cold materialization')
    const persisted = await ctx.sessionPersistence.open(SessionId(first.childId), 'read')
    try {
      const events = (await persisted.read(0)).events
      const prefix = JSON.parse(originalPrefix) as SessionEvent[]
      assert.equal(JSON.stringify(events.slice(0, prefix.length)), originalPrefix, 'model selection cannot rewrite historical events')
    } finally { await persisted.close() }
    await targets.sendRoleActor(run, 'worker', 'A287 COLD_ROLE_DISPATCH', { provider: MODEL, modelId: 'model-d', reasoningEffort: 'low' })
    await waitFor(async () => adapter.requests.length >= 4 && ends.length >= 2 ? true : undefined)
    assert.deepEqual([adapter.requests[3]!.provider, adapter.requests[3]!.model, adapter.requests[3]!.reasoningEffort], [MODEL, 'model-d', 'low'])
    assert.equal(starts.length, 1, 'cold Role continuation must publish one new residency epoch')
    assert.ok(adapter.requests.every(request => String(request.sessionId) === first.childId))

    // 真正创建 Judge Session，再冷续接同 id：首派冻结路由与省略 effort 的清除均须到达 adapter。
    for (const name of JUDGE_REQUIRED_TOOLS) ctx.tools.register(defineTool({ name, description: `A287 isolated ${name}.`, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, async execute() { return 'fixture' } }))
    const judgeId = 'a287-judge'
    const judgeEnds: string[] = []
    ctx.on('subagent/end', info => { if (String(info.id) === judgeId) judgeEnds.push(String(info.runId)) })
    const judgeInput = { nodeToken: run.callStack[0]!.nodeToken, criteria: 'Correct.', result: 'succeeded', resultCriteria: 'Complete.',
      boundary: { dispatchedAt: 0, managerFromSeq: 0 }, claim: { result: 'succeeded', handoff: 'A287 JUDGE_DISPATCH' },
      cwd: workspace, workspace, judgeSessionId: judgeId, model: { provider: MODEL, modelId: 'model-e', reasoningEffort: 'low' } }
    await host.startJudge(run, judgeInput)
    await waitFor(async () => adapter.requests.length >= 5 && judgeEnds.length === 1 ? true : undefined)
    assert.equal(ctx.agents.get(SessionId(judgeId)), undefined)
    await host.followupJudge(run, judgeId, { ...judgeInput, model: { provider: MODEL, modelId: 'model-e' } })
    await waitFor(async () => adapter.requests.length >= 6 && judgeEnds.length === 2 ? true : undefined)
    assert.deepEqual(adapter.requests.slice(4).map(request => [request.model, request.reasoningEffort]),
      [['model-e', 'low'], ['model-e', undefined]])
    assert.ok(adapter.requests.slice(4).every(request => String(request.sessionId) === judgeId))
    assert.match(messageText(adapter.requests[5]!), /A287 reply 5/)
  } finally {
    adapter.releaseFirst.resolve()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** #287：仍用既有 Host 组合，只在实际请求边界控制失败/成功；不替换 Engine 或工具注册。 */
class A287ManagerToolAdapter extends LlmAdapter {
  readonly targets: Array<{ options: GenerateOptions; finish: ReturnType<typeof Promise.withResolvers<'fail' | 'accept'>> }> = []
  managerCall: { id: string; name: string; args: object } | undefined
  beforeJudge: (() => Promise<void>) | undefined
  stopping = false
  private kickoffClaimed = false
  private call = 0

  readonly target: 'worker' | 'judge'
  readonly managerId: string
  constructor(target: 'worker' | 'judge', managerId: string) {
    super()
    this.target = target
    this.managerId = managerId
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(['manager', 'A', 'B', 'C', 'D'].map(id => ({ provider, id, name: id })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 },
      reasoning: { efforts: ['high', 'low', 'medium'].map(id => ({ id: ReasoningEffortId(id), name: id })), ...(model === 'C' ? { defaultEffort: ReasoningEffortId('medium') } : {}) } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'compaction') { yield* textChunks(SUMMARY); return }
    const manager = String(options.sessionId) === this.managerId
    const tools = new Set((options.tools ?? []).map(tool => tool.name))
    const judge = !manager && tools.has('judge_claim') && !tools.has('node_claim')
    const actor = !manager && tools.has('node_claim')
    if (!this.stopping && (this.target === 'judge' ? judge : actor)) {
      const finish = Promise.withResolvers<'fail' | 'accept'>()
      this.targets.push({ options, finish })
      // dispose 时也能放行，测试断言失败不会留下永不结算的模型流。
      options.signal?.addEventListener('abort', () => finish.resolve('accept'), { once: true })
      if (await finish.promise === 'fail') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', status: 503, message: 'A287 scripted eligible provider failure' } } }
        return
      }
    }
    if (manager) {
      const pending = this.managerCall
      if (pending) {
        this.managerCall = undefined
        yield* toolChunks(pending.id, pending.name, pending.args)
      } else if (!this.kickoffClaimed && messageText(options).includes('A287 CHAIN KICKOFF')) {
        this.kickoffClaimed = true
        yield* toolChunks(`a287-chain-${++this.call}`, 'node_claim', { result: 'succeeded', handoff: 'A287 isolated Manager kickoff complete.' })
      } else yield* textChunks('Manager observes the isolated workflow notice.')
    } else if (judge) {
      await this.beforeJudge?.()
      const token = messageText(options).match(/"nodeToken": "([^"]+)"/)?.[1]
      assert.ok(token, 'real Judge packet must carry the current nodeToken')
      yield* toolChunks(`a287-chain-${++this.call}`, 'judge_claim', { nodeToken: token, result: 'ACCEPT', reason: 'A287 scripted read-only acceptance.' })
    } else if (actor) {
      yield* toolChunks(`a287-chain-${++this.call}`, 'node_claim', { result: 'succeeded', handoff: 'A287 Role accepted with its frozen actual request route.' })
    } else yield* textChunks('No workflow mutation.')
  }
}

test('A287 registered Manager model tool reaches real Engine dispatch snapshots and Host requests for Role/Judge', { timeout: 30_000 }, async t => {
  for (const target of ['worker', 'judge'] as const) await t.test(target, async () => {
    const root = mkdtempSync(join(tmpdir(), `dsh-a287-manager-${target}-`))
    const home = join(root, 'home')
    const workspace = join(root, 'workspace')
    const sessions = join(root, 'sessions')
    mkdirSync(join(home, 'workflows'), { recursive: true })
    mkdirSync(workspace)
    mkdirSync(sessions)
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const ctx = new Context()
    const managerId = `a287-chain-manager-${target}`
    const adapter = new A287ManagerToolAdapter(target, managerId)
    const starts: Array<{ id: string; runId: string }> = []
    const ends: Array<{ id: string; runId: string; released: boolean }> = []
    const epochs: Array<{ id: string; runId: string }> = []
    ctx.on('subagent/start', info => { starts.push({ id: String(info.id), runId: String(info.runId) }) })
    ctx.on('subagent/end', info => { ends.push({ id: String(info.id), runId: String(info.runId), released: ctx.agents.get(info.id) === undefined }) })
    if (target === 'worker') adapter.beforeJudge = async () => {
      const previous = epochs.at(-1)
      if (previous) await waitFor(async () => ends.some(end => end.runId === previous.runId && end.released) ? true : undefined)
    }
    // 三个正常节点提供后续派发；Judge 每节点新建会话是既有生命周期，不把换模归因为 fresh。
    const visits = target === 'worker' ? ['first', 'second', 'third'] : ['second', 'third']
    writeFileSync(join(home, 'workflows', 'a287-chain.yaml'), `schemaVersion: agent-workflow/v3
roles:
  worker:
    persona: A287 isolated Role.
    reuse: continuable
    compactBeforeReuse: false
${target === 'worker' ? `    model: { provider: ${MODEL}, modelId: A, reasoningEffort: high }
    fallbackModel: { provider: ${MODEL}, modelId: B, reasoningEffort: low }
` : ''}judgeRole:
  persona: A287 isolated read-only Judge.
${target === 'judge' ? `  model: { provider: ${MODEL}, modelId: A, reasoningEffort: high }
  fallbackModel: { provider: ${MODEL}, modelId: B, reasoningEffort: low }
` : ''}workflow:
  startNode: kickoff
  returns: [done]
  nodes:
    kickoff:
      execution: { type: actor-task, role: manager, instruction: A287 CHAIN KICKOFF }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept isolated Manager kickoff. } }
      results:
        succeeded: { criteria: Manager ready., target: { node: ${visits[0]} } }
${visits.map((id, index) => `    ${id}:
      execution: { type: actor-task, role: worker, instruction: A287 ${id} accepted route visit. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept isolated Role handoff. } }
      results:
        succeeded: { criteria: Role ready., target: ${index + 1 < visits.length ? `{ node: ${visits[index + 1]} }` : '{ return: done }'} }
`).join('')}`)
    try {
      await mountSubagentContractHost(ctx, { workspace, sessions, presetId: 'a287-chain-preset', adapter })
      await ctx.plugin(CommandRuntime)
      for (const name of ['read', 'glob', 'grep', 'read_image'] as const) ctx.tools.register(readOnlyFixtureTool(name))
      const WorkflowPlugin = await import('../src/index.ts')
      await ctx.plugin(WorkflowPlugin)
      const manager = await ctx.agentLoop.create(SessionId(managerId), { provider: MODEL, model: 'manager' }, { cwd: workspace })
      const signal = new AbortController().signal
      let managerCalls = 0
      const invoke = async (name: 'workflow_set_role_model' | 'workflow_status', args: object): Promise<string> => {
        const id = `a287-manager-tool-${++managerCalls}`
        assert.equal(adapter.managerCall, undefined)
        adapter.managerCall = { id, name, args }
        manager.followup(createUserMessage({ content: [{ type: 'text', text: `Execute registered Manager tool ${id}.` }], source: WORKFLOW_DISPATCH_SOURCE }))
        const output = await waitFor(async () => {
          const event = manager.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)
          if (event?.type !== 'tool/result') return undefined
          assert.notEqual(event.data.message.isError, true, JSON.stringify(event.data))
          return event.data.message.content.map(blockText).join('\n')
        }, 3_000).catch(error => { throw new Error(`${String(error)} pending=${JSON.stringify(adapter.managerCall)} events=${JSON.stringify(manager.session.snapshotEvents().slice(-12))}`) })
        await manager.whenIdle()
        assert.ok(!output.startsWith('拒绝：'), output)
        return output
      }
      const status = () => ctx.commands.execute(manager, '/dsh-flow status', [], signal).then(commandJson)
      const frozen = async (): Promise<NodeExecution> => {
        const current = await status()
        const history = JSON.parse(await invoke('workflow_status', { executionId: current.execution.executionId })) as { history: { events: NodeExecutionEvent[] } }
        const snapshot = history.history.events.at(-1)?.snapshot
        assert.ok(snapshot)
        return snapshot
      }
      const targetRequest = async (index: number) => {
        const request = await waitFor(async () => adapter.targets[index])
        const epoch = starts.findLast(info => info.id === String(request.options.sessionId))
        assert.ok(epoch, 'every actual request belongs to a real Host residency epoch')
        epochs[index] = epoch
        return request
      }
      const route = (snapshot: NodeExecution) => target === 'worker' ? snapshot.dispatch : snapshot.judge
      const requestRoute = (index: number) => {
        const options = adapter.targets[index]!.options
        return [options.provider, options.model, options.reasoningEffort]
      }
      const setC = () => invoke('workflow_set_role_model', { roleKey: target, provider: MODEL, modelId: 'C' })
      const summary = async (stage: 'primary' | 'fallback', switches: number) => {
        const current = await status()
        const selected = current.routes.find((entry: { role: string }) => entry.role === target)
        assert.equal(selected.stage, stage)
        assert.equal(selected.autoSwitches, switches)
        assert.equal(selected.fallback, `${MODEL}/B/low`)
      }
      const started = await ctx.commands.execute(manager, '/dsh-flow start a287-chain', [], signal)
      assert.ok(started?.result.kind === 'success', JSON.stringify(started))
      await targetRequest(0)
      const initial = await frozen()
      assert.deepEqual(requestRoute(0), [MODEL, 'A', 'high'])
      assert.equal(route(initial)?.configRevision, 0)
      assert.match(await setC(), /next dispatch primary saved/)
      assert.deepEqual(route(await frozen()), route(initial), 'active A dispatch identity, route and revision stay frozen')
      await summary('primary', 0)
      adapter.targets[0]!.finish.resolve('fail')
      await targetRequest(1)
      const primary = await frozen()
      assert.deepEqual(requestRoute(1), [MODEL, 'C', 'medium'], 'omitted override uses C default rather than inherited A/high')
      assert.equal(route(primary)?.configRevision, 1)
      assert.equal(route(primary)?.source, 'primary')
      assert.notEqual(route(primary)?.id, route(initial)?.id)
      await summary('primary', 0)
      adapter.targets[1]!.finish.resolve('fail')
      await targetRequest(2)
      const fallback = await frozen()
      assert.deepEqual(requestRoute(2), [MODEL, 'B', 'low'])
      assert.equal(route(fallback)?.configRevision, 1)
      assert.equal(route(fallback)?.source, 'fallback')
      assert.equal(route(fallback)?.sessionId, adapter.targets[0]!.options.sessionId, 'failure retry must preserve the durable Session')
      await summary('fallback', 1)
      adapter.targets[2]!.finish.resolve('accept')
      await targetRequest(3)
      const later = await frozen()
      assert.deepEqual(requestRoute(3), [MODEL, 'B', 'low'], 'success does not silently switch back from fallback')
      assert.equal(route(later)?.source, 'fallback')
      assert.equal(route(later)?.configRevision, 1)
      assert.notEqual(later.executionId, fallback.executionId, 'later B belongs to a genuinely new node registration')
      await summary('fallback', 1)
      assert.match(await setC(), /next dispatch primary saved/)
      assert.deepEqual(route(await frozen()), route(later), 'same-route explicit set cannot rewrite the active B dispatch')
      await summary('primary', 0)
      adapter.targets[3]!.finish.resolve('accept')
      await targetRequest(4)
      const final = await frozen()
      assert.deepEqual(requestRoute(4), [MODEL, 'C', 'medium'], 'explicit C reset must not inherit fallback B/low')
      assert.equal(route(final)?.source, 'primary')
      assert.equal(route(final)?.configRevision, 2, 'same C selected again still creates a new configuration revision')
      assert.deepEqual(route(final)?.model, { provider: MODEL, modelId: 'C' }, 'omitted effort clears inherited high/low')
      if (target === 'worker') {
        assert.equal(new Set(adapter.targets.map(({ options }) => options.sessionId)).size, 1)
        for (const index of [3, 4]) {
          assert.notEqual(epochs[index]!.runId, epochs[index - 1]!.runId, 'later B and saved C must cold-materialize rather than fall back to descriptor A')
          assert.ok(ends.some(end => end.runId === epochs[index - 1]!.runId && end.released), 'the previous real Role residency is released before continuation')
        }
      }
      adapter.targets[4]!.finish.resolve('accept')
      await waitFor(async () => (await status()).status === 'completed' ? true : undefined)
      const managerSetCalls = manager.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data.name === 'workflow_set_role_model')
      assert.equal(managerSetCalls.length, 2, 'both changes actually passed the registered Manager tool and its caller authorization')
      assert.equal(adapter.targets.length, 5)
    } finally {
      adapter.stopping = true
      for (const request of adapter.targets) request.finish.resolve('accept')
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test('A288 authenticated GUI RPC saves future C/D while A settles, then real Host cold-resumes the same Role Session', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-a288-gui-host-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const sessions = join(root, 'sessions')
  mkdirSync(join(home, 'workflows'), { recursive: true })
  mkdirSync(workspace)
  mkdirSync(sessions)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const managerId = 'a288-gui-manager'
  const adapter = new A287ManagerToolAdapter('worker', managerId)
  const routes = new Map<string, WebRoute>()
  const starts: Array<{ id: string; runId: string }> = []
  const ends: Array<{ runId: string; released: boolean }> = []
  const epochs: string[] = []
  ctx.on('subagent/start', info => { starts.push({ id: String(info.id), runId: String(info.runId) }) })
  ctx.on('subagent/end', info => { ends.push({ runId: String(info.runId), released: ctx.agents.get(info.id) === undefined }) })
  adapter.beforeJudge = async () => {
    const request = adapter.targets.at(-1)
    const epoch = request && starts.findLast(start => start.id === String(request.options.sessionId))
    if (epoch) await waitFor(async () => ends.some(end => end.runId === epoch.runId && end.released) ? true : undefined)
  }
  // 三个 Role 节点：A 正常结算；第二节点 C 合格失败后 D；第三节点仍 D。
  writeFileSync(join(home, 'workflows', 'a288-gui.yaml'), `schemaVersion: agent-workflow/v3
roles:
  worker:
    persona: A288 isolated Role.
    reuse: continuable
    compactBeforeReuse: false
    model: { provider: ${MODEL}, modelId: A, reasoningEffort: high }
    fallbackModel: { provider: ${MODEL}, modelId: B, reasoningEffort: low }
judgeRole:
  persona: A288 isolated read-only Judge.
workflow:
  startNode: kickoff
  returns: [done]
  nodes:
    kickoff:
      execution: { type: actor-task, role: manager, instruction: A287 CHAIN KICKOFF }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept isolated Manager kickoff. } }
      results:
        succeeded: { criteria: Manager ready., target: { node: first } }
${['first', 'second', 'third'].map((id, index, visits) => `    ${id}:
      execution: { type: actor-task, role: worker, instruction: A288 GUI ${id} accepted route visit. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept isolated Role handoff. } }
      results:
        succeeded: { criteria: Role ready., target: ${index + 1 < visits.length ? `{ node: ${visits[index + 1]} }` : '{ return: done }'} }
`).join('')}`)
  try {
    await mountSubagentContractHost(ctx, { workspace, sessions, presetId: 'a288-gui-preset', adapter })
    await ctx.plugin(CommandRuntime)
    for (const name of ['read', 'glob', 'grep', 'read_image'] as const) ctx.tools.register(readOnlyFixtureTool(name))
    const browserPeer = { id: 'a288-trusted-browser' }
    let admissions = 0
    // 只替换宿主 transport 身份来源；Opaque BrowserRpcContext 必须由生产挂载器生成。
    ctx.provide('connection', {
      browserPeer,
      admit(req: { headers: Record<string, unknown> }) {
        admissions++
        return req.headers['x-a288-browser'] === 'trusted' ? { peer: browserPeer } : { rejection: 401 as const }
      },
    })
    ctx.provide('webServer', { register(route: WebRoute) { routes.set(route.path, route); return () => { routes.delete(route.path) } } })
    const WorkflowPlugin = await import('../src/index.ts')
    await ctx.plugin(WorkflowPlugin)
    const webRoute = await waitFor(async () => routes.get(MODEL_CONFIG_RPC_CHANNEL))
    let rpcId = 0
    const rpc = async (method: 'model-config' | 'model-config-save', payload: object) => {
      const id = `a288-browser-${++rpcId}`
      const request = {
        method: 'POST', url: `${MODEL_CONFIG_RPC_CHANNEL}/${method}`,
        headers: { 'content-type': 'application/json', 'x-a288-browser': 'trusted' },
        destroy() {},
        async * [Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ type: 'client-request', rpcId: id, method, payload })) },
      }
      const response = {
        writableEnded: false, status: 0, body: '',
        write(chunk: unknown) { this.body += chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk); return true },
        end(chunk?: unknown) { if (chunk !== undefined) this.body += String(chunk); this.writableEnded = true },
        writeHead(status: number) { this.status = status },
        on() {}, off() {}, once() {},
      }
      await webRoute.handler(request, response)
      assert.equal(response.status, 200, response.body)
      const envelope = JSON.parse(response.body)
      assert.equal(envelope.type, 'server-response')
      assert.equal(envelope.rpcId, id)
      assert.equal(envelope.result.ok, true, response.body)
      return envelope.result.value as ReturnType<typeof projectModelConfig> & { message?: string }
    }
    const worker = (view: ReturnType<typeof projectModelConfig>) => {
      const role = view.roles.find(role => role.role === 'worker')
      assert.ok(role)
      return role
    }
    const manager = await ctx.agentLoop.create(SessionId(managerId), { provider: MODEL, model: 'manager' }, { cwd: workspace })
    const signal = new AbortController().signal
    const status = () => ctx.commands.execute(manager, '/dsh-flow status', [], signal).then(commandJson)
    const started = await ctx.commands.execute(manager, '/dsh-flow start a288-gui', [], signal)
    assert.equal(started?.result.kind, 'success', JSON.stringify(started))
    const target = async (index: number) => {
      const request = await waitFor(async () => adapter.targets[index])
      const epoch = starts.findLast(start => start.id === String(request.options.sessionId))
      assert.ok(epoch)
      epochs[index] = epoch.runId
      return request
    }
    const first = await target(0)
    const runId = (await status()).runId as string
    const childId = SessionId(String(first.options.sessionId))
    const originalPrefix = ctx.agents.get(childId)!.session.snapshotEvents().map(event => JSON.stringify(event))
    const initialView = await rpc('model-config', { runId })
    assert.equal(initialView.runId, runId)
    assert.equal(initialView.workflowId, 'a288-gui')
    assert.equal(initialView.status, 'running')
    const initial = worker(initialView)
    assert.deepEqual(initial.actual, { provider: MODEL, modelId: 'A', reasoningEffort: 'high' })
    assert.equal(initial.pending, false)
    const saved = await rpc('model-config-save', { runId, role: 'worker', expectedRevision: initial.revision, requestId: 'a288-save-c-d',
      primary: { provider: MODEL, modelId: 'C' }, fallback: { provider: MODEL, modelId: 'D', reasoningEffort: 'low' } })
    assert.match(saved.message ?? '', /下次新派发生效/)
    assert.equal(saved.runId, runId)
    assert.equal(saved.workspaceKey, initialView.workspaceKey, 'save remains bound to the exact Run read from the selector')
    const pending = worker(saved)
    assert.deepEqual(pending.primary, { provider: MODEL, modelId: 'C' })
    assert.deepEqual(pending.fallback, { provider: MODEL, modelId: 'D', reasoningEffort: 'low' })
    assert.equal(pending.revision, initial.revision + 1)
    assert.deepEqual(pending.actual, initial.actual, 'saving C/D cannot relabel the actual in-flight A request')
    assert.equal(pending.pending, true)
    assert.equal(adapter.targets.length, 1, 'GUI save does not interrupt A or dispatch C before normal settlement')
    assert.deepEqual(ctx.agents.get(childId)!.session.snapshotEvents().slice(0, originalPrefix.length).map(event => JSON.stringify(event)), originalPrefix)
    first.finish.resolve('accept')
    await target(1)
    const selectedC = worker(await rpc('model-config', { runId }))
    assert.deepEqual(selectedC.actual, { provider: MODEL, modelId: 'C' })
    assert.equal(selectedC.pending, false)
    assert.notEqual(epochs[1], epochs[0], 'GUI-selected C must survive actual cold materialization, not descriptor A')
    assert.ok(ends.some(end => end.runId === epochs[0] && end.released))
    assert.match(messageText(adapter.targets[1]!.options), /A288 GUI first accepted route visit/)
    assert.match(messageText(adapter.targets[1]!.options), /A287 Role accepted with its frozen actual request route/)
    adapter.targets[1]!.finish.resolve('fail')
    await target(2)
    const fallback = worker(await rpc('model-config', { runId }))
    assert.deepEqual(fallback.actual, { provider: MODEL, modelId: 'D', reasoningEffort: 'low' })
    assert.deepEqual(fallback.primary, { provider: MODEL, modelId: 'C' }, 'actual fallback must not masquerade as the saved primary')
    assert.equal(fallback.revision, pending.revision)
    assert.equal(fallback.pending, false)
    adapter.targets[2]!.finish.resolve('accept')
    await target(3)
    assert.deepEqual(adapter.targets.map(({ options }) => [options.provider, options.model, options.reasoningEffort]),
      [[MODEL, 'A', 'high'], [MODEL, 'C', 'medium'], [MODEL, 'D', 'low'], [MODEL, 'D', 'low']])
    assert.ok(adapter.targets.every(({ options }) => options.sessionId === childId), 'GUI edits and fallback keep the original durable Session')
    assert.notEqual(epochs[3], epochs[2], 'fallback D also persists across a subsequent cold Role continuation')
    assert.deepEqual(worker(await rpc('model-config', { runId })).actual, fallback.actual)
    const persisted = await ctx.sessionPersistence.open(childId, 'read')
    try {
      const events = (await persisted.read(0)).events
      assert.deepEqual(events.slice(0, originalPrefix.length).map(event => JSON.stringify(event)), originalPrefix, 'GUI edits never rewrite existing Session history')
    } finally { await persisted.close() }
    adapter.targets[3]!.finish.resolve('accept')
    await waitFor(async () => (await status()).status === 'completed' ? true : undefined)
    assert.equal(manager.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data.name === 'workflow_set_role_model').length, 0,
      'the GUI path must not impersonate the fixed Manager tool caller')
    assert.equal(admissions, rpcId, 'all model configuration calls passed the production transport identity gate')
  } finally {
    adapter.stopping = true
    for (const request of adapter.targets) request.finish.resolve('accept')
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('A30 real DSH Host composes cold Role continuation, Basic compaction, Host interrupt, and same-execution resume', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-a30-host-'))
  const workspace = join(home, 'workspace')
  const sessions = join(home, 'sessions')
  mkdirSync(join(home, 'workflows'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(home, 'workflows', 'a30.yaml'), `schemaVersion: agent-workflow/v3
roles:
  worker:
    # A30 场景断言的是 continuable 语义（整 Run 复用 + 节点边界 compact + 冷延续）；
    # 缺省 reuse: node 的节点级释放由 scripts/e2e-smoke.mjs 与 runtime-work-order 的 node 用例覆盖。
    reuse: continuable
    persona: Complete only the current workflow work order and use its control tools.
judgeRole:
  persona: Read-only verification of the isolated workspace.
workflow:
  startNode: kickoff
  returns: [done]
  nodes:
    kickoff:
      execution: { type: actor-task, role: manager, instruction: Kickoff the isolated A30 Host scenario. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept the scripted kickoff handoff. } }
      results:
        succeeded: { criteria: The kickoff handoff is accepted., target: { node: first-role } }
    first-role:
      execution: { type: actor-task, role: worker, instruction: FIRST_ROLE_VISIT complete the first isolated Host task. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept the first Role handoff. } }
      results:
        succeeded: { criteria: The first Role handoff is accepted., target: { node: second-role } }
    second-role:
      execution: { type: actor-task, role: worker, instruction: "SECOND_ROLE_VISIT wait for a Host interrupt, then complete after Manager resume." }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept only the resumed second Role handoff. } }
      results:
        succeeded: { criteria: The resumed second Role handoff is accepted., target: { return: done } }
`, 'utf8')

  const catalog = await scanCatalog(home)
  assert.deepEqual(catalog.diagnostics, [], JSON.stringify(catalog.diagnostics, null, 2))
  assert.equal(catalog.entries.length, 1)

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapter = new A30Adapter()
  const lifecycleStarts = new Map<string, { runId: string; id: string }>()
  const lifecycleOrder: string[] = []
  const roleEnds: Array<{ runId: string; released: boolean }> = []
  const observedCompactionEvents: SessionEvent[] = []
  const signal = new AbortController().signal

  try {
    await mountAgentLoopTestDependencies(ctx)
    // 0.2.1 起 SubagentRuntime 静态 inject=['workingDirectory'] 且子代理创建
    // 需要 `set`：testkit 的 fixture 不含 set，这里提供完整最小桩。
    ctx.provide('workingDirectory', {
      defaultDirectory: workspace,
      get: (session: { header: { cwd?: string } }) => session.header.cwd ?? workspace,
      ensure: (agent: { session: { header: { cwd?: string } } }) =>
        Promise.resolve(agent.session.header.cwd ?? workspace),
      set: () => Promise.resolve(),
    })
    // #216：persona/deny 组装走 Agent Preset——真实宿主侧挂 loader + registry + persona。
    await ctx.plugin(CordisLoader.Loader)
    await ctx.plugin(AgentPresetRegistry, { default: 'a30-base' })
    await ctx.get('agentPresets').register({ id: 'a30-base', plugins: [] })
    await ctx.plugin(JsonlSessionPersistence, { root: sessions, compression: 'none', packChunks: false })
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(BasicCompactionEngine, { auto: false })
    await ctx.plugin(LocalJobRegistry, {})
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(CommandRuntime)
    for (const name of ['read', 'glob', 'grep', 'read_image'] as const) ctx.tools.register(readOnlyFixtureTool(name))
    ctx.llm.registerAdapter([MODEL], adapter)

    ctx.on('subagent/start', info => {
      lifecycleStarts.set(String(info.runId), { runId: String(info.runId), id: String(info.id) })
      lifecycleOrder.push(`start:${String(info.runId)}`)
    })
    ctx.on('subagent/end', info => {
      lifecycleOrder.push(`end:${String(info.runId)}`)
      if (String(info.id) !== adapter.roleSessionId) return
      roleEnds.push({ runId: String(info.runId), released: ctx.agents.get(info.id) === undefined })
      if (roleEnds.length === 1) adapter.firstRoleReleased.resolve()
    })
    ctx.on('session/event', (session, event) => {
      if (String(session.id) === adapter.roleSessionId && event.type.startsWith('compaction/')) observedCompactionEvents.push(event)
    })

    const WorkflowPlugin = await import('../src/index.ts')
    await ctx.plugin(WorkflowPlugin)
    const manager = await ctx.agentLoop.create(SessionId('a30-manager'), { provider: MODEL, model: MODEL }, { cwd: workspace })
    const start = await ctx.commands.execute(manager, '/dsh-flow start a30 isolated-host-input', [], signal)
    assert.ok(start)
    assert.equal(start.result.kind, 'success', start.result.kind === 'error' ? start.result.text : undefined)

    await adapter.secondRoleStarted.promise
    const interruptedRoleSessionId = adapter.roleSessionId
    assert.ok(interruptedRoleSessionId)
    assert.equal(ctx.agents.get(SessionId(interruptedRoleSessionId))?.status, 'running')
    ctx.subagents.interrupt(SessionId(interruptedRoleSessionId), { kind: 'ancestor', agent: manager })

    await waitFor(async () => adapter.blockedSeen ? true : undefined, 10_000).catch(async error => {
      const current = commandJson(await ctx.commands.execute(manager, '/dsh-flow status', [], signal))
      throw new Error(`${String(error)}; current status:\n${JSON.stringify(current, null, 2)}; adapter trace:\n${adapter.trace.join('\n')}`)
    })
    const blocked = commandJson(await ctx.commands.execute(manager, '/dsh-flow status', [], signal))
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.execution.nodeId, 'second-role', `${JSON.stringify(blocked, null, 2)}\nadapter trace:\n${adapter.trace.join('\n')}`)
    assert.equal(blocked.execution.hasClaim, false, 'interrupted old Turn did not gain claim qualification')
    // #29：BLOCK 文本必须自带可辨识的失败分类（此处为父会话中断），而不是只有裸的基础原因。
    assert.match(blocked.execution.blockReason ?? '', /^actor-turn-ended-without-result \| turn-end reason=aborted cause=parent \| turn=\d+ tools=used$/,
      `blockReason should carry the turn-end failure classification: ${blocked.execution.blockReason}`)
    const blockedExecutionId = blocked.execution.executionId
    const blockedToken = blocked.execution.nodeToken
    adapter.resumeGate.resolve()

    const completed = await waitFor(async () => {
      const status = commandJson(await ctx.commands.execute(manager, '/dsh-flow status', [], signal))
      return status.status === 'completed' ? status : undefined
    }, 10_000).catch(error => {
      throw new Error(`${String(error)}; adapter trace:\n${adapter.trace.join('\n')}`)
    })
    assert.equal(completed.execution.executionId, blockedExecutionId)
    assert.notEqual(completed.execution.nodeToken, blockedToken)
    assert.equal(completed.finalHandoffPreview, 'second Role visit completed after Host interrupt and same-execution resume')

    const roleSessionId = adapter.roleSessionId
    assert.ok(roleSessionId)
    // 0.1.5 起持久化读走 SessionHandle：open('read') 不取写所有权，读完即 close。
    const persistedHandle = await ctx.sessionPersistence.open(SessionId(roleSessionId), 'read')
    let persisted: { events: readonly SessionEvent[] }
    try {
      persisted = { events: (await persistedHandle.read(0)).events }
    } finally {
      await persistedHandle.close()
    }
    const abortedEnd = persisted.events.find(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted')
    assert.ok(abortedEnd)
    assert.equal(persisted.events.some(event => event.type === 'tool/call'
      && event.data.turn === abortedEnd.data.turn && event.data.name === 'node_claim'), false,
    'the interrupted old Turn never dispatched node_claim')
    const compactEvents = persisted.events.filter(event => event.type.startsWith('compaction/'))
    const startEvent = compactEvents.find(event => event.type === 'compaction/start')
    const summaryEvent = compactEvents.find(event => event.type === 'compaction/summary')
    const endEvent = compactEvents.find(event => event.type === 'compaction/end')
    assert.ok(startEvent && summaryEvent && endEvent)
    assert.equal(startEvent.data.compactionId, summaryEvent.data.compactionId)
    assert.equal(summaryEvent.data.compactionId, endEvent.data.compactionId)
    assert.equal(startEvent.data.turn, null)
    assert.equal(endEvent.data.turn, null)
    assert.equal(endEvent.data.error, undefined)
    assert.equal(summaryEvent.data.llmStreamCall, true)
    assert.ok(summaryEvent.data.shadowedSeqs.length > 0)
    assert.equal(summaryEvent.data.provider, MODEL)
    assert.equal(summaryEvent.data.model, MODEL)
    assert.equal(adapter.compactionRequests.length, 1, 'same-execution BLOCK/resume must not add another node-boundary compact')
    assert.equal(observedCompactionEvents.length, 3)

    const replacement = persisted.events.find(event => event.type === 'user/message'
      && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace')
    assert.ok(replacement)
    // 0.1.5 起 surfaceOp.replace 的字段名为 startSeq/endSeq（旧名 start/end）。
    assert.equal(replacement.surfaceOp.startSeq, summaryEvent.data.shadowedRange.start)
    assert.equal(replacement.surfaceOp.endSeq, summaryEvent.data.shadowedRange.end)

    const resumedRequest = adapter.roleRequests.at(-1)
    assert.ok(resumedRequest)
    const resumedText = messageText(resumedRequest)
    assert.match(resumedText, /A30 COMPACT CHECKPOINT/)
    assert.doesNotMatch(resumedText, /OLD_ROLE_SURFACE/)

    // MF-4：真实宿主的 residency epoch 契约——暖多派共享一个 epoch，
    // 冷续接只在旧 epoch 结算/释放后开新 epoch，每个 start 恰好配对一次 end。
    const roleStarts = [...lifecycleStarts.values()].filter(start => start.id === roleSessionId)
    assert.ok(roleStarts.length >= 2, `expected at least two Role residency epochs: ${JSON.stringify(roleStarts)}`)
    assert.equal(roleEnds.length, roleStarts.length, 'every Role residency epoch must publish exactly one terminal edge')
    assert.equal(new Set(roleStarts.map(start => start.runId)).size, roleStarts.length,
      'cold continuation must open a new residency epoch id')
    for (const start of roleStarts) {
      const startedAt = lifecycleOrder.indexOf(`start:${start.runId}`)
      const endedAt = lifecycleOrder.indexOf(`end:${start.runId}`)
      assert.ok(startedAt >= 0, `missing subagent/start ordering for ${start.runId}`)
      assert.ok(endedAt > startedAt, `subagent/end must follow its own start for ${start.runId}`)
    }
    for (const end of roleEnds) {
      assert.ok(roleStarts.some(start => start.runId === end.runId), `end ${end.runId} has no matching Role epoch`)
    }
    const firstRoleStart = roleStarts[0]!
    const secondRoleStart = roleStarts[1]!
    assert.ok(lifecycleOrder.indexOf(`end:${firstRoleStart.runId}`) < lifecycleOrder.indexOf(`start:${secondRoleStart.runId}`),
      'cold continuation must start only after the previous residency epoch ended')
    assert.equal(roleEnds[0]!.released, true, 'first Role Activation must be released before cold continuation')

    // #216 断言一：preset 组装下 Judge deny 实际收敛工具面——
    // Judge 请求携带 judge_claim 且不携带 workflow 控制工具（node_claim 等）。
    assert.ok(adapter.judgeSurfaces.length > 0, 'Judge must have issued at least one request')
    for (const surface of adapter.judgeSurfaces) {
      assert.ok(surface.includes('judge_claim'), `Judge surface must keep judge_claim: ${surface.join(',')}`)
      for (const denied of ['node_claim', 'node_block', 'node_resume', 'node_run_program', 'node_resolve_program'])
        assert.ok(!surface.includes(denied), `Judge surface must not expose ${denied}: ${surface.join(',')}`)
    }
    // #216 断言二：动态 preset 注册/注销与 Run 生命周期严格配对——
    // Run 完成后注册表不得残留 dsh-wf-* 派生 preset。
    const registry = ctx.get('agentPresets')
    assert.ok(registry)
    const leftover = (await registry.list()).filter((preset: { id: string }) => preset.id.startsWith('dsh-wf-'))
    assert.deepEqual(leftover.map((preset: { id: string }) => preset.id), [], `Run 完成后动态 preset 必须全部注销: ${JSON.stringify(leftover)}`)
  } finally {
    adapter.resumeGate.resolve()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// #247 真实宿主契约：受理后无 turn/end 的失败必须经过真实插件接线（index.ts 的
// `subagent/end` 观察 → Dispatch Lifecycle → Engine 工作单核验 → SQLite）落成技术
// BLOCK，而不是停在 running 或等下一次 turn 才失败。这里刻意让 Role 的模型流挂起
// （不产出任何 chunk，因此不会有 turn/end），再用宿主同款 `subagent/end` 事件注入
// 终态；事件可能在派发登记发布前到达，正好覆盖发布窗口对账。
class A3LifecycleAdapter extends LlmAdapter {
  readonly roleGate = Promise.withResolvers<void>()
  readonly roleTurnStarted = Promise.withResolvers<void>()
  roleSessionId: string | undefined
  private managerClaimed = false
  private call = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const tools = new Set((options.tools ?? []).map(tool => tool.name))
    const text = messageText(options)
    const sessionId = String(options.sessionId ?? '')
    if (tools.has('judge_claim') && !tools.has('node_claim')) {
      const token = text.match(/"nodeToken": "([^"]+)"/)?.[1]
      if (!token) throw new Error('Judge packet omitted nodeToken')
      yield* toolChunks(`a3-call-${++this.call}`, 'judge_claim', {
        nodeToken: token,
        result: 'ACCEPT',
        reason: 'Scripted read-only Judge accepts the kickoff handoff.',
      })
      return
    }
    if (sessionId === 'a3-manager') {
      if (!this.managerClaimed && text.includes('Kickoff the isolated A3 lifecycle scenario.')) {
        this.managerClaimed = true
        yield* toolChunks(`a3-call-${++this.call}`, 'node_claim', { result: 'succeeded', handoff: 'kickoff accepted' })
        return
      }
      yield* textChunks('Manager observed a Host lifecycle notice; no workflow mutation is needed.')
      return
    }
    if (tools.has('node_claim')) {
      if (this.roleSessionId === undefined) {
        this.roleSessionId = sessionId
        this.roleTurnStarted.resolve()
      }
      // 受理后的模型流挂起（不产出 chunk、不结束 turn），终态由测试注入的宿主事件给出。
      await this.roleGate.promise
      yield* textChunks('Late Role turn after the injected Host terminal event.')
      return
    }
    yield* textChunks('No workflow action required.')
  }
}

test('A3 real DSH Host: accepted Role dispatch without turn/end fails into a technical BLOCK through plugin wiring', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-a3-host-'))
  const workspace = join(home, 'workspace')
  const sessions = join(home, 'sessions')
  mkdirSync(join(home, 'workflows'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(home, 'workflows', 'a3.yaml'), `schemaVersion: agent-workflow/v3
roles:
  worker:
    persona: Complete only the current workflow work order and use its control tools.
judgeRole:
  persona: Read-only verification of the isolated workspace.
workflow:
  startNode: kickoff
  returns: [done]
  nodes:
    kickoff:
      execution: { type: actor-task, role: manager, instruction: Kickoff the isolated A3 lifecycle scenario. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept the scripted kickoff handoff. } }
      results:
        succeeded: { criteria: The kickoff handoff is accepted., target: { node: work } }
    work:
      execution: { type: actor-task, role: worker, instruction: Wait for a Host terminal event without finishing a turn. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept the worker handoff. } }
      results:
        succeeded: { criteria: The worker handoff is accepted., target: { return: done } }
`, 'utf8')

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapter = new A3LifecycleAdapter()
  const signal = new AbortController().signal
  const lifecycleStarts = new Map<string, { id: string; runId: string }>()

  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.provide('workingDirectory', {
      defaultDirectory: workspace,
      get: (session: { header: { cwd?: string } }) => session.header.cwd ?? workspace,
      ensure: (agent: { session: { header: { cwd?: string } } }) =>
        Promise.resolve(agent.session.header.cwd ?? workspace),
      set: () => Promise.resolve(),
    })
    await ctx.plugin(CordisLoader.Loader)
    await ctx.plugin(AgentPresetRegistry, { default: 'a3-base' })
    await ctx.get('agentPresets').register({ id: 'a3-base', plugins: [] })
    await ctx.plugin(JsonlSessionPersistence, { root: sessions, compression: 'none', packChunks: false })
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(BasicCompactionEngine, { auto: false })
    await ctx.plugin(LocalJobRegistry, {})
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(CommandRuntime)
    for (const name of ['read', 'glob', 'grep', 'read_image'] as const) ctx.tools.register(readOnlyFixtureTool(name))
    ctx.llm.registerAdapter([MODEL], adapter)

    ctx.on('subagent/start', info => {
      lifecycleStarts.set(String(info.id), { id: String(info.id), runId: String(info.runId) })
    })

    const WorkflowPlugin = await import('../src/index.ts')
    await ctx.plugin(WorkflowPlugin)
    const manager = await ctx.agentLoop.create(SessionId('a3-manager'), { provider: MODEL, model: MODEL }, { cwd: workspace })
    const start = await ctx.commands.execute(manager, '/dsh-flow start a3 isolated-host-input', [], signal)
    assert.ok(start)
    assert.equal(start.result.kind, 'success', start.result.kind === 'error' ? start.result.text : undefined)

    // 受理 = Role turn 已开始（模型请求已到达）。此后注入宿主终态：没有 turn/end 可以
    // 解释这次结束，只能由观察模块转交 Engine 落成技术 BLOCK。
    await adapter.roleTurnStarted.promise
    const roleSessionId = adapter.roleSessionId
    assert.ok(roleSessionId)
    const startInfo = lifecycleStarts.get(roleSessionId)
    assert.ok(startInfo, `missing subagent/start for the Role session: ${JSON.stringify([...lifecycleStarts])}`)
    ctx.emit('subagent/end', {
      id: SessionId(startInfo.id),
      runId: SubagentRunId(startInfo.runId),
      provider: 'spawn',
      local: true,
      stopReason: 'error',
    })

    const blocked = await waitFor(async () => {
      const status = commandJson(await ctx.commands.execute(manager, '/dsh-flow status', [], signal))
      return status.status === 'blocked' ? status : undefined
    }, 10_000).catch(error => {
      throw new Error(`${String(error)}; lifecycle starts: ${JSON.stringify([...lifecycleStarts])}`)
    })
    assert.equal(blocked.execution.nodeId, 'work')
    assert.equal(blocked.execution.hasClaim, false)
    assert.match(blocked.execution.blockReason ?? '', /^activation settled without turn\/end: actor role=worker/,
      `blockReason should carry the lifecycle settlement: ${blocked.execution.blockReason}`)
  } finally {
    adapter.roleGate.resolve()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// MF-4（#247）：真实宿主的 residency epoch 契约。暖多派（同一 activation 内先后受理
// 两条 prompt）只发一次 subagent/start、一次 subagent/end；结算后的冷续接必须开新的
// activation/runId，旧 end 不会串到新 epoch。受控测试只能模拟这些时序，因此这条契约
// 必须在真实 Host 上单独固定。
test('A4 real DSH Host: warm dispatches share one residency epoch and cold continuation opens a new one', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-a4-lifecycle-'))
  const workspace = join(home, 'workspace')
  const sessions = join(home, 'sessions')
  mkdirSync(workspace, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapter = new A4WarmDispatchAdapter()
  const childId = SessionId('a4-child')
  const signal = new AbortController().signal
  const starts: string[] = []
  const ends: Array<{ runId: string; stopReason: string }> = []
  const sequence: string[] = []

  try {
    await mountSubagentContractHost(ctx, { workspace, sessions, presetId: 'a4-base', adapter })
    ctx.on('subagent/start', info => {
      if (String(info.id) !== String(childId)) return
      starts.push(String(info.runId))
      sequence.push(`start:${String(info.runId)}`)
    })
    ctx.on('subagent/end', info => {
      if (String(info.id) !== String(childId)) return
      ends.push({ runId: String(info.runId), stopReason: info.stopReason })
      sequence.push(`end:${String(info.runId)}`)
    })

    const parent = await ctx.agentLoop.create(SessionId('a4-parent'), { provider: MODEL, model: MODEL }, { cwd: workspace })
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: 'a4-contract',
      childId,
      request: { prompt: [{ type: 'text', text: 'A4 FIRST_PROMPT' }], parent, signal },
      signal,
      delivery: 'parent',
    })

    await adapter.firstTurnStarted.promise
    await queueHostSubagentPrompt(
      ctx.subagents,
      parent,
      childId,
      [{ type: 'text', text: 'A4 SECOND_PROMPT' }],
      WORKFLOW_DISPATCH_SOURCE,
      signal,
    )
    adapter.gate.resolve()
    const result = await started.result
    sequence.push('result')

    assert.equal(result.stopReason, 'completed')
    assert.equal(starts.length, 1, 'warm dispatches must not open a second residency epoch')
    assert.equal(ends.length, 1, 'one residency epoch publishes exactly one terminal edge')
    assert.equal(ends[0]!.runId, starts[0])
    assert.equal(sequence.indexOf(`end:${ends[0]!.runId}`), sequence.indexOf('result') - 1,
      'the host publishes subagent/end before the result resolves')
    assert.ok(adapter.turnTexts.some(text => text.includes('A4 SECOND_PROMPT')),
      'the second prompt must be delivered inside the warm activation')

    // 结算后再次投递：宿主冷续接，必须开新 activation/runId。
    await queueHostSubagentPrompt(
      ctx.subagents,
      parent,
      childId,
      [{ type: 'text', text: 'A4 THIRD_PROMPT' }],
      WORKFLOW_DISPATCH_SOURCE,
      new AbortController().signal,
    )
    await waitFor(async () => ends.length === 2 ? true : undefined, 10_000).catch(error => {
      throw new Error(`${String(error)}; starts=${JSON.stringify(starts)}; ends=${JSON.stringify(ends)}`)
    })
    assert.equal(starts.length, 2, 'cold continuation must start a new residency epoch')
    assert.notEqual(starts[1], starts[0], 'cold continuation must not reuse the settled epoch id')
    assert.equal(ends[1]!.runId, starts[1])
    assert.equal(ends[1]!.stopReason, 'completed')
  } finally {
    adapter.gate.resolve()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// MF-4（#247）：真实宿主的 completed+cleanup-error 表达。宿主在会话干净收尾时捕获
// completed 结果，但把拆卸失败折进终态边：subagent/end 为 error、随后 result 仍为
// completed。观察模块必须消费「结果 completed + end error」而不把已完成的工作误判成
// 技术失败。这里通过真实 AgentHandle 的 dispose 注入一次性清理故障来固定该表达。
test('A5 real DSH Host: a completed turn with a cleanup failure ends with an error edge and a completed result', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-a5-cleanup-'))
  const workspace = join(home, 'workspace')
  const sessions = join(home, 'sessions')
  mkdirSync(workspace, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapter = new A5ReplyAdapter()
  const childId = SessionId('a5-child')
  const signal = new AbortController().signal
  const sequence: string[] = []
  const stops: string[] = []
  let cleanupCalls = 0
  let injected = false

  try {
    await mountSubagentContractHost(ctx, { workspace, sessions, presetId: 'a5-base', adapter })
    type AgentHandle = Awaited<ReturnType<typeof ctx.agents.create>>
    const agents = ctx.agents as unknown as {
      create: (options: Parameters<typeof ctx.agents.create>[0]) => Promise<AgentHandle>
    }
    const originalCreate = agents.create.bind(ctx.agents)
    agents.create = async options => {
      const handle = await originalCreate(options)
      if (String(options.sessionId) !== String(childId) || injected) return handle
      injected = true
      const originalDispose = handle.dispose.bind(handle)
      handle.dispose = async () => {
        await originalDispose()
        cleanupCalls += 1
        throw new Error('A5 injected cleanup failure')
      }
      return handle
    }
    ctx.on('subagent/end', info => {
      if (String(info.id) !== String(childId)) return
      sequence.push('end')
      stops.push(String(info.stopReason))
    })

    const parent = await ctx.agentLoop.create(SessionId('a5-parent'), { provider: MODEL, model: MODEL }, { cwd: workspace })
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: 'a5-contract',
      childId,
      request: { prompt: [{ type: 'text', text: 'A5 PROMPT' }], parent, signal },
      signal,
      delivery: 'parent',
    })
    const result = await started.result
    sequence.push('result')

    assert.equal(injected, true, 'the cleanup fault must be injected on the child AgentHandle')
    assert.equal(cleanupCalls, 1)
    assert.deepEqual(sequence, ['end', 'result'], 'the terminal edge is published before the result resolves')
    assert.deepEqual(stops, ['error'], 'cleanup failure is folded into the terminal edge')
    assert.equal(result.stopReason, 'completed', 'the captured business result stays completed')
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})


// #246 A0 的真实宿主契约：宿主只在 setup 返回值 resolve 之后才 publication
// （agent-loop `setupAndPublish`：`await raceAbort(setup(...))` → publish）。
// 冷维护 setup 等待角色 preset 挂载正是靠这条时序才成立，所以这里在真实 Host 上
// 固定它：不等待的 setup 立刻发布（旧形态的失效机制）；等待中的 setup 在其
// resolve 前不发布；取消挂起中的 setup 不留迟到 live Agent，同一 Session id
// 之后仍可再次 resume。不断言取消能回滚底层 mount / preset 绑定。
test('A0 real DSH Host publishes a cold resume only after its awaited setup resolves (#246)', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-a0-setup-'))
  const workspace = join(home, 'workspace')
  const sessions = join(home, 'sessions')
  mkdirSync(workspace, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: sessions, compression: 'none', packChunks: false })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter([MODEL], new A30Adapter())

    const id = SessionId('a0-setup-contract')
    const seed = await ctx.agents.create({ sessionId: id, agentOptions: { provider: MODEL, model: MODEL }, meta: { cwd: workspace } })
    seed.agent.session.append('turn/start', { turn: 1 })
    seed.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await seed.dispose()
    assert.equal(ctx.agents.get(id), undefined, '冷基线：持久化会话存在但没有 live agent')

    // 1) 旧插件形态：setup 里把 mount 的 Promise 丢掉，宿主立刻 publication。
    const backgroundMount = Promise.withResolvers<void>()
    const detached = await ctx.agentLoop.resume(ctx, {
      resumeSessionId: id,
      setup: () => { void backgroundMount.promise },
    })
    assert.notEqual(ctx.agents.get(id), undefined,
      '不等待的 setup 在其同步返回后就被当成完成——这正是 #246 的失效机制（挂载仍在进行却已发布）')
    await detached.dispose()
    assert.equal(ctx.agents.get(id), undefined)
    backgroundMount.resolve()

    // 2) 修复形态：setup await 挂载，挂载完成前不得 publication。
    const mountStarted = Promise.withResolvers<void>()
    const mountGate = Promise.withResolvers<void>()
    const trace: string[] = []
    const pending = ctx.agentLoop.resume(ctx, {
      resumeSessionId: id,
      setup: async () => {
        trace.push('setup-start')
        mountStarted.resolve()
        await mountGate.promise
        trace.push('setup-done')
      },
    })
    await mountStarted.promise
    await sleep(50)
    assert.equal(ctx.agents.get(id), undefined, 'setup/挂载挂起期间不得 publication（否则后续解析会跑在没挂上的 isolate 上）')
    mountGate.resolve()
    const mountedHandle = await pending
    assert.deepEqual(trace, ['setup-start', 'setup-done'])
    assert.notEqual(ctx.agents.get(id), undefined, '挂载完成后才 publication')
    await mountedHandle.dispose()

    // 3) 挂起中取消：不留迟到 live Agent；同一 Session id 仍可再次 resume。
    const controller = new AbortController()
    const cancellingStart = Promise.withResolvers<void>()
    const cancelGate = Promise.withResolvers<void>()
    const cancelled = ctx.agentLoop.resume(ctx, {
      resumeSessionId: id,
      signal: controller.signal,
      setup: async () => {
        cancellingStart.resolve()
        await cancelGate.promise
      },
    })
    await cancellingStart.promise
    controller.abort()
    await assert.rejects(cancelled)
    cancelGate.resolve()
    await sleep(50)
    assert.equal(ctx.agents.get(id), undefined, '取消后的迟到 setup 不得发布 live Agent')

    const recovered = await ctx.agentLoop.resume(ctx, { resumeSessionId: id, setup: () => {} })
    assert.notEqual(ctx.agents.get(id), undefined, '同一 Session id 仍可冷 resume（取消不回滚可复用性）')
    await recovered.dispose()
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
