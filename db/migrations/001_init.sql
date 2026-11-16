create extension if not exists pgcrypto;

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table api_keys (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  key_hash    text not null unique,          -- sha256 of the key; the key itself is never stored
  prefix      text not null,                 -- first chars, for display only
  created_at  timestamptz not null default now()
);

create table endpoints (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  url          text not null,
  secret       text not null,
  event_types  text[] not null default '{}', -- empty = subscribe to everything
  enabled      boolean not null default true,
  created_at   timestamptz not null default now()
);
create index endpoints_tenant_idx on endpoints (tenant_id) where enabled;

create table events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  type             text not null,
  payload          jsonb not null,
  idempotency_key  text,
  created_at       timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create index events_tenant_created_idx on events (tenant_id, created_at desc);

-- The outbox: one row per (event, endpoint). Written in the same transaction
-- as the event, so an accepted event can never be lost between DB and queue.
create table deliveries (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  event_id         uuid not null references events(id) on delete cascade,
  endpoint_id      uuid not null references endpoints(id) on delete cascade,
  status           text not null default 'pending'
                   check (status in ('pending', 'queued', 'delivering', 'succeeded', 'dead')),
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_status_code int,
  last_error       text,
  last_latency_ms  int,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  delivered_at     timestamptz
);
create index deliveries_due_idx on deliveries (next_attempt_at) where status = 'pending';
create index deliveries_inflight_idx on deliveries (updated_at) where status in ('queued', 'delivering');
create index deliveries_tenant_status_idx on deliveries (tenant_id, status);

create table delivery_attempts (
  id           bigserial primary key,
  delivery_id  uuid not null references deliveries(id) on delete cascade,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  attempt      int not null,
  ok           boolean not null,
  status_code  int,
  error        text,
  latency_ms   int not null,
  created_at   timestamptz not null default now()
);
create index delivery_attempts_delivery_idx on delivery_attempts (delivery_id);
create index delivery_attempts_tenant_created_idx on delivery_attempts (tenant_id, created_at desc);
