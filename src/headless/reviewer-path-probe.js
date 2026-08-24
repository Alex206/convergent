'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { workspaceRevision } = require('../orchestrator/revision');

const execFileAsync = promisify(execFile);
const PATH_PROBE_TOOL = 'custom:probe_path_resolution';
const MAX_CAPTURED_PROBE_OBSERVATIONS = 8;

const REVIEWER_PATH_PROBE_PROMPT = `
For this containment benchmark you also have probe_path_resolution, a benchmark-only read-only diagnostic tool. It creates only an isolated OS-temporary filesystem fixture and invokes the current workspace's resolve_artifact_path implementation. You choose the fixture shape, symlinks, and artifact-path inputs; the tool has no expected answers and does not know the hidden acceptance oracle.

Prefer this tool when independent review evidence needs temporary directories or symlinks. Derive witness cases from the task contract. For a contrastive boundary claim, probe both the restrictive rule and the corresponding permissive rule at their semantic boundary; do not substitute an easier happy path that cannot falsify an over-restrictive implementation.

When correctness depends on the provenance or mechanism of an intermediate boundary transition rather than only the final state, make the pair genuinely discriminating. The hostile witness should cross by the forbidden mechanism and later converge to a final state that a final-state-only check could mistake as allowed. If the contract permits the same controversial boundary transition through another mechanism, the benign witness must actually exercise that permitted transition and converge to a comparable allowed final state. A hostile case whose final state is still plainly outside/invalid, or a benign case that never reaches the controversial boundary state, does not prove the provenance distinction.

The probe reports an oracle-blind transition_trace and transition_features for every case. These describe actual filesystem resolution of each progressive input component (inside/root-self/outside, and whether the current component is a symlink); they do not encode expected resolver behavior. Use those observations rather than mentally simulating path semantics when explaining why a witness pair is genuinely matched.
`.trim();

function pythonExecutable(platform = process.platform) {
  return platform === 'win32' ? 'python' : 'python3';
}

function normalizeSandboxRelative(value, label) {
  const text = String(value ?? '').trim().replace(/\\/g, '/');
  if (!text) throw new Error(`${label} must be a non-empty relative path inside the temporary sandbox.`);
  if (path.posix.isAbsolute(text) || /^[A-Za-z]:\//.test(text)) {
    throw new Error(`${label} must be relative to the temporary sandbox.`);
  }
  const normalized = path.posix.normalize(text);
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    throw new Error(`${label} must stay inside the temporary sandbox.`);
  }
  return normalized;
}

function normalizeProbeSpec(args = {}) {
  const rootName = normalizeSandboxRelative(args.root_name ?? 'work', 'root_name');
  if (rootName.includes('/')) throw new Error('root_name must be one path component.');

  const directories = (Array.isArray(args.directories) ? args.directories : [])
    .map((value, index) => normalizeSandboxRelative(value, `directories[${index}]`));
  if (directories.length > 16) throw new Error('At most 16 temporary directories are allowed.');

  const symlinks = (Array.isArray(args.symlinks) ? args.symlinks : []).map((entry, index) => ({
    path: normalizeSandboxRelative(entry?.path, `symlinks[${index}].path`),
    target: normalizeSandboxRelative(entry?.target, `symlinks[${index}].target`),
  }));
  if (symlinks.length > 8) throw new Error('At most 8 temporary symlinks are allowed.');

  const cases = (Array.isArray(args.cases) ? args.cases : []).map((entry, index) => ({
    label: String(entry?.label ?? `case-${index + 1}`).trim().slice(0, 80) || `case-${index + 1}`,
    artifact_path: String(entry?.artifact_path ?? ''),
  }));
  if (!cases.length) throw new Error('At least one artifact-path case is required.');
  if (cases.length > 16) throw new Error('At most 16 artifact-path cases are allowed.');
  if (cases.some((entry) => entry.artifact_path.length > 500)) throw new Error('artifact_path is limited to 500 characters per case.');

  return { root_name: rootName, directories, symlinks, cases };
}

const PYTHON_PROBE = String.raw`
import json
import sys
import tempfile
from pathlib import Path

workspace = Path(sys.argv[1]).resolve()
spec = json.loads(sys.argv[2])
sys.path.insert(0, str(workspace))
from taskflow import resolve_artifact_path


def relation_row(value, root, base):
    resolved = Path(value).resolve(strict=False)
    try:
        relative_base = resolved.relative_to(base).as_posix()
    except ValueError:
        relative_base = '<outside-temporary-sandbox>'
    try:
        relative_root = resolved.relative_to(root).as_posix()
        relation = 'strict-descendant' if relative_root not in ('', '.') else 'root-self'
    except ValueError:
        relative_root = None
        relation = 'outside-root'
    return resolved, relative_base, relative_root, relation


def transition_observation(root, base, artifact_path):
    parts = Path(artifact_path).parts
    trace = []
    for index in range(1, len(parts) + 1):
        prefix = Path(*parts[:index])
        lexical_candidate = root / prefix
        component = parts[index - 1]
        try:
            component_is_symlink = lexical_candidate.is_symlink()
        except OSError:
            component_is_symlink = False
        resolved, relative_base, relative_root, relation = relation_row(lexical_candidate, root, base)
        trace.append({
            'index': index,
            'component': component,
            'prefix': str(prefix).replace('\\\\', '/'),
            'component_is_symlink': component_is_symlink,
            'resolved_relative_to_sandbox': relative_base,
            'resolved_relative_to_root': relative_root,
            'resolved_relation_to_root': relation,
        })

    final_relation = trace[-1]['resolved_relation_to_root'] if trace else None
    prior = trace[:-1]
    outside_steps = [step for step in prior if step['resolved_relation_to_root'] == 'outside-root']
    outside_via_symlink = any(step['component_is_symlink'] for step in trace if step['resolved_relation_to_root'] == 'outside-root')
    outside_via_parent = any(step['component'] == '..' for step in trace if step['resolved_relation_to_root'] == 'outside-root')
    root_self_steps = [step for step in prior if step['resolved_relation_to_root'] == 'root-self']
    final_inside = final_relation == 'strict-descendant'
    return trace, {
        'final_relation_to_root': final_relation,
        'intermediate_outside_root': bool(outside_steps),
        'intermediate_root_self': bool(root_self_steps),
        'outside_via_symlink_component': outside_via_symlink,
        'outside_via_parent_component': outside_via_parent,
        'final_inside_after_outside': final_inside and bool(outside_steps),
        'final_inside_after_symlink_escape': final_inside and outside_via_symlink,
        'final_inside_after_parent_excursion': final_inside and outside_via_parent,
    }


with tempfile.TemporaryDirectory() as td:
    base = Path(td).resolve()
    root = base / spec['root_name']
    root.mkdir(parents=True, exist_ok=True)

    for value in spec['directories']:
        (base / value).mkdir(parents=True, exist_ok=True)

    symlink_supported = True
    symlink_error = None
    for item in spec['symlinks']:
        link = base / item['path']
        target = base / item['target']
        link.parent.mkdir(parents=True, exist_ok=True)
        target.mkdir(parents=True, exist_ok=True)
        try:
            link.symlink_to(target, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            symlink_supported = False
            symlink_error = f'{type(exc).__name__}: {exc}'
            break

    results = []
    if symlink_supported:
        for case in spec['cases']:
            trace, features = transition_observation(root, base, case['artifact_path'])
            row = {
                'label': case['label'],
                'artifact_path': case['artifact_path'],
                'transition_trace': trace,
                'transition_features': features,
            }
            try:
                value = resolve_artifact_path(root, case['artifact_path'])
            except Exception as exc:
                row.update({
                    'accepted': False,
                    'error_type': type(exc).__name__,
                    'error': str(exc),
                })
            else:
                resolved, relative_base, relative_root, relation = relation_row(value, root, base)
                row.update({
                    'accepted': True,
                    'resolved_relative_to_sandbox': relative_base,
                    'resolved_relative_to_root': relative_root,
                    'resolved_relation_to_root': relation,
                })
            results.append(row)

    print(json.dumps({
        'root_name': spec['root_name'],
        'symlink_supported': symlink_supported,
        'symlink_error': symlink_error,
        'results': results,
    }, sort_keys=True))
`;

async function runPathResolutionProbe(workspace, args = {}, { platform = process.platform } = {}) {
  const spec = normalizeProbeSpec(args);
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

function captureProbeObservation(observationSink, observation) {
  if (!Array.isArray(observationSink)) return;
  observationSink.push(observation);
  if (observationSink.length > MAX_CAPTURED_PROBE_OBSERVATIONS) {
    observationSink.splice(0, observationSink.length - MAX_CAPTURED_PROBE_OBSERVATIONS);
  }
}

function createPathResolutionProbeTool(defineTool, { workspace, observationSink = null } = {}) {
  if (!workspace) throw new Error('createPathResolutionProbeTool requires workspace.');
  return defineTool('probe_path_resolution', {
    description: 'Run model-chosen artifact-path resolution cases against the current implementation using a disposable OS-temp filesystem. The tool creates only the declared temp directories/symlinks, never writes the repository, and returns resolver outcomes plus oracle-blind per-component filesystem transition traces without expected verdicts.',
    parameters: {
      type: 'object',
      properties: {
        root_name: {
          type: 'string',
          description: 'Single directory name for the temporary artifact root. Defaults to work.',
        },
        directories: {
          type: 'array',
          maxItems: 16,
          items: { type: 'string' },
          description: 'Optional directory paths relative to the temporary sandbox, for example outside or work/inside.',
        },
        symlinks: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Symlink path relative to the temporary sandbox, for example work/escape.' },
              target: { type: 'string', description: 'Directory target relative to the temporary sandbox, for example outside.' },
            },
            required: ['path', 'target'],
            additionalProperties: false,
          },
        },
        cases: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              artifact_path: { type: 'string' },
            },
            required: ['artifact_path'],
            additionalProperties: false,
          },
          description: 'Artifact paths passed verbatim to resolve_artifact_path(root, artifact_path). Choose positive and negative witnesses from the task contract.',
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
        spec = normalizeProbeSpec(args);
        revision = await workspaceRevision(workspace);
        const result = await runPathResolutionProbe(workspace, spec);
        captureProbeObservation(observationSink, { revision, spec, result });
        return { accepted: true, ...result };
      } catch (error) {
        captureProbeObservation(observationSink, {
          revision,
          spec,
          error: error?.message ?? String(error),
        });
        return { accepted: false, error: error?.message ?? String(error) };
      }
    },
  });
}

function injectPathProbeIntoReviewerClient(factory, baseClient, probeTool) {
  const proxy = Object.create(baseClient);
  proxy.createSession = async (options = {}) => {
    const originalPrompt = options.systemMessage?.content ?? '';
    return baseClient.createSession({
      ...options,
      tools: [...(options.tools ?? []), probeTool],
      availableTools: [...new Set([...(options.availableTools ?? []), PATH_PROBE_TOOL])],
      systemMessage: {
        mode: 'append',
        content: [originalPrompt, REVIEWER_PATH_PROBE_PROMPT].filter(Boolean).join('\n\n'),
      },
    });
  };
  return proxy;
}

module.exports = {
  PATH_PROBE_TOOL,
  MAX_CAPTURED_PROBE_OBSERVATIONS,
  REVIEWER_PATH_PROBE_PROMPT,
  pythonExecutable,
  normalizeSandboxRelative,
  normalizeProbeSpec,
  runPathResolutionProbe,
  captureProbeObservation,
  createPathResolutionProbeTool,
  injectPathProbeIntoReviewerClient,
};