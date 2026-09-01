'use strict';

// The files a person attached to this turn, and whether the run may touch
// anything else.
//
// Chat mode has no filesystem. Its whole tool list is ask_user, calculate,
// remember, web_search and web_fetch — it cannot read a file, let alone write
// one, and that is deliberate. But "here is my worksheet, fill it in" is a chat
// request, and answering it means writing a PDF.
//
// So chat is widened by exactly one step: it may act on the files the person
// themselves dropped into the composer, and nowhere else. Not the working
// directory, not a granted root, not a path the model invented — the specific
// documents a human handed it this turn. A model that asks for anything else
// gets an error listing what it actually has.
//
// Code mode does not restrict: it already has write_file and a project to use
// it on, so attachments are simply additional names it can refer to.

const path = require('path');

let attached = [];
let restricted = false;

// `files` is [{ name, path }]. A pasted image or a file dragged from another
// application may have no path — those stay readable-as-context only, since
// there is nothing on disk to write back to.
function setAttachedFiles(files, { restrict = false } = {}) {
  attached = (Array.isArray(files) ? files : [])
    .filter((file) => file && file.path)
    .map((file) => ({ name: String(file.name || path.basename(file.path)), path: String(file.path) }));
  restricted = !!restrict;
}

function isRestricted() {
  return restricted;
}

function list() {
  return attached.map((file) => ({ ...file }));
}

// A model refers to an attachment the way the person did — by the name shown in
// the composer. An absolute path is accepted too, but only if it is one of the
// attached files.
function match(requested) {
  const wanted = String(requested || '').trim();
  if (!wanted) return '';
  const byName = attached.find((file) => file.name === wanted)
    || attached.find((file) => file.name.toLowerCase() === wanted.toLowerCase());
  if (byName) return byName.path;
  const resolved = path.resolve(wanted);
  const byPath = attached.find((file) => path.resolve(file.path) === resolved);
  return byPath ? byPath.path : '';
}

function describeAvailable() {
  if (!attached.length) return 'No files are attached to this conversation. Ask the user to attach one.';
  return `Attached file${attached.length === 1 ? '' : 's'}: ${attached.map((file) => file.name).join(', ')}`;
}

// Resolve the file a tool was asked to read. In a restricted run this is the
// only door: `fallback` is never consulted.
function resolveInput(requested, fallback) {
  const matched = match(requested);
  if (matched) return matched;
  if (restricted) {
    throw new Error(`In chat, files can only be worked on if you attached them. ${describeAvailable()}`);
  }
  return fallback(requested);
}

// Where a result may be written. Restricted runs cannot choose: the output
// lands beside the source under the suffixed default, so there is no path for a
// model to point somewhere else. Passing an empty output makes the caller use
// that default.
function resolveOutput(requested, fallback) {
  if (restricted) return '';
  return requested ? fallback(requested) : '';
}

module.exports = { setAttachedFiles, isRestricted, list, match, describeAvailable, resolveInput, resolveOutput };
