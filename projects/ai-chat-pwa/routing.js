export function inferTier(text, selectedTier = 'auto') {
  if (selectedTier !== 'auto') return selectedTier;
  const prompt = text.toLowerCase();
  if (
    text.length > 500 ||
    /\b(debug|refactor|architecture|compare|analyze|analisis|bandingkan|strategi|langkah demi langkah|buktikan|review|audit|kode|code)\b/.test(prompt)
  ) return 'deep';
  if (text.length < 100 && !/[?？]/.test(text)) return 'fast';
  return 'balanced';
}

function allCandidates(providers) {
  return providers.flatMap(provider =>
    (Array.isArray(provider.models) ? provider.models : [])
      .filter(model => typeof model.id === 'string' && model.id.trim())
      .map(model => ({ provider, model }))
  );
}

export function chooseModel(providers, text, selectedTier = 'auto', selectedModel = null) {
  return chooseModelCandidates(providers, text, selectedTier, selectedModel, 1)[0];
}

export function chooseModelCandidates(providers, text, selectedTier = 'auto', selectedModel = null, limit = 4) {
  const candidates = allCandidates(providers);
  if (!candidates.length) throw new Error('Belum ada model yang dapat dipakai. Periksa pengaturan provider.');
  if (selectedModel) {
    const manual = candidates.find(({ provider, model }) =>
      provider.id === selectedModel.providerId && model.id === selectedModel.modelId
    );
    if (!manual) throw new Error('Model yang dipilih tidak lagi tersedia. Pilih Auto atau perbarui pengaturan provider.');
    const sameModelElsewhere = candidates.filter(({ provider, model }) =>
      model.id === selectedModel.modelId && provider.id !== selectedModel.providerId
    );
    return [{ ...manual, tier: 'manual' }, ...sameModelElsewhere.map(item => ({ ...item, tier: 'manual' }))]
      .slice(0, Math.max(1, limit));
  }

  const tier = inferTier(text, selectedTier);
  const tierRank = candidate => {
    const tiers = candidate.model.tiers || [];
    if (tiers.includes(tier)) return 0;
    if (tiers.includes('default')) return 1;
    if (tier !== 'balanced' && tiers.includes('balanced')) return 2;
    if (tier === 'deep' && tiers.includes('fast')) return 4;
    return 3;
  };
  const seen = new Set();
  return candidates
    .map((candidate, index) => ({ candidate, index, rank: tierRank(candidate) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ candidate }) => ({ ...candidate, tier }))
    .filter(candidate => {
      const key = `${candidate.provider.id}\u0000${candidate.model.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, limit));
}
