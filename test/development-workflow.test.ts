import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'

const source = readFileSync(new URL('../docs/example/development-workflow.yaml', import.meta.url), 'utf8')

test('通用入门模板：五节点串行、失败重验、仅合并可交付', () => {
  const warnings: string[] = []
  const config = validateAndNormalize(parseCatalogConfig(source), { workflowId: 'development-workflow', warnings })
  assert.deepEqual(warnings, [])
  assert.equal(config.workflow.startNode, 'create-issue')
  assert.deepEqual(Object.keys(config.workflow.nodes), ['create-issue', 'implement', 'review', 'test', 'merge'])
  assert.deepEqual(config.workflow.returns, ['delivered'])
  const nodes = config.workflow.nodes
  assert.deepEqual(nodes['create-issue'].results.ready.target, { node: 'implement' })
  assert.deepEqual(nodes.implement.results.implemented.target, { node: 'review' })
  assert.deepEqual(nodes.review.results.approved.target, { node: 'test' })
  assert.deepEqual(nodes.test.results.passed.target, { node: 'merge' })
  for (const id of ['review', 'test']) {
    assert.deepEqual(nodes[id].results['changes-required'].target, { node: 'implement' })
  }
  for (const id of ['review', 'test', 'merge']) {
    assert.deepEqual(nodes[id].results.stale.target, { node: 'implement' })
  }
  assert.deepEqual(nodes.merge.results.delivered.target, { return: 'delivered' })
  for (const [id, node] of Object.entries(nodes)) {
    assert.equal(node.execution.type, 'actor-task')
    assert.equal(node.checker?.checkerId, 'judge.claim-correct')
    if (id !== 'merge') {
      for (const result of Object.values(node.results)) assert.ok(!('return' in result.target))
    }
  }
})

test('通用入门模板：用户交互归 Manager，无模型或技能依赖', () => {
  const config = parseCatalogConfig(source)
  for (const id of ['create-issue', 'merge']) {
    const execution = config.workflow.nodes[id].execution
    assert.equal(execution.type, 'actor-task')
    if (execution.type === 'actor-task') assert.equal(execution.role, 'manager')
  }
  for (const role of Object.values(config.roles)) {
    assert.equal(role.model, undefined)
    assert.ok(role.reuse === undefined || role.reuse === 'node')
  }
  assert.equal(config.judgeRole.model, undefined)
  assert.doesNotMatch(source, /\b(?:grilling|to-spec|code-review|tdd|skill)\b/)
  const merge = config.workflow.nodes.merge
  assert.match(merge.execution.type === 'actor-task' ? merge.execution.instruction : '', /用户.*明确合并确认/)
  assert.match(merge.results.delivered.criteria, /squash/)
  assert.match(merge.results.stale.criteria, /合并尚未执行/)
})
