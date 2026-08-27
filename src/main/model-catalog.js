function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function groupFromId(id, fallback = 'Models') {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : fallback;
}

function openAIGroup(id, owner) {
  const fallback = !owner || owner.toLowerCase() === 'system' ? 'OpenAI' : owner;
  return groupFromId(id, fallback);
}

function normalizeOpenAIModels(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  return entries
    .map((entry) => {
      const id = String(entry?.id || '').trim();
      if (!id) return null;
      const inputPrice = finiteNumber(entry?.pricing?.prompt);
      const outputPrice = finiteNumber(entry?.pricing?.completion);
      const owner = String(entry?.owned_by || '').trim();
      return {
        id,
        name: String(entry?.name || id).trim() || id,
        group: openAIGroup(id, owner),
        contextLength: finiteNumber(entry?.context_length),
        inputPricePerMillion: inputPrice === null ? null : inputPrice * 1_000_000,
        outputPricePerMillion: outputPrice === null ? null : outputPrice * 1_000_000,
        modalities: Array.isArray(entry?.architecture?.input_modalities)
          ? entry.architecture.input_modalities.map(String)
          : [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeOllamaModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((entry) => {
      const id = String(entry?.name || entry?.model || '').trim();
      if (!id) return null;
      return {
        id,
        name: id,
        group: 'Local',
        contextLength: null,
        inputPricePerMillion: 0,
        outputPricePerMillion: 0,
        modalities: [],
        sizeBytes: finiteNumber(entry?.size),
        parameterSize: String(entry?.details?.parameter_size || '').trim(),
        quantization: String(entry?.details?.quantization_level || '').trim(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = {
  groupFromId,
  normalizeOpenAIModels,
  normalizeOllamaModels,
};
