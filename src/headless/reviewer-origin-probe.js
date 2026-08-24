'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { workspaceRevision } = require('../orchestrator/revision');
const { pythonExecutable, captureProbeObservation } = require('./reviewer-path-probe');

const execFileAsync = promisify(execFile);
const ORIGIN_PROBE_TOOL = 'custom:probe_redirect_chain';

const REVIEWER_ORIGIN_PROBE_PROMPT = `
For this redirect-origin containment benchmark you also have probe_redirect_chain, a benchmark-only read-only diagnostic tool. It invokes the current workspace's resolve_redirect_chain implementation on model-chosen URL chains and reports oracle-blind per-hop URL/origin observations. The tool has no expected answers and does not know the hidden acceptance oracle.

Derive witness chains from the task contract. For a contrastive origin-boundary claim, probe both the restrictive rule and the corresponding permissive rule at their semantic boundary; do not substitute an easy direct external redirect for a transition bug that can be masked by a later hop.

When correctness depends on every intermediate redirect remaining on the trusted origin, make the pair genuinely discriminating. The hostile witness should resolve at least one intermediate hop to a different origin and then return to an otherwise allowed-looking trusted-origin final URL. The benign witness should use a comparable multi-hop chain and exercise permitted URL-reference/path transitions while remaining on the trusted origin at every hop. A hostile case whose final URL is still plainly cross-origin does not expose a final-state-only check, and a benign one-hop happy path cannot falsify an over-restrictive remediation.

The probe reports the resolved URL and normalized origin relation for every hop, including target provenance (absolute, scheme-relative, root-relative, query/fragment-only, parent-relative, or other relative reference). These are mechanically observed facts, not expected resolver verdicts. Use those observations rather than mentally simulating URL-join/origin semantics when explaining why a witness pair is matched.
`.trim();

function normalizeOriginProbeSpec(args = {}) {
  const baseUrl = String(args.base_url ?? '').trim();
  if (!baseUrl) throw new Error('base_url is required.');
  if (baseUrl.length > 1000) throw new Error('base_url is limited to 1000 characters.');

  const cases = (Array.isArray(args.cases) ? args.cases : []).map((entry, index) => {
    const redirects = Array.isArray(entry?.redirects) ? entry.redirects.map((value) => String(value)) : [];
    if (redirects.length > 16) throw new Error(`cases[${index}].redirects allows at most 16 hops.`);
    if (redirects.some((value) => value.length > 1000)) throw new Error(`cases[${index}] redirect targets are limited to 1000 characters.`);
    return {
      label: String(entry?.label ?? `case-${index + 1}`).trim().slice(0, 80) || `case-${index + 1}`,
      redirects,
    };
  });
  if (!cases.length) throw new Error('At least one redirect-chain case is required.');
  if (cases.length > 16) throw new Error('At most 16 redirect-chain cases are allowed.');
  return { base_url: baseUrl, cases };
}

const PYTHON_ORIGIN_PROBE = String.raw`
import json
import sys
from pathlib import Path
from urllib.parse import urljoin, urlsplit

workspace = Path(sys.argv[1]).resolve()
spec = json.loads(sys.argv[2])
sys.path.insert(0, str(workspace))
from taskflow import resolve_redirect_chain


def effective_port(scheme, port):
    if port is not None:
        return port
    if scheme == 'https':
        return 443
    if scheme == 'http':
        return 80
    return None


def origin_row(url):
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname.lower() if parsed.hostname else None
    try:
        port = effective_port(scheme, parsed.port)
        port_error = None
    except ValueError as exc:
        port = None
        port_error = str(exc)
    return {
        'scheme': scheme,
        'hostname': hostname,
        'effective_port': port,
        'port_error': port_error,
    }


def same_origin(left, right):
    return (
        left['port_error'] is None
        and right['port_error'] is None
        and left['scheme'] == right['scheme']
        and left['hostname'] == right['hostname']
        and left['effective_port'] == right['effective_port']
    )


def target_provenance(target):
    parsed = urlsplit(target)
    if parsed.scheme:
        return 'absolute'
    if target.startswith('//'):
        return 'scheme-relative'
    if target.startswith('/'):
        return 'root-relative'
    if target.startswith('?'):
        return 'query-only'
    if target.startswith('#'):
        return 'fragment-only'
    parts = target.split('/', 1)
    if parts and parts[0] in ('.', '..'):
        return 'parent-relative' if parts[0] == '..' else 'dot-relative'
    return 'relative'


base_url = spec['base_url']
trusted_origin = origin_row(base_url)
all_results = []
for case in spec['cases']:
    current = base_url
    trace = []
    for index, target in enumerate(case['redirects'], start=1):
        source = current
        resolved = urljoin(source, target)
        resolved_origin = origin_row(resolved)
        relation = 'trusted-origin' if same_origin(resolved_origin, trusted_origin) else 'outside-origin'
        trace.append({
            'index': index,
            'source_url': source,
            'redirect_target': target,
            'target_provenance': target_provenance(target),
            'resolved_url': resolved,
            'resolved_origin': resolved_origin,
            'resolved_relation_to_trusted_origin': relation,
            'scheme_changed': resolved_origin['scheme'] != trusted_origin['scheme'],
            'hostname_changed': resolved_origin['hostname'] != trusted_origin['hostname'],
            'port_changed': resolved_origin['effective_port'] != trusted_origin['effective_port'],
        })
        current = resolved

    outside_steps = [step for step in trace if step['resolved_relation_to_trusted_origin'] == 'outside-origin']
    prior_outside = [step for step in trace[:-1] if step['resolved_relation_to_trusted_origin'] == 'outside-origin']
    final_same = (not trace) or trace[-1]['resolved_relation_to_trusted_origin'] == 'trusted-origin'
    features = {
        'hop_count': len(trace),
        'intermediate_outside_origin': bool(prior_outside),
        'any_outside_origin': bool(outside_steps),
        'final_same_origin': final_same,
        'final_same_origin_after_outside': final_same and bool(prior_outside),
        'outside_via_absolute_target': any(step['target_provenance'] == 'absolute' for step in outside_steps),
        'outside_via_scheme_relative_target': any(step['target_provenance'] == 'scheme-relative' for step in outside_steps),
        'outside_via_scheme_change': any(step['scheme_changed'] for step in outside_steps),
        'outside_via_hostname_change': any(step['hostname_changed'] for step in outside_steps),
        'outside_via_port_change': any(step['port_changed'] for step in outside_steps),
    }

    row = {
        'label': case['label'],
        'redirects': case['redirects'],
        'trusted_origin': trusted_origin,
        'transition_trace': trace,
        'transition_features': features,
    }
    try:
        value = resolve_redirect_chain(base_url, case['redirects'])
    except Exception as exc:
        row.update({
            'accepted': False,
            'error_type': type(exc).__name__,
            'error': str(exc),
        })
    else:
        row.update({
            'accepted': True,
            'resolved_url': value,
            'resolved_origin': origin_row(value),
        })
    all_results.append(row)

print(json.dumps({
    'base_url': base_url,
    'trusted_origin': trusted_origin,
    'results': all_results,
}, sort_keys=True))
`;

async function runRedirectOriginProbe(workspace, args = {}, { platform = process.platform } = {}) {
  const spec = normalizeOriginProbeSpec(args);
  const { stdout, stderr } = await execFileAsync(
    pythonExecutable(platform),
    ['-B', '-c', PYTHON_ORIGIN_PROBE, path.resolve(workspace), JSON.stringify(spec)],
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

function createRedirectOriginProbeTool(defineTool, { workspace, observationSink = null } = {}) {
  if (!workspace) throw new Error('createRedirectOriginProbeTool requires workspace.');
  return defineTool('probe_redirect_chain', {
    description: 'Run model-chosen redirect chains against the current resolve_redirect_chain implementation and return oracle-blind per-hop resolved URL/origin transition facts plus the implementation outcome. The tool is read-only and does not encode expected verdicts.',
    parameters: {
      type: 'object',
      properties: {
        base_url: {
          type: 'string',
          description: 'Trusted absolute HTTP(S) base URL for all cases.',
        },
        cases: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              redirects: {
                type: 'array',
                maxItems: 16,
                items: { type: 'string' },
                description: 'Sequential redirect targets passed verbatim to resolve_redirect_chain.',
              },
            },
            required: ['redirects'],
            additionalProperties: false,
          },
        },
      },
      required: ['base_url', 'cases'],
      additionalProperties: false,
    },
    skipPermission: true,
    defer: 'never',
    handler: async (args = {}) => {
      let spec = null;
      let revision = null;
      try {
        spec = normalizeOriginProbeSpec(args);
        revision = await workspaceRevision(workspace);
        const result = await runRedirectOriginProbe(workspace, spec);
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

module.exports = {
  ORIGIN_PROBE_TOOL,
  REVIEWER_ORIGIN_PROBE_PROMPT,
  normalizeOriginProbeSpec,
  runRedirectOriginProbe,
  createRedirectOriginProbeTool,
};
