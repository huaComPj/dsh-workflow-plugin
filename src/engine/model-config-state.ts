/** #287：配置保存不使工作回执失效；底层物理 CAS 与 execution CAS 仍是提交屏障。 */
import type { RuntimeRow, StateHost } from './engine.ts'
import type { NodeExecution, RunState } from '../types.ts'
import { StateGoneError, StateVersionError } from '../state/store.ts'

export class ModelConfigConflictError extends Error {
  constructor(workspaceKey: string, role: string, actual: number, expected: number) {
    super(`model config revision mismatch for ${workspaceKey}/${role}: actual ${actual}, expected ${expected}`)
    this.name = 'ModelConfigConflictError'
  }
}

const workVersion = (row: RuntimeRow): number => row.version - (row.run.modelConfigRevision ?? 0)
const configRevision = (run: RunState, role: string): number => run.roleModelConfigs?.[role]?.revision ?? 0
function actorRole(run: RunState, execution: NodeExecution): string | undefined {
  const workflow = execution.workflowId === run.catalogWorkflowId
    ? run.definitionSnapshot.workflow : run.definitionSnapshot.childWorkflows?.[execution.workflowId]
  const node = workflow?.nodes[execution.nodeId]
  return node?.execution.type === 'actor-task' && node.execution.role !== 'manager' ? node.execution.role : undefined
}

/** 只装配一次；配置端口必须保留原始 StateHost，不能经此工作端口写配置。 */
export function modelConfigState(state: StateHost): StateHost {
  return {
    async get(workspaceKey) {
      const row = await state.get(workspaceKey)
      return row === undefined ? undefined : { ...row, version: workVersion(row) }
    },
    async listRuns() {
      return (await state.listRuns()).map(row => ({ ...row, version: workVersion(row) }))
    },
    async create(workspaceKey, run, execution) {
      const revision = run.modelConfigRevision ?? 0
      return (await state.create(workspaceKey, run, execution)) - revision
    },
    execution: (workspaceKey, executionId) => state.execution(workspaceKey, executionId),
    events: (workspaceKey, executionId, after, limit) => state.events(workspaceKey, executionId, after, limit),
    historyOwner: (workspaceKey, executionId) => state.historyOwner(workspaceKey, executionId),
    async put(workspaceKey, run, expectedVersion, changes) {
      // 与 Store.updateRow 一样在第一个 await 前固定调用材料。
      const candidate = structuredClone(run)
      const savedChanges = structuredClone(changes)
      for (let attempt = 0; ; attempt += 1) {
        const current = await state.get(workspaceKey)
        if (current === undefined) throw new StateGoneError(workspaceKey)
        if (current.run.runId !== candidate.runId || workVersion(current) !== expectedVersion) {
          throw new StateVersionError(workspaceKey, workVersion(current), expectedVersion)
        }
        const stageRoles = new Set<string>()
        const requireRevision = (role: string, expected: number): void => {
          const actual = configRevision(current.run, role)
          if (actual !== expected) throw new ModelConfigConflictError(workspaceKey, role, actual, expected)
        }
        for (const change of savedChanges) {
          const execution = change.execution
          const previous = execution.executionId === current.execution.executionId
            ? current.execution : await state.execution(workspaceKey, execution.executionId)
          const role = actorRole(candidate, execution)
          if (role !== undefined && execution.dispatch !== undefined && execution.dispatch.id !== previous?.dispatch?.id) {
            requireRevision(role, execution.dispatch.configRevision ?? 0)
          }
          if (execution.judge !== undefined && execution.judge.id !== previous?.judge?.id) {
            requireRevision('judge', execution.judge.configRevision ?? 0)
          }
          if (change.events.includes('model-changed')) {
            const stageRole = change.events.includes('judge-arranged') || (execution.phase === 'checking' && execution.judge !== undefined)
              ? 'judge' : role
            if (stageRole !== undefined) {
              requireRevision(stageRole, configRevision(candidate, stageRole))
              stageRoles.add(stageRole)
            }
          }
        }
        const merged = structuredClone(candidate)
        // 工作写永远不能改配置内容/计数；有配置保存穿过 await 时连旧 stage/预算也不能覆盖。
        delete merged.roleModelConfigs
        delete merged.modelConfigRevision
        if (current.run.roleModelConfigs !== undefined) merged.roleModelConfigs = structuredClone(current.run.roleModelConfigs)
        if (current.run.modelConfigRevision !== undefined) merged.modelConfigRevision = current.run.modelConfigRevision
        if ((candidate.modelConfigRevision ?? 0) !== (current.run.modelConfigRevision ?? 0)) {
          merged.modelOverrides = structuredClone(current.run.modelOverrides)
          delete merged.roleRoutes
          if (current.run.roleRoutes !== undefined) merged.roleRoutes = structuredClone(current.run.roleRoutes)
          // 另一角色保存配置不妨碍本角色已通过 revision 校验的 stage 推进。
          for (const role of stageRoles) {
            const route = candidate.roleRoutes?.[role]
            if (route !== undefined) (merged.roleRoutes ??= {})[role] = structuredClone(route)
            else if (merged.roleRoutes !== undefined) delete merged.roleRoutes[role]
            const override = candidate.modelOverrides[role]
            if (override !== undefined) merged.modelOverrides[role] = structuredClone(override)
            else delete merged.modelOverrides[role]
          }
        }
        try {
          await state.put(workspaceKey, merged, current.version, savedChanges)
          return
        } catch (error) {
          if (!(error instanceof StateVersionError)) throw error
          const latest = await state.get(workspaceKey)
          // ponytail: 最多三次物理 CAS；持续配置争抢交回调用者，不持锁等待 Host。
          if (attempt >= 2 || latest === undefined || latest.version === current.version
            || latest.run.runId !== candidate.runId || workVersion(latest) !== expectedVersion) throw error
        }
      }
    },
  }
}
