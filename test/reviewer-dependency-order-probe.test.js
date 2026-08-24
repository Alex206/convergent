'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  REVIEWER_DEPENDENCY_ORDER_PROMPT,
  normalizeDependencyProbeSpec,
  runDependencyOrderProbe,
  captureDependencyObservation,
} = require('../src/headless/reviewer-dependency-order-probe');

const GOOD_TASKFLOW = `
from dataclasses import dataclass

class ConfigError(ValueError):
    pass

@dataclass(frozen=True)
class TaskSpec:
    name: str
    command: tuple[str, ...]
    depends_on: tuple[str, ...] = ()

def order_tasks(tasks):
    tasks = tuple(tasks)
    by_name = {task.name: task for task in tasks}
    input_index = {task.name: index for index, task in enumerate(tasks)}
    indegree = {task.name: 0 for task in tasks}
    successors = {task.name: [] for task in tasks}
    for task in tasks:
        for dependency in task.depends_on:
            if dependency not in by_name:
                raise ConfigError(f'unknown dependency {dependency} for {task.name}')
            indegree[task.name] += 1
            successors[dependency].append(task.name)
    ready = [task.name for task in tasks if indegree[task.name] == 0]
    ordered = []
    while ready:
        chosen = min(ready, key=input_index.get)
        ready.remove(chosen)
        ordered.append(by_name[chosen])
        for successor in successors[chosen]:
            indegree[successor] -= 1
            if indegree[successor] == 0:
                ready.append(successor)
    if len(ordered) != len(tasks):
        cycle = [name for name, count in indegree.items() if count > 0]
        raise ConfigError('dependency cycle: ' + ', '.join(cycle))
    return tuple(ordered)
`;

const UNSTABLE_TASKFLOW = GOOD_TASKFLOW.replace(
  'chosen = min(ready, key=input_index.get)',
  'chosen = max(ready, key=input_index.get)',
);

async function fixture(source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'convergent-dependency-probe-'));
  const pkg = path.join(root, 'taskflow');
  await fs.mkdir(pkg);
  await fs.writeFile(path.join(pkg, '__init__.py'), source, 'utf8');
  return root;
}

function mixedAndCycleSpec() {
  return {
    cases: [
      {
        label: 'mixed-stability',
        tasks: [
          { name: 'z' },
          { name: 'dependent', depends_on: ['base'] },
          { name: 'a' },
          { name: 'base' },
          { name: 'm' },
        ],
      },
      {
        label: 'cycle',
        tasks: [
          { name: 'left', depends_on: ['right'] },
          { name: 'right', depends_on: ['left'] },
        ],
      },
    ],
  };
}

test('dependency probe validates bounded model-chosen graph specs', () => {
  const normalized = normalizeDependencyProbeSpec({
    cases: [{ label: 'case', tasks: [{ name: 'a' }, { name: 'b', depends_on: ['a'] }] }],
  });
  assert.deepEqual(normalized.cases[0].tasks[1].depends_on, ['a']);
  assert.throws(() => normalizeDependencyProbeSpec({ cases: [] }), /at least one/i);
  assert.throws(
    () => normalizeDependencyProbeSpec({ cases: [{ tasks: [{ name: 'a' }, { name: 'a' }] }] }),
    /unique names/i,
  );
  assert.throws(
    () => normalizeDependencyProbeSpec({ cases: [{ tasks: [{ name: 'a', depends_on: ['b', 'b'] }] }] }),
    /duplicates/i,
  );
});

test('dependency probe exposes stable ready-set transitions and cycle diagnostics without an expected order oracle', async () => {
  const root = await fixture(GOOD_TASKFLOW);
  try {
    const result = await runDependencyOrderProbe(root, mixedAndCycleSpec());
    const mixed = result.results.find((entry) => entry.label === 'mixed-stability');
    const cycle = result.results.find((entry) => entry.label === 'cycle');

    assert.equal(mixed.accepted, true);
    assert.deepEqual(mixed.output_order, ['z', 'a', 'base', 'dependent', 'm']);
    assert.equal(mixed.output_is_input_permutation, true);
    assert.equal(mixed.all_declared_dependencies_respected, true);
    assert.equal(mixed.all_choices_earliest_ready_by_input, true);
    assert.ok(mixed.mixed_ready_step_count >= 1);
    assert.ok(mixed.ready_transition_trace.some((row) => row.ready_before.length >= 2));

    assert.equal(cycle.graph.has_cycle, true);
    assert.equal(cycle.accepted, false);
    assert.match(cycle.error, /cycle/i);
    assert.deepEqual(new Set(cycle.cycle_names_present_in_error), new Set(['left', 'right']));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dependency probe reports an unstable ready-set choice as a mechanical fact', async () => {
  const root = await fixture(UNSTABLE_TASKFLOW);
  try {
    const result = await runDependencyOrderProbe(root, { cases: [mixedAndCycleSpec().cases[0]] });
    const mixed = result.results[0];
    assert.equal(mixed.accepted, true);
    assert.equal(mixed.output_is_input_permutation, true);
    assert.equal(mixed.all_choices_earliest_ready_by_input, false);
    assert.ok(mixed.ready_transition_trace.some((row) => row.chosen_was_ready && !row.chose_earliest_ready));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dependency observation capture is bounded and reviewer guidance requires discriminating mixed witnesses', () => {
  const sink = [];
  for (let index = 0; index < 10; index += 1) captureDependencyObservation(sink, { index });
  assert.equal(sink.length, 8);
  assert.equal(sink[0].index, 2);
  assert.match(REVIEWER_DEPENDENCY_ORDER_PROMPT, /mixed partial-order graph/i);
  assert.match(REVIEWER_DEPENDENCY_ORDER_PROMPT, /ready_before/i);
  assert.match(REVIEWER_DEPENDENCY_ORDER_PROMPT, /does not know the external acceptance oracle/i);
});
