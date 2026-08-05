import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3300;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function buildTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || 'true') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// Estado de configuración para que la UI avise si falta el .env
app.get('/api/config', (req, res) => {
  res.json({
    configured: Boolean(process.env.SMTP_USER && process.env.SMTP_PASS),
    from: process.env.SMTP_USER || null,
    fromName: process.env.FROM_NAME || 'Newsletter Test',
    defaultRecipients: process.env.DEFAULT_RECIPIENTS || '',
  });
});

app.post('/api/send', async (req, res) => {
  const { html, subject, recipients, fileName } = req.body || {};

  if (!html || typeof html !== 'string' || !html.trim()) {
    return res.status(400).json({ error: 'No se recibió contenido HTML.' });
  }

  const toList = String(recipients || '')
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);

  const invalid = toList.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (!toList.length) {
    return res.status(400).json({ error: 'Agrega al menos un correo destinatario.' });
  }
  if (invalid.length) {
    return res.status(400).json({ error: `Correos inválidos: ${invalid.join(', ')}` });
  }

  const transporter = buildTransporter();
  if (!transporter) {
    return res.status(500).json({
      error: 'SMTP no configurado. Crea el archivo .env con SMTP_USER y SMTP_PASS (ver .env.example).',
    });
  }

  const finalSubject = (subject && subject.trim()) || `[TEST] ${fileName || 'Newsletter'}`;

  // Un envío por destinatario: si uno rebota, los demás igual llegan,
  // y cada proveedor (Gmail/iCloud/Outlook) recibe su propia copia.
  const results = await Promise.allSettled(
    toList.map((to) =>
      transporter.sendMail({
        from: `"${process.env.FROM_NAME || 'Newsletter Test'}" <${process.env.SMTP_USER}>`,
        to,
        subject: finalSubject,
        html,
      })
    )
  );

  const detail = results.map((r, i) => ({
    to: toList[i],
    ok: r.status === 'fulfilled',
    error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null,
    messageId: r.status === 'fulfilled' ? r.value.messageId : null,
  }));

  const sent = detail.filter((d) => d.ok).length;
  res.status(sent > 0 ? 200 : 502).json({ sent, total: toList.length, detail });
});

app.listen(PORT, () => {
  console.log(`✉️  Email tester corriendo en http://localhost:${PORT}`);
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('⚠️  Falta configurar .env (copia .env.example a .env y completa tus credenciales).');
  }
});
