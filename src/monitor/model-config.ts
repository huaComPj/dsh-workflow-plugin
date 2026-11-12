/** #288：人类 GUI 的 exact-Run 主备配置边界；不复用只读 status 的 cwd 回退。 */
import { z } from 'zod'
import { isBrowserRpcCall, type EditorRpcHandler, type EditorRpcResult } from '../editor/rpc.ts'
import type { ModelConfigSaveResult, SaveRoleModelConfigInput } from '../engine/engine.ts'
import { roleModelConfig } from '../roles/roles.ts'
import { roleKeysWithJudge, type NodeExecution, type StateRow } from '../types.ts'

export const MODEL_CONFIG_RPC_CHANNEL = '/workflow-run-model-config'
const route = z.object({ provider: z.string(), modelId: z.string(), reasoningEffort: z.string().optional() }).strict()
const read = z.object({ runId: z.string().min(1).max(128) }).strict()
const save = read.extend({ role: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
  requestId: z.string().trim().min(1).max(128), primary: route, fallback: route.optional() }).strict()

export interface ModelConfigRpcDeps {
  maintenance: () => unknown | undefined
  byRunId: (runId: string) => Promise<StateRow | undefined>
  latest: (workspaceKey: string) => Promise<StateRow | undefined>
  executions?: (runId: string) => Promise<NodeExecution[]>
  save: (workspaceKey: string, input: SaveRoleModelConfigInput) => Promise<ModelConfigSaveResult>
}
const fail = (code: string, message: string, details: Record<string, unknown> = {}): EditorRpcResult =>
  ({ ok: false, error: { code: `model-config/${code}`, message, details } })

export function projectModelConfig(row: StateRow, executions: NodeExecution[] = [row.execution]) {
  const run = row.run
  const actuals = new Map<string, NonNullable<NodeExecution['dispatch']>>()
  for (const execution of [...executions].sort((a, b) => a.visit - b.visit)) {
    const definition = execution.workflowId === run.catalogWorkflowId ? run.definitionSnapshot.workflow
      : run.definitionSnapshot.childWorkflows?.[execution.workflowId]
    const executor = definition?.nodes[execution.nodeId]?.execution
    if (executor?.type === 'actor-task' && executor.role !== 'manager' && execution.dispatch !== undefined) actuals.set(executor.role, execution.dispatch)
    if (execution.judge !== undefined) actuals.set('judge', execution.judge)
  }
  return { runId: run.runId, workspaceKey: row.workspaceKey, workflowId: run.catalogWorkflowId, status: run.status,
    terminal: run.status === 'completed' || run.status === 'terminated',
    roles: roleKeysWithJudge(run.definitionSnapshot).map(role => {
      const config = roleModelConfig(run, role)
      const dispatch = actuals.get(role)
      return { role, primary: config.primary, ...(config.fallback === undefined ? {} : { fallback: config.fallback }), revision: config.revision,
        ...(dispatch?.model === undefined ? {} : { actual: dispatch.model }),
        pending: (dispatch?.configRevision ?? 0) !== config.revision }
    }) }
}

export function createModelConfigRpcHandler(deps: ModelConfigRpcDeps): EditorRpcHandler {
  return async (endpoint, payload, signal, context) => {
    if (!isBrowserRpcCall(context)) return fail('forbidden', '需要已鉴权的人类 GUI 浏览器连接')
    if (signal.aborted) return fail('unavailable', '请求已取消')
    if (endpoint !== 'model-config' && endpoint !== 'model-config-save') return fail('unknown-endpoint', '未知配置 endpoint')
    const parsed = (endpoint === 'model-config' ? read : save).safeParse(payload)
    if (!parsed.success) return fail('invalid-payload', '需要 exact runId 与合法主备配置，不接受身份或 cwd 字段')
    if (deps.maintenance() !== undefined) return fail('unavailable', '状态库处于维护模式')
    try {
      const row = await deps.byRunId(parsed.data.runId)
      if (row === undefined) return fail('target-not-found', '指定 Run 不存在；不会回退到其他 Run')
      const executions = await deps.executions?.(row.run.runId)
      if (endpoint === 'model-config') return { ok: true, value: projectModelConfig(row, executions) }
      if (row.run.status !== 'running' && row.run.status !== 'blocked') return fail('read-only', '终局 Run 只读')
      const latest = await deps.latest(row.workspaceKey)
      if (latest?.run.runId !== row.run.runId) return fail('target-not-found', '指定 Run 已不再是该 workspace 的当前 Run')
      if (signal.aborted) return fail('unavailable', '请求已取消')
      // save schema 此处已成功；重新解析只收窄联合类型，不添加第二种输入语义。
      const input = save.parse(parsed.data)
      const result = await deps.save(row.workspaceKey, input)
      if (!result.ok) {
        const current = await deps.byRunId(row.run.runId)
        return fail(result.code, result.reason, result.code === 'conflict' && current !== undefined ? { latest: projectModelConfig(current, await deps.executions?.(row.run.runId)) } : {})
      }
      // 读取保存返回的 Run，不把并发晚到的别次保存冒充本次结果。
      return { ok: true, value: { ...projectModelConfig({ ...row, run: result.run }, await deps.executions?.(row.run.runId)), message: result.message, replayed: result.replayed } }
    } catch (error) {
      return fail('save-failed', `配置请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
