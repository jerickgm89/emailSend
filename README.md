# ✉️ Newsletter Email Tester

App web local para probar tus newsletters HTML enviándolas a correos reales
(Gmail, iCloud, Outlook, Hotmail) antes del envío oficial.

## Configuración (solo la primera vez)

1. **Instala dependencias:**
   ```bash
   cd email-tester
   npm install
   ```

2. **Crea tu `.env`:**
   ```bash
   cp .env.example .env
   ```

3. **Consigue una contraseña de aplicación de Gmail:**
   - Ve a https://myaccount.google.com/apppasswords
   - (Necesitas tener la verificación en 2 pasos activada)
   - Crea una contraseña de aplicación llamada "email-tester"
   - Pégala en `SMTP_PASS` del `.env` (sin espacios)

## Uso

```bash
npm start
```

Abre **http://localhost:3300** y:

1. Arrastra tu archivo `.html` (ej. `boletin-julio.html`)
2. Revisa el preview (desktop y móvil)
3. Escribe los correos destino (chips rápidos para @gmail, @icloud, @outlook, @hotmail)
4. Clic en **Enviar test** — cada destinatario recibe su propia copia

## Notas

- El envío se hace por SMTP de Gmail, así que llega a bandejas reales de
  cualquier proveedor. Revisa también la carpeta de spam la primera vez.
- Las imágenes deben estar hosteadas (ej. Cloudinary) — las rutas locales
  no se verán en el correo. Tus boletines ya cumplen esto. ✅
- El `.env` está en `.gitignore`: tu contraseña nunca se sube al repo.
