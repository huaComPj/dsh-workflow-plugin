/**
 * #251 运行监控右侧栏 tab 组件：可见时每 2s 轮询 status，不可见暂停；
 * RPC 失败显示横幅并保留上一次成功数据，恢复后自动清横幅继续轮询。
 * #261：轮询上下文 = (scope.cwd, 选定 runId)，切目录/切 Run/重新可见都重建周期，
 * 旧上下文的在途响应一律丢弃；终态 Run 停周期，另给只读「刷新状态」入口。
 * status 保持只读；#288 按需模型配置经独立、鉴权的控制 RPC 提交。
 */
import { createElement as h, useState, useEffect, useRef } from 'react'
import { monitorViewModel, monitorErrorState, monitorPollingContinues, initialFollowState, monitorFollowView, selectFlow, resumeFollow, RECORD_COLUMNS } from './monitor-view.js'
import { NodeCanvas } from './graph-canvas.js'
import { EDITOR_STYLES } from './styles.js'
import { modelChoices } from './model-selector.js'

const POLL_INTERVAL_MS = 2000

const MONITOR_TEXT = 'var(--dsw-alias-label-primary, currentColor)'
const MONITOR_MUTED = 'var(--dsw-alias-label-secondary, currentColor)'
const MONITOR_ACCENT_TEXT = `color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 55%, ${MONITOR_TEXT})`

export const MONITOR_STYLES = `
/* #282 主题契约：正文/次要文字/边框取宿主 --dsw-alias-* 语义色（浅色由 body、深色由 body[data-ds-dark-theme] 定义），
   兜底写 currentColor；状态色由宿主状态语义色与正文色混合，浅深两套都保持 >=4.5:1，不再依赖宿主未定义的
   --dsh-text/#ddd 浅灰兜底，也不只按操作系统偏好换色。 */
.wf-monitor { font-size: 13px; color: ${MONITOR_TEXT}; padding: 8px; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; overflow-y: auto; gap: 8px; container-type: inline-size; }
/* 外层承接全部内容；低高度时不让 flex 压扁图、记录或展开材料。 */
.wf-monitor > * { flex-shrink: 0; min-width: 0; }
.wf-monitor-overview { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; align-items: start; }
.wf-monitor-overview > * { min-width: 0; }
.wf-monitor-current, .wf-monitor-node, .wf-monitor-prompt, .wf-record-rounds, .wf-monitor-toolbar { overflow-wrap: anywhere; }
.wf-monitor button:focus-visible, .wf-monitor select:focus-visible, .wf-monitor-records-scroll:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 2px; }
@container (max-width: 760px) { .wf-monitor-overview { grid-template-columns: minmax(0, 1fr); } }
.wf-monitor-banner { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 16%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 55%, transparent); color: ${MONITOR_TEXT}; padding: 6px 8px; border-radius: 6px; }
.wf-monitor-status { font-weight: 600; }
.wf-monitor-status.run-blocked { color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 60%, ${MONITOR_TEXT}); }
.wf-monitor-status.run-ok { color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 45%, ${MONITOR_TEXT}); }
.wf-monitor-muted { color: ${MONITOR_MUTED}; }
/* #286 摘要并入顶栏，随侧栏宽度自然换行。 */
.wf-model-config { border: 1px solid currentColor; border-radius: 6px; padding: 8px; overflow-wrap: anywhere; }
.wf-model-config-route { display: flex; flex-wrap: wrap; gap: 8px; margin-block: 8px; min-width: 0; }
.wf-model-config-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.wf-model-config select, .wf-model-config input { max-width: 100%; color: inherit; background: transparent; }
.wf-model-config input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); }
.wf-model-config-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.wf-monitor-summary { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; flex: 1 1 200px; }
.wf-monitor-return-value { color: ${MONITOR_MUTED}; }
.wf-monitor-terminal-note { margin-left: auto; color: ${MONITOR_MUTED}; font-size: 12px; }
/* #282 运行详情默认收起：原生 details/summary 保留键盘与 aria-expanded 语义。 */
.wf-monitor-details { display: flex; flex-direction: column; gap: 2px; }
.wf-monitor-details > summary { cursor: pointer; font-weight: 600; color: ${MONITOR_TEXT}; }
.wf-monitor-details > summary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 2px; }
.wf-monitor-details-body { display: flex; flex-direction: column; gap: 2px; padding-top: 2px; color: ${MONITOR_MUTED}; font-size: 12px; overflow-wrap: anywhere; }
.wf-monitor-prompt { white-space: pre-wrap; background: rgba(128,128,128,0.12); border-radius: 6px; padding: 6px 8px; }
.wf-monitor-nodes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.wf-monitor-node { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; padding: 3px 6px; border-radius: 4px; }
.wf-monitor-node.wf-node-current { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 18%, transparent); }
.wf-node-phase.phase-working { color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 45%, ${MONITOR_TEXT}); }
.wf-node-phase.phase-checking { color: ${MONITOR_ACCENT_TEXT}; }
.wf-node-phase.phase-settling { color: ${MONITOR_ACCENT_TEXT}; }
.wf-node-phase.phase-exited { color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 45%, ${MONITOR_TEXT}); }
.wf-node-phase.phase-ready { color: ${MONITOR_MUTED}; }
.wf-node-block { color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 60%, ${MONITOR_TEXT}); font-weight: 600; }
/* #252 运行图：复用配置编辑器画布样式，只读展示；侧栏里给固定高度并允许缩放/平移。 */
.wf-monitor-graph { display: flex; flex-direction: column; gap: 4px; }
/* #282 图默认高度适中：0,4,0 特异度压过共享编辑器 @container 的 460px 覆盖（窄侧栏下曾长期挤占首屏）。 */
.wf-monitor-graph .wf-editor.wf-monitor-canvas {
  --wf-bg: transparent;
  --wf-surface: var(--dsw-alias-bg-layer-2, #ffffff);
  --wf-soft: var(--dsw-alias-bg-layer-3, #eef3f7);
  --wf-text: var(--dsw-alias-label-primary, #243449);
  --wf-muted: var(--dsw-alias-label-secondary, #65768b);
  --wf-border: var(--dsw-alias-border-l3, #dbe3ec);
  height: auto; padding: 0; gap: 0; background: transparent; overflow: hidden;
}
.wf-monitor-graph .wf-editor.wf-monitor-canvas .wf-canvas { height: 260px; min-height: 220px; }
.wf-monitor-graph .wf-canvas-help { margin-top: 4px; }
.wf-monitor-flowtabs { display: flex; gap: 4px; flex-wrap: wrap; }
.wf-monitor-flowtabs button { padding: 3px 8px; font-size: 12px; }
/* #276 只读查看工具：临时调整只在本页生效，恢复布局只重置当前流程。 */
.wf-monitor-viewtools { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; font-size: 12px; }
.wf-monitor-viewtools button { padding: 3px 8px; font-size: 12px; }
/* #282 选中态取宿主 business 语义色（文字 55% 混正文色，两种主题都 >=4.5:1）。 */
.wf-monitor-flowtabs button[aria-selected="true"] { border-color: var(--dsw-alias-state-business-primary, currentColor); color: ${MONITOR_ACCENT_TEXT}; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 14%, transparent); }
/* #253 子流程下钻：面包屑导航 + 暂停跟随后的「回到当前节点」入口。 */
.wf-monitor-breadcrumb { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; font-size: 12px; }
.wf-monitor-breadcrumb button { padding: 2px 6px; font-size: 12px; border: 1px solid transparent; background: transparent; color: inherit; }
.wf-monitor-breadcrumb button.is-current { border-color: var(--dsw-alias-state-business-primary, currentColor); color: ${MONITOR_ACCENT_TEXT}; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 14%, transparent); }
.wf-monitor-sep { opacity: 0.6; }
.wf-monitor-return { align-self: flex-start; padding: 3px 8px; font-size: 12px; border-color: var(--dsw-alias-state-business-primary, currentColor); color: ${MONITOR_ACCENT_TEXT}; }
/* #254 多 Run 切换器 / 空态 / 终态提示。 */
.wf-monitor-switcher { display: flex; align-items: center; gap: 6px; font-size: 12px; min-width: 0; max-width: 100%; }
.wf-monitor-switcher select { min-width: 0; max-width: 100%; padding: 2px 4px; font-size: 12px; }
.wf-monitor-guidance { background: rgba(128,128,128,0.12); border-radius: 6px; padding: 8px; white-space: pre-wrap; }
.wf-monitor-maintenance { white-space: pre-wrap; }
/* #261 只读刷新入口：终态停周期后由用户决定何时重新读取；#282 与 Run 选择同排，少占一行。 */
.wf-monitor-toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.wf-monitor-refresh { padding: 2px 8px; font-size: 12px; }
/* #274 独立当前执行卡：一眼看清谁在干活、用什么模型、来源阶段。 */
.wf-monitor-current { display: flex; flex-direction: column; gap: 4px; background: color-mix(in srgb, ${MONITOR_TEXT} 6%, transparent); border-left: 3px solid var(--dsw-alias-state-business-primary, #4176e6); border-radius: 6px; padding: 8px; }
.wf-monitor-current.is-terminal { border-left-color: ${MONITOR_MUTED}; }
.wf-monitor-card-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.wf-monitor-card-title { font-size: 14px; }
.wf-monitor-card-row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.wf-monitor-card-role { min-width: 96px; color: ${MONITOR_MUTED}; }
.wf-monitor-card-state { font-weight: 600; }
.wf-monitor-card-terminal { color: ${MONITOR_TEXT}; font-weight: 600; }
/* #286 原生双向滚动：短表自然高，长表占视口约 60%，横条留在可视窗口底部。 */
.wf-monitor-records { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.wf-monitor-records-title { font-weight: 600; font-size: 13px; }
.wf-monitor-records-scroll { max-height: 60vh; max-height: 60dvh; overflow: auto; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3)); border-radius: 6px; background: var(--dsw-alias-bg-layer-2, Canvas); }
.wf-record-table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12px; }
.wf-record-table th, .wf-record-table td { box-sizing: border-box; padding: 4px 6px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); }
.wf-record-table thead th { position: sticky; top: 0; z-index: 3; background: var(--dsw-alias-bg-layer-2, Canvas); border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.45)); }
.wf-record-table .wf-record-sticky-1 { position: sticky; left: 0; z-index: 2; background: var(--dsw-alias-bg-layer-2, Canvas); width: 168px; min-width: 168px; max-width: 168px; overflow: hidden; text-overflow: ellipsis; }
.wf-record-table .wf-record-sticky-2 { position: sticky; left: 168px; z-index: 2; background: var(--dsw-alias-bg-layer-2, Canvas); min-width: 96px; box-shadow: 1px 0 0 var(--dsw-alias-border-l3, rgba(128,128,128,0.35)); }
/* 窄侧栏只固定节点身份，给后方字段留出空间；完整名称可用行展开阅读。 */
@container (max-width: 600px) {
  .wf-record-table .wf-record-sticky-1 { width: 124px; min-width: 124px; max-width: 124px; }
  .wf-record-table tbody .wf-record-sticky-2 { position: static; }
  .wf-record-table thead .wf-record-sticky-2 { left: auto; }
}
.wf-record-table thead .wf-record-sticky-1, .wf-record-table thead .wf-record-sticky-2 { z-index: 4; }
.wf-record-table tbody .wf-record-sticky-1, .wf-record-table tbody .wf-record-sticky-2 { background: var(--dsw-alias-bg-layer-2, Canvas); }
.wf-record-row.is-blocked td { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c85050) 12%, var(--dsw-alias-bg-layer-2, Canvas)); }
.wf-record-row.is-current td { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #78a0ff) 14%, var(--dsw-alias-bg-layer-2, Canvas)); }
.wf-record-toggle { padding: 0 4px; font-size: 11px; border: 1px solid rgba(128,128,128,0.5); background: transparent; color: inherit; margin-right: 4px; }
.wf-record-node { font-weight: 600; }
.wf-record-detail td { background: rgba(128,128,128,0.08); white-space: normal; }
.wf-record-rounds { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
`

/** 轮询上下文键：cwd + 选定 runId 决定一个独立读取周期；用值而非函数身份，重渲染不重启周期（#261）。 */
function pollContextKey(cwd, runId) {
  return `${cwd ?? ''}\u0000${runId ?? ''}`
}

const IDLE_POLL_STATE = { key: null, data: null, banner: '', refreshing: false }

/**
 * 轮询驱动（抽出便于测试），上下文 = (scope.cwd, 选定 runId)：
 * - 可见时每 2s 读取；document 隐藏期间不发请求；终态停周期，运行中/BLOCK/空态/维护态继续。
 * - 上下文变化、tab 隐藏或卸载时旧在途响应一律丢弃：不写数据/横幅，也不启停别人的定时器。
 * - refresh()：只读手动刷新，同上下文在途请求合并；返回活跃/空态/维护态后恢复周期。
 * - 数据与横幅带上下文键：切目录/切 Run 的当次渲染就读不到旧目录数据（不等 effect 擦除）。
 */
export function useMonitorPolling(fetchStatus, options = {}) {
  const enabled = options.enabled !== false
  const cwd = typeof options.cwd === 'string' ? options.cwd : null
  const runId = typeof options.runId === 'string' ? options.runId : null
  const key = pollContextKey(cwd, runId)
  const [state, setState] = useState({ ...IDLE_POLL_STATE, key })
  const fetchRef = useRef(fetchStatus)
  const refreshRef = useRef(null)
  // 每次渲染新建的闭包只更新引用，不参与周期依赖（R1 F4：函数身份不重启轮询）。
  useEffect(() => { fetchRef.current = fetchStatus }, [fetchStatus])
  useEffect(() => {
    if (!enabled) { refreshRef.current = null; return undefined }
    let disposed = false
    let timer
    let busy = false
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const stop = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined } }
    const schedule = () => { stop(); if (!disposed) timer = setTimeout(tick, POLL_INTERVAL_MS) }
    const read = async (manual) => {
      if (disposed) return
      // 同上下文在途刷新合并成一次，不叠加请求；手动点击在结果回来前给按钮即时反馈。
      if (manual) setState(prev => (prev.key === key ? { ...prev, refreshing: true } : prev))
      if (busy) return
      stop()
      busy = true
      let payload
      let errorText = ''
      try {
        const result = await fetchRef.current(runId)
        if (result?.ok) payload = result.value
        else errorText = String(result?.error?.message ?? result?.error?.code ?? 'monitor failed')
      } catch (error) {
        errorText = String(error)
      }
      // 卸载或上下文已切换（本周期被 dispose）：旧响应静默丢弃。
      if (disposed) return
      busy = false
      if (payload !== undefined) {
        setState({ key, data: payload, banner: '', refreshing: false })
        // 终态停周期；其余模式继续（维护态恢复、空态等新 Run 都靠它自愈，见 monitorPollingContinues）。
        if (!monitorPollingContinues(payload)) return
      } else {
        // 失败：只保留同一上下文最后成功数据，横幅提示，下一轮自动重试。
        setState(prev => ({
          key,
          data: prev.key === key ? prev.data : null,
          banner: monitorErrorState(prev.key === key ? prev.banner : '', errorText),
          refreshing: false,
        }))
      }
      schedule()
    }
    const tick = () => {
      if (disposed) return
      // 页面隐藏：不发请求，保留周期让回到可见后自愈（visibilitychange 另外立即读一次）。
      if (hidden()) { schedule(); return }
      void read(false)
    }
    // 重新可见读一次：隐藏期或在途时不叠加；终态上下文的这次读取只是复用同一周期规则。
    const wake = () => { if (disposed || busy || hidden()) return; void read(false) }
    refreshRef.current = () => { if (!disposed) void read(true) }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake)
    void read(false)
    return () => {
      disposed = true
      refreshRef.current = null
      stop()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake)
    }
  }, [enabled, key])
  const current = state.key === key ? state : IDLE_POLL_STATE
  return {
    data: current.data,
    banner: current.banner,
    refreshing: current.refreshing,
    refresh: () => { const invoke = refreshRef.current; if (invoke !== null) invoke() },
  }
}

/** #274 当前执行卡：节点为主标题，Actor/Judge 的模型·来源·状态分行显示；无事实的字段不渲染。 */
function currentCardEl(card) {
  if (card === null || card === undefined) return null
  const row = (name, entry) => h('div', { className: 'wf-monitor-card-row' },
    h('span', { className: 'wf-monitor-card-role' }, name),
    entry.modelText === null || entry.modelText === ''
      ? null
      : h('span', { className: 'wf-monitor-muted', title: entry.modelText }, entry.modelText),
    // #274 重派后的旧轮：另起一段标注「上一轮 …」，当前轮不因此变色/移位。
    entry.previousText === null || entry.previousText === undefined
      ? null
      : h('span', { className: 'wf-monitor-muted wf-monitor-card-prev', title: entry.previousText }, entry.previousText),
    h('span', { className: 'wf-monitor-card-state' }, entry.status))
  return h('div', {
    className: `wf-monitor-current${card.active ? '' : ' is-terminal'}`,
    role: 'region',
    'aria-label': card.heading,
    'data-execution-id': card.executionId ?? '',
  },
  h('div', { className: 'wf-monitor-card-head' },
    h('strong', { className: 'wf-monitor-card-title' }, `${card.heading}：${card.nodeId}`),
    h('span', { className: 'wf-monitor-muted' }, [card.workflowLabel, card.visitText].filter(Boolean).join(' · ')),
    h('span', { className: `wf-node-phase ${card.phaseClass}` }, card.phaseLabel),
    card.active ? null : h('span', { className: 'wf-monitor-card-terminal' }, card.terminalLabel)),
  card.targetText === null ? null : h('div', { className: 'wf-monitor-muted' }, card.targetText),
  card.actor === null ? null : row(`Actor（${card.actor.role ?? '—'}）`, card.actor),
  card.judge === null ? null : row('Judge', card.judge),
  card.blocked ? h('div', { className: 'wf-node-block' }, `BLOCK：${card.blockReason}`) : null)
}

/** #275 执行记录表下钻：同一次进入内的多轮提交/判定、未形成提交的重派与换模时间线。 */
function recordDetailEl(record) {
  const items = [h('li', { key: 'identity' }, `${record.nodeLabel} · 节点 ID：${record.nodeId} · ${record.workflowLabel}`)]
  if (record.blockReason !== null && record.blockReason !== '') items.push(h('li', { key: 'block', className: 'wf-node-block' }, `BLOCK：${record.blockReason}`))
  for (const round of record.drilldown.rounds) {
    const times = [`提交 ${round.submittedAtText ?? '时间未记录'}`, round.judgedAtText === null ? null : `判定 ${round.judgedAtText}`].filter(Boolean).join(' · ')
    items.push(h('li', { key: round.claimId }, `第 ${round.index} 轮：${round.resultText} · ${round.statusText} · ${times} · Actor ${round.actorModelText} · Judge ${round.judgeModelText}`))
  }
  if (record.drilldown.pending !== undefined) items.push(h('li', { key: 'pending' }, `第 ${record.drilldown.pending.index} 轮：${record.drilldown.pending.statusText} · Actor ${record.drilldown.pending.actorModelText}`))
  for (const [index, attempt] of record.drilldown.abandoned.entries()) {
    items.push(h('li', { key: `abandoned-${index}`, className: 'wf-monitor-muted' }, `未形成提交的派发：${attempt.reasonText} · ${attempt.modelText}${attempt.atText === null ? '' : ` · ${attempt.atText}`}`))
  }
  for (const [index, switchEvent] of record.drilldown.switches.entries()) {
    items.push(h('li', { key: `switch-${index}`, className: 'wf-monitor-muted' }, `${switchEvent.roleText}${switchEvent.atText === null ? '' : `：${switchEvent.atText}`}`))
  }
  return h('ul', { className: 'wf-record-rounds' }, ...items)
}

/** #275 执行记录表：每次进入一行，同一次进入的多轮事实收在行下钻里。 */
function recordsEl(records, openKey, onToggle) {
  if (!Array.isArray(records) || records.length === 0) return null
  const cell = (record, name) => {
    if (name === '节点名称') {
      const expanded = openKey === record.key
      return h('td', { key: name, className: 'wf-record-sticky-1' },
        h('button', {
          type: 'button',
          className: 'wf-record-toggle',
          'aria-expanded': expanded ? 'true' : 'false',
          'aria-label': `${expanded ? '收起' : '展开'} ${record.nodeLabel} 的提交/判定明细`,
          onClick: () => onToggle(record.key),
        }, expanded ? '▾' : '▸'),
        h('span', { className: 'wf-record-node', title: record.nodeId }, record.nodeLabel),
        record.visitText !== '' ? h('span', { className: 'wf-monitor-muted' }, ` ${record.visitText}`) : null)
    }
    if (name === '所属流程') return h('td', { key: name, className: 'wf-record-sticky-2', title: record.workflowLabel }, record.flowText)
    if (name === '运行情况') {
      return h('td', { key: name },
        record.outcomeText,
        record.roundCountText === null ? null : h('span', { className: 'wf-monitor-muted' }, ` · ${record.roundCountText}`),
        record.waitingText === null ? null : h('span', { className: 'wf-monitor-muted' }, ` · ${record.waitingText}`))
    }
    if (name === '进入时间') return h('td', { key: name }, record.enteredAtText ?? '—')
    if (name === '提交结果时间') return h('td', { key: name }, record.submittedAtText)
    if (name === '提交判定时间') return h('td', { key: name }, record.judgedAtText)
    if (name === 'Actor 模型') return h('td', { key: name, title: record.actorModelText }, record.actorModelText)
    return h('td', { key: name, title: record.judgeModelText }, record.judgeModelText)
  }
  return h('section', { className: 'wf-monitor-records', 'aria-label': '执行记录' },
    h('div', { className: 'wf-monitor-records-title' }, `执行记录（${records.length} 次进入）`),
    h('div', { className: 'wf-monitor-records-scroll', role: 'region', 'aria-label': '执行记录，可横向和纵向滚动', tabIndex: 0 },
      h('table', { className: 'wf-record-table' },
        h('thead', null,
          h('tr', null, ...RECORD_COLUMNS.map((name, index) => h('th', {
            key: name,
            scope: 'col',
            className: index === 0 ? 'wf-record-sticky-1' : index === 1 ? 'wf-record-sticky-2' : '',
          }, name)))),
        h('tbody', null,
          ...records.flatMap(record => {
            const expanded = openKey === record.key
            const row = h('tr', {
              key: record.key,
              className: `wf-record-row${record.blocked ? ' is-blocked' : ''}${record.current === true ? ' is-current' : ''}`,
            }, ...RECORD_COLUMNS.map(name => cell(record, name)))
            if (!expanded) return [row]
            return [row, h('tr', { key: `${record.key}:detail`, className: 'wf-record-detail' },
              h('td', { colSpan: RECORD_COLUMNS.length }, recordDetailEl(record)))]
          })))),
  )
}

const emptyModelForm = () => ({ provider: '', modelId: '', effort: '' })
const modelFormOf = route => ({ provider: route?.provider ?? '', modelId: route?.modelId ?? '', effort: route?.reasoningEffort ?? '' })
const modelDraftOf = role => ({ primary: modelFormOf(role.primary), fallback: modelFormOf(role.fallback) })
const modelRouteOf = form => ({ provider: form.provider, modelId: form.modelId, ...(form.effort.trim() === '' ? {} : { reasoningEffort: form.effort.trim() }) })
const routeText = route => route?.provider && route?.modelId
  ? `${route.provider}/${route.modelId}${route.reasoningEffort ? ` · ${route.reasoningEffort}` : ' · 模型默认档位'}` : '未记录'
const modelDraftDirty = editor => editor?.draft && JSON.stringify(editor.draft) !== JSON.stringify(modelDraftOf(editor.baseline))

/** 仅渲染表单，生命周期留在监控模块；目录是建议，最终路由/能力校验由服务端完成。 */
function modelEditorEl(editor, catalog, actions) {
  if (editor === null) return null
  const latestRole = editor.latest?.roles?.find(role => role.role === editor.role)
  const terminal = editor.latest?.terminal || (editor.latest !== null && !['running', 'blocked'].includes(editor.latest.status))
  const readonly = terminal || !actions.targetMatches
  const busy = editor.saving || editor.pending !== null
  const fields = (kind, title) => {
    const form = editor.draft[kind]
    const { providers, models } = modelChoices(catalog.groups, form.provider, form.modelId)
    const select = (label, value, choices, change) => h('label', { className: 'wf-model-config-field' }, label,
      h('select', { 'aria-label': `${title} ${label}`, value, disabled: busy || readonly, onChange: event => change(event.target.value) },
        h('option', { value: '' }, '请选择'), ...choices.map(item => h('option', { key: item.id, value: item.id }, `${item.name} (${item.id})`))))
    return h('fieldset', { className: 'wf-model-config-route', disabled: busy || readonly },
      h('legend', null, title),
      select('provider', form.provider, providers, provider => actions.field(kind, { provider, modelId: '', effort: '' })),
      select('modelId', form.modelId, models, modelId => actions.field(kind, { modelId, effort: '' })),
      h('label', { className: 'wf-model-config-field' }, '思考档位（留空 = 模型默认）',
        h('input', { 'aria-label': `${title} 思考档位`, value: form.effort, disabled: busy || readonly,
          onChange: event => actions.field(kind, { effort: event.target.value }) })),
      h('button', { type: 'button', disabled: busy || readonly, onClick: () => actions.field(kind, kind === 'fallback' ? emptyModelForm() : { effort: '' }) },
        kind === 'fallback' ? '清空备用（禁用）' : '使用模型默认档位'),
      h('small', null, form.provider && form.modelId ? `完整路由：${form.provider}/${form.modelId}` : kind === 'primary' ? '主模型必填' : '未配置备用（禁用）'))
  }
  return h('section', { className: 'wf-model-config', 'aria-label': '运行模型配置' },
    h('div', { className: 'wf-monitor-card-head' }, h('strong', null, '模型配置'),
      h('button', { type: 'button', onClick: actions.close }, '关闭模型配置')),
    h('div', null, `目标 Run：${editor.target.runId}`),
    h('div', null, `目标工作区：${editor.target.workspaceKey}`),
    !actions.targetMatches ? h('div', { role: 'alert' }, '当前监控已切换；原目标草稿已保留，暂停更新，绝不自动改写其他 Run。',
      h('button', { type: 'button', onClick: actions.returnTarget }, '返回编辑目标 Run')) : null,
    h('p', { className: 'wf-monitor-muted' }, '只修改此 Run 的下一次新派发配置；不打断当前任务，BLOCK 不会自动恢复。'),
    editor.loading ? h('p', { role: 'status' }, '正在读取模型配置…') : null,
    editor.error ? h('p', { role: 'alert' }, editor.error) : null,
    editor.notice ? h('p', { role: 'status' }, editor.notice) : null,
    editor.draft ? h('div', null,
      h('label', { className: 'wf-model-config-field' }, '角色',
        h('select', { 'aria-label': '模型配置角色', value: editor.role, disabled: busy,
          onChange: event => actions.role(event.target.value) },
        ...editor.latest.roles.filter(role => role.role !== 'manager').map(role => h('option', { key: role.role, value: role.role }, role.role === 'judge' ? 'Judge' : role.role)))),
      h('div', null, `实际派发模型：${routeText(latestRole?.actual)}`),
      h('div', null, `已保存主模型：${routeText(latestRole?.primary)}`),
      h('div', null, `已保存备用：${latestRole?.fallback ? routeText(latestRole.fallback) : '禁用'}`),
      h('div', { role: 'status' }, latestRole?.pending ? '已保存待生效：下次新派发生效' : '已保存配置；实际派发以运行记录为准'),
      terminal ? h('p', { role: 'status' }, '目标 Run 已结束，只读；不能更新模型配置。') : null,
      fields('primary', '主模型'), fields('fallback', '备用模型（可选）'),
      latestRole?.revision !== editor.baseline.revision ? h('div', { role: 'alert' },
        '模型配置已被其他人或工具修改；本地草稿已保留。请核对上方最新配置。',
        h('button', { type: 'button', disabled: busy || readonly, onClick: actions.rebase }, '核对后使用最新配置版本')) : null,
      h('div', { className: 'wf-model-config-actions' },
        h('button', { type: 'button', disabled: busy || readonly || latestRole?.revision !== editor.baseline.revision,
          onClick: actions.save }, '更新，下次从主模型开始'),
        editor.unknown ? h('button', { type: 'button', disabled: editor.saving || readonly, onClick: actions.retry }, '重传同一次更新') : null,
        h('button', { type: 'button', disabled: catalog.loading, onClick: actions.reloadModels }, '刷新模型列表')),
      editor.unknown ? h('p', { role: 'alert' }, '保存结果未知，服务端可能已保存。重传会复用同一请求，不会再次重开恢复轮次；关闭不会撤销保存。') : null,
      catalog.error ? h('p', { role: 'alert' }, catalog.error) : null,
      ...catalog.failures.map(failure => h('p', { key: failure.id, role: 'status' }, `${failure.name}：${failure.message}`)),
    ) : null,
    editor.leave ? h('div', { role: 'alertdialog', 'aria-label': '放弃模型配置草稿确认' },
      h('p', null, editor.pending ? '更新可能已经保存；关闭或切换不会撤销请求。是否放弃本地草稿和重传状态？' : '尚有未保存草稿，是否放弃？'),
      h('button', { type: 'button', onClick: actions.stay }, '继续编辑'),
      h('button', { type: 'button', onClick: actions.discard }, '放弃并继续')) : null)
}

export function WorkflowMonitorTab({ fetchStatus, configRpc, loadModels, visible = true, scope }) {
  // 目录只来自 tab scope.cwd；缺席/空串不回退宿主 process.cwd（R1 F4）。
  const cwd = typeof scope?.cwd === 'string' && scope.cwd !== '' ? scope.cwd : null
  // 选择与目录绑在一起：cwd 变化即回到「当前目录（默认）」，不等 effect 事后纠正（#261）。
  const [selection, setSelection] = useState({ cwd, runId: null })
  const selectedRunId = selection.cwd === cwd ? selection.runId : null
  const [follow, setFollow] = useState(initialFollowState)
  // #275 执行记录表下钻：一次只展开一行；Run 变化时收起（行 key 含 runId 之外的身份，显式重置更稳）。
  const [openRecord, setOpenRecord] = useState(null)
  // #276 恢复布局：只递增信号让画布重置当前流程的临时位置/视图，不触碰数据与配置。
  const [layoutReset, setLayoutReset] = useState(0)
  // 维护态继续探测、终态停周期、只读手动刷新都在 hook 里（#261）。
  const { data, banner, refreshing, refresh } = useMonitorPolling(
    runId => fetchStatus(runId),
    { enabled: visible !== false, cwd, runId: selectedRunId },
  )
  const view = monitorViewModel(data, { banner })
  const returnedRunId = view.mode === 'run' || view.mode === 'terminal' ? view.run.runId : null
  const [modelEditor, setModelEditor] = useState(null)
  const [modelCatalog, setModelCatalog] = useState({ groups: [], failures: [], loading: false, error: '' })
  const [catalogRevision, setCatalogRevision] = useState(0)
  const editorEpoch = useRef(0)
  const readEpoch = useRef(0)
  const savingRequest = useRef(null)
  const editorRef = useRef(modelEditor)
  editorRef.current = modelEditor
  const configRpcRef = useRef(configRpc)
  configRpcRef.current = configRpc
  const openModels = () => {
    if (returnedRunId === null) return
    editorEpoch.current += 1
    setModelEditor({ target: { runId: returnedRunId, workspaceKey: view.run.workspaceKey }, loading: true,
      role: '', draft: null, baseline: null, latest: null, pending: null, saving: false, unknown: false, error: '', notice: '', leave: null })
  }
  const leaveEditor = action => {
    const editor = editorRef.current
    if (editor !== null && (modelDraftDirty(editor) || editor.pending !== null)) {
      setModelEditor(previous => ({ ...previous, leave: action }))
      return
    }
    editorEpoch.current += 1
    setModelEditor(null)
    if (action.kind === 'run') setSelection({ cwd, runId: action.runId })
  }
  const chooseRole = role => {
    const editor = editorRef.current
    if (role === editor.role) return
    if (modelDraftDirty(editor)) { setModelEditor(previous => ({ ...previous, leave: { kind: 'role', role } })); return }
    const baseline = editor.latest.roles.find(item => item.role === role)
    if (baseline) setModelEditor(previous => ({ ...previous, role, baseline, draft: modelDraftOf(baseline), error: '', notice: '', leave: null }))
  }
  // 模型读取不沿用 status 的失效 ID 回退；旧目标/旧读取的成功和失败都不能污染新面板。
  useEffect(() => {
    if (modelEditor === null) return undefined
    const target = modelEditor.target
    const epoch = editorEpoch.current
    const reading = ++readEpoch.current
    let active = true
    Promise.resolve().then(() => configRpcRef.current('model-config', { runId: target.runId })).then(result => {
      if (!active || epoch !== editorEpoch.current || reading !== readEpoch.current) return
      setModelEditor(previous => {
        if (previous === null || previous.target.runId !== target.runId) return previous
        if (!result.ok) return { ...previous, loading: false, error: result.error?.message ?? '无法读取模型配置' }
        const latest = result.value
        if (latest.runId !== target.runId || latest.workspaceKey !== target.workspaceKey) return { ...previous, loading: false, error: '模型配置返回的目标不匹配；拒绝使用。' }
        const roles = latest.roles.filter(role => role.role !== 'manager')
        const baseline = previous.baseline ?? roles[0]
        return { ...previous, loading: false, latest: { ...latest, roles },
          ...(baseline && previous.baseline === null ? { baseline, role: baseline.role, draft: modelDraftOf(baseline) } : {}) }
      })
    }).catch(error => {
      if (active && epoch === editorEpoch.current && reading === readEpoch.current) setModelEditor(previous => previous === null ? previous : { ...previous, loading: false, error: String(error) })
    })
    return () => { active = false }
  }, [data, modelEditor?.target.runId])
  useEffect(() => {
    if (modelEditor === null) return undefined
    let active = true
    setModelCatalog(previous => ({ ...previous, loading: true, error: '' }))
    Promise.resolve().then(() => loadModels()).then(value => {
      if (active) setModelCatalog({ ...value, loading: false, error: '' })
    }, error => { if (active) setModelCatalog(previous => ({ ...previous, loading: false, error: String(error.message ?? error) })) })
    return () => { active = false }
  }, [modelEditor !== null, loadModels, catalogRevision])
  const saveModels = async retry => {
    const editor = editorRef.current
    if (editor === null || editor.saving || editor.draft === null || editor.target.runId !== returnedRunId
      || savingRequest.current?.epoch === editorEpoch.current || (editor.pending !== null && !retry)) return
    let pending = retry ? editor.pending : null
    if (pending === null) {
      const { primary, fallback } = editor.draft
      if (!primary.provider || !primary.modelId || ((fallback.provider || fallback.modelId || fallback.effort) && (!fallback.provider || !fallback.modelId))) {
        setModelEditor(previous => ({ ...previous, error: '主模型必须包含 provider/modelId；备用需完整填写或清空禁用。' }))
        return
      }
      pending = { runId: editor.target.runId, role: editor.role, expectedRevision: editor.baseline.revision,
        requestId: crypto.randomUUID(), primary: modelRouteOf(primary), ...(fallback.provider ? { fallback: modelRouteOf(fallback) } : {}) }
    }
    const epoch = editorEpoch.current
    savingRequest.current = { epoch, requestId: pending.requestId }
    setModelEditor(previous => ({ ...previous, pending, saving: true, unknown: false, error: '', notice: '' }))
    let result
    try { result = await configRpcRef.current('model-config-save', pending) }
    catch (error) { result = { ok: false, error: { code: 'editor/transport', message: String(error) } } }
    if (savingRequest.current?.requestId === pending.requestId) savingRequest.current = null
    if (epoch !== editorEpoch.current) return
    // 不让较早的轮询读取覆盖这次保存返回的最新配置。
    readEpoch.current += 1
    setModelEditor(previous => {
      if (previous === null || previous.pending?.requestId !== pending.requestId) return previous
      if (!result.ok) {
        const code = result.error?.code ?? ''
        const unknown = /timeout|transport|cancelled|save-failed/.test(code)
        const latest = result.error?.details?.latest
        return { ...previous, saving: false, unknown, pending: unknown ? pending : null,
          ...(latest?.runId === pending.runId ? { latest } : {}), error: result.error?.message ?? '模型保存失败；草稿已保留。' }
      }
      const latest = result.value
      if (latest.runId !== pending.runId || latest.workspaceKey !== previous.target.workspaceKey) {
        return { ...previous, saving: false, unknown: true, error: '保存响应目标不匹配；结果未知，请重传同一次更新。' }
      }
      const baseline = latest.roles.find(role => role.role === pending.role)
      return { ...previous, latest, baseline, draft: modelDraftOf(baseline), saving: false, pending: null, unknown: false,
        error: '', notice: '已保存：下次新派发生效；当前已登记派发保持原模型。' }
    })
  }
  const modelActions = {
    targetMatches: modelEditor?.target.runId === returnedRunId,
    returnTarget: () => setSelection({ cwd, runId: editorRef.current.target.runId }),
    close: () => leaveEditor({ kind: 'close' }), role: chooseRole,
    field: (kind, patch) => setModelEditor(previous => ({ ...previous, draft: { ...previous.draft, [kind]: { ...previous.draft[kind], ...patch } }, error: '', notice: '' })),
    save: () => { void saveModels(false) }, retry: () => { void saveModels(true) },
    rebase: () => setModelEditor(previous => ({ ...previous, baseline: previous.latest.roles.find(role => role.role === previous.role), error: '', notice: '已确认最新版本；本地草稿保留，请主动更新。' })),
    reloadModels: () => setCatalogRevision(value => value + 1),
    stay: () => setModelEditor(previous => ({ ...previous, leave: null })),
    discard: () => {
      const action = editorRef.current.leave
      if (action.kind === 'role') {
        const baseline = editorRef.current.latest.roles.find(role => role.role === action.role)
        setModelEditor(previous => ({ ...previous, role: action.role, baseline, draft: modelDraftOf(baseline), error: '', notice: '', leave: null }))
      } else {
        editorEpoch.current += 1
        setModelEditor(null)
        if (action.kind === 'run') setSelection({ cwd, runId: action.runId })
      }
    },
  }
  // 实际返回的 Run 变化（新 Run / 切目录 / 刷新到别的 Run）：跟随与手动流程选择回到默认。
  useEffect(() => { setFollow(initialFollowState()) }, [returnedRunId, cwd])
  // 换 Run/换目录时收起旧 Run 的下钻，避免同名节点行在新 Run 里意外展开。
  useEffect(() => { setOpenRecord(null) }, [returnedRunId, cwd])
  // 选中的 Run 失效/回退到 cwd 默认：清掉选择，避免切换器值悬空（loading/维护态下保留选择）。
  const selectionLost = selectedRunId !== null && view.mode !== 'loading' && view.mode !== 'maintenance'
    && !view.runs.some(ref => ref.runId === selectedRunId)
  useEffect(() => { if (selectionLost) setSelection({ cwd, runId: null }) }, [selectionLost, cwd])
  // 横幅在全部模式（loading/maintenance/empty/run）都渲染：首轮失败必须可见（R1 F5）。
  const bannerEl = view.banner !== ''
    ? h('div', { className: 'wf-monitor-banner' }, `状态刷新失败（保留上次数据）：${view.banner}`)
    : null
  // 宿主 client bundle 不做 JSX 转译：统一 createElement（与 panel.js 同约定）。
  // better-sidebar 的 descriptor 不支持 styles 字段，样式随组件内联注入。
  const styleEl = h('style', null, MONITOR_STYLES)
  // 只读「刷新状态」：每个模式都可用；终态停周期后这是发现同目录新 Run 的唯一入口（#261）。
  const refreshEl = h('button', {
    type: 'button',
    className: 'wf-monitor-refresh',
    disabled: refreshing,
    'aria-busy': refreshing ? 'true' : 'false',
    title: '只读刷新：重新读取当前目录的运行状态，不启动也不停止 Run',
    onClick: () => refresh(),
  }, refreshing ? '正在刷新…' : '刷新状态')
  // #254 切换器：默认「当前目录」，另列全部活跃 Run（跨 workspace）；选中项变化即重置轮询/跟随。
  const switcher = view.runs.length === 0 ? null : h('label', { className: 'wf-monitor-switcher' },
    '运行：',
    h('select', {
      value: selectedRunId ?? '',
      onChange: event => leaveEditor({ kind: 'run', runId: event.target.value === '' ? null : event.target.value }),
      'aria-label': '切换运行',
    },
    h('option', { value: '' }, '当前目录（默认）'),
    ...view.runs.map(ref => h('option', { key: ref.runId, value: ref.runId }, `${ref.label} · ${ref.statusLabel}`))))
  const hasRun = view.mode === 'run' || view.mode === 'terminal'
  const toolbarEl = h('div', { className: 'wf-monitor-toolbar' }, switcher,
    hasRun ? h('div', { className: 'wf-monitor-summary' },
      h('span', { className: `wf-monitor-status ${view.run.statusClass}` }, view.run.statusLabel),
      h('span', { className: 'wf-monitor-muted' }, view.run.workflowId),
      h('span', null, `${view.run.durationLabel} ${view.run.durationText ?? '—'}`),
      view.run.businessReturn ? h('span', { className: 'wf-monitor-return-value' }, `返回：${view.run.businessReturn}`) : null,
      view.terminalNote ? h('span', { className: 'wf-monitor-terminal-note' }, view.terminalNote) : null,
    ) : null,
    hasRun ? h('button', { type: 'button', disabled: modelEditor !== null || typeof configRpc !== 'function', onClick: openModels }, '模型配置') : null,
    refreshEl)
  const frame = (...children) => h('div', { className: 'wf-monitor' }, styleEl, bannerEl, toolbarEl,
    modelEditorEl(modelEditor, modelCatalog, modelActions), ...children)
  if (view.mode === 'loading') {
    return frame(h('div', { className: 'wf-monitor-muted' }, '正在加载运行状态…'))
  }
  if (view.mode === 'maintenance') {
    return frame(h('div', { className: 'wf-monitor-banner wf-monitor-maintenance' }, `状态库维护模式：\n${view.reason}`))
  }
  if (view.mode === 'empty') {
    // 切换器已随 frame 序言的 toolbarEl 渲染；此处不得再放一份（否则跨目录活跃 Run 时空态出现两个切换器）。
    return frame(h('div', { className: 'wf-monitor-guidance' }, view.guidance ?? '当前目录没有工作流运行记录。'))
  }
  const run = view.run
  const graph = run.graph ?? null
  const currentFlowId = graph?.currentFlowId ?? run.workflowId
  const followView = monitorFollowView(follow, currentFlowId)
  const callPath = graph?.callPath ?? { frames: [] }
  const flow = graph === null
    ? null
    : graph.flows.find(item => item.id === followView.activeFlowId) ?? graph.flows.find(item => item.id === currentFlowId) ?? graph.flows[0] ?? null
  return frame(
    // BLOCK 不收进折叠材料中；长原因完整换行显示。
    run.blockReason ? h('div', { className: 'wf-node-block' }, `BLOCK：${run.blockReason}`) : null,
    // #282 「运行详情」默认收起（原生 details，保留键盘与 aria-expanded）；角色配置可能含 override，非实际派发。
    h('details', { className: 'wf-monitor-details' },
      h('summary', null, '运行详情'),
      h('div', { className: 'wf-monitor-details-body' },
        h('div', null, `Run：${run.runId}`),
        h('div', null, `工作区：${run.workspaceKey}`),
        h('div', null, `开始：${run.startedAtText ?? '—'}`),
        run.roles !== '' ? h('div', null, `运行角色配置（非实际派发）：${run.roles}`) : null,
      ),
    ),
    h('div', { className: 'wf-monitor-overview' },
    graph !== null && flow !== null ? h('div', { className: 'wf-monitor-graph' },
      h('style', null, EDITOR_STYLES),
      callPath.frames.length > 1 ? h('div', { className: 'wf-monitor-breadcrumb', role: 'navigation', 'aria-label': '流程路径' },
        ...callPath.frames.flatMap((frame, index) => [
          index > 0 ? h('span', { key: `sep-${index}`, className: 'wf-monitor-sep', 'aria-hidden': 'true' }, '›') : null,
          h('button', {
            key: `crumb-${index}`,
            type: 'button',
            className: frame.workflowId === flow.id ? 'is-current' : '',
            title: `调用节点 ${frame.nodeLabel}`,
            onClick: () => setFollow(selectFlow(follow, frame.workflowId, currentFlowId)),
          }, frame.label),
        ])) : null,
      graph.flows.length > 1 ? h('div', { className: 'wf-monitor-flowtabs', role: 'tablist', 'aria-label': '流程切换' },
        ...graph.flows.map(item => h('button', {
          key: item.id, type: 'button', role: 'tab', 'aria-selected': item.id === flow.id, onClick: () => setFollow(selectFlow(follow, item.id, currentFlowId)),
        }, item.label))) : null,
      h('div', { className: 'wf-monitor-viewtools' },
        followView.showReturn ? h('button', { type: 'button', className: 'wf-monitor-return', onClick: () => setFollow(resumeFollow()) }, '回到当前节点') : null,
        h('button', {
          type: 'button',
          className: 'wf-monitor-reset-layout',
          title: '只重置当前流程在本页的临时布局（上游布局文件与配置不变，其他流程/Run 不受影响）',
          onClick: () => setLayoutReset(value => value + 1),
        }, '恢复布局'),
      ),
      h('div', { className: 'wf-editor wf-monitor-canvas' },
        h(NodeCanvas, {
          key: `${run.runId}:${flow.id}`,
          readOnly: true,
          // 临时布局/查看状态的隔离身份：同一 Run 的不同流程、同一流程的不同 Run 都不共享。
          viewKey: `${run.runId}:${flow.id}`,
          resetSignal: layoutReset,
          flowId: flow.id === run.workflowId ? null : flow.id,
          def: flow.def,
          positions: flow.positions,
          startNode: flow.def.startNode,
          returns: flow.def.returns,
          decorations: flow.decorations,
          // AC1：点击子流程节点直接下钻；普通节点点击不改变跟随状态。
          onSelectNode: (nodeId) => {
            // 画布 NodeDef 的子流程目标在 execution.workflowId（graphOf 归一化），不是 childWorkflowId。
            const execution = flow.def.nodes?.[nodeId]?.execution
            const child = execution?.type === 'child-workflow' ? execution.workflowId : undefined
            if (child && graph.flows.some(item => item.id === child)) setFollow(selectFlow(follow, child, currentFlowId))
          },
        })),
    ) : null,
    // 始终指向当前（或结束）工作单，与历史行展开/流程切换无关。
    currentCardEl(view.currentExecution)),
    // #275 执行记录表：每次进入一行；多轮提交/判定、未形成提交的重派与换模收在行下钻。
    recordsEl(view.records, openRecord, key => setOpenRecord(current => (current === key ? null : key))),
    h('details', { key: `${run.runId}:prompt`, className: 'wf-monitor-details' },
      h('summary', null, '启动 prompt'),
      h('div', { className: 'wf-monitor-prompt' }, run.launchPrompt)),
    ...view.nodes.filter(node => node.blocked && !node.current).map(node => h('div', { key: `${node.key}:block`, className: 'wf-node-block' }, `${node.label} · BLOCK：${node.blockReason}`)),
    h('details', { key: `${run.runId}:nodes`, className: 'wf-monitor-details' },
    h('summary', null, '完整节点列表'),
    h('ul', { className: 'wf-monitor-nodes' },
      ...view.nodes.map(node => h('li', { key: node.key, className: `wf-monitor-node${node.current ? ' wf-node-current' : ''}` },
        h('span', null, node.label),
        node.role !== null || node.modelText !== ''
          ? h('span', { className: 'wf-monitor-muted' }, [node.role, node.modelText].filter(Boolean).join(' · '))
          : null,
        node.targetText !== null ? h('span', { className: 'wf-monitor-muted' }, node.targetText) : null,
        h('span', { className: `wf-node-phase ${node.phaseClass}` }, node.phaseLabel),
        node.visit > 1 ? h('span', { className: 'wf-monitor-muted' }, `第${node.visit}次`) : null,
        node.blocked ? h('span', { className: 'wf-node-block' }, `BLOCK：${node.blockReason}`) : null,
      )))),
  )
}
