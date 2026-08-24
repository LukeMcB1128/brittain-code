'use strict';

// The Discord bridge itself: gateway connection, REST replies, command loop.
//
// It takes its transport rather than choosing one, which is what lets the same
// code run two ways. In the packaged app it runs inside whichever process owns
// the trigger scheduler and dispatches straight to the daemon's handlers; from
// a checkout, scripts/discord-bridge.js supplies handlers that go over the unix
// socket instead. One implementation, so the standalone path cannot drift from
// the shipped one.
//
// No dependencies. Node ships a WebSocket global and the gateway is documented
// JSON, so this is hand-rolled for the same reason mcp.js is: the most
// security-sensitive component of the app should not carry a supply chain.
//
// The bridge holds no authority of its own. It turns an allowlisted person's
// message into the same run the app starts, under the policy in its config, so
// every invariant, every park, and every decision record still applies. What it
// adds is that an approval can travel: a run parks on this machine and the
// decision arrives from wherever the person is.

const { authorize, parseCommand, eventTarget, chunk, renderPending, renderEvent, renderResult, renderQuestion, parseAnswer, HELP } = require('./discord-protocol');

const API = 'https://discord.com/api/v10';

// Gateway close codes that no amount of retrying will fix. Reconnecting on
// these hides the cause behind an endless loop, which is exactly what makes a
// misconfigured bot look like a broken one — so they stop the bridge and say
// what to change instead.
const FATAL_CLOSE = {
  4004: 'the bot token is wrong or has been reset — copy it again from the Developer Portal (Bot → Reset Token)',
  4010: 'invalid shard',
  4011: 'this bot is in too many servers to connect without sharding',
  4012: 'invalid API version',
  4013: 'the requested gateway intents are invalid',
  4014: 'the Message Content intent is not enabled for this bot — Developer Portal → your app → Bot → '
    + 'Privileged Gateway Intents → turn on MESSAGE CONTENT INTENT, then restart Brittain Code',
};
// GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

// Discord REST calls for one channel must stay in order. Each channel gets its
// own promise tail, so a slow reply in one DM does not block another channel.
// A rate-limited part is retried in place. Advancing to the next part would
// silently remove text from the answer.
function createDiscordSender({ token, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console }) {
  const tails = new Map();

  async function deliver(channelId, text) {
    if (!channelId) return false;
    let sentAny = false;
    for (const part of chunk(text)) {
      if (!part.trim()) continue;
      for (;;) {
        let res;
        try {
          res = await fetchImpl(`${API}/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: part }),
          });
        } catch (error) {
          log.error?.('Discord send failed:', String(error.message || error));
          return false;
        }
        if (res.status === 429) {
          const retry = Number((await res.json())?.retry_after || 1);
          await sleep(retry * 1000);
          continue;
        }
        if (!res.ok) {
          log.error?.('Discord send failed:', res.status, await res.text());
          return false;
        }
        sentAny = true;
        break;
      }
    }
    return sentAny;
  }

  return function send(channelId, text) {
    const key = String(channelId || '');
    const previous = tails.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => deliver(key, text)).catch((error) => {
      log.error?.('Discord send failed:', String(error.message || error));
      return false;
    });
    let tracked;
    tracked = task.finally(() => {
      if (tails.get(key) === tracked) tails.delete(key);
    });
    tails.set(key, tracked);
    return task;
  };
}

// `ask(message, timeoutMs)` runs one daemon command and resolves its reply.
// `subscribe(fn)` receives run events and returns an unsubscribe function.
function createDiscordBridge({ config, ask, subscribe, greetStore = null, log = console }) {
  let socket = null;
  let heartbeat = null;
  let unsubscribe = null;
  let notifyChannel = '';
  let stopped = false;
  // Captured from READY. A bot that is in no server cannot be DMed at all —
  // Discord refuses to open the channel — so this one number explains most of
  // the ways setup goes wrong, and is worth surfacing rather than inferring.
  let identity = { username: '', guilds: null };
  // What the gateway is actually doing, as opposed to whether start() was
  // called. "The bridge is running" and "Discord accepted us" are different
  // facts and were being reported as one.
  let gateway = { state: 'starting', lastError: '' };
  // Questions and streamed replies belong to a specific Discord run. Global
  // flags let a second channel answer or suppress the first channel's result.
  const awaitingQuestions = new Map();
  const streamedRuns = new Map();
  const queuedRequests = new Set();
  const send = createDiscordSender({ token: config.token, log });

  // A bot cannot message someone out of the blue without a channel to do it in,
  // and the notifications worth having are exactly the unprompted ones — a run
  // parking overnight. So resolve one up front rather than waiting to be spoken
  // to. Opening a DM requires the bot and the owner to share a server, which is
  // why setup asks you to invite it to one.
  async function resolveNotifyChannel() {
    if (config.notifyChannelId) return String(config.notifyChannelId);
    const owner = String((config.ownerIds || [])[0] || '');
    if (!owner) return '';
    try {
      const res = await fetch(`${API}/users/@me/channels`, {
        method: 'POST',
        headers: { Authorization: `Bot ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: owner }),
      });
      if (!res.ok) {
        log.error?.(`Could not open a DM with owner ${owner} (${res.status}). Unprompted notifications will go to the last channel used.`);
        log.error?.('A bot can only DM someone it shares a server with — invite it to one, or set notifyChannelId.');
        return '';
      }
      return String((await res.json()).id || '');
    } catch (error) {
      log.error?.('Could not open an owner DM:', String(error.message || error));
      return '';
    }
  }

  async function handle(message, channelId) {
    const command = parseCommand(message.content);
    switch (command.kind) {
      case 'ignore': return;
      case 'help': return send(channelId, HELP);
      case 'error': return send(channelId, command.error);

      case 'status': {
        const res = await ask({ cmd: 'status' });
        if (!res.ok) return send(channelId, `Daemon: ${res.error}`);
        const active = res.run?.status === 'running' ? res.run : res.mission?.status === 'running' ? res.mission : null;
        return send(channelId, active
          ? `Running: ${active.goal || '(no goal)'}`
          : `Idle.${res.queued?.length ? ` ${res.queued.length} queued.` : ''}`);
      }

      case 'pending': {
        const res = await ask({ cmd: 'pending' });
        return send(channelId, res.ok ? renderPending(res.records) : `Could not read parked calls: ${res.error}`);
      }

      case 'resolve': {
        const listed = await ask({ cmd: 'pending' });
        if (!listed.ok || !listed.records.length) return send(channelId, 'Nothing parked.');
        if (listed.records.length > 1) {
          return send(channelId, 'Several runs are suspended; deciding from here handles one at a time — `!resume` them in order, or use the app.');
        }
        const record = listed.records[0];
        const indexes = command.selector === 'all'
          ? record.parked.map((entry) => entry.index)
          : [parseInt(command.selector, 10)].filter((n) => Number.isInteger(n));
        if (!indexes.length) return send(channelId, `"${command.selector}" is not one of the parked calls. \`!pending\` lists them.`);
        for (const index of indexes) {
          const res = await ask({ cmd: 'resolve', payload: { runId: record.runId, index, approved: command.approved } });
          if (!res.ok) return send(channelId, `Failed: ${res.error}`);
        }
        return send(channelId, `${command.approved ? 'Approved' : 'Denied'} ${indexes.length} call(s). \`!resume\` to continue the run.`);
      }

      case 'resume': {
        const listed = await ask({ cmd: 'pending' });
        const record = command.runId
          ? listed.records?.find((entry) => entry.runId.endsWith(command.runId))
          : listed.records?.[0];
        if (!record) return send(channelId, 'No suspended run to resume.');
        await send(channelId, `▶️ Resuming ${record.runId}…`);
        const res = await ask({ cmd: 'resume', payload: { runId: record.runId } }, 0);
        return send(channelId, res.ok ? `Finished: ${res.status}` : `Resume failed: ${res.error}`);
      }

      case 'stop': {
        const res = await ask({
          cmd: 'stop',
          payload: { chatId: `discord-${channelId}`, cancelQueued: true },
        });
        if (!res.ok) return send(channelId, res.error);
        const parts = [];
        if (res.stopping) parts.push('Stopping after the current operation.');
        if (res.cancelledQueued?.length) {
          parts.push(`Cancelled ${res.cancelledQueued.length} queued request${res.cancelledQueued.length === 1 ? '' : 's'} from this conversation.`);
        }
        return send(channelId, parts.join('\n'));
      }

      case 'run': {
        // One short acknowledgement, then silence until there is something to
        // say. The alternative — narrating every step — turns a chat into a
        // console log nobody reads.
        await send(channelId, '🤖 On it…');
        const res = await ask({
          cmd: 'run',
          payload: {
            goal: command.goal,
            cwd: config.cwd,
            policy: config.policy,
            model: config.model || undefined,
            chatId: `discord-${channelId}`,
            origin: 'discord',
            requestId: String(message.id || ''),
            replyChannelId: String(channelId),
          },
        }, 0);
        if (res.queued) {
          if (message.id) queuedRequests.add(String(message.id));
          return send(channelId, renderResult(res, false));
        }
        // A suspension has already said what it is waiting on, so renderResult
        // returns nothing for it rather than repeating itself.
        const streamed = res.runId ? await (streamedRuns.get(res.runId) || false) : false;
        if (res.runId) streamedRuns.delete(res.runId);
        return send(channelId, renderResult(res, streamed));
      }
      default: return;
    }
  }

  // Discord hides a DM channel until it holds a message, so a bridge that opens
  // one silently leaves nothing to click — the bot is unreachable precisely
  // because it has never spoken. Introduce it once per channel: enough to make
  // the conversation exist, not enough to be noise on every restart.
  async function introduce() {
    if (!notifyChannel || !greetStore || greetStore.hasGreeted(notifyChannel)) return;
    await send(notifyChannel, [
      '**Brittain Code** is here.',
      `Send me anything and I will work on it in \`${config.cwd.split('/').pop() || config.cwd}\`.`,
      'If I hit something only you can approve, I will ask.',
      '`!help` for the rest.',
    ].join('\n')).catch(() => {});
    greetStore.markGreeted(notifyChannel);
  }

  function connect() {
    if (stopped) return;
    let sequence = null;
    socket = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

    socket.addEventListener('message', async (event) => {
      const frame = JSON.parse(event.data);
      if (frame.s !== null && frame.s !== undefined) sequence = frame.s;

      if (frame.op === 10) {
        heartbeat = setInterval(() => socket.send(JSON.stringify({ op: 1, d: sequence })), frame.d.heartbeat_interval);
        socket.send(JSON.stringify({
          op: 2,
          d: {
            token: config.token,
            intents: INTENTS,
            properties: { os: process.platform, browser: 'brittain-code', device: 'brittain-code' },
          },
        }));
        return;
      }
      if (frame.op === 7 || frame.op === 9) { socket.close(); return; }
      if (frame.op !== 0) return;

      if (frame.t === 'READY') {
        identity = { username: frame.d.user?.username || '', guilds: (frame.d.guilds || []).length };
        gateway = { state: 'ready', lastError: '' };
        log.log?.(`Discord bridge logged in as ${identity.username}. Owners: ${(config.ownerIds || []).join(', ')}.`);
        if (identity.guilds === 0) {
          log.error?.('This bot is in no servers. Discord will not let you DM a bot you share no server with —');
          log.error?.('invite it from the Developer Portal (OAuth2 → URL Generator → scopes: bot) and open that URL.');
        } else {
          log.log?.(`In ${identity.guilds} server(s).`);
        }
        // The DM channel could not be opened before login; with a server in
        // common it can be now, so try again rather than staying unreachable.
        if (!notifyChannel) {
          notifyChannel = await resolveNotifyChannel();
          await introduce();
        }
        return;
      }
      if (frame.t !== 'MESSAGE_CREATE') return;

      // Authorization first, before the content is even looked at. A refused
      // message is dropped in silence: telling strangers they are not allowed
      // only confirms something is listening.
      const allowed = authorize(config, frame.d);
      if (!allowed.ok) {
        log.log?.(`Discord bridge ignored a message: ${allowed.reason}`);
        return;
      }
      try {
        // A pending question takes the next plain message. Bang-commands still
        // work, so !stop is never swallowed by a question you would rather
        // abandon than answer.
        const content = String(frame.d.content || '').trim();
        const awaitingQuestion = awaitingQuestions.get(frame.d.channel_id);
        if (awaitingQuestion && content && !content.startsWith('!')) {
          const { id, questions } = awaitingQuestion;
          awaitingQuestions.delete(frame.d.channel_id);
          const res = await ask({ cmd: 'answer', payload: { id, answers: parseAnswer(content, questions) } });
          if (!res.ok) await send(frame.d.channel_id, res.error);
          return;
        }
        await handle(frame.d, frame.d.channel_id);
      } catch (error) {
        log.error?.('Discord handler failed:', error);
        await send(frame.d.channel_id, `Bridge error: ${String(error.message || error)}`);
      }
    });

    socket.addEventListener('close', (event) => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (stopped) return;

      const explanation = FATAL_CLOSE[event?.code];
      if (explanation) {
        gateway = { state: 'failed', lastError: `Discord refused the connection (${event.code}): ${explanation}` };
        log.error?.(gateway.lastError);
        stopped = true; // retrying cannot help, and a loop would bury the reason
        return;
      }
      gateway = { state: 'closed', lastError: event?.code ? `closed with code ${event.code}` : '' };
      log.log?.(`Discord gateway closed${event?.code ? ` (${event.code})` : ''}; reconnecting in 5s.`);
      setTimeout(connect, 5_000);
    });
    socket.addEventListener('error', (error) => log.error?.('Discord gateway error:', error?.message || error));
  }

  return {
    async start() {
      stopped = false;
      notifyChannel = await resolveNotifyChannel();
      // Prompted replies use the destination captured on their run. Scheduled
      // work uses the notification channel, so it can still reach you first.
      await introduce();

      unsubscribe = subscribe((channel, payload, metadata = null) => {
        const route = metadata || {};
        const target = eventTarget(route, notifyChannel);
        if (!target) return;
        if (channel === 'question:request') {
          const text = renderQuestion(payload);
          if (!text) return;
          awaitingQuestions.set(target, { id: payload.id, runId: route.runId || '', questions: payload.questions || [] });
          send(target, text).catch(() => {});
          return;
        }
        if (channel === 'stream:done' && route.requestId && queuedRequests.has(route.requestId)) {
          queuedRequests.delete(route.requestId);
          const finishQueued = async () => {
            const streamed = route.runId ? await (streamedRuns.get(route.runId) || false) : false;
            if (route.runId) streamedRuns.delete(route.runId);
            const result = renderResult(payload, streamed);
            if (result) await send(target, result);
          };
          finishQueued().catch(() => {});
          return;
        }
        const text = renderEvent(channel, payload);
        if (!text) {
          if (channel === 'stream:done' && route.runId) {
            const timer = setTimeout(() => streamedRuns.delete(route.runId), 60_000);
            timer.unref?.();
          }
          return;
        }
        const delivery = send(target, text);
        if (channel === 'stream:message' && route.runId) streamedRuns.set(route.runId, delivery);
        delivery.catch(() => {});
      });
      connect();
      return { notifyChannel };
    },
    stop() {
      stopped = true;
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
      try { socket?.close(); } catch {}
    },
    notifyChannel: () => notifyChannel,
    identity: () => ({ ...identity, ...gateway }),
  };
}

module.exports = { createDiscordBridge, createDiscordSender, INTENTS };
