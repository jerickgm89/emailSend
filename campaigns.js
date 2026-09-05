// Fase 4: cola por lotes y cuota diaria.
//
// El problema que resuelve: una función de Vercel tiene tope de duración
// (60 s aquí), y por la API de Gmail cada envío toma ~1 s incluyendo la pausa
// anti rate-limit. Mandar 200 correos en un solo request se corta a la mitad y
// no hay forma de saber quién recibió y quién no.
//
// Solución: la campaña y sus destinatarios se guardan en Postgres, y el envío
// avanza a lotes con `POST /api/campaigns/:id/step`. El cliente llama a /step
// en bucle y pinta el progreso. Cada lote es independiente y reanudable: si se
// cierra la pestaña, la campaña queda a medias y se puede continuar después.
//
// Por qué polling y no Vercel Cron: en el plan Hobby los cron jobs corren como
// mucho UNA VEZ AL DÍA, lo que no sirve para vaciar una cola. Con plan Pro sí
// valdría la pena mover /step a un cron cada minuto.

import { requireAuth } from './auth.js';
import { sendViaGmail, GmailAuthError, gmailStatus } from './gmail.js';
import { sendViaSmtp, smtpConfigured, smtpAddress } from './smtp.js';
import {
  dbEnabled,
  createCampaign,
  getCampaign,
  setCampaignStatus,
  campaignProgress,
  claimRecipients,
  markRecipient,
  releaseRecipients,
  unfinishedCampaigns,
  remainingQuota,
  addQuotaUsage,
} from './db.js';

// 20 destinatarios × ~1 s por envío de Gmail ≈ 20 s, cómodo bajo el
// maxDuration de 60 s de vercel.json.
const BATCH_SIZE = Number(process.env.CAMPAIGN_BATCH_SIZE || 20);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseRecipients(raw) {
  const list = String(raw || '')
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  // Duplicados en la lista = correos repetidos al mismo buzón y cuota gastada
  // de más. Se quitan sin avisar, pero se reportan en la respuesta.
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const e of list) {
    const key = e.toLowerCase();
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    unique.push(e);
  }

  return { list: unique, invalid: unique.filter((e) => !EMAIL_RE.test(e)), duplicates };
}

function requireDb(req, res) {
  if (!dbEnabled() || !req.user.uid) {
    res.status(503).json({
      error: 'Los envíos por lotes necesitan Supabase configurado (ver .env.example).',
    });
    return false;
  }
  return true;
}

export function mountCampaigns(app) {
  // --- Crear la campaña (no envía nada todavía) ---------------------------
  app.post('/api/campaigns', requireAuth, async (req, res) => {
    if (!requireDb(req, res)) return;

    const { html, subject, recipients, fileName, sender } = req.body || {};

    if (!html || typeof html !== 'string' || !html.trim()) {
      return res.status(400).json({ error: 'No se recibió contenido HTML.' });
    }
    if (sender !== 'gmail' && sender !== 'smtp') {
      return res.status(400).json({ error: 'Remitente inválido.' });
    }

    const { list, invalid, duplicates } = parseRecipients(recipients);
    if (!list.length) return res.status(400).json({ error: 'Agrega al menos un correo destinatario.' });
    if (invalid.length) return res.status(400).json({ error: `Correos inválidos: ${invalid.join(', ')}` });

    let fromEmail;
    if (sender === 'gmail') {
      const status = await gmailStatus(req.user.uid);
      if (!status.connected) {
        return res.status(409).json({ error: 'No hay una cuenta de Gmail conectada.', needsReconnect: true });
      }
      fromEmail = status.email;
    } else {
      if (!smtpConfigured()) {
        return res.status(500).json({ error: 'SMTP no configurado en el servidor.' });
      }
      fromEmail = smtpAddress();
    }

    // Se comprueba la cuota antes de crear nada: mejor decir "no entra" que
    // dejar media campaña colgada hasta mañana.
    const quota = await remainingQuota(req.user.uid, sender);
    if (list.length > quota.remaining) {
      return res.status(429).json({
        error:
          `Hoy solo quedan ${quota.remaining} envíos de ${quota.limit} por ` +
          `${sender === 'gmail' ? 'tu cuenta de Gmail' : 'la cuenta del sistema'}, ` +
          `y la lista tiene ${list.length}. La cuota se reinicia a medianoche UTC.`,
        quota,
      });
    }

    const campaign = await createCampaign({
      userId: req.user.uid,
      subject: (subject && subject.trim()) || `[TEST] ${fileName || 'Newsletter'}`,
      html,
      sender,
      fromEmail,
      recipients: list,
    });

    res.status(201).json({ id: campaign.id, total: list.length, from: fromEmail, duplicates, quota });
  });

  // --- Enviar el siguiente lote -------------------------------------------
  app.post('/api/campaigns/:id/step', requireAuth, async (req, res) => {
    if (!requireDb(req, res)) return;

    const campaign = await getCampaign(req.user.uid, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada.' });

    if (campaign.status === 'done' || campaign.status === 'failed') {
      return res.json({ done: true, ...(await campaignProgress(campaign.id)) });
    }

    const quota = await remainingQuota(req.user.uid, campaign.sender);
    if (quota.remaining <= 0) {
      await setCampaignStatus(campaign.id, 'quota_exceeded');
      return res.json({
        done: true,
        quotaExceeded: true,
        error: 'Cuota diaria agotada. Los pendientes siguen guardados: reanuda mañana.',
        quota,
        ...(await campaignProgress(campaign.id)),
      });
    }

    const claimed = await claimRecipients(campaign.id, Math.min(BATCH_SIZE, quota.remaining));
    if (!claimed.length) {
      await setCampaignStatus(campaign.id, 'done');
      return res.json({ done: true, quota, ...(await campaignProgress(campaign.id)) });
    }

    await setCampaignStatus(campaign.id, 'sending');

    let result;
    try {
      const args = {
        fromName: process.env.FROM_NAME || 'Newsletter Test',
        recipients: claimed.map((c) => c.email),
        subject: campaign.subject,
        html: campaign.html,
      };
      result =
        campaign.sender === 'gmail'
          ? await sendViaGmail({ userId: req.user.uid, ...args })
          : await sendViaSmtp(args);
    } catch (err) {
      // No se envió nada del lote: devolver las filas a pending para que el
      // siguiente intento las tome, en vez de darlas por fallidas.
      await releaseRecipients(claimed.map((c) => c.id));

      if (err instanceof GmailAuthError) {
        await setCampaignStatus(campaign.id, 'quota_exceeded'); // pausada, no perdida
        return res.status(409).json({ error: err.message, needsReconnect: true });
      }
      await setCampaignStatus(campaign.id, 'pending');
      return res.status(502).json({ error: `Error enviando el lote: ${err.message}` });
    }

    await Promise.all(
      result.detail.map((d, i) =>
        markRecipient(claimed[i].id, { ok: d.ok, error: d.error, messageId: d.messageId })
      )
    );

    const sentNow = result.detail.filter((d) => d.ok).length;
    await addQuotaUsage(req.user.uid, campaign.sender, sentNow);

    const progress = await campaignProgress(campaign.id);
    const done = progress.pending === 0;
    if (done) await setCampaignStatus(campaign.id, 'done');

    console.log(
      `[campaign ${campaign.id.slice(0, 8)}] ${req.user.email} vía ${campaign.sender}: ` +
        `+${sentNow} (${progress.sent}/${progress.total})`
    );

    res.json({
      done,
      batch: claimed.length,
      quota: await remainingQuota(req.user.uid, campaign.sender),
      ...progress,
    });
  });

  // --- Progreso ------------------------------------------------------------
  app.get('/api/campaigns/unfinished', requireAuth, async (req, res) => {
    if (!dbEnabled() || !req.user.uid) return res.json({ campaigns: [] });
    res.json({ campaigns: await unfinishedCampaigns(req.user.uid) });
  });

  app.get('/api/campaigns/:id', requireAuth, async (req, res) => {
    if (!requireDb(req, res)) return;

    const campaign = await getCampaign(req.user.uid, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada.' });

    res.json({
      id: campaign.id,
      subject: campaign.subject,
      sender: campaign.sender,
      from: campaign.from_email,
      status: campaign.status,
      ...(await campaignProgress(campaign.id)),
    });
  });
}
