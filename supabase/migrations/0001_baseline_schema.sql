-- =============================================================================
-- 0001_baseline_schema.sql
-- Build-a-Bank :: baseline RBI reference schema
--
-- This reproduces the schema that already exists in the project's Supabase
-- database. It is written idempotently so a brand-new Supabase project can be
-- bootstrapped from scratch by running 0001 followed by 0002.
--
-- If your database already has these tables, running this file is a no-op.
-- =============================================================================

create extension if not exists pg_trgm;

-- -----------------------------------------------------------------------------
-- Registered NBFCs  (source: "List of NBFCs" sheet)
-- -----------------------------------------------------------------------------
create table if not exists public.registered_nbfc (
    id                  uuid primary key default gen_random_uuid(),
    source_row_number   integer not null,
    sl_no               integer,
    name                text not null,
    name_normalized     text not null,
    regional_office     text,
    public_deposits     text,
    classification      text,
    cin                 text,
    layer               text,
    address             text,
    email               text,
    created_at          timestamptz not null default now()
);

create index if not exists registered_nbfc_name_trgm_idx
    on public.registered_nbfc using gin (name_normalized gin_trgm_ops);

create index if not exists registered_nbfc_cin_idx
    on public.registered_nbfc (cin);

-- -----------------------------------------------------------------------------
-- Registered ARCs  (source: "ARCs" sheet)
-- -----------------------------------------------------------------------------
create table if not exists public.registered_arc (
    id                  uuid primary key default gen_random_uuid(),
    source_row_number   integer not null,
    sr_no               integer,
    name                text not null,
    name_normalized     text not null,
    regional_office     text,
    cin                 text,
    address             text,
    email               text,
    created_at          timestamptz not null default now()
);

create index if not exists registered_arc_name_trgm_idx
    on public.registered_arc using gin (name_normalized gin_trgm_ops);

create index if not exists registered_arc_cin_idx
    on public.registered_arc (cin);

-- -----------------------------------------------------------------------------
-- Cancelled companies  (source: "Cancelled List" sheet)
-- -----------------------------------------------------------------------------
create table if not exists public.cancelled_company (
    id                  uuid primary key default gen_random_uuid(),
    source_row_number   integer not null,
    sl_no               integer,
    name                text not null,
    name_normalized     text not null,
    regional_office     text,
    address             text,
    created_at          timestamptz not null default now()
);

create index if not exists cancelled_company_name_trgm_idx
    on public.cancelled_company using gin (name_normalized gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- Historical cancellation / restoration records  (source: "Record" sheet)
-- -----------------------------------------------------------------------------
create table if not exists public.cancelled_record (
    id                        uuid primary key default gen_random_uuid(),
    source_row_number         integer not null,
    sr_no                     integer,
    nbfc_code                 text,
    company_name              text,
    company_name_normalized   text,
    regional_office           text,
    category                  text,
    classification            text,
    cor_number                text,
    cor_issuance_date         date,
    cor_cancellation_date     date,
    reason                    text,
    created_at                timestamptz not null default now()
);

create index if not exists cancelled_record_name_trgm_idx
    on public.cancelled_record using gin (company_name_normalized gin_trgm_ops);

create index if not exists cancelled_record_nbfc_code_idx
    on public.cancelled_record (nbfc_code);

-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- RLS is enabled with NO policies on purpose. Every read in this application
-- happens server-side through the Supabase service role, which bypasses RLS.
-- The browser never talks to PostgREST directly, so leaving these tables
-- policy-less keeps the anon / publishable key from reading anything.
-- -----------------------------------------------------------------------------
alter table public.registered_nbfc   enable row level security;
alter table public.registered_arc    enable row level security;
alter table public.cancelled_company enable row level security;
alter table public.cancelled_record  enable row level security;
