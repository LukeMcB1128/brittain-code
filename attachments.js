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

async function extractPdfText(buffer) {
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('does not appear to be a valid PDF');
  const { extractText } = await import('unpdf');
  const result = await extractText(new Uint8Array(buffer), { mergePages: false });
  const pages = Array.isArray(result.text) ? result.text : [result.text];
  const text = pages
    .map((pageText, index) => `[Page ${index + 1}]\n${normalizeText(pageText)}`)
    .join('\n\n')
    .trim();
  if (!text.replace(/\[Page \d+\]/g, '').trim()) {
    throw new Error('contains no selectable text; scanned PDFs need OCR, which is not supported yet');
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
    try {
      if (type === 'application/pdf' || extensionFor(name) === '.pdf') {
        kind = 'pdf';
        ({ text, pages } = await extractPdfText(buffer));
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
  MAX_ATTACHMENT_FILES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TEXT_CHARS,
  isSupportedTextFile,
  extractFileAttachments,
  validateImageAttachments,
};
