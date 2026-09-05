-- =============================================================================
-- 0002_verification_schema.sql
-- Build-a-Bank :: verification upgrade
--
-- Purely ADDITIVE. No table is dropped, no column is removed, no data is
-- deleted. Safe to run more than once.
--
-- Why each change is here:
--
--  1. GRANTS      The baseline tables were created without privileges for the
--                 `service_role`, so every REST call returned
--                 `42501 permission denied`. Nothing worked until this ran.
--
--  2. PROVENANCE  source_file / source_sheet / dataset_as_of / last_imported_at
--                 record where each row came from and which RBI publication it
--                 belongs to (the workbooks are dated "as on June 30, 2026").
--
--  3. IDEMPOTENCY A unique key on (source_file, source_sheet, source_row_number)
--                 lets the importer UPSERT instead of INSERT, so re-running it
--                 updates rows in place rather than duplicating the dataset.
--
--  4. MATCHING    name_core (legal suffixes stripped), cin_normalized,
--                 emails[] and email_domains[] exist because the raw data
--                 cannot be matched against reliably:
--                   - 477 NBFC rows hold several e-mail addresses in one cell
--                   - names carry "Private Limited" noise that wrecks similarity
--                   - CINs contain stray whitespace and one malformed value
--
--  5. SECTIONS    The "Record" sheet stacks TWO tables in one sheet:
--                 "List of NBFCs removed from this list" (CoR restored) and
--                 "List of NBFCs added to the list" (newly cancelled). Their
--                 SR No. counters both restart at 1. Without `section` the two
--                 groups merge into one meaningless block with duplicate SR Nos.
--
--  6. RPCs        pg_trgm's similarity() is not reachable through PostgREST,
--                 so fuzzy name search is exposed as SQL functions.
-- =============================================================================

create extension if not exists pg_trgm;

-- =============================================================================
-- 1. PRIVILEGES
-- =============================================================================
grant usage on schema public to service_role;

grant all privileges on table public.registered_nbfc   to service_role;
grant all privileges on table public.registered_arc    to service_role;
grant all privileges on table public.cancelled_company to service_role;
grant all privileges on table public.cancelled_record  to service_role;

-- Future tables created by the migration owner inherit the same grant.
alter default privileges in schema public
    grant all privileges on tables to service_role;

-- =============================================================================
-- 2. PROVENANCE + MATCHING COLUMNS
-- =============================================================================

-- ---- registered_nbfc --------------------------------------------------------
-- alternate_names captures the parenthetical aliases the RBI embeds in the
-- name cell: 544 rows carry "(Formerly: <old name>)" and 49 carry
-- "(Name as per MCA - <mca name>)". Someone searching the old name deserves
-- to find the company, so those aliases are stored and indexed separately.
alter table public.registered_nbfc
    add column if not exists display_name         text,
    add column if not exists alternate_names      text[] not null default '{}',
    add column if not exists alternate_names_normalized text[] not null default '{}',
    add column if not exists name_core            text,
    add column if not exists cin_normalized       text,
    add column if not exists cin_is_valid         boolean,
    add column if not exists classification_code  text,
    add column if not exists has_factoring_cor    boolean not null default false,
    add column if not exists accepts_public_deposits boolean,
    add column if not exists emails               text[] not null default '{}',
    add column if not exists email_domains        text[] not null default '{}',
    add column if not exists source_file          text,
    add column if not exists source_sheet         text,
    add column if not exists dataset_as_of        date,
    add column if not exists last_imported_at     timestamptz;

-- ---- registered_arc ---------------------------------------------------------
alter table public.registered_arc
    add column if not exists display_name     text,
    add column if not exists alternate_names  text[] not null default '{}',
    add column if not exists alternate_names_normalized text[] not null default '{}',
    add column if not exists name_core        text,
    add column if not exists cin_normalized   text,
    add column if not exists cin_is_valid     boolean,
    add column if not exists emails           text[] not null default '{}',
    add column if not exists email_domains    text[] not null default '{}',
    add column if not exists source_file      text,
    add column if not exists source_sheet     text,
    add column if not exists dataset_as_of    date,
    add column if not exists last_imported_at timestamptz;

-- ---- cancelled_company ------------------------------------------------------
alter table public.cancelled_company
    add column if not exists name_core        text,
    add column if not exists source_file      text,
    add column if not exists source_sheet     text,
    add column if not exists dataset_as_of    date,
    add column if not exists last_imported_at timestamptz;

-- ---- cancelled_record -------------------------------------------------------
-- `section` distinguishes the two stacked tables inside the "Record" sheet.
alter table public.cancelled_record
    add column if not exists company_name_core  text,
    add column if not exists section            text,
    add column if not exists section_title      text,
    add column if not exists cor_issuance_date_raw     text,
    add column if not exists cor_cancellation_date_raw text,
    add column if not exists source_file        text,
    add column if not exists source_sheet       text,
    add column if not exists dataset_as_of      date,
    add column if not exists last_imported_at   timestamptz;

do $do$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'cancelled_record_section_check'
    ) then
        alter table public.cancelled_record
            add constraint cancelled_record_section_check
            check (section is null or section in ('removed_from_list', 'added_to_list'));
    end if;
end
$do$;

-- =============================================================================
-- 3. IDEMPOTENCY KEYS
-- =============================================================================
create unique index if not exists registered_nbfc_source_key
    on public.registered_nbfc (source_file, source_sheet, source_row_number);

create unique index if not exists registered_arc_source_key
    on public.registered_arc (source_file, source_sheet, source_row_number);

create unique index if not exists cancelled_company_source_key
    on public.cancelled_company (source_file, source_sheet, source_row_number);

create unique index if not exists cancelled_record_source_key
    on public.cancelled_record (source_file, source_sheet, source_row_number);

-- =============================================================================
-- 4. LOOKUP INDEXES
-- =============================================================================

-- Exact / normalised name lookups (btree), separate from the trigram indexes.
create index if not exists registered_nbfc_name_norm_idx
    on public.registered_nbfc (name_normalized);
create index if not exists registered_arc_name_norm_idx
    on public.registered_arc (name_normalized);
create index if not exists cancelled_company_name_norm_idx
    on public.cancelled_company (name_normalized);
create index if not exists cancelled_record_name_norm_idx
    on public.cancelled_record (company_name_normalized);

-- Suffix-stripped name (fuzzy): "ABC FINANCE" should match
-- "ABC FINANCE PRIVATE LIMITED".
create index if not exists registered_nbfc_name_core_trgm_idx
    on public.registered_nbfc using gin (name_core gin_trgm_ops);
create index if not exists registered_arc_name_core_trgm_idx
    on public.registered_arc using gin (name_core gin_trgm_ops);
create index if not exists cancelled_company_name_core_trgm_idx
    on public.cancelled_company using gin (name_core gin_trgm_ops);
create index if not exists cancelled_record_name_core_trgm_idx
    on public.cancelled_record using gin (company_name_core gin_trgm_ops);

-- Normalised CIN lookups.
create index if not exists registered_nbfc_cin_norm_idx
    on public.registered_nbfc (cin_normalized);
create index if not exists registered_arc_cin_norm_idx
    on public.registered_arc (cin_normalized);

-- E-mail domain lookups (array containment).
create index if not exists registered_nbfc_email_domains_idx
    on public.registered_nbfc using gin (email_domains);
create index if not exists registered_arc_email_domains_idx
    on public.registered_arc using gin (email_domains);

-- Former / MCA name lookups (array containment).
create index if not exists registered_nbfc_alt_names_idx
    on public.registered_nbfc using gin (alternate_names_normalized);
create index if not exists registered_arc_alt_names_idx
    on public.registered_arc using gin (alternate_names_normalized);

-- =============================================================================
-- 5. IMPORT BOOKKEEPING
-- =============================================================================
create table if not exists public.import_runs (
    id                  uuid primary key default gen_random_uuid(),
    started_at          timestamptz not null default now(),
    finished_at         timestamptz,
    status              text not null default 'running',
    source_file         text not null,
    source_sheet        text not null,
    target_table        text not null,
    dataset_as_of       date,
    dataset_title       text,
    rows_read           integer not null default 0,
    rows_imported       integer not null default 0,
    rows_skipped        integer not null default 0,
    rows_missing_cin    integer not null default 0,
    rows_invalid_cin    integer not null default 0,
    rows_missing_email  integer not null default 0,
    duplicate_keys      integer not null default 0,
    rows_pruned         integer not null default 0,
    error_count         integer not null default 0,
    notes               jsonb not null default '{}'::jsonb,
    constraint import_runs_status_check
        check (status in ('running', 'succeeded', 'failed'))
);

create index if not exists import_runs_started_at_idx
    on public.import_runs (started_at desc);

alter table public.import_runs enable row level security;
grant all privileges on table public.import_runs to service_role;

-- Reference values lifted from "Sheet3" of the registered workbook.
-- Kept for display / documentation only. It is deliberately NOT used to
-- validate imported rows: the live data contains classifications such as
-- HFC, AA, Factor, NOFHC, MGC and IDF that Sheet3 never lists.
create table if not exists public.rbi_reference_value (
    id                uuid primary key default gen_random_uuid(),
    field_group       text not null,
    value             text not null,
    source_file       text not null,
    source_sheet      text not null,
    source_row_number integer not null,
    source_column     integer not null,
    dataset_as_of     date,
    last_imported_at  timestamptz,
    created_at        timestamptz not null default now()
);

create unique index if not exists rbi_reference_value_source_key
    on public.rbi_reference_value (source_file, source_sheet, source_row_number, source_column);

alter table public.rbi_reference_value enable row level security;
grant all privileges on table public.rbi_reference_value to service_role;

-- =============================================================================
-- 6. FUZZY NAME SEARCH RPCs
--
-- pg_trgm's similarity() cannot be reached through PostgREST, so fuzzy name
-- search is exposed as SQL functions instead.
--
-- Each function returns the whole matched row as jsonb alongside its trigram
-- similarity, so adding a column to a table never requires editing these
-- signatures. Similarity is measured against BOTH the full normalised name and
-- the suffix-stripped core name, and the higher of the two wins -- that is what
-- lets "ABC FINANCE" match "ABC FINANCE PRIVATE LIMITED".
--
-- pg_trgm.similarity_threshold is set transaction-locally from min_similarity
-- so that the `%` operator (which is what the GIN index accelerates) agrees
-- with the threshold the caller actually asked for.
-- =============================================================================

drop function if exists public.search_registered_nbfc_by_name(text, text, real, integer);
create function public.search_registered_nbfc_by_name(
    query_normalized text,
    query_core       text,
    min_similarity   real default 0.30,
    max_results      integer default 10
)
returns table (id uuid, similarity real, matched_on text, record jsonb)
language plpgsql
as $fn$
begin
    perform set_config('pg_trgm.similarity_threshold', min_similarity::text, true);

    return query
    select x.id, x.similarity, x.matched_on, x.record
    from (
        select
            t.id,
            greatest(
                similarity(t.name_normalized, query_normalized),
                similarity(coalesce(t.name_core, ''), query_core)
            )::real as similarity,
            case
                when similarity(t.name_normalized, query_normalized)
                     >= similarity(coalesce(t.name_core, ''), query_core)
                then 'full_name' else 'core_name'
            end as matched_on,
            t.name_normalized as sort_name,
            to_jsonb(t) as record
        from public.registered_nbfc t
        where t.name_normalized % query_normalized
           or coalesce(t.name_core, '') % query_core
           or t.name_normalized like '%' || query_normalized || '%'
           or coalesce(t.name_core, '') like '%' || query_core || '%'
    ) x
    where x.similarity >= min_similarity
    order by x.similarity desc, x.sort_name asc
    limit max_results;
end;
$fn$;

drop function if exists public.search_registered_arc_by_name(text, text, real, integer);
create function public.search_registered_arc_by_name(
    query_normalized text,
    query_core       text,
    min_similarity   real default 0.30,
    max_results      integer default 10
)
returns table (id uuid, similarity real, matched_on text, record jsonb)
language plpgsql
as $fn$
begin
    perform set_config('pg_trgm.similarity_threshold', min_similarity::text, true);

    return query
    select x.id, x.similarity, x.matched_on, x.record
    from (
        select
            t.id,
            greatest(
                similarity(t.name_normalized, query_normalized),
                similarity(coalesce(t.name_core, ''), query_core)
            )::real as similarity,
            case
                when similarity(t.name_normalized, query_normalized)
                     >= similarity(coalesce(t.name_core, ''), query_core)
                then 'full_name' else 'core_name'
            end as matched_on,
            t.name_normalized as sort_name,
            to_jsonb(t) as record
        from public.registered_arc t
        where t.name_normalized % query_normalized
           or coalesce(t.name_core, '') % query_core
           or t.name_normalized like '%' || query_normalized || '%'
           or coalesce(t.name_core, '') like '%' || query_core || '%'
    ) x
    where x.similarity >= min_similarity
    order by x.similarity desc, x.sort_name asc
    limit max_results;
end;
$fn$;

drop function if exists public.search_cancelled_company_by_name(text, text, real, integer);
create function public.search_cancelled_company_by_name(
    query_normalized text,
    query_core       text,
    min_similarity   real default 0.30,
    max_results      integer default 10
)
returns table (id uuid, similarity real, matched_on text, record jsonb)
language plpgsql
as $fn$
begin
    perform set_config('pg_trgm.similarity_threshold', min_similarity::text, true);

    return query
    select x.id, x.similarity, x.matched_on, x.record
    from (
        select
            t.id,
            greatest(
                similarity(t.name_normalized, query_normalized),
                similarity(coalesce(t.name_core, ''), query_core)
            )::real as similarity,
            case
                when similarity(t.name_normalized, query_normalized)
                     >= similarity(coalesce(t.name_core, ''), query_core)
                then 'full_name' else 'core_name'
            end as matched_on,
            t.name_normalized as sort_name,
            to_jsonb(t) as record
        from public.cancelled_company t
        where t.name_normalized % query_normalized
           or coalesce(t.name_core, '') % query_core
           or t.name_normalized like '%' || query_normalized || '%'
           or coalesce(t.name_core, '') like '%' || query_core || '%'
    ) x
    where x.similarity >= min_similarity
    order by x.similarity desc, x.sort_name asc
    limit max_results;
end;
$fn$;

drop function if exists public.search_cancelled_record_by_name(text, text, real, integer);
create function public.search_cancelled_record_by_name(
    query_normalized text,
    query_core       text,
    min_similarity   real default 0.30,
    max_results      integer default 10
)
returns table (id uuid, similarity real, matched_on text, record jsonb)
language plpgsql
as $fn$
begin
    perform set_config('pg_trgm.similarity_threshold', min_similarity::text, true);

    return query
    select x.id, x.similarity, x.matched_on, x.record
    from (
        select
            t.id,
            greatest(
                similarity(coalesce(t.company_name_normalized, ''), query_normalized),
                similarity(coalesce(t.company_name_core, ''), query_core)
            )::real as similarity,
            case
                when similarity(coalesce(t.company_name_normalized, ''), query_normalized)
                     >= similarity(coalesce(t.company_name_core, ''), query_core)
                then 'full_name' else 'core_name'
            end as matched_on,
            coalesce(t.company_name_normalized, '') as sort_name,
            to_jsonb(t) as record
        from public.cancelled_record t
        where coalesce(t.company_name_normalized, '') % query_normalized
           or coalesce(t.company_name_core, '') % query_core
           or coalesce(t.company_name_normalized, '') like '%' || query_normalized || '%'
           or coalesce(t.company_name_core, '') like '%' || query_core || '%'
    ) x
    where x.similarity >= min_similarity
    order by x.similarity desc, x.sort_name asc
    limit max_results;
end;
$fn$;

grant execute on function public.search_registered_nbfc_by_name(text, text, real, integer)   to service_role;
grant execute on function public.search_registered_arc_by_name(text, text, real, integer)    to service_role;
grant execute on function public.search_cancelled_company_by_name(text, text, real, integer) to service_role;
grant execute on function public.search_cancelled_record_by_name(text, text, real, integer)  to service_role;

-- =============================================================================
-- 7. SCHEMA VERSION MARKER
-- Lets `npm run db:status` report which migrations the database has seen
-- without needing a direct Postgres connection.
-- =============================================================================
create table if not exists public.schema_migrations (
    version    text primary key,
    applied_at timestamptz not null default now()
);

alter table public.schema_migrations enable row level security;
grant all privileges on table public.schema_migrations to service_role;

insert into public.schema_migrations (version) values ('0001_baseline_schema')
    on conflict (version) do nothing;
insert into public.schema_migrations (version) values ('0002_verification_schema')
    on conflict (version) do nothing;

-- Make PostgREST pick up the new columns and functions immediately.
notify pgrst, 'reload schema';
