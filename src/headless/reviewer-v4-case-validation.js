#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runPythonProbe } = require('./reviewer-only-case-validation');

function falseKeys(checks) {
  return Object.entries(checks ?? {}).filter(([, value]) => value === false).map(([key]) => key).sort();
}

function validateLease(workspace) {
  return runPythonProbe(workspace, String.raw`
import json
from taskflow.leases import LeaseRegistry

checks = {}

r = LeaseRegistry()
a = r.acquire("gpu0", "alice")
checks["baseline_lifecycle"] = r.active("gpu0") == a and r.release(a) and r.active("gpu0") is None
b = r.acquire("gpu0", "alice")
checks["baseline_generation"] = b.generation > a.generation
r.release(b)

r = LeaseRegistry()
first = r.acquire("gpu0", "alice")
renewed = r.renew(first)
old_rejected = False
try:
    r.release(first)
except RuntimeError:
    old_rejected = True
checks["renew_rotates_and_invalidates_old"] = (
    renewed.generation > first.generation
    and old_rejected
    and r.active("gpu0") == renewed
)

class Abort(BaseException):
    pass
r = LeaseRegistry()
try:
    r.run("gpu0", "alice", lambda _lease: (_ for _ in ()).throw(Abort("stop")))
except Abort:
    pass
checks["baseexception_cleanup"] = r.active("gpu0") is None

r = LeaseRegistry()
def replace_callback(lease):
    r.release(lease)
    return r.acquire("gpu0", "bob")
replacement = r.run("gpu0", "alice", replace_callback)
checks["baseline_replacement_lease_preserved"] = (
    replacement.owner == "bob"
    and r.active("gpu0") == replacement
)

print(json.dumps({"checks": checks}))
`);
}

function validateAuthCache(workspace) {
  return runPythonProbe(workspace, String.raw`
import json
from taskflow.authcache import AuthorizationCache

checks = {}

c = AuthorizationCache()
checks["baseline_exact"] = c.authorize("a", "u", "read", lambda *_: {"read": True}) is True
c.clear()
checks["baseline_wildcard"] = c.authorize("a", "u", "deploy", lambda *_: {"*": True}) is True

c = AuthorizationCache()
alpha = c.authorize("alpha", "alice", "read", lambda *_: {"read": True})
beta_loader_calls = []
def beta_loader(*args):
    beta_loader_calls.append(args)
    return {"read": False}
beta = c.authorize("beta", "alice", "read", beta_loader)
checks["tenant_isolation"] = alpha is True and beta is False and len(beta_loader_calls) == 1

c = AuthorizationCache()
checks["explicit_deny_overrides_wildcard"] = c.authorize(
    "alpha", "alice", "delete", lambda *_: {"*": True, "delete": False}
) is False

print(json.dumps({"checks": checks}))
`);
}

function validateHeaders(workspace) {
  return runPythonProbe(workspace, String.raw`
import json
from types import MappingProxyType
from taskflow.headers import normalize_headers

checks = {}

checks["baseline_generic_mapping"] = normalize_headers(
    MappingProxyType({"Accept": ["json"], "X-ID": ("a", "b")})
) == {"Accept": ["json"], "X-ID": ["a", "b"]}

checks["scalar_string_atomic"] = normalize_headers({"Accept": "json"}) == {"Accept": ["json"]}

source = {"X-ID": ["a"], "x-id": ["b"], "Other": ["z"]}
checks["casefold_collision_merge_first_spelling"] = normalize_headers(source) == {
    "X-ID": ["a", "b"],
    "Other": ["z"],
}

print(json.dumps({"checks": checks}))
`);
}

function validateRetryTxn(workspace) {
  return runPythonProbe(workspace, String.raw`
import json
from taskflow.retrytxn import PermanentError, TransientError, run_transaction

checks = {}

state = {"count": 0}
calls = [0]
def baseline_op(current):
    calls[0] += 1
    if calls[0] == 1:
        current["count"] = 9
        raise TransientError("retry")
    ok = current["count"] == 0
    current["count"] = 2
    return ok
checks["baseline_top_level_retry"] = run_transaction(state, baseline_op, retries=1) is True and state == {"count": 2}

state = {"nested": {"items": []}}
calls = [0]
def nested_op(current):
    calls[0] += 1
    if calls[0] == 1:
        current["nested"]["items"].append("leak")
        raise TransientError("retry")
    clean = current["nested"]["items"] == []
    current["nested"]["items"].append("committed")
    return clean
checks["nested_state_rollback"] = run_transaction(state, nested_op, retries=1) is True and state == {"nested": {"items": ["committed"]}}

state = {"count": 0}
calls = [0]
def permanent_op(current):
    calls[0] += 1
    current["count"] = calls[0]
    raise PermanentError("no retry")
try:
    run_transaction(state, permanent_op, retries=3)
except PermanentError:
    pass
checks["permanent_error_not_retried"] = calls[0] == 1 and state == {"count": 0}

class Abort(BaseException):
    pass
state = {"nested": {"items": []}}
def abort_op(current):
    current["nested"]["items"].append("leak")
    current["extra"] = True
    raise Abort("stop")
try:
    run_transaction(state, abort_op, retries=3)
except Abort:
    pass
checks["baseexception_rollback"] = state == {"nested": {"items": []}}

print(json.dumps({"checks": checks}))
`);
}

const CASES = Object.freeze({
  'v4-s15-lease-multidefect': { validator: validateLease, expected: ['renew_rotates_and_invalidates_old', 'baseexception_cleanup'] },
  'v4-s15-lease-clean': { validator: validateLease, expected: [] },
  'v4-s16-authcache-multidefect': { validator: validateAuthCache, expected: ['tenant_isolation', 'explicit_deny_overrides_wildcard'] },
  'v4-s16-authcache-clean': { validator: validateAuthCache, expected: [] },
  'v4-s17-headers-multidefect': { validator: validateHeaders, expected: ['scalar_string_atomic', 'casefold_collision_merge_first_spelling'] },
  'v4-s17-headers-clean': { validator: validateHeaders, expected: [] },
  'v4-s18-retrytxn-multidefect': { validator: validateRetryTxn, expected: ['nested_state_rollback', 'permanent_error_not_retried', 'baseexception_rollback'] },
  'v4-s18-retrytxn-clean': { validator: validateRetryTxn, expected: [] },
});

function validateCase(caseId, workspace) {
  const spec = CASES[caseId];
  if (!spec) throw new Error(`Unknown reviewer-v4 case ${JSON.stringify(caseId)}.`);
  const oracle = spec.validator(workspace);
  const failed = falseKeys(oracle.checks);
  const expected = [...spec.expected].sort();
  return {
    valid: JSON.stringify(failed) === JSON.stringify(expected),
    expectedDefects: expected,
    oracle,
  };
}

function main(argv = process.argv.slice(2)) {
  const caseId = String(argv[0] ?? '').trim();
  const workspace = path.resolve(argv[1] ?? '.');
  const output = path.resolve(argv[2] ?? path.join(process.cwd(), 'reviewer-v4-case-validation.json'));
  let result;
  try {
    result = { caseId, ...validateCase(caseId, workspace) };
  } catch (error) {
    result = { caseId, valid: false, error: error?.message ?? String(error) };
  }
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { CASES, falseKeys, validateLease, validateAuthCache, validateHeaders, validateRetryTxn, validateCase };
