// Fase 3: conectar la cuenta de Gmail del usuario y enviar con ella.
//
// OJO: el scope gmail.send es "Restricted" para Google. Con la app en modo
// Testing funciona sin verificación, pero solo para los usuarios de prueba que
// registres (máx. 100) y EL REFRESH TOKEN CADUCA A LOS 7 DÍAS. Cuando eso pasa,
// Google responde `invalid_grant` y aquí se marca la cuenta como revocada para
// que la UI pida reconectar. Salir de ese límite exige verificación + CASA.

import crypto from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { requireAuth } from './auth.js';
import { saveGmailAccount, getGmailAccount, revokeGmailAccount, dbEnabled } from './db.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const CONNECT_COOKIE = 'gmail_tx';

// Gmail permite ~150 envíos/minuto/usuario (15.000 quota units, 100 por envío).
// 400 ms entre envíos deja margen sin acercarse al borde.
const SEND_SPACING_MS = Number(process.env.GMAIL_SEND_SPACING_MS || 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function redirectUri(req) {
  const base =
    process.env.OAUTH_REDIRECT_BASE ||
    `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/auth/gmail/callback`;
}

// --- Access tokens ---------------------------------------------------------

// Los access tokens duran 1 h. Cachearlos evita pedir uno nuevo por destinatario.
// En serverless el caché vive lo que viva la instancia caliente: es un ahorro,
// no algo de lo que dependa la corrección.
const tokenCache = new Map();

export class GmailAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GmailAuthError';
    this.needsReconnect = true;
  }
}

async function getAccessToken(userId) {
  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const account = await getGmailAccount(userId);
  if (!account) throw new GmailAuthError('No hay una cuenta de Gmail conectada.');

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: account.refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // invalid_grant = el usuario revocó el acceso, o caducó el refresh token
    // (los 7 días del modo Testing). No tiene arreglo automático.
    if (data.error === 'invalid_grant') {
      throw await handleRevoked(
        userId,
        'La conexión con Gmail expiró o fue revocada. Vuelve a conectar tu cuenta.'
      );
    }
    throw new Error(`Google rechazó el refresh token: ${data.error_description || data.error || res.status}`);
  }

  tokenCache.set(userId, {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

// --- Envío -----------------------------------------------------------------

async function sendOne({ accessToken, from, to, subject, html }) {
  const raw = await new MailComposer({ from, to, subject, html }).compile().build();

  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: raw.toString('base64url') }),
  });

  if (res.ok) return (await res.json()).id;

  const body = await res.json().catch(() => ({}));
  const msg = body.error?.message || `HTTP ${res.status}`;
  const err = new Error(msg);
  err.status = res.status;
  // 429 y 5xx son transitorios; 403 con "Daily Limit Exceeded" no lo es.
  err.retryable = res.status === 429 || res.status >= 500;
  err.quotaExceeded = res.status === 403 && /limit|quota/i.test(msg);
  throw err;
}

// Un access token cacheado sigue siendo válido hasta 1 h después de que el
// usuario revoque el permiso desde su cuenta de Google, así que el refresh
// nunca se entera. El 401 al enviar es la única señal de que pasó eso.
async function handleRevoked(userId, mensaje) {
  tokenCache.delete(userId);
  await revokeGmailAccount(userId);
  return new GmailAuthError(mensaje);
}

/**
 * Envía una copia individual a cada destinatario, en serie y con espaciado.
 * Devuelve el mismo formato `detail[]` que el camino SMTP.
 */
export async function sendViaGmail({ userId, fromName, recipients, subject, html }) {
  const account = await getGmailAccount(userId);
  if (!account) throw new GmailAuthError('No hay una cuenta de Gmail conectada.');

  const accessToken = await getAccessToken(userId);
  const from = `"${fromName}" <${account.email}>`;
  const detail = [];

  for (const [i, to] of recipients.entries()) {
    if (i > 0) await sleep(SEND_SPACING_MS);

    try {
      const messageId = await sendOne({ accessToken, from, to, subject, html });
      detail.push({ to, ok: true, error: null, messageId });
    } catch (err) {
      if (err.status === 401) {
        throw await handleRevoked(
          userId,
          'Gmail rechazó el permiso de envío. Vuelve a conectar tu cuenta.'
        );
      }

      if (err.retryable) {
        // Un solo reintento: si Gmail sigue diciendo que no, mejor reportarlo
        // que quemarse el tiempo de la función.
        await sleep(2000);
        try {
          const messageId = await sendOne({ accessToken, from, to, subject, html });
          detail.push({ to, ok: true, error: null, messageId });
          continue;
        } catch (retryErr) {
          err.message = retryErr.message;
          err.quotaExceeded = retryErr.quotaExceeded;
        }
      }

      detail.push({ to, ok: false, error: err.message, messageId: null });

      // Si se acabó la cuota diaria, los siguientes van a fallar igual.
      if (err.quotaExceeded) {
        for (const rest of recipients.slice(detail.length)) {
          detail.push({ to: rest, ok: false, error: 'Cuota diaria de Gmail agotada.', messageId: null });
        }
        break;
      }
    }
  }

  return { detail, from: account.email };
}

export async function gmailStatus(userId) {
  if (!dbEnabled() || !userId) return { connected: false, reason: 'no-db' };
  const account = await getGmailAccount(userId);
  return account ? { connected: true, email: account.email } : { connected: false };
}

// --- Rutas -----------------------------------------------------------------

export function mountGmail(app) {
  app.get('/auth/gmail/connect', requireAuth, (req, res) => {
    const back = (msg) => res.redirect('/?gmail_error=' + encodeURIComponent(msg));

    if (!dbEnabled()) {
      return back('Conectar Gmail necesita Supabase configurado (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY).');
    }
    if (!req.user.uid) {
      return back('Tu sesión es anterior a la base de datos. Cierra sesión y vuelve a entrar.');
    }

    const state = crypto.randomBytes(16).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    res.cookie(CONNECT_COOKIE, `${state}.${nonce}`, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL),
      sameSite: 'lax',
      path: '/',
      maxAge: 600_000,
    });

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(req),
      response_type: 'code',
      // openid+email para saber QUÉ cuenta conectó: gmail.send por sí solo no
      // revela la dirección.
      scope: `openid email ${GMAIL_SCOPE}`,
      access_type: 'offline',   // sin esto no llega refresh_token
      prompt: 'consent',        // fuerza que Google reemita el refresh_token
      include_granted_scopes: 'true',
      login_hint: req.user.email,
      state,
      nonce,
    });
    res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
  });

  app.get('/auth/gmail/callback', requireAuth, async (req, res) => {
    const back = (msg) => res.redirect('/?gmail_error=' + encodeURIComponent(msg));

    const [expectedState, expectedNonce] = String(req.cookies?.[CONNECT_COOKIE] || '').split('.');
    res.clearCookie(CONNECT_COOKIE, { path: '/' });

    if (req.query.error) {
      return back(
        req.query.error === 'access_denied'
          ? 'Cancelaste el permiso de envío. Sin él no se puede enviar desde tu Gmail.'
          : `Google devolvió: ${req.query.error}`
      );
    }
    if (!expectedState || req.query.state !== expectedState) {
      return back('Estado OAuth inválido. Vuelve a intentar la conexión.');
    }
    if (!req.query.code) return back('Google no devolvió el código de autorización.');

    try {
      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code),
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri(req),
          grant_type: 'authorization_code',
        }),
      });

      const tokens = await tokenRes.json();
      if (!tokenRes.ok) {
        return back(`No se pudo canjear el código: ${tokens.error_description || tokens.error}`);
      }

      // Google solo manda refresh_token con access_type=offline + prompt=consent.
      if (!tokens.refresh_token) {
        return back('Google no devolvió un refresh token. Revoca el acceso en https://myaccount.google.com/permissions y vuelve a conectar.');
      }
      // El usuario puede desmarcar el permiso de envío en la pantalla de consentimiento.
      if (!String(tokens.scope || '').includes(GMAIL_SCOPE)) {
        return back('No autorizaste el permiso de envío. Marca la casilla de "Enviar correo" al conectar.');
      }

      const { payload } = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      if (payload.nonce !== expectedNonce) return back('Nonce inválido en el id_token.');

      await saveGmailAccount({
        userId: req.user.uid,
        email: payload.email,
        refreshToken: tokens.refresh_token,
        scopes: tokens.scope,
      });
      tokenCache.delete(req.user.uid);

      res.redirect('/?gmail_ok=' + encodeURIComponent(payload.email));
    } catch (err) {
      return back(`Error conectando Gmail: ${err.message}`);
    }
  });

  app.post('/auth/gmail/disconnect', requireAuth, async (req, res) => {
    tokenCache.delete(req.user.uid);
    await revokeGmailAccount(req.user.uid);
    res.json({ ok: true });
  });
}
