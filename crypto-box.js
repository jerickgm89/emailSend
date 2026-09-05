// Cifrado de los refresh tokens de Gmail antes de guardarlos en Postgres.
//
// Modelo de amenaza: si alguien se lleva un dump de la base (backup filtrado,
// service role key expuesta, acceso al panel de Supabase), no debe poder enviar
// correos en nombre de nadie. La clave maestra vive solo en env vars de Vercel,
// nunca en la base.
//
// AES-256-GCM con subclave por usuario derivada por HKDF-SHA256. El user_id va
// también como AAD, así que un ciphertext copiado de la fila de un usuario a la
// de otro falla al descifrar en vez de funcionar.

import crypto from 'node:crypto';

const VERSION = 'v1';
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96 bits, lo recomendado para GCM
const KEY_BYTES = 32;

function masterKey() {
  const raw = process.env.TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error('Falta TOKEN_ENC_KEY (32 bytes en base64). Ver .env.example.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENC_KEY debe ser de 32 bytes en base64 (llegaron ${key.length}). ` +
        'Genérala con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  return key;
}

export function encryptionConfigured() {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

// Una subclave distinta por usuario: comprometer una no compromete las demás.
function deriveKey(userId, salt) {
  const info = Buffer.from(`${VERSION}:gmail-refresh-token:${userId}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', masterKey(), salt, info, KEY_BYTES));
}

const aad = (userId) => Buffer.from(`${VERSION}:${userId}`, 'utf8');
const b64 = (buf) => buf.toString('base64url');

/** Devuelve un string `v1.salt.iv.tag.ciphertext` listo para guardar en una columna text. */
export function encryptForUser(userId, plaintext) {
  if (!userId) throw new Error('encryptForUser requiere un userId.');
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(userId, salt), iv);
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return [VERSION, b64(salt), b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
}

/** Lanza si el ciphertext fue alterado, es de otro usuario, o la clave maestra cambió. */
export function decryptForUser(userId, packed) {
  if (!userId) throw new Error('decryptForUser requiere un userId.');

  const [version, salt, iv, tag, ct] = String(packed || '').split('.');
  if (version !== VERSION || !salt || !iv || !tag || !ct) {
    throw new Error('Token cifrado con formato inválido.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(userId, Buffer.from(salt, 'base64url')),
    Buffer.from(iv, 'base64url')
  );
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ct, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
