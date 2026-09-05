// Acceso a Postgres (Supabase) con la service role key.
//
// Supabase se usa SOLO como base de datos: el login lo maneja auth.js, porque
// en la Fase 3 hace falta el refresh token de Google con nuestro propio scope
// de Gmail, y Supabase Auth no lo entrega de forma utilizable.
//
// La base es opcional en la Fase 2: sin ella el login sigue funcionando con la
// identidad dentro de la cookie (comportamiento de la Fase 1). Deja de serlo en
// la Fase 3, cuando haya refresh tokens que guardar.

import { createClient } from '@supabase/supabase-js';
import { encryptForUser, decryptForUser } from './crypto-box.js';

let client = null;

export function dbEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function db() {
  if (!dbEnabled()) return null;
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

function unwrap(result, contexto) {
  if (result.error) throw new Error(`${contexto}: ${result.error.message}`);
  return result.data;
}

/**
 * Alta o actualización del usuario en su login. Devuelve null si no hay base
 * configurada, y quien llama sigue con la identidad de la cookie.
 */
export async function upsertUser({ sub, email, name, picture }) {
  if (!dbEnabled()) return null;

  const data = unwrap(
    await db()
      .from('users')
      .upsert(
        {
          google_sub: sub,
          email,
          name: name || null,
          picture: picture || null,
          last_login_at: new Date().toISOString(),
        },
        { onConflict: 'google_sub' }
      )
      .select('id, email, name, picture')
      .single(),
    'No se pudo guardar el usuario'
  );

  return data;
}

export async function getUserById(id) {
  if (!dbEnabled() || !id) return null;
  const { data } = await db()
    .from('users')
    .select('id, email, name, picture')
    .eq('id', id)
    .maybeSingle();
  return data || null;
}

// --- Lista de acceso (panel de admin) --------------------------------------

export async function listAllowedEmails() {
  if (!dbEnabled()) return [];
  return unwrap(
    await db()
      .from('allowed_emails')
      .select('id, entry, note, added_by, created_at')
      .order('entry'),
    'No se pudo leer la lista de acceso'
  );
}

export async function addAllowedEmail({ entry, note, addedBy }) {
  const { data, error } = await db()
    .from('allowed_emails')
    .insert({ entry, note: note || null, added_by: addedBy })
    .select('id, entry, note, added_by, created_at')
    .single();

  if (error) {
    if (error.code === '23505') throw new Error(`"${entry}" ya está en la lista.`);
    throw new Error(`No se pudo agregar: ${error.message}`);
  }
  return data;
}

export async function removeAllowedEmail(id) {
  const data = unwrap(
    await db().from('allowed_emails').delete().eq('id', id).select('entry'),
    'No se pudo quitar de la lista'
  );
  return data[0] || null;
}

/** Quién ha entrado alguna vez. La tabla se llena sola en cada login. */
export async function listUsers() {
  if (!dbEnabled()) return [];
  return unwrap(
    await db()
      .from('users')
      .select('id, email, name, picture, created_at, last_login_at')
      .order('last_login_at', { ascending: false })
      .limit(100),
    'No se pudieron leer los usuarios'
  );
}

// --- Cuentas de Gmail (se usan en la Fase 3) -------------------------------

export async function saveGmailAccount({ userId, email, refreshToken, scopes }) {
  if (!dbEnabled()) throw new Error('Conectar Gmail requiere Supabase configurado.');

  unwrap(
    await db().from('gmail_accounts').upsert(
      {
        user_id: userId,
        email,
        refresh_token_enc: encryptForUser(userId, refreshToken),
        scopes: scopes || null,
        connected_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: 'user_id' }
    ),
    'No se pudo guardar la cuenta de Gmail'
  );
}

/** Devuelve `{ email, refreshToken, scopes }` o null si no hay cuenta activa. */
export async function getGmailAccount(userId) {
  if (!dbEnabled() || !userId) return null;

  const { data } = await db()
    .from('gmail_accounts')
    .select('email, refresh_token_enc, scopes, revoked_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (!data || data.revoked_at) return null;

  return {
    email: data.email,
    scopes: data.scopes,
    refreshToken: decryptForUser(userId, data.refresh_token_enc),
  };
}

/**
 * Marca la cuenta como revocada. Se usa cuando Google responde `invalid_grant`
 * — el caso típico de los refresh tokens que caducan a los 7 días con la app
 * en modo Testing.
 */
export async function revokeGmailAccount(userId) {
  if (!dbEnabled() || !userId) return;
  await db()
    .from('gmail_accounts')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId);
}

// --- Campañas (Fase 4) -----------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10); // UTC, como Gmail

export async function createCampaign({ userId, subject, html, sender, fromEmail, recipients }) {
  const campaign = unwrap(
    await db()
      .from('campaigns')
      .insert({ user_id: userId, subject, html, sender, from_email: fromEmail })
      .select('id, subject, status, created_at')
      .single(),
    'No se pudo crear la campaña'
  );

  unwrap(
    await db()
      .from('recipients')
      .insert(recipients.map((email) => ({ campaign_id: campaign.id, email }))),
    'No se pudieron guardar los destinatarios'
  );

  return campaign;
}

export async function getCampaign(userId, campaignId) {
  const { data } = await db()
    .from('campaigns')
    .select('id, subject, html, sender, from_email, status, created_at, finished_at')
    .eq('id', campaignId)
    .eq('user_id', userId) // que un id adivinado no dé acceso a la campaña de otro
    .maybeSingle();
  return data || null;
}

export async function setCampaignStatus(campaignId, status) {
  const finished = ['done', 'failed', 'quota_exceeded'].includes(status);
  await db()
    .from('campaigns')
    .update({ status, finished_at: finished ? new Date().toISOString() : null })
    .eq('id', campaignId);
}

export async function campaignProgress(campaignId) {
  const rows = unwrap(
    await db().from('recipients').select('email, status, error, sent_at').eq('campaign_id', campaignId),
    'No se pudo leer el progreso'
  );

  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    sent: count('sent'),
    failed: count('failed'),
    pending: count('pending') + count('sending'),
    detail: rows.map((r) => ({
      to: r.email,
      ok: r.status === 'sent',
      pending: r.status === 'pending' || r.status === 'sending',
      error: r.error,
    })),
  };
}

/**
 * Reclama hasta `limit` destinatarios pendientes marcándolos `sending`.
 * El update condicionado a `status = 'pending'` es lo que evita que dos
 * peticiones simultáneas manden el mismo correo dos veces: solo vuelven las
 * filas que esta llamada consiguió cambiar.
 */
export async function claimRecipients(campaignId, limit) {
  // Filas que quedaron colgadas porque la función murió a mitad de un lote.
  const stale = new Date(Date.now() - 5 * 60_000).toISOString();
  await db()
    .from('recipients')
    .update({ status: 'pending', claimed_at: null })
    .eq('campaign_id', campaignId)
    .eq('status', 'sending')
    .lt('claimed_at', stale);

  const candidates = unwrap(
    await db()
      .from('recipients')
      .select('id, email')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .order('id')
      .limit(limit),
    'No se pudieron leer los pendientes'
  );

  if (!candidates.length) return [];

  return unwrap(
    await db()
      .from('recipients')
      .update({ status: 'sending', claimed_at: new Date().toISOString() })
      .in('id', candidates.map((c) => c.id))
      .eq('status', 'pending')
      .select('id, email'),
    'No se pudieron reclamar los destinatarios'
  );
}

export async function markRecipient(id, { ok, error, messageId }) {
  await db()
    .from('recipients')
    .update({
      status: ok ? 'sent' : 'failed',
      error: error || null,
      message_id: messageId || null,
      sent_at: ok ? new Date().toISOString() : null,
      claimed_at: null,
    })
    .eq('id', id);
}

/** Devuelve los reclamados a `pending` (p. ej. si se agotó la cuota a media tanda). */
export async function releaseRecipients(ids) {
  if (!ids.length) return;
  await db()
    .from('recipients')
    .update({ status: 'pending', claimed_at: null })
    .in('id', ids)
    .eq('status', 'sending');
}

export async function unfinishedCampaigns(userId) {
  const rows = unwrap(
    await db()
      .from('campaigns')
      .select('id, subject, status, created_at, recipients(status)')
      .eq('user_id', userId)
      .in('status', ['pending', 'sending', 'quota_exceeded'])
      .order('created_at', { ascending: false })
      .limit(5),
    'No se pudieron leer las campañas sin terminar'
  );

  return rows
    .map((c) => ({
      id: c.id,
      subject: c.subject,
      status: c.status,
      createdAt: c.created_at,
      total: c.recipients.length,
      sent: c.recipients.filter((r) => r.status === 'sent').length,
      pending: c.recipients.filter((r) => r.status === 'pending' || r.status === 'sending').length,
    }))
    .filter((c) => c.pending > 0);
}

// --- Cuota diaria ----------------------------------------------------------

/**
 * Cuántos envíos quedan hoy. Para 'gmail' es la cuota de la cuenta del usuario;
 * para 'smtp' es una sola bandeja compartida, así que se suma en global.
 */
export async function remainingQuota(userId, sender) {
  const limit = Number(
    sender === 'smtp'
      ? process.env.SMTP_DAILY_LIMIT || 450
      : process.env.DAILY_LIMIT_PER_USER || 450
  );

  let query = db().from('quota_usage').select('sent').eq('day', today()).eq('sender', sender);
  if (sender !== 'smtp') query = query.eq('user_id', userId);

  const rows = unwrap(await query, 'No se pudo leer la cuota');
  const used = rows.reduce((acc, r) => acc + r.sent, 0);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

export async function addQuotaUsage(userId, sender, n) {
  if (n <= 0) return;
  const day = today();

  const { data: existing } = await db()
    .from('quota_usage')
    .select('sent')
    .eq('user_id', userId)
    .eq('day', day)
    .eq('sender', sender)
    .maybeSingle();

  unwrap(
    await db()
      .from('quota_usage')
      .upsert(
        { user_id: userId, day, sender, sent: (existing?.sent || 0) + n },
        { onConflict: 'user_id,day,sender' }
      ),
    'No se pudo actualizar la cuota'
  );
}
