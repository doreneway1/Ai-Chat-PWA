# Orbit AI Chat PWA

Client chat AI statis dengan multi-provider, pemilihan model lokal berdasarkan tingkat tugas, lampiran, dan riwayat perangkat. Aplikasi memakai Cloudflare Worker sebagai relay; tidak memerlukan VPS.

- Aplikasi: https://doreneway1.github.io/Ai-Chat-PWA/
- Panduan setup, privasi, dan pengembangan: [projects/ai-chat-pwa/README.md](./projects/ai-chat-pwa/README.md)
- Source Worker: [projects/ai-chat-pwa/cloudflare/ai-chat-proxy.mjs](./projects/ai-chat-pwa/cloudflare/ai-chat-proxy.mjs)

API key dan riwayat tidak disimpan dalam repo atau bundle. Key disimpan di localStorage browser tanpa enkripsi; chat dan lampiran dikirim melalui Worker ke provider yang dipilih.
