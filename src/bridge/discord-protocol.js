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
    // Session housekeeping, mirroring the slash commands in the app. These act
    // on this channel's conversation, not on whatever the window has open.
    case 'compact': return { kind: 'compact' };
    case 'clear': case 'new': return { kind: 'clear' };
    case 'usage': case 'context': return { kind: 'usage' };
    case 'ledger': return { kind: 'ledger' };
    case 'memory': return { kind: 'memory' };
    default: return { kind: 'error', error: `Unknown command "!${word}". !help for the list.` };
  }
}

// A run event carries its own destination. App work has no Discord target and
// must stay in the app. Scheduled work is the one intentional exception: it is
// unprompted, so it uses the configured notification channel.
function eventTarget(metadata, notifyChannel = '') {
  if (metadata?.origin === 'discord' && metadata.replyChannelId) return String(metadata.replyChannelId);
  if (metadata?.origin === 'trigger' || metadata?.origin === 'heartbeat') return String(notifyChannel || '');
  return '';
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
  '',
  '**This conversation**',
  '`!compact` — summarise the older half to free up room',
  '`!clear` — start fresh, forgetting what we have said here',
  '`!usage` — how full the context is',
  '`!ledger` — files changed and commands run',
  '`!memory` — what I have remembered about this project',
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
// So: relay the model's own words and any interruption — never the machinery.
const RELAYED = new Set(['run:decisions', 'stream:message']);

// Info lines worth breaking silence for. Everything else is bookkeeping.
//
// The test is not "is this interesting" but "does the person need to know".
// A successful compaction is housekeeping — nothing was lost that they can act
// on. A failed one is not: the run either carries on with a context it could
// not trim, or stops mid-task. Left silent, both are experienced as the bot
// quietly getting worse, or ending early, for no stated reason.
//
// Some of these are phrased for a console and mean nothing in a chat, so they
// are rewritten rather than passed through.
const NOTEWORTHY = [
  { match: /^Agent run failed:/i },
  { match: /^Deferred / },
  { match: /could not be read/i },
  { match: /^Trigger "/ },
  { match: /^Heartbeat for / },
  {
    match: /^Auto-compact failed/,
    as: () => '⚠️ I could not summarise the earlier conversation to make room. Carrying on, but my answers may get worse — `!stop` and start fresh if they do.',
  },
  {
    match: /^Recovery compact failed/,
    as: () => '⚠️ I got stuck and could not reset myself, so I stopped here rather than continue badly.',
  },
  {
    match: /^Detected again after recovery/,
    as: () => '⚠️ I started repeating myself and could not shake it, so I stopped. Worth trying a different model, or starting a new conversation.',
  },
  {
    match: /^Model produced no output after/,
    as: () => '⚠️ The model went quiet and would not continue. Nothing more will happen on this one — send it again, or try a different model.',
  },
];

function renderEvent(channel, payload) {
  // What the model actually said, as it says it. A long run narrates its way
  // through several steps, and relaying only the last paragraph made a working
  // agent look like a silent one.
  if (channel === 'stream:message') return String(payload || '').trim();
  if (channel === 'stream:info') {
    const text = String(payload || '');
    const rule = NOTEWORTHY.find((entry) => entry.match.test(text));
    if (!rule) return '';
    return rule.as ? rule.as(text) : text;
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

// A question from ask_user, put to whoever is driving the run.
//
// Options are numbered so a reply can be a digit rather than retyping a phrase
// — on a phone that is the difference between answering and not bothering.
function renderQuestion(payload) {
  const questions = payload?.questions || [];
  if (!questions.length) return '';
  const lines = ['❓ **I need to know:**'];
  questions.forEach((entry, index) => {
    lines.push(questions.length > 1 ? `**${index + 1}.** ${entry.question}` : entry.question);
    (entry.options || []).forEach((option, choice) => lines.push(`  \`${choice + 1}\` ${option}`));
  });
  lines.push('', questions.length > 1
    ? 'Reply with one line per question.'
    : 'Reply with your answer, or the number of an option.');
  return lines.join('\n');
}

// A reply back into answers. A bare number picks that option; anything else is
// taken literally, because a free-text answer is always valid even when options
// were offered.
function parseAnswer(reply, questions = []) {
  const lines = String(reply || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return questions.map((entry, index) => {
    const raw = (questions.length === 1 ? String(reply || '').trim() : lines[index]) || '';
    const options = entry.options || [];
    const asNumber = /^\d+$/.test(raw) ? parseInt(raw, 10) : 0;
    if (asNumber >= 1 && asNumber <= options.length) return options[asNumber - 1];
    return raw;
  });
}

// Compaction, reported the way it matters to someone in a chat: what it did to
// the room, not the internal description. A failure says why.
function renderCompaction(result) {
  if (!result?.ok) return `⚠️ Could not compact: ${result?.error || 'unknown reason'}`;
  const before = Number(result.beforeTokens || 0);
  const after = Number(result.approxTokens || 0);
  const saved = before && after && before > after ? ` — ${Math.round((1 - after / before) * 100)}% smaller` : '';
  return `🗜️ Compacted${saved}. ${result.description || 'Older messages summarised; recent ones kept as they were.'}`;
}

function renderUsage(result, contextLength = 0) {
  if (!result?.ok) return `⚠️ ${result?.error || 'could not read usage'}`;
  const tokens = Number(result.approxTokens || 0);
  const limit = Number(contextLength || 0);
  const share = limit ? ` of ${limit.toLocaleString()} (${Math.round((tokens / limit) * 100)}%)` : '';
  return `${result.messages} message(s), about ${tokens.toLocaleString()} tokens${share}.`;
}

function renderMemory(result) {
  if (!result?.ok) return `⚠️ ${result?.error || 'could not read memory'}`;
  const content = String(result.content || '').trim();
  if (!content) return 'Nothing remembered for this project yet.';
  return [`**Remembered**${result.inRepo ? ' (in the repo)' : ''}:`, '', content].join('\n');
}

// The end of a run, as a person would want it: the answer first, then one line
// of what it did. A run that changed nothing and said nothing still says so,
// because silence is indistinguishable from a bridge that broke.
// `streamed` is whether the model's closing message already went out live. It
// almost always has, now that whole messages are relayed as they happen — so
// repeating it here would post everything twice.
function renderResult(result, streamed = false) {
  if (!result?.ok) return `⚠️ ${result?.error || 'the run could not start'}`;
  if (result.queued) return `Busy — queued (${result.depth} waiting).`;
  if (result.status === 'suspended') return '';

  const parts = [];
  const answer = streamed ? '' : String(result.content || '').trim();
  if (result.status === 'failed') parts.push(`⚠️ **Failed** — ${result.error || 'see the run report'}`);
  else if (result.status === 'stopped') parts.push('⏹️ Stopped.');

  if (answer) parts.push(answer);
  else if (!streamed && result.status === 'completed') parts.push('Done — the run finished without a closing message.');

  const did = [];
  if (result.changed) did.push(`${result.changed} file${result.changed === 1 ? '' : 's'} changed`);
  if (result.commands) did.push(`${result.commands} command${result.commands === 1 ? '' : 's'}`);
  if (result.changed && !result.verified) did.push('not verified');
  if (did.length) parts.push(`-# ${did.join(' · ')}`);

  return parts.join('\n\n');
}

module.exports = {
  MAX_DISCORD_MESSAGE, HELP, RELAYED,
  authorize, parseCommand, eventTarget, chunk, renderPending, renderEvent, renderResult, renderQuestion, parseAnswer,
  renderCompaction, renderUsage, renderMemory, NOTEWORTHY,
};
