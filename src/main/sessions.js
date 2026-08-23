'use strict';

// Which conversation a run belongs to.
//
// One module-level conversation was right while every run started from the
// window. It stopped being right the moment runs could start anywhere: a
// Discord message, a scheduled trigger and the window all pushed into the same
// history, so a 3am heartbeat reasoned with Tuesday's chat still in scope, and
// a transcript saved under a Discord chat id carried messages that were never
// sent from Discord. Two separate bugs, one cause.
//
// Only one run executes at a time — the run queue guarantees that — so
// conversations are swapped rather than held concurrently. Each entry point
// declares which session it is for; the outgoing one is stashed on the way out
// and restored untouched when something returns to it. That keeps every
// existing use of the conversation variable working while giving each origin
// its own history, ledger and context state.

// A run belongs to the window unless it says otherwise. Defaulting that way
// means anything that forgets to declare an origin behaves exactly as it did
// before, rather than quietly getting a conversation of its own.
function sessionKeyFor(payload = {}) {
  const origin = payload?.origin;
  if (!origin || origin === 'ui') return 'window';
  // The chat id is the identity when there is one: two Discord channels are
  // two conversations, and so are two triggers.
  const chatId = String(payload?.chatId || '').trim();
  return chatId || String(origin);
}

function createSessions(initialKey = 'window') {
  const stored = new Map();
  let active = String(initialKey);

  return {
    active: () => active,
    known: () => [...stored.keys()],

    // Stash `current` under the active key and hand back whatever `key` had.
    // `changed` is false when already there, so callers can skip the swap;
    // `state` is null for a session being entered for the first time, which the
    // caller turns into a fresh, empty conversation.
    switchTo(key, current) {
      const target = String(key || 'window');
      if (target === active) return { changed: false, state: null };
      stored.set(active, current);
      active = target;
      return { changed: true, state: stored.get(target) || null };
    },

    // Read a session's stored state without becoming it. Anything that only
    // needs to look — returning the window's transcript to the renderer while a
    // Discord run is mid-flight — must use this: switching would pull the
    // conversation out from under the running loop.
    peek(key) {
      return stored.get(String(key || '')) || null;
    },

    // Drop a session's stored history — used when a conversation is cleared, so
    // "reset" does not leave the old messages waiting to be restored later.
    forget(key) {
      return stored.delete(String(key || ''));
    },
  };
}

module.exports = { createSessions, sessionKeyFor };
