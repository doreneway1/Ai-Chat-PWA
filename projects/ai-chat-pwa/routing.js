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

export function chooseModel(providers, text, selectedTier = 'auto', selectedModel = null) {
  const candidates = providers.flatMap(provider =>
    (Array.isArray(provider.models) ? provider.models : [])
      .filter(model => typeof model.id === 'string' && model.id.trim())
      .map(model => ({ provider, model }))
  );
  if (!candidates.length) throw new Error('Belum ada model yang dapat dipakai. Periksa pengaturan provider.');
  if (selectedModel) {
    const manual = candidates.find(({ provider, model }) =>
      provider.id === selectedModel.providerId && model.id === selectedModel.modelId
    );
    if (!manual) throw new Error('Model yang dipilih tidak lagi tersedia. Pilih Auto atau perbarui pengaturan provider.');
    return { ...manual, tier: 'manual' };
  }
  const tier = inferTier(text, selectedTier);
  const selected = candidates.find(({ model }) => model.tiers?.includes(tier)) ||
    candidates.find(({ model }) => model.tiers?.includes('default')) ||
    candidates.find(({ model }) => model.tiers?.includes('balanced')) ||
    candidates[0];
  return { ...selected, tier };
}
