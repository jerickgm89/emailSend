# Plan: login con Google + envío desde la cuenta Gmail del usuario

> Estado: propuesta. Nada de esto está implementado todavía.
> Contexto previo: en agosto de 2026 la decisión fue **Next.js + Supabase + Resend**.
> Este plan cambia de rumbo (Gmail del usuario en vez de Resend); ver §6.

---

## 1. El bloqueo que hay que decidir primero

Enviar correo con la cuenta Gmail de un usuario requiere el scope
`https://www.googleapis.com/auth/gmail.send`, que Google clasifica como
**Restricted** (el nivel más alto). Eso implica:

| | App en modo **Testing** | App en modo **Production** (verificada) |
|---|---|---|
| Usuarios | máx. **100**, agregados a mano por email | ilimitados |
| Pantalla de login | aviso "app no verificada" | limpia |
| Refresh token | **caduca a los 7 días** → re-login semanal | no caduca |
| Requisitos | ninguno | política de privacidad + ToS publicados, video demo, y **CASA security assessment** por un auditor externo |
| Costo | $0 | cientos a miles de USD/año, semanas de proceso |

**Recomendación:** empezar en **modo Testing**. Si los usuarios son tú y el
equipo de Mensa Perú (<100 personas), funciona perfecto y es gratis. El único
costo real es volver a conectar Gmail cada 7 días, y eso se puede detectar y
avisar en la UI.

El login en sí (saber quién eres) usa scopes `openid email profile`, que **no
son sensibles ni requieren verificación**. Por eso conviene separarlo:

- **Login con Google** → sin fricción, se hace ya.
- **"Conectar mi Gmail"** → consentimiento aparte, incremental, solo para quien
  vaya a enviar.

---

## 2. Los límites de Gmail (esto no lo cambia ninguna arquitectura)

| Límite | Gmail gratuito | Google Workspace |
|---|---|---|
| Mensajes/día | ~500 | ~2.000 |
| Destinatarios externos/día | ~500 | ~2.000 |
| Destinatarios por mensaje | 100 | 100 |
| Rate de la API | 15.000 quota units/min/usuario · `messages.send` = 100 units → **~150 envíos/min** | igual |

Tres palancas para "no pasar el límite", en orden de honestidad:

1. **Repartir en el tiempo** (cola + lotes). Evita el 429 por rate limit.
   *No sube el techo diario.*
2. **Repartir entre las cuentas conectadas** de varios usuarios. Sí sube el
   techo — pero Google puede leerlo como evasión de cuota y suspender cuentas.
   Usar solo si cada persona envía **su propia** lista, no como sharding.
3. **Usar un ESP real (Resend/Brevo) para lo masivo** y Gmail solo para tests
   y envíos chicos. *La única que escala de verdad.*

Además, el ToS de Google prohíbe usar Gmail para correo masivo/marketing, y sin
SPF/DKIM/DMARC alineados a dominio propio ni `List-Unsubscribe` los boletines
caen en spam. **Gmail sirve para probar y para envíos pequeños; no para
reemplazar un ESP.**

---

## 3. Stack propuesto

Mantener **Express + Vercel** (lo que ya funciona) en lugar de reescribir en
Next.js. La app son ~420 líneas; el OAuth cabe en 3 endpoints.

```
Auth      google-auth-library      (code exchange + refresh)
Sesión    jose (JWT) + cookie HttpOnly Secure SameSite=Lax
DB        Supabase Postgres, vía @supabase/supabase-js con service role
          (solo como base de datos; el Auth lo manejamos nosotros porque
           necesitamos el refresh token de Gmail con scope propio)
Envío     fetch directo a gmail.googleapis.com  (no `googleapis`, pesa mucho
          en serverless) + MailComposer de nodemailer para armar el MIME
Cola      Vercel Cron cada minuto, o polling desde el cliente
```

Dependencias nuevas: `google-auth-library`, `jose`, `cookie-parser`,
`@supabase/supabase-js`. `nodemailer` se queda (para el MIME y como fallback SMTP).

---

## 4. Fases

### Fase 1 — Login con Google ✅ HECHA (2026-09-05)

Implementada en [`auth.js`](auth.js). Endpoints: `GET /auth/google`,
`GET /auth/google/callback`, `POST /auth/logout`, `GET /api/me`.
`requireAuth` protege `/api/config` y `/api/send`. `APP_PASSWORD` eliminado.

**Desvío respecto al plan:** se usó **`jose`** en vez de `google-auth-library`.
La librería de Google arrastra `gaxios`, `gcp-metadata` y `gtoken`, y en
serverless eso es cold start de más; lo que se necesita (canje del code y
verificación del `id_token` contra el JWKS) son dos llamadas `fetch` y un
`jwtVerify`. En la Fase 3 el refresh token se resuelve con el mismo POST.

**Adelanto de la Fase 2:** como todavía no hay base de datos, la identidad vive
entera dentro de la cookie de sesión firmada (HS256, `HttpOnly`, `SameSite=Lax`,
7 días). No hay tabla `users` aún.

**`ALLOWED_EMAILS` es lo que sostiene esta fase.** Sin base de datos no hay a
quién dar de alta, así que la lista blanca por env var es el control de acceso:
acepta correos exactos y dominios (`@mensaperu.org`), y **vacío no deja entrar a
nadie** (fail-closed). Sin ella, "login con Google" solo significaría que
cualquier persona del mundo con cuenta de Google puede enviar con tu Gmail.
La lista se revalida en cada request, así que quitar a alguien lo expulsa aunque
tenga cookie vigente.

Verificado: 401 sin cookie en los tres endpoints · `state` falso rechazado ·
correo exacto y dominio entran · correo fuera de lista rechazado ·
sin `ALLOWED_EMAILS` no entra ni un correo válido · sin OAuth configurado la UI
lo dice en vez de mostrar un botón roto.

### Fase 2 — Base de datos + tokens cifrados ✅ HECHA (2026-09-05)

[`schema.sql`](schema.sql) (las 5 tablas), [`db.js`](db.js) (acceso con service
role) y [`crypto-box.js`](crypto-box.js) (AES-256-GCM). El login hace upsert en
`users` y mete el uuid de la fila como claim `uid` de la sesión; `sub` sigue
siendo el id de Google.

**Cifrado, más duro de lo planeado.** Además de HKDF por usuario, cada
ciphertext lleva su propio salt aleatorio y el `user_id` va como **AAD**: mover
una fila de un usuario a otro hace que falle el descifrado en vez de funcionar.
Formato `v1.salt.iv.tag.ciphertext` para poder rotar la clave maestra después.

**Desvío:** `refresh_token_enc` es `text`, no `bytea` — el formato ya lleva
versión, y en texto se debuggea desde el panel de Supabase sin decodificar nada.

**La base es opcional en esta fase**, no obligatoria: sin `SUPABASE_URL` el
login sigue funcionando con la identidad en la cookie (Fase 1) y `/api/me`
devuelve `storage.persisted = false`. Deja de ser opcional en la Fase 3, donde
ya hay refresh tokens que guardar. Pero **si la base está configurada y falla,
el login falla**: arrastrar una sesión sin `uid` dejaría al usuario sin poder
conectar Gmail y sin una causa visible.

Verificado contra un Postgres 16 real (Docker): el esquema corre y es
idempotente · RLS activo con 0 políticas en las 5 tablas · el upsert por
`google_sub` actualiza en vez de duplicar · borrar un usuario limpia en cascada
sus 4 tablas dependientes · el `check` de `status` rechaza valores inválidos.
Y 13 pruebas del cifrado: round-trip · el token en claro no aparece en la salida
· dos cifrados del mismo token difieren · la fila de A no descifra como B ·
alterar ciphertext, tag o salt falla · versión desconocida falla · otra clave
maestra falla · clave de 16 bytes rechazada.

### Fase 3 — Conectar Gmail y enviar ✅ HECHA (2026-09-05)

[`gmail.js`](gmail.js): `GET /auth/gmail/connect`, `GET /auth/gmail/callback`,
`POST /auth/gmail/disconnect`, más `sendViaGmail()`. `/api/send` acepta
`sender: 'smtp' | 'gmail'` y la UI trae el selector **Enviar desde**.

**Añadido sobre el plan:** el scope pedido es `openid email gmail.send`, no solo
`gmail.send`. Con `gmail.send` a secas no hay forma de saber **qué** cuenta
conectó el usuario (`users.getProfile` exige otro scope), y sin eso no se puede
poner el `From` correcto ni mostrárselo. El `id_token` que vuelve lo resuelve.

**Hueco que encontraron las pruebas:** si el usuario revoca el acceso desde su
cuenta de Google, el access token cacheado sigue siendo válido hasta 1 h, así
que el refresh **nunca se entera** y `invalid_grant` no llega. La única señal es
un **401 al enviar**. Ahora ese 401 también revoca la cuenta y pide reconectar,
en vez de reportarse como un fallo suelto de un destinatario.

**Ritmo de envío:** en serie con 400 ms de pausa (`GMAIL_SEND_SPACING_MS`), no
en paralelo como el camino SMTP. Con `MAX_RECIPIENTS_PER_REQUEST=25` eso son
~10 s, dentro del `maxDuration` de 60 s. Mandar 25 llamadas simultáneas a la API
de Gmail es la forma más rápida de comerse un 429.

**Cuota agotada:** un 403 con "Daily Limit Exceeded" corta el bucle y marca los
pendientes con el motivo, en vez de insistir destinatario por destinatario.

Verificado con la API de Google simulada: el refresh token queda cifrado en la
fila · el `From` usa la cuenta conectada · una copia individual por destinatario
· asuntos con acentos codificados en MIME · un 429 se reintenta una vez y sale ·
la cuota agotada corta el bucle · `invalid_grant` y 401 lanzan `GmailAuthError`,
revocan la cuenta y devuelven 409 con `needsReconnect`. Y a nivel HTTP: las
rutas exigen sesión · el consentimiento lleva `access_type=offline`,
`prompt=consent` e `include_granted_scopes=true` · `state` falso rechazado ·
`access_denied` da un mensaje entendible · una sesión de Fase 1 (sin `uid`)
recibe "cierra sesión y vuelve a entrar" en vez de fallar en silencio.

### Fase 4 — Cuotas, cola y lotes ✅ HECHA (2026-09-05)

[`campaigns.js`](campaigns.js) (`POST /api/campaigns`, `POST /api/campaigns/:id/step`,
`GET /api/campaigns/:id`, `GET /api/campaigns/unfinished`) y [`smtp.js`](smtp.js),
extraído para que ambos caminos de envío devuelvan el mismo `detail[]`.

**Decisión de disparador: polling, y no por gusto.** En el plan Hobby de Vercel
los cron jobs corren **una vez al día**, así que Cron no sirve para vaciar una
cola. Queda como mejora si algún día hay plan Pro.

**Lo que compensa la debilidad del polling:** si se cierra la pestaña, la
campaña queda en la base y al volver aparece *"Tienes un envío a medias"* con
botón de reanudar. Lo mismo cuando se agota la cuota o caduca Gmail: la campaña
se pausa, nunca se pierde.

**Cuotas: son dos límites, no uno.** `DAILY_LIMIT_PER_USER` se cuenta por
usuario (es la cuenta de cada quien), pero `SMTP_DAILY_LIMIT` se cuenta **sumando
a todos**, porque la cuenta SMTP es una sola bandeja compartida. Por eso
`quota_usage` lleva ahora una columna `sender` y su PK pasó a
`(user_id, day, sender)` — con la migración incluida en `schema.sql` para las
bases creadas en la Fase 2.

**Concurrencia:** los destinatarios se reclaman marcándolos `sending` con un
update condicionado a `status = 'pending'`. Solo vuelven las filas que esa
llamada logró cambiar, así que dos peticiones simultáneas se reparten el lote en
vez de mandar el mismo correo dos veces. Las filas que quedan colgadas más de
5 min (función muerta a media tanda) se devuelven a `pending`.

**Además:** los correos repetidos en la lista se quitan antes de encolar y se
reportan — son cuota gastada de más y copias duplicadas al mismo buzón.

Verificado con base en memoria: 45 destinatarios salen en 3 lotes de 20 y no en
un request · la cuota rechaza la lista que no cabe y acepta la que sí ·
duplicados quitados ignorando mayúsculas · un usuario no puede leer ni avanzar
la campaña de otro (404) · dos `/step` simultáneos suman exactamente 30 envíos
sin solaparse · quedarse sin cuota a media campaña deja 5 pendientes
reanudables, y al liberarse terminan · un 401 de Gmail devuelve el lote a
`pending` sin marcarlo fallido y deja la campaña pausada · los rebotes
individuales no bloquean al resto y solo se cobra cuota por los que salieron.
La migración del esquema se probó sobre una base con datos de la Fase 2:
conserva los contadores y cambia la PK correctamente.

### Fase 5 — Decisión sobre entregabilidad

Al terminar la Fase 4 tendrás datos reales. Ahí decides:

- **≤100 usuarios, envíos chicos** → quedarse en modo Testing. Fin.
- **Boletines de verdad a cientos de suscriptores** → volver a la decisión de
  agosto: dominio propio + Resend/Brevo + Batch API + `List-Unsubscribe`, y
  dejar Gmail solo para los tests. La Fase 4 (cola, cuotas, progreso) se
  reaprovecha entera; solo cambia el adaptador de envío.
- **Necesitas usuarios externos con su Gmail** → arrancar la verificación de
  Google + CASA. Contar 4–8 semanas.

---

## 5. Variables de entorno nuevas

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
OAUTH_REDIRECT_BASE=https://tu-app.vercel.app
SESSION_SECRET=            # 32+ bytes aleatorios, para firmar el JWT
TOKEN_ENC_KEY=             # 32 bytes en base64, para AES-256-GCM
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
DAILY_LIMIT_PER_USER=450   # margen bajo el tope real de Gmail
CRON_SECRET=               # si usas Vercel Cron
```

## 6. Lo que cambia respecto a la decisión de agosto

| | Agosto 2026 | Este plan |
|---|---|---|
| Framework | Next.js App Router | Express (el que ya existe) |
| Auth | Supabase Auth | OAuth de Google propio (hace falta el refresh token con scope Gmail) |
| Envío | Resend, API key por usuario | Gmail API del usuario |
| Supabase | Auth + DB | solo DB |

El cambio de Resend a Gmail es el de fondo, y trae de vuelta el problema de
entregabilidad que Resend resolvía. Por eso la Fase 5 deja la puerta abierta
para volver: la cola y las cuotas sirven igual para ambos.
