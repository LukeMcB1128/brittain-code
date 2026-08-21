'use strict';

// How much a run may do without being asked.
//
// This replaces a boolean. AUTO-APPROVE was either "prompt for everything" or
// "prompt for nothing", which is the wrong shape for two reasons: most runs
// want something in between, and a run with nobody watching cannot be served by
// either setting — one hangs forever waiting for a click, the other waives
// every check precisely when no one is there to catch a mistake.
//
// A verdict is one of:
//   allow   run it
//   ask     put it to the human (only meaningful when someone is watching)
//   defer   do not run it, record it for review, let the run continue
//   deny    refuse outright and tell the model not to retry
//
// The invariants below hold whatever a policy says. They are the actual
// security design; everything else is configuration.

const BUILT_IN = {
  supervised: {
    label: 'Supervised',
    description: 'Approve every risky tool call. Nothing touches the project unattended.',
    attendedOnly: true,
    allow: [],
    deny: [],
    network: 'ask',
  },
  guarded: {
    label: 'Guarded',
    description: 'Reads and project checks run automatically; writes and commands still ask.',
    attendedOnly: true,
    allow: [
      'read_file', 'browse_files', 'search_files', 'search_local_docs',
      'project_outline', 'find_symbol', 'find_references',
      'get_file_lines', 'file_metadata', 'git_status', 'read_git_diff',
      'get_git_log', 'check_port_usage', 'run_project_check',
    ],
    deny: [],
    network: 'ask',
  },
  trusted: {
    label: 'Trusted',
    description: 'Ordinary risky tools run unattended. Destructive, sensitive, and external tools still ask.',
    attendedOnly: false,
    allowRisky: true,
    allow: [],
    deny: [],
    network: 'ask',
  },
};

// A null policy is a realistic state, not a programming error: settings can
// name a policy that has since been removed from autonomy.json. Falling back to
// an empty object means such a run supervises everything, which is the safe
// direction to fail in.
function normalizePolicy(rawPolicy) {
  const policy = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  return {
    label: String(policy.label || ''),
    description: String(policy.description || ''),
    attendedOnly: !!policy.attendedOnly,
    allowRisky: !!policy.allowRisky,
    allow: new Set(policy.allow || []),
    deny: new Set(policy.deny || []),
    network: policy.network === true ? 'allow' : policy.network === 'ask' ? 'ask' : 'deny',
    writeScope: policy.writeScope || (policy.allowRisky ? 'project' : 'none'),
    requireBranch: !!policy.requireBranch,
    maxToolCalls: Number(policy.maxToolCalls) > 0 ? Number(policy.maxToolCalls) : 0,
  };
}

function matches(patterns, name) {
  if (patterns.has(name)) return true;
  for (const pattern of patterns) {
    if (pattern === '*') return true;
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

// An 'ask' with nobody there is not an approval — it is a hang. Decision B says
// the run continues and reports rather than stalling until morning.
function resolveAsk(attended) {
  return attended ? 'ask' : 'defer';
}

function decide(rawPolicy, call = {}) {
  const policy = normalizePolicy(rawPolicy);
  const {
    name = '',
    attended = true,
    risky = false,
    sensitive = false,
    destructive = false,
    mcp = false,
    network = false,
    onlineResearch = false,
    toolCalls = 0,
  } = call;

  // Budget first: a runaway loop should stop regardless of what it is doing.
  if (policy.maxToolCalls && toolCalls >= policy.maxToolCalls) {
    return { verdict: 'deny', reason: `policy tool-call budget of ${policy.maxToolCalls} is spent` };
  }

  // An explicit deny beats everything below it, including an allow list.
  if (matches(policy.deny, name)) {
    return { verdict: 'deny', reason: 'denied by policy' };
  }

  // --- invariants: no policy may waive these ---

  // Online requests need the app-level switch and a policy that opts in.
  if (network) {
    if (!onlineResearch) return { verdict: 'deny', reason: 'online research is disabled' };
    if (policy.network === 'deny') return { verdict: 'deny', reason: 'policy does not permit online requests' };
    if (policy.network === 'allow') return { verdict: 'allow', reason: 'policy permits online requests' };
    return { verdict: resolveAsk(attended), reason: 'online requests always need approval' };
  }

  // Losing a day's work unsupervised is not a trade worth making.
  if (destructive) {
    return { verdict: resolveAsk(attended), reason: 'destructive operations are never automatic' };
  }

  // Third-party tools are untrusted regardless of how much the user trusts
  // this policy — the same posture the MCP client already takes.
  if (mcp) {
    return { verdict: resolveAsk(attended), reason: 'external MCP tools are never automatic' };
  }

  // Credentials and keys leaving the machine is the worst available outcome.
  if (sensitive) {
    return { verdict: resolveAsk(attended), reason: 'sensitive reads are never automatic' };
  }

  // --- ordinary tools ---

  if (matches(policy.allow, name)) return { verdict: 'allow', reason: 'permitted by policy' };
  if (!risky) return { verdict: 'allow', reason: 'not a risky tool' };
  if (policy.allowRisky) {
    if (policy.writeScope === 'none') {
      return { verdict: resolveAsk(attended), reason: 'policy permits no writes' };
    }
    return { verdict: 'allow', reason: 'policy permits risky tools' };
  }
  return { verdict: resolveAsk(attended), reason: 'risky tool not in the policy allow list' };
}

// Runs that nobody is watching depend on the checkpoint and branch for undo.
// Without a repository there is no way back, so refuse rather than degrade.
function checkPreconditions(rawPolicy, { attended = true, isGitRepo = false, onBranch = '' } = {}) {
  const policy = normalizePolicy(rawPolicy);
  if (attended) return { ok: true };
  if (!isGitRepo) {
    return { ok: false, error: 'An unattended run needs a Git repository — there is no undo without one.' };
  }
  if (policy.requireBranch && !/^brittain\//.test(onBranch)) {
    return { ok: false, error: `This policy requires a brittain/ branch; the working tree is on "${onBranch || 'an unknown branch'}".` };
  }
  return { ok: true };
}

function listPolicies(custom = {}) {
  return { ...BUILT_IN, ...custom };
}

function getPolicy(id, custom = {}) {
  return listPolicies(custom)[id] || null;
}

// AUTO-APPROVE checked meant "run risky tools without asking", which is exactly
// Trusted. Unchecked is Supervised. Landing an existing user anywhere else
// would change what their app does without them asking for it.
function policyForLegacyAutoApprove(autoApprove) {
  return autoApprove ? 'trusted' : 'supervised';
}

module.exports = {
  decide,
  checkPreconditions,
  normalizePolicy,
  listPolicies,
  getPolicy,
  policyForLegacyAutoApprove,
  BUILT_IN,
};
