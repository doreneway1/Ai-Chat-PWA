const VAULT_PREFIX = 'vault:v1:';
const PBKDF2_ITERATIONS = 210_000;

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function isVaultCiphertext(value) {
  return typeof value === 'string' && value.startsWith(VAULT_PREFIX);
}

async function deriveVaultKey(pin, salt, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error('Browser ini tidak mendukung WebCrypto.');
  if (typeof pin !== 'string' || pin.length < 6) throw new Error('PIN brankas minimal 6 karakter.');
  const material = await cryptoImpl.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return cryptoImpl.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptSecret(plaintext, pin, cryptoImpl = globalThis.crypto) {
  if (typeof plaintext !== 'string') throw new Error('Secret harus berupa teks.');
  const salt = cryptoImpl.getRandomValues(new Uint8Array(16));
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(pin, salt, cryptoImpl);
  const cipher = await cryptoImpl.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${VAULT_PREFIX}${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipher))}`;
}

export async function decryptSecret(ciphertext, pin, cryptoImpl = globalThis.crypto) {
  if (!isVaultCiphertext(ciphertext)) return ciphertext;
  const [, saltPart, ivPart, cipherPart] = ciphertext.split(':');
  // Prefix memakai vault:v1: sehingga split menghasilkan segmen kosong pertama dari skema versi.
  const parts = ciphertext.slice(VAULT_PREFIX.length).split(':');
  if (parts.length !== 3 || !saltPart || !ivPart || !cipherPart) {
    throw new Error('Format brankas API key tidak valid.');
  }
  try {
    const key = await deriveVaultKey(pin, base64ToBytes(parts[0]), cryptoImpl);
    const plain = await cryptoImpl.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(parts[1]) },
      key,
      base64ToBytes(parts[2])
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('PIN salah atau data brankas rusak.');
  }
}
