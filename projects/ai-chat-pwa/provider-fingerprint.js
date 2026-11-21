// Fingerprint konfigurasi provider: dipakai untuk mengetahui apakah provider
// sudah dites dengan nilai yang sama persis seperti sekarang.
// Diekstrak dari app.js agar dapat diuji tanpa DOM.

export function providerFingerprint(provider, proxyUrl) {
  return JSON.stringify([proxyUrl, provider.apiBase, provider.apiKey, provider.models]);
}

export function rebuildTestFingerprints(providers, proxyUrl) {
  return new Map(
    (providers || [])
      .filter(provider => provider.tested)
      .map(provider => [provider.id, providerFingerprint(provider, proxyUrl)])
  );
}
