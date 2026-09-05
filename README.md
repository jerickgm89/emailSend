# ✉️ Newsletter Email Tester

App web para probar tus newsletters HTML enviándolas a correos reales
(Gmail, iCloud, Outlook, Hotmail) antes del envío oficial.

## Estructura

| Archivo | Para qué |
|---|---|
| `app.js` | La app Express (rutas `/api/config` y `/api/send`). No hace `listen`. |
| `auth.js` | Login con Google: OAuth, cookie de sesión y lista blanca. |
| `gmail.js` | Conectar la cuenta de Gmail del usuario y enviar con ella. |
| `smtp.js` | Envío por la cuenta SMTP del sistema. |
| `campaigns.js` | Cola por lotes, cuota diaria y progreso. |
| `admin.js` | Panel de accesos: quién puede iniciar sesión. |
| `db.js` | Acceso a Supabase (usuarios y cuentas de Gmail). |
| `crypto-box.js` | Cifrado AES-256-GCM de los refresh tokens. |
| `schema.sql` | Migración para el SQL Editor de Supabase. |
| `server.js` | Arranque local (`npm start`). |
| `api/index.js` | Entrypoint de Vercel: exporta la misma app como Serverless Function. |
| `vercel.json` | Rewrites de `/api/*` y `maxDuration`. |
| `public/` | La UI. Vercel la sirve como estático. |

## Probar en local

Todo funciona en `localhost` — ni Google ni Supabase necesitan que la app esté
publicada. Son 4 pasos.

### 1. Google Cloud (~10 min, una sola vez)

En [console.cloud.google.com](https://console.cloud.google.com/) crea un
proyecto y luego:

- **APIs & Services → Library** → busca *Gmail API* → **Enable**.
- **OAuth consent screen** → *External* → llena nombre y correo de soporte.
  - En **Scopes**, agrega `.../auth/gmail.send`.
  - En **Test users**, **agrégate a ti mismo**. Sin esto Google te bloquea.
  - Déjalo en modo *Testing*, no lo publiques (ver lo de los 7 días más abajo).
- **Credentials → Create credentials → OAuth client ID → Web application**.
  En *Authorized redirect URIs* pon **las dos**:
  ```
  http://localhost:3300/auth/google/callback
  http://localhost:3300/auth/gmail/callback
  ```

Copia el **Client ID** y el **Client secret**.

### 2. Supabase (~5 min, una sola vez)

Crea un proyecto gratis en [supabase.com](https://supabase.com/) y:

- **SQL Editor** → pega [`schema.sql`](schema.sql) → **Run**.
- **Settings → API** → copia la *Project URL* y la key **service_role**.

> Un Postgres suelto en Docker **no sirve**: la app habla con la API REST de
> Supabase, no con Postgres directamente. Sin Supabase la app arranca igual,
> pero sin panel de accesos, sin cola por lotes y sin conectar tu Gmail.

### 3. El `.env`

```bash
npm install
cp .env.example .env
```

Genera los dos secretos:

```bash
node -e "const c=require('crypto');console.log('SESSION_SECRET='+c.randomBytes(32).toString('base64url'));console.log('TOKEN_ENC_KEY='+c.randomBytes(32).toString('base64'))"
```

Y completa el `.env`:

```ini
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
OAUTH_REDIRECT_BASE=            # ← VACÍA en local, si no el login falla
SESSION_SECRET=...              # del comando de arriba
TOKEN_ENC_KEY=...               # del comando de arriba
ADMIN_EMAILS=tu_correo@gmail.com
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SMTP_USER=                      # opcional, ver abajo
SMTP_PASS=
```

`SMTP_USER`/`SMTP_PASS` son **opcionales**: configuran una cuenta del sistema
compartida, alternativa a que cada quien envíe desde su propio Gmail. Déjalas
vacías si no la quieres. Si sí, `SMTP_PASS` es una **contraseña de aplicación**
de Google (https://myaccount.google.com/apppasswords, requiere verificación en
2 pasos), no la de tu cuenta.

### 4. Arrancar

```bash
npm start
```

Abre **http://localhost:3300**. Los avisos de la consola dicen qué falta.

Al iniciar sesión Google mostrará **"Google no ha verificado esta aplicación"**
— es lo esperado en modo Testing. Entra por *Configuración avanzada → Ir a
(no seguro)*.

### Qué probar

Truco para no llenar bandejas ajenas: Gmail ignora lo que va después de un `+`,
así que `tu_correo+a@gmail.com`, `+b`, `+c`… son direcciones distintas para la
app pero todas caen en tu propia bandeja.

| Probar | Cómo |
|---|---|
| Login y lista de acceso | Entra con tu correo. Prueba con otra cuenta de Google: debe rechazarla. |
| Panel de accesos | Botón **Accesos** → autoriza esa otra cuenta → ahora sí entra. |
| Cola por lotes | `CAMPAIGN_BATCH_SIZE=2` en `.env`, manda a 5 direcciones con `+` y mira la barra avanzar de 2 en 2. |
| Reanudar | Recarga la página a mitad del envío: debe salir *"Tienes un envío a medias"*. |
| Cuota | `DAILY_LIMIT_PER_USER=3` y manda a 5: debe rechazarlo diciendo cuántos quedan. |
| Tu Gmail | **Conectar mi Gmail** → autoriza → envía. El correo queda en tus *Enviados*. |

## Login con Google (obligatorio)

Todos los endpoints `/api/*` exigen sesión. Configúralo así:

1. [Google Cloud Console](https://console.cloud.google.com/) → crea un proyecto.
2. **APIs & Services → OAuth consent screen** → External. Con los scopes
   `openid email profile` **no hace falta verificación de Google**: puedes
   dejar la app en modo Testing y agregarte como usuario de prueba.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized redirect URIs:
   ```
   http://localhost:3300/auth/google/callback
   https://TU-APP.vercel.app/auth/google/callback
   ```
4. Copia el client ID y el secret al `.env`, y genera el secreto de sesión:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
5. Pon tu correo en **`ADMIN_EMAILS`**. Eres admin: entras siempre y eres el
   único que ve el panel de accesos.

**Sin `ADMIN_EMAILS` ni `ALLOWED_EMAILS` no entra nadie.** Es a propósito: la URL
de Vercel es pública y los correos salen con tu cuenta de Gmail, así que
"cualquiera con una cuenta de Google" no puede ser el criterio de acceso.

La sesión es una cookie `HttpOnly` firmada (HS256) que dura 7 días. Al expirar,
la UI vuelve sola al login.

## Panel de accesos (`/admin.html`)

Con Supabase configurado, el admin tiene un botón **Accesos** en la cabecera
para autorizar gente **sin volver a desplegar**: agregar correos exactos
(`ana@gmail.com`) o dominios enteros (`@mensaperu.org`, que autoriza a todos los
de ese dominio), quitarlos, y ver quién ha iniciado sesión y cuándo.

La lista efectiva son tres fuentes unidas:

| Fuente | Editable desde | Para qué |
|---|---|---|
| `ADMIN_EMAILS` (env) | Vercel | Tú. Entras siempre y ves el panel. |
| `ALLOWED_EMAILS` (env) | Vercel | Semilla fija; lo único que hay sin Supabase. |
| Tabla `allowed_emails` | **el panel** | Todo lo demás. |

**Por qué el admin va en env var y no en la base:** si viviera en una tabla, un
borrado accidental te dejaría fuera de tu propia app sin forma de volver a
entrar. La env var es el candado de emergencia — por eso el panel muestra las
entradas de env vars pero no deja quitarlas.

Quitar a alguien tiene efecto **inmediato** si lo haces desde el panel (invalida
el caché al escribir). La lista se cachea 60 s, así que un cambio hecho desde
otra instancia tarda como mucho un minuto. La cookie de 7 días no lo protege:
la autorización se revalida en cada petición.

## Base de datos

Sin Supabase la app arranca y el login funciona (la identidad vive dentro de la
cookie), pero no hay panel de accesos, ni cola por lotes, ni forma de conectar
tu Gmail: los refresh tokens necesitan dónde guardarse. En la práctica, ponla.

1. Crea un proyecto en [Supabase](https://supabase.com/).
2. **SQL Editor** → pega [`schema.sql`](schema.sql) → Run. Es idempotente.
3. **Settings → API** → copia la URL y la **service role key** al `.env`.
4. Genera la clave de cifrado:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   y ponla en `TOKEN_ENC_KEY`.

Los refresh tokens se guardan cifrados con **AES-256-GCM**, con una subclave
derivada por HKDF para cada usuario y el `user_id` como AAD: un ciphertext
copiado de una fila a otra no descifra. La clave maestra vive solo en las env
vars — **si la cambias, todos tienen que reconectar su Gmail**.

Las tablas tienen **RLS activado y cero políticas**, o sea que deniegan todo a
las claves públicas; el servidor entra con la service role key, que salta RLS
por diseño. Esa key nunca debe llegar al navegador.

## Enviar desde tu propio Gmail

El modo normal: **cada usuario autorizado conecta su cuenta y los correos salen
de su bandeja**, con su cuota y quedando en sus *Enviados*.

La cuenta SMTP del sistema (`SMTP_USER`/`SMTP_PASS`) es una **alternativa
opcional**: una sola bandeja compartida por todos. Si dejas esas variables
vacías, la app funciona igual — simplemente desaparece esa opción del selector
*Enviar desde*, y hasta que conectes tu Gmail el botón de enviar te lo dice.

Para conectar tu Gmail, agrega estos redirect URIs al mismo OAuth client:

```
http://localhost:3300/auth/gmail/callback
https://TU-APP.vercel.app/auth/gmail/callback
```

Luego, en Google Cloud, habilita la **Gmail API** en *APIs & Services → Library*
y agrega el scope `.../auth/gmail.send` a la pantalla de consentimiento.

### ⚠️ El límite de los 7 días

`gmail.send` es un scope **Restricted**. Con la app en modo Testing funciona sin
verificación, pero:

- solo para los usuarios de prueba que registres (máx. 100), y
- **el refresh token caduca a los 7 días**.

Cuando caduca, Google responde `invalid_grant`, la app marca la cuenta como
revocada y la UI pide reconectar. Lo mismo pasa si revocas el acceso desde
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).
**Es el comportamiento esperado, no un bug.** Salir de ese límite exige
verificación de Google + un CASA security assessment (ver `PLAN-AUTH.md`).

Cada destinatario recibe su propia copia, enviada en serie con 400 ms de pausa
(`GMAIL_SEND_SPACING_MS`) para no chocar con el límite de ~150 envíos/minuto.

## Deploy en Vercel

```bash
npm i -g vercel
vercel
```

Luego, en **Project → Settings → Environment Variables**, agrega:

| Variable | Valor |
|---|---|
| `SMTP_USER` / `SMTP_PASS` | opcionales (cuenta del sistema compartida) |
| `FROM_NAME` | nombre del remitente |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | del OAuth client |
| `OAUTH_REDIRECT_BASE` | `https://tu-app.vercel.app` (fíjalo: los deploys de preview tienen URLs aleatorias que Google rechaza) |
| `SESSION_SECRET` | 32+ bytes aleatorios |
| `ADMIN_EMAILS` | tu correo (entras siempre + ves el panel) |
| `ALLOWED_EMAILS` | acceso fijo adicional (opcional) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | del proyecto de Supabase |
| `TOKEN_ENC_KEY` | 32 bytes en base64 |
| `DAILY_LIMIT_PER_USER` / `SMTP_DAILY_LIMIT` | `450` por defecto |
| `CAMPAIGN_BATCH_SIZE` | `20` por defecto |
| `MAX_RECIPIENTS_PER_REQUEST` | `25` por defecto |

Después de agregarlas, vuelve a desplegar (`vercel --prod`) para que las tome.

## Listas largas: cola por lotes

Con Supabase configurado, un envío no se hace en una sola petición. Se crea una
**campaña** con sus destinatarios en la base, y el navegador va llamando a
`/api/campaigns/:id/step`, que manda `CAMPAIGN_BATCH_SIZE` (20) por vez. Así
ninguna petición se acerca al tope de duración de la función, y la barra de
progreso avanza lote a lote.

Si cierras la pestaña a mitad, la campaña queda guardada: al volver aparece
**"Tienes un envío a medias"** con un botón para reanudarla. Lo mismo si se
agota la cuota — los pendientes esperan a mañana en vez de perderse.

> **Por qué polling y no Vercel Cron:** en el plan Hobby los cron jobs corren
> como mucho **una vez al día**, lo que no sirve para vaciar una cola. Con plan
> Pro sí valdría la pena mover `/step` a un cron cada minuto, y así el envío no
> dependería de que la pestaña siga abierta.

Sin Supabase la app cae al envío directo de `/api/send`, acotado a
`MAX_RECIPIENTS_PER_REQUEST` (25) por el mismo motivo del timeout.

## Cuotas

Son dos límites distintos y se cuentan por separado:

| | Se cuenta | Variable |
|---|---|---|
| **Tu Gmail** | por usuario | `DAILY_LIMIT_PER_USER` (450) |
| **SMTP del sistema** | sumando a todos los usuarios, porque es **una sola bandeja** | `SMTP_DAILY_LIMIT` (450) |

Antes de crear una campaña se comprueba que la lista quepa en lo que queda del
día; si no, se rechaza indicando cuántos envíos quedan. El contador se reinicia
a **medianoche UTC**, igual que el de Gmail.

Los topes reales de Gmail son ~500/día en cuenta gratuita y ~2.000/día en
Workspace. Los valores por defecto dejan margen para lo que envíes por fuera.

## Notas

- Las imágenes deben estar hosteadas (ej. Cloudinary) — las rutas locales
  no se ven en el correo.
- El `.env` está en `.gitignore`: tus credenciales nunca se suben al repo.
- Revisa spam la primera vez.
