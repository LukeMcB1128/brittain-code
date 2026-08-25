(function attachAttachmentDrop(global) {
  'use strict';

  function list(value) {
    try { return Array.from(value || []); } catch { return []; }
  }

  function hasFilePayload(transfer) {
    if (!transfer) return false;
    if (transfer.files?.length) return true;
    if (list(transfer.types).includes('Files')) return true;
    return list(transfer.items).some((item) => item?.kind === 'file');
  }

  function filesFromTransfer(transfer) {
    if (!transfer) return [];
    const direct = list(transfer.files).filter(Boolean);
    if (direct.length) return direct;
    return list(transfer.items)
      .filter((item) => item?.kind === 'file' && typeof item.getAsFile === 'function')
      .map((item) => item.getAsFile())
      .filter(Boolean);
  }

  const api = { filesFromTransfer, hasFilePayload };
  global.AttachmentDrop = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
