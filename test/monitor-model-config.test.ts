import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModelConfigRpcHandler, MODEL_CONFIG_RPC_CHANNEL } from '../src/monitor/model-config.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { StateStore } from '../src/state/store.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { mountRpcChannel, type WebRoute } from '../src/editor/rpc.ts'

test('#288 direct configuration RPC caller cannot forge human authority', async () => {
  const handler = createModelConfigRpcHandler({
    maintenance: () => undefined,
    async byRunId() { throw new Error('unauthorized read') },
    async latest() { throw new Error('unauthorized read') },
    async save() { throw new Error('unauthorized write') },
  })
  const result = await handler('model-config-save', { human: true, runId: 'r', caller: 'manager' }, new AbortController().signal)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'model-config/forbidden')
})

const CONFIG = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles:
  worker:
    persona: Worker.
    model: { provider: p, modelId: primary }
    fallbackModel: { provider: p, modelId: fallback }
judgeRole:
  persona: Judge.
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: Complete., target: { return: done } }
`), { workflowId: 'model-config' })

function engineFor(store: StateStore) {
  const forbidden = async (): Promise<never> => { throw new Error('configuration must not drive/dispatch/drain/compact') }
  const engine = new WorkflowEngine({
    async steerManager() { return { messageId: 'manager-message' } },
    sendRoleActor: forbidden, managerSessionSeq() { return 0 },
  }, {
    ensureRoleActor: forbidden, startJudge: forbidden, followupJudge: forbidden,
    async judgeSessionAvailability() { return 'available' }, async roleSessionAvailability() { return 'available' },
    retireJudge: forbidden, drainJudge: forbidden, drainRoleActor: forbidden, compactRoleActor: forbidden,
    async safeToInspect() { return 'safe' },
  }, { run: forbidden }, makeStateHost(store))
  engine.cwdResolver = async () => 'cwd'
  engine.validateModelRoute = async () => ({ ok: true })
  return engine
}

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'workflow-model-config-'))
  let store = new StateStore(home)
  let engine = engineFor(store)
  assert.equal((await engine.startRun('ws', engine.buildInitialRun('manager', 'model-config', CONFIG, 'hash'), undefined, 'request')).ok, true)
  const runId = (await store.get('ws'))!.run.runId
  const handler = createModelConfigRpcHandler({
    maintenance: () => undefined, byRunId: id => store.getByRunId(id), latest: ws => store.get(ws),
    executions: id => store.runExecutionsByRunId(id), save: (ws, input) => engine.handleSaveRoleModelConfig(ws, input),
  })
  const browserPeer = {}
  let mounted: WebRoute | undefined
  const connection = {
    rpc: { handle() { throw new Error('custom mount expected') } }, browserPeer,
    admit(req: { headers: Record<string, unknown> }): { peer: unknown } | { rejection: 401 | 403 } {
      return req.headers.cookie === 'browser' ? { peer: browserPeer } : req.headers.cookie === 'api' ? { peer: {} } : { rejection: 401 }
    },
  }
  mountRpcChannel({ connection, webServer: { register(value) { mounted = value } } }, MODEL_CONFIG_RPC_CHANNEL, handler, { browserOnly: true })
  const server = createServer((req, res) => { void mounted!.handler(req, res) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server address missing')
  async function rpc(endpoint: string, payload: unknown, cookie = 'browser') {
    const response = await fetch(`http://127.0.0.1:${address.port}${MODEL_CONFIG_RPC_CHANNEL}/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ rpcId: 'test', method: endpoint, payload }),
    })
    return { status: response.status, body: response.status === 200 ? (await response.json()).result : undefined }
  }
  return { get store() { return store }, get engine() { return engine }, connection, handler, rpc, runId,
    reopen() { store.close(); store = new StateStore(home); engine = engineFor(store) },
    async close() { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}
const route = (modelId: string, reasoningEffort?: string) => ({ provider: 'p', modelId, ...(reasoningEffort ? { reasoningEffort } : {}) })
const inputFor = (runId: string) => ({ runId, role: 'worker', expectedRevision: 0, requestId: 'save-1', primary: route('new', 'high'), fallback: route('backup', 'low') })

test('#288 true HTTP/Engine/SQLite save is atomic, non-lifecycle, pending, persistent retry-safe', async () => {
  const f = await fixture()
  try {
    const before = (await f.store.get('ws'))!
    assert.equal((await f.rpc('model-config', { runId: 'missing' })).body.error.code, 'model-config/target-not-found')
    for (const endpoint of ['model-config', 'model-config-save']) {
      assert.equal((await f.rpc(endpoint, inputFor(f.runId), 'api')).status, 403)
      assert.equal((await f.rpc(endpoint, inputFor(f.runId), '')).status, 401)
    }
    assert.equal((await f.handler('model-config', { runId: f.runId }, new AbortController().signal, { human: true })).ok, false)
    const input = inputFor(f.runId)
    const saved = await f.rpc('model-config-save', input)
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.value.roles.find((r: { role: string }) => r.role === 'worker').revision, 1)
    assert.equal(saved.body.value.roles.find((r: { role: string }) => r.role === 'worker').pending, true)
    const after = (await f.store.get('ws'))!
    assert.deepEqual(after.execution, before.execution)
    assert.deepEqual(after.run.callStack, before.run.callStack)
    assert.equal(after.run.roleRoutes!.worker!.stage, 'primary')
    assert.equal(after.run.roleRoutes!.worker!.autoSwitches, 0)
    assert.deepEqual(after.run.roleModelConfigs!.worker!.fallback, route('backup', 'low'))
    f.reopen()
    assert.equal((await f.rpc('model-config-save', input)).body.value.replayed, true)
    assert.equal((await f.store.get('ws'))!.stateVersion, after.stateVersion)
    assert.equal((await f.rpc('model-config-save', { ...input, primary: route('different') })).body.error.code, 'model-config/conflict')
    assert.equal((await f.rpc('model-config-save', { ...input, requestId: 'save-2', expectedRevision: 1 })).body.value.replayed, false)
    assert.equal((await f.store.get('ws'))!.run.roleModelConfigs!.worker!.revision, 2)
    assert.equal((await f.rpc('model-config-save', input)).body.error.code, 'model-config/conflict')
  } finally { await f.close() }
})

test('#288 validation is atomic for both routes, clearing fallback/efforts is persisted, unknown identities cannot write', async () => {
  const f = await fixture()
  try {
    const before = await f.store.get('ws')
    f.engine.validateModelRoute = async (_p, m, e) => m === 'invalid' || e === 'invalid' ? { ok: false, reason: 'unsupported model/effort' } : { ok: true }
    for (const invalid of [
      { fallback: route('invalid') }, { primary: route('new', 'invalid') },
      { primary: { provider: '', modelId: 'm' } }, { role: 'ghost' }, { role: 'manager' },
      { role: 'constructor' }, { role: '__proto__' }, { caller: 'manager' }, { human: true },
    ]) {
      assert.equal((await f.rpc('model-config-save', { ...inputFor(f.runId), ...invalid })).body.ok, false)
      assert.deepEqual(await f.store.get('ws'), before)
    }
    assert.equal((await f.rpc('model-config-save', inputFor(f.runId))).body.ok, true)
    const cleared = { ...inputFor(f.runId), expectedRevision: 1, requestId: 'clear', primary: route('new'), fallback: undefined }
    assert.equal((await f.rpc('model-config-save', cleared)).body.ok, true)
    const cfg = (await f.store.get('ws'))!.run.roleModelConfigs!.worker!
    assert.equal(cfg.primary.reasoningEffort, undefined)
    assert.equal(cfg.fallback, undefined, 'saved omission must not restore frozen fallback')
    assert.equal((await f.engine.handleSetRoleModel('ws', 'worker', 'p', 'managed', 'worker')).ok, false)
    assert.equal((await f.engine.handleSetRoleModel('ws', 'worker', 'p', 'managed', 'judge')).ok, false)
    assert.equal((await f.engine.handleSetRoleModel('ws', 'worker', 'p', 'managed', 'manager')).ok, true)
    assert.equal((await f.rpc('model-config-save', cleared)).body.error.code, 'model-config/conflict', 'Manager save invalidates old GUI receipt')
  } finally { await f.close() }
})

test('#288 validation races isolate configuration by role, tolerate ordinary work churn, reject same-role stale draft', async () => {
  const f = await fixture()
  try {
    let release!: () => void
    let entered!: () => void
    let ready = new Promise<void>(resolve => { entered = resolve })
    let gate = new Promise<void>(resolve => { release = resolve })
    f.engine.validateModelRoute = async (_p, m) => { if (m === 'new') { entered(); await gate }; return { ok: true } }
    const saving = f.rpc('model-config-save', inputFor(f.runId))
    await ready
    assert.equal((await f.engine.handleSetRoleModel('ws', 'judge', 'p', 'judge-new', 'manager')).ok, true)
    const ordinary = (await f.store.get('ws'))!
    ordinary.run.roleActors.worker = 'unrelated-session'
    await f.store.updateRow('ws', ordinary.run, ordinary.stateVersion, [])
    release()
    assert.equal((await saving).body.ok, true)
    const merged = (await f.store.get('ws'))!
    assert.equal(merged.run.roleModelConfigs!.judge!.primary.modelId, 'judge-new')
    assert.equal(merged.run.roleModelConfigs!.worker!.revision, 1)
    assert.equal(merged.run.roleActors.worker, 'unrelated-session')
    assert.equal(merged.run.modelConfigRevision, 2)

    ready = new Promise<void>(resolve => { entered = resolve })
    gate = new Promise<void>(resolve => { release = resolve })
    const stale = f.rpc('model-config-save', { ...inputFor(f.runId), expectedRevision: 1, requestId: 'stale' })
    await ready
    assert.equal((await f.engine.handleSetRoleModel('ws', 'worker', 'p', 'manager-winner', 'manager')).ok, true)
    release()
    const rejected = (await stale).body
    assert.equal(rejected.error.code, 'model-config/conflict')
    assert.equal(rejected.error.details.latest.runId, f.runId)
    assert.equal((await f.store.get('ws'))!.run.roleModelConfigs!.worker!.primary.modelId, 'manager-winner')
  } finally { await f.close() }
})

test('#288 exact cross-workspace target survives cwd differences and rejects replacement during validation', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.engine.startRun('other-ws', f.engine.buildInitialRun('other-manager', 'model-config', CONFIG, 'hash'), undefined, 'request')).ok, true)
    const otherId = (await f.store.get('other-ws'))!.run.runId
    const before = await f.store.get('ws')
    const saved = await f.rpc('model-config-save', inputFor(otherId))
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.value.workspaceKey, 'other-ws')
    assert.deepEqual(await f.store.get('ws'), before)

    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    f.engine.validateModelRoute = async () => { entered(); await gate; return { ok: true } }
    const saving = f.rpc('model-config-save', inputFor(f.runId))
    await ready
    assert.equal((await f.engine.handleReset('ws', true)).ok, true)
    assert.equal((await f.engine.startRun('ws', f.engine.buildInitialRun('replacement-manager', 'model-config', CONFIG, 'hash'), undefined, 'replacement')).ok, true)
    const replacement = (await f.store.get('ws'))!
    release()
    assert.equal((await saving).body.error.code, 'model-config/target-not-found')
    assert.deepEqual(await f.store.get('ws'), replacement)
    const oldRead = (await f.rpc('model-config', { runId: f.runId })).body.value
    assert.equal(oldRead.runId, f.runId)
    assert.equal(oldRead.terminal, true, 'old exact target must not fall back to replacement')
  } finally { await f.close() }
})

test('#288 legacy registration uses real fourth peer identity, not owner-shaped payload', async () => {
  const browserPeer = {}
  let registered: Parameters<typeof mountRpcChannel>[2] | undefined
  let calls = 0
  const result = mountRpcChannel({ connection: { browserPeer, rpc: { handle(_channel, handler) { registered = handler; return async () => {} } } } }, MODEL_CONFIG_RPC_CHANNEL,
    async () => { calls++; return { ok: true, value: 'browser' } }, { browserOnly: true })
  assert.equal(result.status, 'fallback')
  const signal = new AbortController().signal
  for (const peer of [undefined, { principal: { kind: 'owner' } }]) {
    assert.equal((await registered!('model-config', { human: true }, signal, peer)).ok, false)
  }
  assert.equal(calls, 0)
  assert.equal((await registered!('model-config', {}, signal, browserPeer)).ok, true)
  assert.equal(calls, 1)
})

test('#288 terminal read is exact and read-only; missing browser admission API fails closed', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.engine.handleReset('ws', true)).ok, true)
    const terminal = await f.rpc('model-config', { runId: f.runId })
    assert.equal(terminal.body.value.terminal, true)
    const before = await f.store.getByRunId(f.runId)
    assert.equal((await f.rpc('model-config-save', inputFor(f.runId))).body.error.code, 'model-config/read-only')
    assert.deepEqual(await f.store.getByRunId(f.runId), before)
    Object.assign(f.connection, { admit: undefined })
    assert.equal((await f.rpc('model-config', { runId: f.runId })).status, 403)
  } finally { await f.close() }
})
