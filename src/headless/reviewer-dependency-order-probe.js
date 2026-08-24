'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { workspaceRevision } = require('../orchestrator/revision');

const execFileAsync = promisify(execFile);
const DEPENDENCY_ORDER_PROBE_TOOL = 'custom:probe_dependency_order';
const MAX_CAPTURED_DEPENDENCY_OBSERVATIONS = 8;

const REVIEWER_DEPENDENCY_ORDER_PROMPT = `
For dependency-ordering tasks you may use probe_dependency_order, a benchmark-only read-only diagnostic. It imports the current workspace's TaskSpec/order_tasks implementation, constructs only in-memory task graphs chosen by you, and reports the actual output/error plus oracle-blind graph structure and ready-set transition facts. It does not know the external acceptance oracle or any expected output ordering.

Derive graph witnesses from the task contract. For stable ordering, do not rely only on a simple chain or an all-independent list: include a mixed partial-order graph where dependencies change the ready set while unrelated tasks also compete for position. Use the reported ready_before / earliest_ready_input / chosen transition rows to reason about whether the observed behavior preserves the contract's deterministic input-order tie-breaking without mentally simulating the graph. Also exercise a genuine cycle when cycle handling is part of the task contract.

The probe is evidence, not a verdict. A reviewer CLEAN claim should explain how the mechanically observed graph/output/error facts support the stated contract and should still review parsing, API/export, and other requirements outside this observer's scope normally.
`.trim();

function pythonExecutable(platform = process.platform) {
  return platform === 'win32' ? 'python' : 'python3';
}

function normalizeTask(entry, label) {
  const name = String(entry?.name ?? '').trim();
  if (!name || name.length > 80) throw new Error(`${label}.name must be a non-empty string of at most 80 characters.`);
  const rawDependencies = Array.isArray(entry?.depends_on) ? entry.depends_on : [];
  if (rawDependencies.length > 12) throw new Error(`${label}.depends_on supports at most 12 entries.`);
  const dependsOn = rawDependencies.map((value, index) => {
    const dependency = String(value ?? '').trim();
    if (!dependency || dependency.length > 80) throw new Error(`${label}.depends_on[${index}] must be a non-empty task name.`);
    return dependency;
  });
  if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`${label}.depends_on must not contain duplicates.`);
  return { name, depends_on: dependsOn };
}

function normalizeDependencyProbeSpec(args = {}) {
  const rawCases = Array.isArray(args.cases) ? args.cases : [];
  if (!rawCases.length) throw new Error('At least one dependency-order case is required.');
  if (rawCases.length > 8) throw new Error('At most 8 dependency-order cases are allowed.');
  const cases = rawCases.map((entry, caseIndex) => {
    const label = String(entry?.label ?? `case-${caseIndex + 1}`).trim().slice(0, 80) || `case-${caseIndex + 1}`;
    const rawTasks = Array.isArray(entry?.tasks) ? entry.tasks : [];
    if (!rawTasks.length) throw new Error(`cases[${caseIndex}].tasks must contain at least one task.`);
    if (rawTasks.length > 12) throw new Error(`cases[${caseIndex}].tasks supports at most 12 tasks.`);
    const tasks = rawTasks.map((task, taskIndex) => normalizeTask(task, `cases[${caseIndex}].tasks[${taskIndex}]`));
    const names = tasks.map((task) => task.name);
    if (new Set(names).size !== names.length) throw new Error(`cases[${caseIndex}].tasks must use unique names.`);
    return { label, tasks };
  });
  return { cases };
}

const PYTHON_PROBE = String.raw`
import json
import sys
from pathlib import Path

workspace = Path(sys.argv[1]).resolve()
spec = json.loads(sys.argv[2])
sys.path.insert(0, str(workspace))
from taskflow import TaskSpec, order_tasks


def graph_analysis(tasks):
    names = [item['name'] for item in tasks]
    name_set = set(names)
    input_index = {name: index for index, name in enumerate(names)}
    dependencies = {item['name']: list(item.get('depends_on', [])) for item in tasks}
    unknown = sorted({dep for deps in dependencies.values() for dep in deps if dep not in name_set})
    successors = {name: [] for name in names}
    indegree = {name: 0 for name in names}
    for task, deps in dependencies.items():
        for dep in deps:
            if dep in name_set:
                successors[dep].append(task)
                indegree[task] += 1

    ready = [name for name in names if indegree[name] == 0]
    visited = []
    indegree_work = dict(indegree)
    while ready:
        chosen = min(ready, key=input_index.get)
        ready.remove(chosen)
        visited.append(chosen)
        for successor in successors[chosen]:
            indegree_work[successor] -= 1
            if indegree_work[successor] == 0:
                ready.append(successor)
    cycle_nodes = [name for name in names if name not in visited] if len(visited) != len(names) else []
    return {
        'input_order': names,
        'dependencies': dependencies,
        'unknown_dependencies': unknown,
        'has_cycle': bool(cycle_nodes),
        'cycle_nodes': cycle_nodes,
        'input_index': input_index,
    }


def output_facts(analysis, output_order):
    names = analysis['input_order']
    dependencies = analysis['dependencies']
    name_set = set(names)
    output_positions = {name: index for index, name in enumerate(output_order)}
    permutation_ok = len(output_order) == len(names) and len(set(output_order)) == len(output_order) and set(output_order) == name_set
    edge_rows = []
    all_dependencies_respected = permutation_ok
    for task in names:
        for dep in dependencies[task]:
            if dep not in name_set:
                continue
            respected = permutation_ok and output_positions[dep] < output_positions[task]
            edge_rows.append({'dependency': dep, 'task': task, 'respected': respected})
            all_dependencies_respected = all_dependencies_respected and respected

    emitted = set()
    remaining = list(names)
    transition_trace = []
    stable_ready_choices = True
    for step, chosen in enumerate(output_order):
        ready_before = [
            name for name in remaining
            if all(dep in emitted for dep in dependencies.get(name, []) if dep in name_set)
        ]
        earliest = ready_before[0] if ready_before else None
        chosen_was_ready = chosen in ready_before
        chose_earliest = chosen_was_ready and chosen == earliest
        transition_trace.append({
            'step': step,
            'chosen': chosen,
            'ready_before': ready_before,
            'earliest_ready_input': earliest,
            'chosen_was_ready': chosen_was_ready,
            'chose_earliest_ready': chose_earliest,
        })
        stable_ready_choices = stable_ready_choices and chose_earliest
        if chosen in remaining:
            remaining.remove(chosen)
        emitted.add(chosen)

    mixed_ready_steps = [
        row for row in transition_trace
        if len(row['ready_before']) >= 2
    ]
    return {
        'output_is_input_permutation': permutation_ok,
        'dependency_edges': edge_rows,
        'all_declared_dependencies_respected': all_dependencies_respected,
        'ready_transition_trace': transition_trace,
        'mixed_ready_step_count': len(mixed_ready_steps),
        'all_choices_earliest_ready_by_input': permutation_ok and stable_ready_choices,
    }


results = []
for case in spec['cases']:
    analysis = graph_analysis(case['tasks'])
    row = {
        'label': case['label'],
        'graph': {
            'input_order': analysis['input_order'],
            'dependencies': analysis['dependencies'],
            'unknown_dependencies': analysis['unknown_dependencies'],
            'has_cycle': analysis['has_cycle'],
            'cycle_nodes': analysis['cycle_nodes'],
        },
    }
    try:
        task_specs = [
            TaskSpec(name=item['name'], command=('echo', item['name']), depends_on=tuple(item.get('depends_on', [])))
            for item in case['tasks']
        ]
        ordered = order_tasks(tuple(task_specs))
    except Exception as exc:
        text = str(exc)
        row.update({
            'accepted': False,
            'error_type': type(exc).__name__,
            'error': text,
            'cycle_names_present_in_error': [name for name in analysis['cycle_nodes'] if name in text],
        })
    else:
        output_order = [item.name for item in ordered]
        row.update({
            'accepted': True,
            'output_order': output_order,
            **output_facts(analysis, output_order),
        })
    results.append(row)

print(json.dumps({'results': results}, sort_keys=True))
`;

async function runDependencyOrderProbe(workspace, args = {}, { platform = process.platform } = {}) {
  const spec = normalizeDependencyProbeSpec(args);
  const { stdout, stderr } = await execFileAsync(
    pythonExecutable(platform),
    ['-B', '-c', PYTHON_PROBE, path.resolve(workspace), JSON.stringify(spec)],
    {
      cwd: path.resolve(workspace),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const result = JSON.parse(String(stdout ?? '').trim());
  if (stderr?.trim()) result.stderr = String(stderr).trim().slice(0, 4000);
  return result;
}

function captureDependencyObservation(observationSink, observation) {
  if (!Array.isArray(observationSink)) return;
  observationSink.push(observation);
  if (observationSink.length > MAX_CAPTURED_DEPENDENCY_OBSERVATIONS) {
    observationSink.splice(0, observationSink.length - MAX_CAPTURED_DEPENDENCY_OBSERVATIONS);
  }
}

function createDependencyOrderProbeTool(defineTool, { workspace, observationSink = null } = {}) {
  if (!workspace) throw new Error('createDependencyOrderProbeTool requires workspace.');
  return defineTool('probe_dependency_order', {
    description: 'Run model-chosen in-memory TaskSpec graphs through the current workspace order_tasks implementation and return actual output/error plus oracle-blind dependency and ready-set transition facts. The tool never writes the repository and contains no expected output order.',
    parameters: {
      type: 'object',
      properties: {
        cases: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              tasks: {
                type: 'array',
                minItems: 1,
                maxItems: 12,
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    depends_on: {
                      type: 'array',
                      maxItems: 12,
                      items: { type: 'string' },
                    },
                  },
                  required: ['name'],
                  additionalProperties: false,
                },
              },
            },
            required: ['tasks'],
            additionalProperties: false,
          },
        },
      },
      required: ['cases'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args = {}) => {
      let spec = null;
      let revision = null;
      try {
        spec = normalizeDependencyProbeSpec(args);
        revision = await workspaceRevision(workspace);
        const result = await runDependencyOrderProbe(workspace, spec);
        captureDependencyObservation(observationSink, { revision, spec, result });
        return { accepted: true, ...result };
      } catch (error) {
        captureDependencyObservation(observationSink, {
          revision,
          spec,
          error: error?.message ?? String(error),
        });
        return { accepted: false, error: error?.message ?? String(error) };
      }
    },
  });
}

module.exports = {
  DEPENDENCY_ORDER_PROBE_TOOL,
  MAX_CAPTURED_DEPENDENCY_OBSERVATIONS,
  REVIEWER_DEPENDENCY_ORDER_PROMPT,
  pythonExecutable,
  normalizeDependencyProbeSpec,
  runDependencyOrderProbe,
  captureDependencyObservation,
  createDependencyOrderProbeTool,
};
