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
//   park    do not run it now; suspend the run and hold the call, with its
//           exact arguments frozen, until a human decides — then resume
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

// An 'ask' with nobody there is not an approval — it is a hang. Unattended,
// a call where a human decision is genuinely needed is parked — the run
// suspends and resumes once someone decides — while a call whose answer would
// be stale by morning is deferred: recorded, skipped, the run continues.
function resolveAsk(attended, parkable = false) {
  if (attended) return 'ask';
  return parkable ? 'park' : 'defer';
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
    financial = false,
    mcpTrust = '',
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

  // Moving money out is the one action where "agreed at launch" and "approved
  // this specific transaction" are genuinely different consents. No policy,
  // however permissive, turns it into an automatic 'allow'. Unattended, that
  // means it is held for review rather than performed — the fence bounded-B
  // runs inside.
  if (financial) {
    return { verdict: resolveAsk(attended, true), reason: 'a financial transaction always needs approval at the moment it happens' };
  }

  // Online requests need the app-level switch and a policy that opts in.
  if (network) {
    if (!onlineResearch) return { verdict: 'deny', reason: 'online research is disabled' };
    if (policy.network === 'deny') return { verdict: 'deny', reason: 'policy does not permit online requests' };
    if (policy.network === 'allow') return { verdict: 'allow', reason: 'policy permits online requests' };
    return { verdict: resolveAsk(attended, true), reason: 'online requests always need approval' };
  }

  // Losing a day's work unsupervised is not a trade worth making.
  if (destructive) {
    return { verdict: resolveAsk(attended, true), reason: 'destructive operations are never automatic' };
  }

  // Third-party tools are untrusted regardless of how much the user trusts
  // this policy — the same posture the MCP client already takes.
  if (mcp) {
    // Graduated trust: a specific tool on a specific server, granted 'allow' or
    // 'park' by the user in mcp.json, may run or park under that grant. The
    // grant is per-tool and resets when the server's command line changes; the
    // default for everything remains ask/park. The destructive, sensitive, and
    // financial invariants above still apply to MCP calls regardless of trust.
    if (mcpTrust === 'allow') {
      return { verdict: 'allow', reason: 'this MCP tool is explicitly trusted in mcp.json' };
    }
    if (mcpTrust === 'park') {
      return { verdict: resolveAsk(attended, true), reason: 'this MCP tool is set to park for approval in mcp.json' };
    }
    return { verdict: resolveAsk(attended, true), reason: 'external MCP tools are never automatic' };
  }

  // Credentials and keys leaving the machine is the worst available outcome.
  if (sensitive) {
    return { verdict: resolveAsk(attended, true), reason: 'sensitive reads are never automatic' };
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

// A project's .brittain/autonomy.json may only make the active policy
// stricter. It arrives via `git pull` like any other repository file, so
// letting it widen permissions would let a malicious PR grant itself access;
// widening lives in the userData autonomy.json, outside the repository.
// Anything that is not a narrowing is returned in `ignored` for the caller to
// warn about, and applied is the policy actually enforced.
function narrowPolicy(rawPolicy, overlay) {
  const policy = normalizePolicy(rawPolicy);
  if (!overlay || typeof overlay !== 'object') return { policy, ignored: [] };
  const ignored = [];
  const narrowed = { ...policy, allow: new Set(policy.allow), deny: new Set(policy.deny) };
  for (const [key, value] of Object.entries(overlay)) {
    if (key === 'deny' && Array.isArray(value)) {
      for (const name of value) narrowed.deny.add(String(name));
    } else if (key === 'maxToolCalls') {
      const cap = Number(value);
      if (cap > 0 && (!narrowed.maxToolCalls || cap < narrowed.maxToolCalls)) narrowed.maxToolCalls = cap;
      else if (!(cap > 0) || (narrowed.maxToolCalls && cap > narrowed.maxToolCalls)) ignored.push(key);
    } else if (key === 'network') {
      // Downgrade only: allow → ask → deny. An overlay cannot move up.
      const rank = { deny: 0, ask: 1, allow: 2 };
      const wanted = value === true ? 'allow' : value === 'ask' ? 'ask' : 'deny';
      if (rank[wanted] < rank[narrowed.network]) narrowed.network = wanted;
      else if (rank[wanted] > rank[narrowed.network]) ignored.push(key);
    } else if (key === 'label' || key === 'description') {
      // informational; nothing to enforce
    } else {
      ignored.push(key);
    }
  }
  return { policy: narrowed, ignored };
}

// A Git checkpoint is the wrong safety model for a run that can act on the
// world — you cannot revert a request that has already left the machine — so a
// repository is no longer required. When there is one, the run still branches
// and checkpoints for the file-level work it does; when there is not, the
// disclosure is the guard and undo simply does not apply.
//
// A policy may still opt into requiring a generated branch. That only makes
// sense with a repository, so a policy that demands one without a repo is a
// contradiction the user chose, and is refused with a clear message.
function checkPreconditions(rawPolicy, { attended = true, isGitRepo = false, onBranch = '' } = {}) {
  const policy = normalizePolicy(rawPolicy);
  if (attended) return { ok: true };
  if (policy.requireBranch) {
    if (!isGitRepo) {
      return { ok: false, error: 'This policy requires a brittain/ branch, which needs a Git repository. Remove requireBranch or run in a repo.' };
    }
    if (!/^brittain\//.test(onBranch)) {
      return { ok: false, error: `This policy requires a brittain/ branch; the working tree is on "${onBranch || 'an unknown branch'}".` };
    }
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

// Custom policies live beside mcp.json, in the same spirit: a plain file the
// user owns, surfaced by a slash command rather than buried in a settings pane.
function loadCustomPolicies(userDataDir) {
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(userDataDir, 'autonomy.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const policies = parsed?.policies && typeof parsed.policies === 'object' ? parsed.policies : {};
    // Built-ins are not overridable: their whole value is that they mean the
    // same thing in every install.
    for (const id of Object.keys(BUILT_IN)) delete policies[id];
    return { policies, configPath, error: '' };
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    return { policies: {}, configPath, error: missing ? '' : String(error.message || error) };
  }
}

// A worked example of bounded-B: an autonomous policy that runs unattended
// inside a fence, rather than a raw waiver. Written disabled-by-omission — it
// is only a template until a run names it — and every field is a bound the
// user chose, not a default they inherited.
const EXAMPLE_CONFIG = {
  policies: {
    autonomous: {
      label: 'Autonomous',
      description: 'Runs unattended within a fence. Raise the bounds deliberately, not by default.',
      allowRisky: true,
      writeScope: 'project',
      // The fence. Autonomy is real; it just runs inside these.
      maxToolCalls: 300,
      // Set requireBranch: true to force work onto a generated brittain/ branch
      // — only meaningful in a Git repository. Off by default so an autonomous
      // run works in any folder, code or not.
      requireBranch: false,
      network: 'ask',
      // Even here, these are never automatic — destructive ops, sensitive
      // reads, external MCP tools, and anything that moves money still stop
      // for you (unattended, they wait in the review tray).
      deny: [],
    },
  },
};

function ensureConfig(userDataDir) {
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(userDataDir, 'autonomy.json');
  try {
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf8');
    }
  } catch {}
  return configPath;
}

module.exports = {
  narrowPolicy,
  loadCustomPolicies,
  ensureConfig,
  EXAMPLE_CONFIG,
  decide,
  checkPreconditions,
  normalizePolicy,
  listPolicies,
  getPolicy,
  policyForLegacyAutoApprove,
  BUILT_IN,
};
