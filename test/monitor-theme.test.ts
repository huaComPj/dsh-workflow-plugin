import assert from 'node:assert/strict'
import test from 'node:test'
import { bundleSources } from '../web-client/build.mjs'

/**
 * #282 监控主题接线与静态样式回归；不证明滚动、几何或实际合成对比度。
 * 行为侧断言在 monitor-poll-lifecycle；#286 滚动/布局/主题的实效必须另跑真实 Host GUI。
 */
function monitorStyles(): string {
  // 执行真实打包转换后的模块，只取样式值：声明顺序和相邻函数不会扩大扫描范围。
  // 依赖仅在组件调用时使用；这里不挂载 React，也不复制 import/export 转换规则。
  const styles = new Function('require', '__monitorView', '__graphCanvas', '__styles',
    `${bundleSources().monitor}\nreturn MONITOR_STYLES;`)(() => ({}), {}, {}, {})
  assert.equal(typeof styles, 'string')
  // 去掉注释：注释里会说明「不再用 --dsh-text/#ddd」，不是样式规则本身。
  return styles.replace(/\/\*[\s\S]*?\*\//g, '')
}

test('#282 主题契约：改用宿主 --dsw-alias-* 语义色，不再依赖未定义的 --dsh-* 与 #ddd 兜底', () => {
  const styles = monitorStyles()
  assert.doesNotMatch(styles, /--dsh-(text|muted)/, '宿主只定义 --dsw-* token，--dsh-* 永远取不到值')
  assert.doesNotMatch(styles, /#ddd\b/i, '不再用浅灰兜底（深色主题下会出现浅灰字压浅灰底）')
  assert.match(styles, /color: var\(--dsw-alias-label-primary, currentColor\)/, '正文色接宿主主文字色')
  assert.match(styles, /color: var\(--dsw-alias-label-secondary, currentColor\)/, '次要文字接宿主次文字色')
  // 状态文字由宿主状态色与正文色混合：浅色混近黑、深色混近白，两套主题都保持 >=4.5:1（宿主原生
  // --dsw-alias-state-success-primary 等在浅色下仅 2.28:1，不能直接当文字色）。
  assert.match(styles, /color-mix\(in srgb, var\(--dsw-alias-state-success-primary, #22c55e\) 45%, var\(--dsw-alias-label-primary, currentColor\)\)/)
  assert.match(styles, /color-mix\(in srgb, var\(--dsw-alias-state-error-primary, #ec1313\) 60%, var\(--dsw-alias-label-primary, currentColor\)\)/)
  // 旧的写死浅色文字全部引入 token 体系。
  assert.doesNotMatch(styles, /color: (#9fc8ff|#ffb4b4|#9fdca4|#ffd479|#c9a6ff|#1d4ed8)\b/i)
  // 共享画布在监控内跟随主题（独立编辑器面板不受影响，选择器限定在 .wf-monitor-graph 下）。
  assert.match(styles, /\.wf-monitor-graph \.wf-editor\.wf-monitor-canvas \{[^}]*--wf-text: var\(--dsw-alias-label-primary/)
})

test('#282 监控根容器在受限侧栏内收缩并承担整栏纵向滚动', () => {
  const styles = monitorStyles()
  const rule = /\.wf-monitor \{[^}]*\}/.exec(styles)?.[0] ?? ''
  assert.match(rule, /flex: 1 1 auto/, '根容器应占满宿主 tab 的可用高度')
  assert.match(rule, /min-height: 0/, '允许根容器小于内容高度，避免被宿主 tabBody 裁切')
  assert.match(rule, /overflow-y: auto/, '整栏主滚动由根容器承接，不依赖被裁切隔断的外层滚动')
})

test('#282 运行图默认高度适中，并用更高特异度压过共享编辑器的 460px 覆盖', () => {
  const styles = monitorStyles()
  // 共享编辑器 @container (max-width: 880px) 的 .wf-editor .wf-canvas 规则会在窄侧栏赢下同特异度监控规则。
  assert.match(styles, /\.wf-monitor-graph \.wf-editor\.wf-monitor-canvas \.wf-canvas \{ height: 260px; min-height: 220px; \}/)
  assert.doesNotMatch(styles, /\.wf-monitor-graph \.wf-canvas \{\s*height: 420px/)
})
