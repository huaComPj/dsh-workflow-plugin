/** `dsh-workflow-init` 一键安装的契约测试（Issue #209）：落盘语义与薄封装一致性。 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInit, parseInitArgs, resolveInitSources, canonicalJson, WORKFLOW_IDS } from '../src/init/install.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCES = resolveInitSources(REPO_ROOT)

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-init-test-'))
  mkdirSync(join(home, 'workflows'), { recursive: true })
  return home
}

describe('parseInitArgs', () => {
  it('缺省全关', () => {
    assert.deepEqual(parseInitArgs([]), { options: { force: false, dryRun: false }, home: undefined })
  })

  it('各开关与 --home 生效，未知参数报错', () => {
    const parsed = parseInitArgs(['--force', '--dry-run', '--home', '/tmp/x'])
    assert.deepEqual(parsed.options, { force: true, dryRun: true })
    assert.equal(parsed.home, '/tmp/x')
    assert.match(parseInitArgs(['--bogus']).error ?? '', /未知参数/)
    assert.match(parseInitArgs(['--full']).error ?? '', /未知参数 "--full"/)
    assert.match(parseInitArgs(['--home']).error ?? '', /缺少目录参数/)
  })
})

describe('runInit', () => {
  let home = ''
  beforeEach(() => { home = makeHome() })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('只装 development-workflow + preset，不安装旧模板', () => {
    const result = runInit(home, SOURCES, { force: false, dryRun: false })
    assert.equal(result.ok, true)
    assert.deepEqual(WORKFLOW_IDS, ['development-workflow'])
    assert.deepEqual(readdirSync(join(home, 'workflows')), ['development-workflow.yaml'])
    assert.ok(existsSync(join(home, 'cordis.patch.yml')))
    assert.match(result.text, /definitionHash=/)
  })

  it('已有旧 catalog 在普通与 force 安装后字节不变', () => {
    const legacy = join(home, 'workflows', 'coding-workflow-rapid.yaml')
    const custom = '# 用户保留的旧模板\n'
    writeFileSync(legacy, custom)
    for (const force of [false, true]) {
      assert.equal(runInit(home, SOURCES, { force, dryRun: false }).ok, true)
      assert.equal(readFileSync(legacy, 'utf8'), custom)
    }
  })

  it('幂等：第二次跑全部 up-to-date', () => {
    runInit(home, SOURCES, { force: false, dryRun: false })
    const second = runInit(home, SOURCES, { force: false, dryRun: false })
    assert.equal(second.ok, true)
    assert.match(second.text, /up-to-date/)
    assert.doesNotMatch(second.text, /installed|overwritten|skipped/)
  })

  it('用户文件：内容不同默认跳过并提示首个差异行；--force 备份后覆盖', () => {
    runInit(home, SOURCES, { force: false, dryRun: false })
    const target = join(home, 'workflows', 'development-workflow.yaml')
    writeFileSync(target, '# 用户手改\nid: custom\n', 'utf8')
    const skipped = runInit(home, SOURCES, { force: false, dryRun: false })
    assert.equal(skipped.ok, true)
    assert.match(skipped.text, /skipped workflows\/development-workflow\.yaml/)
    assert.match(skipped.text, /第 1 行不同/)
    assert.equal(readFileSync(target, 'utf8').startsWith('# 用户手改'), true)
    const forced = runInit(home, SOURCES, { force: true, dryRun: false })
    assert.match(forced.text, /overwritten workflows\/development-workflow\.yaml/)
    assert.match(forced.text, /\.bak-\d+/)
    assert.equal(readFileSync(target, 'utf8').startsWith('# 用户手改'), false)
  })

  it('--dry-run：零写入但报告 would-install', () => {
    const result = runInit(home, SOURCES, { force: false, dryRun: true })
    assert.equal(result.ok, true)
    assert.match(result.text, /would-install/)
    assert.equal(existsSync(join(home, 'workflows', 'development-workflow.yaml')), false)
    assert.equal(existsSync(join(home, 'cordis.patch.yml')), false)
  })

  it('preset 合并：保留用户原有行，只追加声明', () => {
    writeFileSync(join(home, 'cordis.patch.yml'), '- name: user-plugin\n', 'utf8')
    const result = runInit(home, SOURCES, { force: false, dryRun: false })
    assert.equal(result.ok, true)
    const text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8')
    assert.match(text, /user-plugin/)
    assert.match(text, /id: preset-manager/)
    assert.match(result.text, /OK cordis\.patch\.yml/)
  })

  it('preset --force：嵌套声明差异覆盖后内置行与用户行的 !!js 标签都不丢', () => {
    writeFileSync(join(home, 'cordis.patch.yml'),
      '- name: user-plugin\n  config:\n    flag: !!js process.platform === \'linux\'\n'
      + '- insert:\n    - id: preset-manager\n      name: old\n', 'utf8')
    const result = runInit(home, SOURCES, { force: true, dryRun: false })
    assert.equal(result.ok, true)
    assert.match(result.text, /overwritten cordis\.patch\.yml/)
    const text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8')
    assert.match(text, /user-plugin/)
    assert.match(text, /flag: !!js process\.platform === 'linux'/)
    assert.match(text, /disabled: !!js process\.platform === 'win32'/)
    assert.match(result.text, /OK cordis\.patch\.yml/)
  })

  it('preset --force：顶层单声明替换同样保 tag', () => {
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: preset-manager\n  name: old\n', 'utf8')
    const result = runInit(home, SOURCES, { force: true, dryRun: false })
    assert.equal(result.ok, true)
    const text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8')
    assert.match(text, /disabled: !!js process\.platform === 'win32'/)
    assert.match(result.text, /OK cordis\.patch\.yml/)
  })

  it('遗留模板不可装：源目录扫描不到 workflow-template', () => {
    const ids = SOURCES.workflows.map(item => item.id)
    assert.equal(ids.includes('workflow-template'), false)
  })
})

describe('canonicalJson', () => {
  it('key 顺序不同视为相同', () => {
    assert.equal(canonicalJson({ b: 1, a: [1, { y: 2, x: 1 }] }), canonicalJson({ a: [1, { x: 1, y: 2 }], b: 1 }))
    assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }))
  })
})

describe('scripts/dsh-workflow-init.mjs 薄封装', () => {
  const script = join(REPO_ROOT, 'scripts', 'dsh-workflow-init.mjs')

  it('--dry-run --home：与库同语义，只报告不写入', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-init-script-'))
    try {
      const minimal = spawnSync(process.execPath, [script, '--dry-run', '--home', home], { encoding: 'utf8' })
      assert.equal(minimal.status, 0, minimal.stderr)
      assert.match(minimal.stdout, /would-install workflows\/development-workflow\.yaml/)
      assert.match(minimal.stdout, /would-install cordis\.patch\.yml/)
      assert.deepEqual(readdirSync(home), [], '预演不得写入任何文件')
      const full = spawnSync(process.execPath, [script, '--full', '--dry-run', '--home', home], { encoding: 'utf8' })
      assert.equal(full.status, 2, full.stderr)
      assert.match(full.stderr, /未知参数 "--full"/)
      assert.deepEqual(readdirSync(home), [], '--full 必须在写入前拒绝')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('未知参数 exit 2 且不写入', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-init-script-'))
    try {
      const result = spawnSync(process.execPath, [script, '--bogus', '--home', home], { encoding: 'utf8' })
      assert.equal(result.status, 2)
      assert.match(result.stderr, /未知参数/)
      assert.deepEqual(readdirSync(home), [])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
