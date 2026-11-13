/** #294：收口诊断只投影白名单标识；从不接收异常、队列或 job detail。 */
import { z } from 'zod'
import { redact } from './tracelog.ts'

export const SAFETY_REASON_CODES = [
  'session_missing', 'orphan_tombstone', 'descendant_diagnostic', 'session_busy', 'inbox_pending',
  'generation_changed', 'descendants_changed', 'job_active', 'job_orphaned', 'probe_error', 'probe_timeout', 'unknown',
] as const
// 拒绝而非截断：不能把不完整 ID 伪装成可操作对象；未暴露的标识显式标记。
const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).refine(value => redact(value) === value)
export const safetyDiagnosticSchema = z.object({
  reasonCode: z.enum(SAFETY_REASON_CODES), type: z.enum(['session', 'descendant', 'job', 'probe']),
  sessionId: identifier.optional(), dispatchId: identifier.optional(), jobId: identifier.optional(), owner: identifier.optional(),
  state: z.enum(['idle', 'running', 'pending', 'stopping', 'completed', 'failed', 'killed', 'unknown']).optional(),
  identityUnavailable: z.literal(true).optional(),
}).strict()
export type SafetyDiagnostic = z.infer<typeof safetyDiagnosticSchema>
export type InspectionStatus = 'safe' | 'waiting' | 'unsafe'
/** 字符串兼容旧 Host/test seam；生产阻碍使用结构化结果。 */
export type SafeInspection = InspectionStatus | { status: Exclude<InspectionStatus, 'safe'>; diagnostic: SafetyDiagnostic }
export function inspectionStatus(result: SafeInspection): InspectionStatus { return typeof result === 'string' ? result : result.status }
export function safetyDiagnostic(reasonCode: SafetyDiagnostic['reasonCode'], type: SafetyDiagnostic['type'], fields: Partial<Record<'sessionId' | 'dispatchId' | 'jobId' | 'owner' | 'state', unknown>> = {}): SafetyDiagnostic {
  const result: SafetyDiagnostic = { reasonCode, type }
  for (const key of ['sessionId', 'dispatchId', 'jobId', 'owner'] as const) {
    if (fields[key] === undefined) continue
    const parsed = identifier.safeParse(fields[key])
    if (parsed.success) result[key] = parsed.data
    else result.identityUnavailable = true
  }
  if (fields.state !== undefined) {
    const parsed = safetyDiagnosticSchema.shape.state.safeParse(fields.state)
    result.state = parsed.success ? parsed.data : 'unknown'
  }
  return result
}
export function inspectionDiagnostic(result: SafeInspection, sessionId: string, dispatchId?: string): SafetyDiagnostic {
  const source = typeof result === 'string' ? safetyDiagnostic('unknown', 'probe', { sessionId }) : result.diagnostic
  // 同一白名单再次用于 Host → Engine 边界；不拷贝额外载荷。
  return { ...safetyDiagnostic(source.reasonCode, source.type, { ...source, dispatchId }), ...(source.identityUnavailable ? { identityUnavailable: true } : {}) }
}
export const SAFETY_BLOCK_HINT = '请等待相关活动闭包、联系原 owner 或核实对象状态；诊断不授权自动恢复或终止任务。'

