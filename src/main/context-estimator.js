'use strict';

const DEFAULT_IMAGE_TOKENS = 1024;

function textTokens(value) {
  return Math.round(JSON.stringify(value).length / 4);
}

function imageDimensions(encoded) {
  try {
    // Image dimensions are in the header. Decode only a bounded prefix so a
    // context refresh does not copy a multi-megabyte attachment.
    const source = String(encoded || '').replace(/^data:image\/[^;]+;base64,/, '');
    const bytes = Buffer.from(source.slice(0, 256 * 1024), 'base64');
    if (bytes.length >= 24 && bytes.subarray(1, 4).toString('ascii') === 'PNG') {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (bytes.length >= 16 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 8 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const marker = bytes[offset + 1];
        if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
        const size = bytes.readUInt16BE(offset + 2);
        if (size < 2) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
        }
        offset += size + 2;
      }
    }
  } catch {}
  return null;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function imageTokens(encoded, model = '') {
  const dimensions = imageDimensions(encoded);
  const name = String(model || '').toLowerCase();

  // These profiles follow the main image grids used by common local vision
  // model families. The estimate is intentionally conservative. It measures
  // vision patches, never the base64 transport bytes.
  if (/qwen[^/]*(?:vl|vision)|(?:vl|vision)[^/]*qwen/.test(name)) {
    if (!dimensions) return 1024;
    return clamp(Math.ceil(dimensions.width / 28) * Math.ceil(dimensions.height / 28), 256, 16_384);
  }
  if (/gemma3|gemma-3/.test(name)) return 256;
  if (/llava|bakllava|moondream/.test(name)) return 576;
  if (/llama[^/]*(?:vision|3\.2)|(?:vision)[^/]*llama/.test(name)) return 1600;

  if (!dimensions) return DEFAULT_IMAGE_TOKENS;
  return clamp(Math.ceil(dimensions.width / 32) * Math.ceil(dimensions.height / 32), 256, 4096);
}

function estimateContextTokens(value, { model = '' } = {}) {
  let visualTokens = 0;
  const serialized = JSON.stringify(value, (key, item) => {
    if (key === 'images' && Array.isArray(item)) {
      visualTokens += item.reduce((sum, image) => sum + imageTokens(image, model), 0);
      return item.map(() => '[image]');
    }
    if (key === 'image_url' && item && typeof item === 'object') {
      const url = String(item.url || '');
      if (url.startsWith('data:image/') && url.includes(';base64,')) {
        visualTokens += imageTokens(url, model);
        return { ...item, url: '[image]' };
      }
    }
    return item;
  });
  return Math.round(serialized.length / 4) + visualTokens;
}

module.exports = {
  DEFAULT_IMAGE_TOKENS,
  estimateContextTokens,
  imageDimensions,
  imageTokens,
  textTokens,
};
