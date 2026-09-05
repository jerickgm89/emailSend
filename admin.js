// Panel de accesos: agregar y quitar quién puede iniciar sesión, sin redeploy.
//
// Solo toca la tabla `allowed_emails`. Las entradas que vienen de env vars
// (ADMIN_EMAILS y ALLOWED_EMAILS) se muestran pero no se pueden borrar desde
// aquí: son el candado de emergencia que evita quedarte fuera de tu propia app.

import { requireAdmin, adminEntries, envEntries, invalidateAllowCache } from './auth.js';
import {
  dbEnabled,
  listAllowedEmails,
  addAllowedEmail,
  removeAllowedEmail,
  listUsers,
} from './db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^@[^\s@]+\.[^\s@]+$/;

/** Devuelve la entrada normalizada, o un mensaje de error. */
export function normalizeEntry(raw) {
  const entry = String(raw || '').trim().toLowerCase();
  if (!entry) return { error: 'Escribe un correo o un dominio.' };
  if (EMAIL_RE.test(entry) || DOMAIN_RE.test(entry)) return { entry };
  return {
    error: entry.includes('@')
      ? `"${entry}" no es un correo ni un dominio válido.`
      : `Para autorizar un dominio entero escríbelo con @ delante: "@${entry}".`,
  };
}

function requireDb(res) {
  if (dbEnabled()) return true;
  res.status(503).json({
    error: 'El panel necesita Supabase configurado. Sin base, la lista solo se edita con ALLOWED_EMAILS.',
  });
  return false;
}

export function mountAdmin(app) {
  app.get('/api/admin/access', requireAdmin, async (req, res) => {
    res.json({
      // Fuentes de solo lectura: se muestran para que no te preguntes por qué
      // alguien entra aunque no esté en la lista editable.
      admins: adminEntries(),
      fromEnv: envEntries(),
      entries: await listAllowedEmails(),
      users: await listUsers(),
      dbEnabled: dbEnabled(),
    });
  });

  app.post('/api/admin/access', requireAdmin, async (req, res) => {
    if (!requireDb(res)) return;

    const { entry, error } = normalizeEntry(req.body?.entry);
    if (error) return res.status(400).json({ error });

    // No es un fallo, pero conviene decirlo: agregarlo no cambiaría nada.
    if ([...adminEntries(), ...envEntries()].includes(entry)) {
      return res.status(400).json({
        error: `"${entry}" ya tiene acceso por variables de entorno. No hace falta agregarlo.`,
      });
    }

    try {
      const row = await addAllowedEmail({
        entry,
        note: String(req.body?.note || '').trim().slice(0, 200) || null,
        addedBy: req.user.email,
      });
      invalidateAllowCache(); // el cambio surte efecto ya, sin esperar los 60 s
      console.log(`[admin] ${req.user.email} autorizó ${entry}`);
      res.status(201).json({ entry: row });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/admin/access/:id', requireAdmin, async (req, res) => {
    if (!requireDb(res)) return;

    const removed = await removeAllowedEmail(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Esa entrada ya no existe.' });

    invalidateAllowCache();
    console.log(`[admin] ${req.user.email} quitó ${removed.entry}`);
    res.json({ ok: true, entry: removed.entry });
  });
}
