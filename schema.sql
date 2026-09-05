-- email-tester · esquema (Fase 2)
-- Pégalo en Supabase → SQL Editor → Run. Es idempotente: se puede correr de nuevo.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Usuarios: se dan de alta solos en el primer login con Google.
-- El control de acceso lo sigue haciendo ALLOWED_EMAILS; esta tabla es
-- identidad y auditoría, no autorización.
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  google_sub    text not null unique,
  email         text not null,
  name          text,
  picture       text,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);

create index if not exists users_email_idx on public.users (lower(email));

-- ---------------------------------------------------------------------------
-- Lista de acceso editable desde el panel de admin.
-- `entry` es un correo exacto ('ana@gmail.com') o un dominio entero
-- ('@mensaperu.org'), siempre en minúsculas.
--
-- Los admins NO viven aquí: salen de la env var ADMIN_EMAILS. Si vivieran en
-- la base, un borrado accidental te dejaría fuera de tu propia app sin forma
-- de volver a entrar.
-- ---------------------------------------------------------------------------
create table if not exists public.allowed_emails (
  id         uuid primary key default gen_random_uuid(),
  entry      text not null unique,
  note       text,
  added_by   text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Cuentas de Gmail conectadas (se llena en la Fase 3).
-- refresh_token_enc es el string `v1.salt.iv.tag.ct` de crypto-box.js, NUNCA
-- el token en claro. Va como text, no bytea: se debuggea mejor y el formato
-- ya lleva versión para poder rotar la clave maestra.
-- ---------------------------------------------------------------------------
create table if not exists public.gmail_accounts (
  user_id            uuid primary key references public.users(id) on delete cascade,
  email              text not null,
  refresh_token_enc  text not null,
  scopes             text,
  connected_at       timestamptz not null default now(),
  revoked_at         timestamptz
);

-- ---------------------------------------------------------------------------
-- Campañas y destinatarios (se llenan en la Fase 4).
-- `html` guarda el boletín entero; suelen ser decenas de KB, sin problema
-- para Postgres. El límite real lo pone express.json({ limit: '10mb' }).
-- ---------------------------------------------------------------------------
create table if not exists public.campaigns (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  subject    text not null,
  html       text not null,
  sender     text not null default 'smtp' check (sender in ('gmail', 'smtp')),
  from_email text,
  status     text not null default 'pending'
             check (status in ('pending', 'sending', 'done', 'failed', 'quota_exceeded')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.campaigns add column if not exists sender text not null default 'smtp';

create index if not exists campaigns_user_idx on public.campaigns (user_id, created_at desc);

-- `sending` = fila reclamada por un lote en curso. Evita que dos peticiones
-- simultáneas manden el mismo correo dos veces.
create table if not exists public.recipients (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  email       text not null,
  status      text not null default 'pending'
              check (status in ('pending', 'sending', 'sent', 'failed')),
  error       text,
  message_id  text,
  claimed_at  timestamptz,
  sent_at     timestamptz
);

-- Migración para bases creadas antes de la Fase 4.
alter table public.recipients add column if not exists claimed_at timestamptz;
do $$ begin
  alter table public.recipients drop constraint if exists recipients_status_check;
  alter table public.recipients add constraint recipients_status_check
    check (status in ('pending', 'sending', 'sent', 'failed'));
end $$;

-- El worker pide "los siguientes N pending de esta campaña".
create index if not exists recipients_pending_idx
  on public.recipients (campaign_id, status)
  where status in ('pending', 'sending');

-- ---------------------------------------------------------------------------
-- Cuota diaria (Fase 4). El día va en UTC, igual que los contadores de Gmail.
--
-- Se separa por remitente porque son dos límites distintos:
--   'gmail' → la cuota de la cuenta de cada usuario (~500/día). Por usuario.
--   'smtp'  → una sola bandeja compartida por todos. Se suma en global.
-- ---------------------------------------------------------------------------
create table if not exists public.quota_usage (
  user_id uuid not null references public.users(id) on delete cascade,
  day     date not null,
  sender  text not null default 'gmail' check (sender in ('gmail', 'smtp')),
  sent    integer not null default 0,
  primary key (user_id, day, sender)
);

-- Migración para bases creadas en la Fase 2, cuando la PK era (user_id, day)
-- y no existía la columna `sender`.
do $$ begin
  alter table public.quota_usage add column if not exists sender text not null default 'gmail';

  if (select count(*) from information_schema.key_column_usage
      where table_schema = 'public' and constraint_name = 'quota_usage_pkey') = 2 then
    alter table public.quota_usage drop constraint quota_usage_pkey;
    alter table public.quota_usage add primary key (user_id, day, sender);
  end if;

  alter table public.quota_usage drop constraint if exists quota_usage_sender_check;
  alter table public.quota_usage add constraint quota_usage_sender_check
    check (sender in ('gmail', 'smtp'));
end $$;

create index if not exists quota_usage_day_sender_idx on public.quota_usage (day, sender);

-- ---------------------------------------------------------------------------
-- RLS activado y SIN políticas: eso deniega todo a los roles `anon` y
-- `authenticated`. El servidor entra con la service role key, que salta RLS
-- por diseño. Así, si algún día se filtra la anon key (que es pública), no
-- da acceso a nada.
-- ---------------------------------------------------------------------------
alter table public.users          enable row level security;
alter table public.allowed_emails enable row level security;
alter table public.gmail_accounts enable row level security;
alter table public.campaigns      enable row level security;
alter table public.recipients     enable row level security;
alter table public.quota_usage    enable row level security;
