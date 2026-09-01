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

const fs = require('fs');
const path = require('path');

let attached = [];
let restricted = false;
// Edits accumulate in one file beside the attachment. Without that, every call
// read the untouched original and wrote the same output, so the second edit
// silently erased the first: stamping a seven-page form worked page by page and
// then only the last page survived.
//
// The name is derived, not remembered. A conversation spans many turns and the
// attachment list is rebuilt on each one, so state held here would be lost
// exactly when someone said "now do page 4" — deriving it means the work
// continues from whatever is already on disk.

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

function isWorkingCopy(candidate) {
  const resolved = path.resolve(String(candidate || ''));
  return attached.some((file) => path.resolve(workingCopyFor(file.path)) === resolved);
}

// The file edits are accumulating in for this attachment, created on first
// write. One name for the whole conversation, whatever the operation: a person
// filling in a form wants one filled form back, not a chain of -stamped,
// -filled, -trimmed files they have to reassemble.
function workingCopyFor(source) {
  const extension = path.extname(source);
  return path.join(path.dirname(source), path.basename(source, extension) + '-edited' + (extension || '.pdf'));
}

// Resolve the file a tool was asked to read. Naming the attachment reads the
// working copy once one exists, because that is the current state of the
// document — reading the pristine original would throw away every earlier edit.
function resolveInput(requested, fallback) {
  const matched = match(requested);
  if (matched) {
    // Continue from the edited version when one exists. Reading the pristine
    // original here is what threw away every earlier edit.
    const inProgress = workingCopyFor(matched);
    return fs.existsSync(inProgress) ? inProgress : matched;
  }
  // An output produced this turn is a legitimate input: chaining one edit into
  // the next is the normal way to work through a document.
  if (isWorkingCopy(requested)) return path.resolve(requested);
  if (restricted) {
    throw new Error(`In chat, files can only be worked on if you attached them. ${describeAvailable()}`);
  }
  return fallback(requested);
}

// Where a result is written. A restricted run cannot choose: everything lands
// in the working copy beside the source, which is what makes edits accumulate
// and also means there is no path for a model to aim anywhere else.
function resolveOutput(requested, fallback, source = '') {
  if (restricted) return source ? workingCopyFor(source) : '';
  return requested ? fallback(requested) : '';
}

module.exports = { setAttachedFiles, isRestricted, list, match, describeAvailable, resolveInput, resolveOutput, workingCopyFor, isWorkingCopy };
