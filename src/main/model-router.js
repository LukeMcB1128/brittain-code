const SAFE_FIT_LEVELS = new Set(['loaded', 'proven', 'good', 'caution', 'unknown']);

function routeReason(model, { mode, needsVision }) {
  const evidence = [];
  if (mode === 'code' && model.capabilities?.tools === true) evidence.push('tool support');
  if (needsVision && model.capabilities?.vision === true) evidence.push('image support');
  if (model.brittainmark?.score != null) evidence.push(`Brittainmark ${model.brittainmark.score}`);
  if (model.speed?.tokensPerSecond) evidence.push(`${model.speed.tokensPerSecond} t/s measured`);
  if (model.fit?.label) evidence.push(model.fit.label.toLowerCase());
  return evidence.length ? evidence.join(', ') : 'best available installed model';
}

function selectAutoModel(models, { mode = 'code', needsVision = false } = {}) {
  const installed = Array.isArray(models)
    ? models.filter((model) => model?.name && model.installed !== false)
    : [];
  if (!installed.length) {
    return { ok: false, error: 'No installed models are available.' };
  }

  let candidates = installed;
  if (needsVision) {
    candidates = candidates.filter((model) => model.capabilities?.vision === true);
    if (!candidates.length) {
      return { ok: false, error: 'No installed model reports image support.' };
    }
  }

  if (mode === 'code') {
    const confirmed = candidates.filter((model) => model.capabilities?.tools === true);
    const possible = candidates.filter((model) => model.capabilities?.tools !== false);
    if (confirmed.length) candidates = confirmed;
    else if (possible.length) candidates = possible;
    else {
      return { ok: false, error: 'No installed model reports tool support for Code mode.' };
    }
  }

  const safe = candidates.filter((model) => SAFE_FIT_LEVELS.has(model.fit?.level));
  if (safe.length) candidates = safe;

  const selected = candidates.find((model) => model.recommended) || candidates[0];
  const warning = selected.fit?.level === 'risk'
    ? 'This is the only compatible choice, but its memory estimate is above the recommended limit.'
    : null;

  return {
    ok: true,
    model: selected.name,
    reason: routeReason(selected, { mode, needsVision }),
    warning,
  };
}

module.exports = { selectAutoModel };
