import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountAuth, requireAuth } from './auth.js';
import { mountGmail, gmailStatus, sendViaGmail, GmailAuthError } from './gmail.js';
import { mountCampaigns, parseRecipients } from './campaigns.js';
import { mountAdmin } from './admin.js';
import { sendViaSmtp, smtpConfigured, smtpAddress } from './smtp.js';
import { dbEnabled } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();

app.set('trust proxy', 1); // Vercel va detrás de proxy: hace falta para req.protocol
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

mountAuth(app);
mountGmail(app);
mountCampaigns(app);
mountAdmin(app);

// Estado de configuración para que la UI avise si falta el .env
app.get('/api/config', requireAuth, async (req, res) => {
  res.json({
    configured: smtpConfigured(),
    from: smtpAddress(),
    fromName: process.env.FROM_NAME || 'Newsletter Test',
    defaultRecipients: process.env.DEFAULT_RECIPIENTS || '',
    gmail: await gmailStatus(req.user.uid),
    // Con base hay cola por lotes; sin ella, solo el envío directo de abajo.
    queue: Boolean(dbEnabled() && req.user.uid),
  });
});


// Envío directo, en una sola petición. Es el camino cuando NO hay Supabase:
// sin base no hay dónde guardar la cola, así que se acota a pocos
// destinatarios para no chocar con el tope de duración de la función.
// Con base configurada la UI usa /api/campaigns, que sí escala.
app.post('/api/send', requireAuth, async (req, res) => {
  const { html, subject, recipients, fileName, sender } = req.body || {};

  if (!html || typeof html !== 'string' || !html.trim()) {
    return res.status(400).json({ error: 'No se recibió contenido HTML.' });
  }

  const { list, invalid } = parseRecipients(recipients);
  if (!list.length) {
    return res.status(400).json({ error: 'Agrega al menos un correo destinatario.' });
  }
  if (invalid.length) {
    return res.status(400).json({ error: `Correos inválidos: ${invalid.join(', ')}` });
  }

  const MAX_PER_REQUEST = Number(process.env.MAX_RECIPIENTS_PER_REQUEST || 25);
  if (list.length > MAX_PER_REQUEST) {
    return res.status(400).json({
      error: `Máximo ${MAX_PER_REQUEST} destinatarios por envío directo (recibidos ${list.length}). ` +
        'Configura Supabase para mandar listas más largas por lotes.',
    });
  }

  const args = {
    fromName: process.env.FROM_NAME || 'Newsletter Test',
    recipients: list,
    subject: (subject && subject.trim()) || `[TEST] ${fileName || 'Newsletter'}`,
    html,
  };

  let result;
  try {
    result =
      sender === 'gmail'
        ? await sendViaGmail({ userId: req.user.uid, ...args })
        : await sendViaSmtp(args);
  } catch (err) {
    // Reconectar es algo que solo puede hacer el usuario: 409 para que la UI
    // muestre el botón en vez de un error genérico.
    if (err instanceof GmailAuthError) {
      return res.status(409).json({ error: err.message, needsReconnect: true });
    }
    return res.status(502).json({ error: `Error enviando: ${err.message}` });
  }

  const sent = result.detail.filter((d) => d.ok).length;
  console.log(`[send] ${req.user.email} vía ${sender === 'gmail' ? 'gmail' : 'smtp'} (${result.from}) → ${sent}/${list.length}`);
  res.status(sent > 0 ? 200 : 502).json({
    sent, total: list.length, detail: result.detail,
    sender: sender === 'gmail' ? 'gmail' : 'smtp', from: result.from,
  });
});

export default app;
