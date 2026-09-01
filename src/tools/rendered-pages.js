'use strict';

// Images a tool produced, waiting for the agent loop to put them in front of
// the model.
//
// A tool result is a string, and that is not an implementation detail we can
// route around: neither Ollama's tool messages nor OpenAI's accept image
// content, so there is no shape in which `pdf_render` could hand pages back
// through its own return value. What both providers do accept is images on a
// user message.
//
// So the tool renders, leaves the pages here, and returns a line of text
// describing them. The loop pushes the tool result as normal and then pushes
// one user message carrying the images. The model sees what it asked for, and
// the two providers' rules are both respected.
//
// Nothing is queued if the model cannot see — rendering pages for a text-only
// model spends a context window to no purpose, and the tool says so instead.

let pending = [];

function queue({ images, imageTypes, note }) {
  if (!Array.isArray(images) || !images.length) return;
  pending.push({
    images,
    imageTypes: Array.isArray(imageTypes) ? imageTypes : images.map(() => 'image/png'),
    note: String(note || ''),
  });
}

// Drained by the loop, which owns deciding where they go. Draining clears, so
// a page is never shown twice: the copy in the conversation is the record.
function take() {
  const batches = pending;
  pending = [];
  return batches;
}

function clear() {
  pending = [];
}

module.exports = { queue, take, clear };
