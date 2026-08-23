'use strict';

// The Discord bridge's decisions, separated from its I/O.
//
// Everything here is pure: who is allowed to command the agent, what a message
// means, and how to render a reply. The socket and gateway plumbing lives in
// scripts/discord-bridge.js, so the security-relevant half can be tested
// directly rather than against a live gateway.
//
// The threat model is the reason this file exists. A bot that turns chat
// messages into agent runs is a remote execution channel: anyone who can post
// where the bot listens could otherwise run commands on the machine. So
// authorization is deny-by-default and checked before a message is even
// parsed, and message text is treated as a request from a person — never as
// instructions that can change the bridge's own rules.

const MAX_DISCORD_MESSAGE = 2000;

// Deny by default. A message must clear every one of these to become a run:
// an allowlisted author, an allowlisted channel, and not a bot (including this
// bridge's own messages, which would otherwise loop).
function authorize(config, message) {
  const owners = (config?.ownerIds || []).map(String).filter(Boolean);
  const channels = (config?.channelIds || []).map(String).filter(Boolean);
  if (!owners.length) return { ok: false, reason: 'no ownerIds configured — the bridge answers nobody until you name yourself' };
  if (message?.author?.bot) return { ok: false, reason: 'message is from a bot' };
  const authorId = String(message?.author?.id || '');
  if (!owners.includes(authorId)) return { ok: false, reason: `author ${authorId || 'unknown'} is not an owner` };
  // An empty channel allowlist means DMs with an owner only, which is the
  // safest default: a shared guild channel should be opted into explicitly.
  const channelId = String(message?.channel_id || '');
  if (channels.length && !channels.includes(channelId)) return { ok: false, reason: `channel ${channelId} is not allowlisted` };
  if (!channels.length && message?.guild_id) return { ok: false, reason: 'guild message but no channelIds allowlisted (DM the bot, or allowlist the channel)' };
  return { ok: true };
}

// What a message asks for. Bang-commands mirror the slash commands in the app
// so there is one vocabulary to learn; anything else is a goal to run.
function parseCommand(content) {
  const text = String(content || '').trim();
  if (!text) return { kind: 'ignore' };
  if (!text.startsWith('!')) return { kind: 'run', goal: text };

  const [word, ...rest] = text.slice(1).split(/\s+/);
  const argument = rest.join(' ').trim();
  switch (word.toLowerCase()) {
    case 'help': return { kind: 'help' };
    case 'status': return { kind: 'status' };
    case 'pending': return { kind: 'pending' };
    case 'approve': return { kind: 'resolve', approved: true, selector: argument || 'all' };
    case 'deny': return { kind: 'resolve', approved: false, selector: argument || 'all' };
    case 'resume': return { kind: 'resume', runId: argument };
    case 'stop': return { kind: 'stop' };
    case 'run': return argument ? { kind: 'run', goal: argument } : { kind: 'error', error: 'Usage: !run <goal>' };
    default: return { kind: 'error', error: `Unknown command "!${word}". !help for the list.` };
  }
}

const HELP = [
  '**Brittain Code**',
  'Send anything and I run it as a task. No prefix needed.',
  '',
  '`!pending` — what is waiting on your approval',
  '`!approve` / `!deny` — decide it (add a number for just one)',
  '`!resume` — carry on after deciding',
  '`!status` — am I busy?',
  '`!stop` — stop what I am doing',
].join('\n');

// Discord hard-caps a message at 2000 characters. Splitting on line boundaries
// keeps code blocks and lists readable; a single line longer than the cap is
// cut, because refusing to send is worse than truncating.
function chunk(text, limit = MAX_DISCORD_MESSAGE) {
  const out = [];
  let current = '';
  for (const line of String(text ?? '').split('\n')) {
    const piece = line.length > limit ? line.slice(0, limit - 1) + '…' : line;
    if (current && current.length + piece.length + 1 > limit) {
      out.push(current);
      current = piece;
    } else {
      current = current ? current + '\n' + piece : piece;
    }
  }
  if (current) out.push(current);
  return out.length ? out : [''];
}

function renderPending(records) {
  if (!records?.length) return 'Nothing parked. Runs only suspend when they hit a call that needs you.';
  const lines = [];
  for (const record of records) {
    lines.push(`**${record.runId}** — ${record.goal}`);
    for (const call of record.parked) {
      lines.push(`  \`[${call.index}]\` **${call.name}**${call.target ? ` on \`${call.target}\`` : ''} — ${call.reason}${call.decision ? ` *(${call.decision})*` : ''}`);
    }
  }
  lines.push('', '`!approve all` then `!resume`, or `!approve <n>` for one.');
  return lines.join('\n');
}

// What a chat window should show, which is far less than a terminal does.
//
// The run narrative is written for someone watching a console: transcript
// paths, branch names, policy grants, compaction notices, step budgets. Piping
// all of it into a DM buries the two things a remote person actually needs —
// that something is waiting on them, and that something went wrong — under
// paragraphs they cannot act on. The answer itself arrives separately, when
// the run returns it.
//
// So: relay interruptions, not progress.
const RELAYED = new Set(['run:decisions']);

// Info lines worth breaking silence for. Everything else is bookkeeping.
const NOTEWORTHY = [
  /^Agent run failed:/i,
  /^Deferred /,
  /could not be read/i,
  /^Trigger "/,
  /^Heartbeat for /,
];

function renderEvent(channel, payload) {
  if (channel === 'stream:info') {
    const text = String(payload || '');
    return NOTEWORTHY.some((pattern) => pattern.test(text)) ? text : '';
  }
  if (!RELAYED.has(channel)) return '';
  const parked = (payload?.parked || []).filter((entry) => !entry.decision);
  if (!parked.length) return '';
  return [
    `⏸️ **Waiting on you** — ${parked.length} call(s) need approval.`,
    ...parked.map((entry) => `• **${entry.name}**${entry.target ? ` \`${entry.target}\`` : ''} — ${entry.reason}`),
    '',
    '`!approve all` then `!resume` · `!pending` for detail',
  ].join('\n');
}

// The end of a run, as a person would want it: the answer first, then one line
// of what it did. A run that changed nothing and said nothing still says so,
// because silence is indistinguishable from a bridge that broke.
function renderResult(result) {
  if (!result?.ok) return `⚠️ ${result?.error || 'the run could not start'}`;
  if (result.queued) return `Busy — queued (${result.depth} waiting).`;
  if (result.status === 'suspended') return '';

  const parts = [];
  const answer = String(result.content || '').trim();
  if (result.status === 'failed') parts.push(`⚠️ **Failed** — ${result.error || 'see the run report'}`);
  else if (result.status === 'stopped') parts.push('⏹️ Stopped.');

  if (answer) parts.push(answer);
  else if (result.status === 'completed') parts.push('Done — the run finished without a closing message.');

  const did = [];
  if (result.changed) did.push(`${result.changed} file${result.changed === 1 ? '' : 's'} changed`);
  if (result.commands) did.push(`${result.commands} command${result.commands === 1 ? '' : 's'}`);
  if (result.changed && !result.verified) did.push('not verified');
  if (did.length) parts.push(`-# ${did.join(' · ')}`);

  return parts.join('\n\n');
}

module.exports = {
  MAX_DISCORD_MESSAGE, HELP, RELAYED,
  authorize, parseCommand, chunk, renderPending, renderEvent, renderResult, NOTEWORTHY,
};
