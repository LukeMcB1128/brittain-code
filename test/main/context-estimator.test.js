const test = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateContextTokens,
  imageDimensions,
  imageTokens,
  textTokens,
} = require('../../src/main/context-estimator');

function png(width, height, padding = 0) {
  const bytes = Buffer.alloc(24 + padding);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

test('image dimensions are read from a PNG header', () => {
  assert.deepEqual(imageDimensions(png(1920, 1080)), { width: 1920, height: 1080 });
});

test('base64 bytes are not counted as text tokens', () => {
  const image = png(1920, 1080, 600_000);
  const message = { role: 'user', content: 'inspect this', images: [image] };
  assert.ok(textTokens(message) > 200_000);
  assert.ok(estimateContextTokens(message, { model: 'gemma3:27b' }) < 400);
});

test('image estimates use the selected model family', () => {
  const image = png(1920, 1080);
  assert.equal(imageTokens(image, 'gemma3:27b'), 256);
  assert.equal(imageTokens(image, 'llava:13b'), 576);
  assert.equal(imageTokens(image, 'qwen2.5vl:32b'), Math.ceil(1920 / 28) * Math.ceil(1080 / 28));
});

test('text-only context keeps the standard estimate', () => {
  const messages = [{ role: 'user', content: 'hello' }];
  assert.equal(estimateContextTokens(messages), textTokens(messages));
});
