const path = require('path');

const MAX_ATTACHMENT_FILES = 6;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_CHARS = 80_000;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cc', '.cpp', '.h',
  '.hpp', '.cs', '.swift', '.kt', '.kts', '.sh', '.bash', '.zsh', '.sql', '.toml',
  '.ini', '.cfg', '.conf', '.log', '.properties', '.env.example',
]);

const TEXT_MIME_TYPES = new Set([
  'application/json', 'application/ld+json', 'application/xml',
  'application/javascript', 'application/x-javascript', 'application/yaml',
  'application/x-yaml', 'application/sql',
]);

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function cleanAttachmentName(value) {
  const raw = path.basename(String(value || 'attachment')).replace(/[\x00-\x1f\x7f]/g, '').trim();
  return (raw || 'attachment').slice(0, 180);
}

function extensionFor(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.env.example')) return '.env.example';
  return path.extname(lower);
}

function isSupportedTextFile(name, mimeType = '') {
  const type = String(mimeType).toLowerCase().split(';')[0].trim();
  return type.startsWith('text/') || TEXT_MIME_TYPES.has(type) || TEXT_EXTENSIONS.has(extensionFor(name));
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    if (swapped.length % 2) return swapped.toString('utf8');
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  const nullCount = sample.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
  if (sample.length && nullCount / sample.length > 0.01) {
    throw new Error('appears to be a binary file rather than readable text');
  }
  return buffer.toString('utf8');
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim();
}

function matchesImageSignature(buffer, type) {
  if (type === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (type === 'image/gif') return buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (type === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

// A scan has no text layer, so there is nothing to extract — but the pages are
// perfectly readable images, and the app already knows how to send images to a
// vision model. Rendering is capped: a long scan at readable resolution will
// eat a context window far faster than the same document as text.
const MAX_RENDERED_PAGES = 8;
const RENDER_SCALE = 2;

async function renderPdfPages(buffer, limit = MAX_RENDERED_PAGES) {
  const [{ renderPageAsImage, getDocumentProxy }, canvas] = await Promise.all([
    import('unpdf'),
    import('@napi-rs/canvas'),
  ]);
  const data = new Uint8Array(buffer);
  const document = await getDocumentProxy(data);
  const total = document.numPages;
  const wanted = Math.min(total, limit);
  const images = [];
  for (let page = 1; page <= wanted; page++) {
    // Re-reading the source per page: unpdf consumes the typed array it is
    // handed, so sharing one across calls renders the first page and then
    // fails on an empty buffer.
    const rendered = await renderPageAsImage(new Uint8Array(buffer), page, {
      scale: RENDER_SCALE,
      canvasImport: () => canvas,
    });
    const png = Buffer.from(rendered);
    if (png.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`page ${page} renders larger than 15 MB; try a lower-resolution scan`);
    }
    images.push(png.toString('base64'));
  }
  return { images, total, rendered: wanted };
}

// Whether an extracted text layer is worth sending to a model.
//
// "Is there any text?" was the wrong question. A PDF with a broken text layer
// extracts plenty of characters — they are just not language. A subset font
// with no ToUnicode map yields private-use glyphs, a mis-declared encoding
// yields replacement characters, and both sail past an emptiness check and
// reach the model as confident nonsense. The pages themselves are perfectly
// readable, so the useful question is whether what came out is legible.
//
// Every test here is language-agnostic: \p{L} covers Chinese and Arabic as
// readily as Latin, and the failure modes being caught are not letters in any
// script. Text that is merely *wrong* — a bad encoding mapping one real letter
// onto another — is indistinguishable from prose at this level and is not
// detected. That is the honest limit of a character-class heuristic.
const GARBLE_TESTS = [
  // Whatever produced this could not decode the bytes at all.
  { name: 'replacement characters', limit: 0.03, match: /\uFFFD/gu },
  // A subset font that shipped no ToUnicode map: the glyphs draw correctly on
  // screen and carry no meaning outside the file.
  { name: 'private-use glyphs', limit: 0.02, match: /[\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu },
  { name: 'control characters', limit: 0.02, match: /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu },
];

function assessText(raw) {
  const text = String(raw || '').replace(/\[Page \d+\]/g, '').trim();
  if (!text) return { usable: false, reason: 'no text layer' };
  // Short extractions are noisy to judge — a cover page of five words can look
  // like anything — so only a real sample is second-guessed.
  if (text.length < 200) return { usable: true };

  const total = [...text].length;
  for (const test of GARBLE_TESTS) {
    const hits = (text.match(test.match) || []).length;
    if (hits / total > test.limit) {
      return { usable: false, reason: `${Math.round((hits / total) * 100)}% ${test.name}` };
    }
  }

  // Anything that is a letter, number, mark, punctuation, symbol or space in
  // any script counts as legible. What is left is the soup.
  const legible = (text.match(/[\p{L}\p{N}\p{M}\p{P}\p{S}\s]/gu) || []).length;
  if (legible / total < 0.6) {
    return { usable: false, reason: `only ${Math.round((legible / total) * 100)}% of characters are readable` };
  }
  return { usable: true };
}

async function extractPdfText(buffer) {
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('does not appear to be a valid PDF');
  const { extractText } = await import('unpdf');
  const result = await extractText(new Uint8Array(buffer), { mergePages: false });
  const pages = Array.isArray(result.text) ? result.text : [result.text];
  const text = pages
    .map((pageText, index) => `[Page ${index + 1}]\n${normalizeText(pageText)}`)
    .join('\n\n')
    .trim();
  const quality = assessText(text);
  if (!quality.usable) {
    let rendering;
    try {
      rendering = await renderPdfPages(buffer);
    } catch (error) {
      // Unreadable text still beats no attachment at all, so a render failure
      // is only fatal when there was nothing to fall back to.
      if (!text.replace(/\[Page \d+\]/g, '').trim()) {
        throw new Error(`contains no selectable text and no pages could be rendered (${error.message})`);
      }
      return {
        text: `[The text layer looks unreadable (${quality.reason}) and the pages could not be rendered`
          + ` as images. What follows may be garbled.]\n\n${text}`,
        pages: Number(result.totalPages) || pages.length,
      };
    }
    const { images, total, rendered } = rendering;
    if (!images.length) throw new Error('contains no selectable text and no pages could be rendered');
    // Say which of the two it was. "No text layer" about a document that
    // plainly has one sends someone looking for the wrong problem.
    const why = quality.reason === 'no text layer' ? 'no text layer' : `unreadable text layer, ${quality.reason}`;
    return {
      scanned: true,
      images,
      pages: total,
      text: `[Scanned document: ${why}. ${rendered} of ${total} page(s) attached as images.`
        + `${rendered < total ? ` Pages ${rendered + 1}-${total} were not rendered.` : ''}]`,
    };
  }
  return { text, pages: Number(result.totalPages) || pages.length };
}

async function extractFileAttachments(files, options = {}) {
  if (!Array.isArray(files) || !files.length) return [];
  if (files.length > MAX_ATTACHMENT_FILES) throw new Error(`Attach at most ${MAX_ATTACHMENT_FILES} files at once.`);

  const totalBudget = Math.max(1, Math.min(
    Number(options.maxTotalChars) || MAX_ATTACHMENT_TEXT_CHARS,
    MAX_ATTACHMENT_TEXT_CHARS * files.length,
  ));
  const perFileBudget = Math.max(1, Math.min(MAX_ATTACHMENT_TEXT_CHARS, Math.floor(totalBudget / files.length)));
  const extracted = [];

  for (const input of files) {
    const name = cleanAttachmentName(input?.name);
    const type = String(input?.type || '').toLowerCase().split(';')[0].trim();
    const encoded = String(input?.data || '');
    if (!encoded) throw new Error(`${name}: file data is missing.`);
    if (encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 16) {
      throw new Error(`${name}: file is larger than 15 MB.`);
    }
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length) throw new Error(`${name}: file is empty.`);
    if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`${name}: file is larger than 15 MB.`);

    let kind;
    let pages;
    let text;
    let scannedImages = [];
    try {
      if (type === 'application/pdf' || extensionFor(name) === '.pdf') {
        kind = 'pdf';
        const pdf = await extractPdfText(buffer);
        ({ text, pages } = pdf);
        if (pdf.scanned) scannedImages = pdf.images;
      } else if (isSupportedTextFile(name, type)) {
        kind = 'text';
        text = normalizeText(decodeText(buffer));
        if (!text) throw new Error('contains no readable text');
      } else {
        throw new Error('unsupported file type');
      }
    } catch (error) {
      throw new Error(`${name}: ${error.message || error}`);
    }

    const originalCharacters = text.length;
    const truncated = originalCharacters > perFileBudget;
    if (truncated) {
      text = text.slice(0, perFileBudget) + `\n\n[Attachment truncated after ${perFileBudget.toLocaleString()} characters]`;
    }
    extracted.push({
      name,
      type: type || (kind === 'pdf' ? 'application/pdf' : 'text/plain'),
      size: buffer.length,
      kind,
      ...(pages ? { pages } : {}),
      ...(scannedImages.length ? { scanned: true, images: scannedImages } : {}),
      text,
      originalCharacters,
      extractedCharacters: Math.min(originalCharacters, perFileBudget),
      truncated,
    });
  }
  return extracted;
}

function validateImageAttachments(images, imageTypes, metadata = []) {
  if (!Array.isArray(images) || !images.length) return { images: [], imageTypes: [], metadata: [] };
  if (images.length > MAX_ATTACHMENT_FILES) throw new Error(`Attach at most ${MAX_ATTACHMENT_FILES} files at once.`);
  const safeImages = [];
  const safeTypes = [];
  const safeMetadata = [];
  for (let index = 0; index < images.length; index++) {
    const type = String(imageTypes?.[index] || '').toLowerCase().split(';')[0].trim();
    const encoded = String(images[index] || '');
    const name = cleanAttachmentName(metadata?.[index]?.name || `image-${index + 1}`);
    if (!IMAGE_MIME_TYPES.has(type)) throw new Error(`${name}: unsupported image type.`);
    if (!encoded || encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 16) {
      throw new Error(`${name}: image is empty or larger than 15 MB.`);
    }
    const buffer = Buffer.from(encoded, 'base64');
    const size = buffer.length;
    if (!size || size > MAX_ATTACHMENT_BYTES) throw new Error(`${name}: image is empty or larger than 15 MB.`);
    if (!matchesImageSignature(buffer, type)) throw new Error(`${name}: file contents do not match the selected image type.`);
    safeImages.push(encoded);
    safeTypes.push(type);
    safeMetadata.push({ name, type, size, kind: 'image' });
  }
  return { images: safeImages, imageTypes: safeTypes, metadata: safeMetadata };
}

module.exports = {
  renderPdfPages,
  MAX_RENDERED_PAGES,
  assessText,
  MAX_ATTACHMENT_FILES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TEXT_CHARS,
  isSupportedTextFile,
  extractFileAttachments,
  validateImageAttachments,
};
