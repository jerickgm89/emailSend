// Fase 1: login con Google usando solo scopes básicos (openid email profile).
// Esos scopes NO son sensibles, así que no requieren verificación de Google.
// El scope gmail.send (Restricted) llega en la Fase 3, con consentimiento aparte.
//
// Todavía no hay base de datos (eso es la Fase 2), así que la identidad vive
// entera dentro de la cookie de sesión firmada. Por eso hace falta ALLOWED_EMAILS:
// sin lista blanca, cualquier persona con una cuenta de Google podría entrar
// y enviar correos con tu Gmail.

import crypto from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { upsertUser, dbEnabled, listAllowedEmails } from './db.js';
import { wrap } from './wrap.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const SESSION_COOKIE = 'session';
const OAUTH_COOKIE = 'oauth_tx';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // segundos

const isProd = () => process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

export function authConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      (process.env.SESSION_SECRET || '').length >= 32
  );
}

function sessionKey() {
  return new TextEncoder().encode(process.env.SESSION_SECRET);
}

// Google exige que el redirect_uri coincida exactamente con uno registrado.
// En producción fíjalo con OAUTH_REDIRECT_BASE; los deploys de preview de
// Vercel tienen URLs aleatorias que nunca van a estar registradas.
function redirectUri(req) {
  const base =
    process.env.OAUTH_REDIRECT_BASE ||
    `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/auth/google/callback`;
}

// --- Quién puede entrar ----------------------------------------------------
//
// La lista efectiva son tres fuentes unidas:
//   1. ADMIN_EMAILS  (env)  — además ven el panel. Van en env var y no en la
//      base a propósito: si un borrado accidental los quitara, te quedarías
//      fuera de tu propia app sin forma de volver a entrar.
//   2. ALLOWED_EMAILS (env) — semilla fija; también es lo único que hay
//      cuando no hay Supabase configurado.
//   3. allowed_emails (base) — lo que se edita desde el panel.

function parseEntries(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Un `entry` es un correo exacto o un dominio entero que empieza con @.
const matches = (entry, addr) => (entry.startsWith('@') ? addr.endsWith(entry) : entry === addr);

export const adminEntries = () => parseEntries(process.env.ADMIN_EMAILS);
export const envEntries = () => parseEntries(process.env.ALLOWED_EMAILS);

export function isAdmin(email) {
  const addr = String(email || '').toLowerCase();
  return adminEntries().some((e) => matches(e, addr));
}

// Consultar la base en cada petición sería una query por request. Se cachea
// 60 s: quitar a alguien del panel tarda como mucho un minuto en surtir efecto
// (o menos, porque el propio panel invalida el caché al escribir).
const ALLOW_TTL_MS = 60_000;
let allowCache = { at: 0, entries: [] };

export function invalidateAllowCache() {
  allowCache = { at: 0, entries: [] };
}

async function dbEntries() {
  if (!dbEnabled()) return [];
  if (allowCache.at && Date.now() - allowCache.at < ALLOW_TTL_MS) return allowCache.entries;
  try {
    const rows = await listAllowedEmails();
    allowCache = { at: Date.now(), entries: rows.map((r) => r.entry.toLowerCase()) };
  } catch {
    // Si la base falla, se sigue con lo último cacheado en vez de dejar a
    // todo el mundo fuera. Los admins entran igual: no dependen de la base.
  }
  return allowCache.entries;
}

/** Sin ninguna de las tres fuentes no entra nadie: fail-closed a propósito. */
async function isAllowed(email) {
  const addr = String(email || '').toLowerCase();
  if (!addr) return false;
  if (isAdmin(addr)) return true;
  if (envEntries().some((e) => matches(e, addr))) return true;
  return (await dbEntries()).some((e) => matches(e, addr));
}

function setCookie(res, name, value, maxAgeSeconds) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: isProd(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  });
}

// `sub` es el id de Google (identidad estable); `uid` es la fila en la tabla
// users, y es la que usa la Fase 3 para guardar el refresh token de Gmail.
// Sin base configurada, uid queda null y la identidad vive solo en la cookie.
async function createSession(res, profile, dbUser) {
  const jwt = await new SignJWT({
    uid: dbUser?.id || null,
    email: profile.email,
    name: profile.name || '',
    picture: profile.picture || '',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(profile.sub)
    .setIssuer('email-tester')
    .setAudience('email-tester')
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(sessionKey());

  setCookie(res, SESSION_COOKIE, jwt, SESSION_MAX_AGE);
}

export async function readSession(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || !authConfigured()) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey(), {
      issuer: 'email-tester',
      audience: 'email-tester',
    });
    // La lista blanca puede haber cambiado después de emitir la cookie.
    if (!(await isAllowed(payload.email))) return null;
    return {
      sub: payload.sub,
      uid: payload.uid || null,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      isAdmin: isAdmin(payload.email),
    };
  } catch {
    return null;
  }
}

export async function requireAuth(req, res, next) {
  if (!authConfigured()) {
    return res.status(503).json({
      error: 'Login con Google sin configurar en el servidor (revisa .env.example).',
    });
  }
  const user = await readSession(req);
  if (!user) return res.status(401).json({ error: 'No autenticado.' });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Solo el admin puede gestionar los accesos.' });
    }
    next();
  });
}

export function mountAuth(app) {
  app.get('/auth/google', (req, res) => {
    if (!authConfigured()) {
      return res.redirect('/?auth_error=' + encodeURIComponent('OAuth sin configurar en el servidor.'));
    }

    const state = crypto.randomBytes(16).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    setCookie(res, OAUTH_COOKIE, `${state}.${nonce}`, 600);

    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(req),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      prompt: 'select_account',
    });
    res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
  });

  app.get('/auth/google/callback', wrap(async (req, res) => {
    const fail = (msg) => res.redirect('/?auth_error=' + encodeURIComponent(msg));

    if (req.query.error) return fail(`Google devolvió: ${req.query.error}`);
    if (!authConfigured()) return fail('OAuth sin configurar en el servidor.');

    const [expectedState, expectedNonce] = String(req.cookies?.[OAUTH_COOKIE] || '').split('.');
    res.clearCookie(OAUTH_COOKIE, { path: '/' });

    if (!expectedState || req.query.state !== expectedState) {
      return fail('Estado OAuth inválido. Vuelve a intentar el login.');
    }
    if (!req.query.code) return fail('Google no devolvió el código de autorización.');

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
      if (!tokenRes.ok || !tokens.id_token) {
        return fail(`No se pudo canjear el código: ${tokens.error_description || tokens.error || tokenRes.status}`);
      }

      const { payload } = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: process.env.GOOGLE_CLIENT_ID,
      });

      if (payload.nonce !== expectedNonce) return fail('Nonce inválido en el id_token.');
      if (!payload.email_verified) return fail('Ese correo de Google no está verificado.');
      if (!(await isAllowed(payload.email))) {
        return fail(`${payload.email} no está en la lista de acceso. Pide al admin que te agregue.`);
      }

      // Si la base falla, el login falla: arrastrar una sesión sin uid deja al
      // usuario sin poder conectar Gmail y sin una causa visible.
      let dbUser = null;
      try {
        dbUser = await upsertUser(payload);
      } catch (err) {
        return fail(`No se pudo registrar tu usuario en la base: ${err.message}`);
      }

      await createSession(res, payload, dbUser);
      res.redirect('/');
    } catch (err) {
      res.status(500);
      return fail(`Error en el login: ${err.message}`);
    }
  }));

  app.post('/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', wrap(async (req, res) => {
    const user = await readSession(req);
    if (!user) {
      return res.status(401).json({ error: 'No autenticado.', authConfigured: authConfigured() });
    }
    res.json({ user, storage: { db: dbEnabled(), persisted: Boolean(user.uid) } });
  }));
}
