// Camino de envío por SMTP (la cuenta del sistema, compartida por todos).
// Devuelve el mismo formato `detail[]` que gmail.js para que quien llama no
// tenga que saber por dónde salió el correo.

import nodemailer from 'nodemailer';

export function smtpConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function smtpAddress() {
  return process.env.SMTP_USER || null;
}

function buildTransporter() {
  if (!smtpConfigured()) return null;
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

export async function sendViaSmtp({ fromName, recipients, subject, html }) {
  const transporter = buildTransporter();
  if (!transporter) {
    throw new Error('SMTP no configurado. Define SMTP_USER y SMTP_PASS (ver .env.example).');
  }

  // Un envío por destinatario: si uno rebota, los demás igual llegan,
  // y cada proveedor (Gmail/iCloud/Outlook) recibe su propia copia.
  const results = await Promise.allSettled(
    recipients.map((to) =>
      transporter.sendMail({
        from: `"${fromName}" <${process.env.SMTP_USER}>`,
        to,
        subject,
        html,
      })
    )
  );

  const detail = results.map((r, i) => ({
    to: recipients[i],
    ok: r.status === 'fulfilled',
    error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null,
    messageId: r.status === 'fulfilled' ? r.value.messageId : null,
  }));

  return { detail, from: process.env.SMTP_USER };
}
