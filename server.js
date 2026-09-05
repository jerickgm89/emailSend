// Servidor local. En Vercel el entrypoint es api/index.js (sin listen).
import app from './app.js';
import { authConfigured } from './auth.js';
import { dbEnabled } from './db.js';
import { encryptionConfigured } from './crypto-box.js';

const PORT = process.env.PORT || 3300;

app.listen(PORT, () => {
  console.log(`✉️  Email tester corriendo en http://localhost:${PORT}`);

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('⚠️  Falta configurar SMTP_USER y SMTP_PASS (copia .env.example a .env).');
  }
  if (!authConfigured()) {
    console.log('⚠️  Login sin configurar: faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o SESSION_SECRET.');
  } else if (!process.env.ADMIN_EMAILS && !process.env.ALLOWED_EMAILS) {
    console.log('⚠️  ADMIN_EMAILS y ALLOWED_EMAILS vacíos: nadie podrá iniciar sesión (fail-closed).');
  } else if (!process.env.ADMIN_EMAILS) {
    console.log('ℹ️  Sin ADMIN_EMAILS nadie ve el panel de accesos (/admin.html).');
  }
  if (!dbEnabled()) {
    console.log('ℹ️  Sin Supabase: la sesión funciona, pero no se persiste nada. Obligatorio desde la Fase 3.');
  } else if (!encryptionConfigured()) {
    console.log('⚠️  Supabase configurado pero falta TOKEN_ENC_KEY: no se podrán guardar tokens de Gmail.');
  }
});
