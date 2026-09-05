-- =============================================================================
-- 0003_lenderlens_schema.sql
-- LenderLens :: banks, model registry, verification audit
--
-- Purely ADDITIVE. No table is dropped, no column is removed, no data is
-- deleted. Safe to run more than once. Migrations 0001 and 0002 remain the
-- baseline and are unchanged.
--
-- Three things are added, for three different reasons:
--
--  1. rbi_bank            The NBFC and ARC workbooks cover neither banks nor
--                         the websites the RBI publishes for them. Without this
--                         table every bank reads as "not found", and the
--                         strongest domain-identity signal in the product has
--                         nowhere to live.
--
--  2. ml_model            The evaluation artifacts are the product's honesty
--                         guarantee, so the numbers that were measured are
--                         recorded against the model version that was shipped.
--                         A metric on a dashboard that cannot be traced to a
--                         training run is decoration.
--
--  3. verification_event  Operational telemetry with no personal data in it:
--                         layer verdicts, signal ids, model score, duration.
--                         The lender's name is stored as a peppered digest and
--                         the person asking is not identified at all.
-- =============================================================================

-- =============================================================================
-- 1. RBI BANKS
--
-- Source: https://www.rbi.org.in/commonman/english/scripts/BanksInIndia.aspx
-- Captured as a dated snapshot by `npm run fetch:banks`, then imported here.
--
-- `hostnames` is the column that earns this table its place: it is the only
-- authoritative institution-to-domain mapping available anywhere in the RBI's
-- published data, and it turns "is this the bank's real website?" from a guess
-- into a lookup.
-- =============================================================================
create table if not exists public.rbi_bank (
    id                uuid primary key default gen_random_uuid(),
    slug              text not null,
    name              text not null,
    name_normalized   text not null,
    name_core         text,
    category          text not null,
    categories        text[] not null default '{}',
    websites          text[] not null default '{}',
    hostnames         text[] not null default '{}',
    address           text,
    source_headings   text[] not null default '{}',
    source_file       text not null,
    source_sheet      text not null,
    source_row_number integer not null,
    -- The RBI page publishes no as-of date, so this is the date it was fetched.
    -- Naming it dataset_as_of keeps it consistent with the workbook tables; the
    -- application labels it "fetched on", never "as on".
    dataset_as_of     date,
    last_imported_at  timestamptz,
    created_at        timestamptz not null default now(),
    constraint rbi_bank_category_check check (
        category in (
            'public_sector_bank', 'private_sector_bank', 'small_finance_bank',
            'payments_bank', 'local_area_bank', 'regional_rural_bank',
            'state_cooperative_bank', 'foreign_bank', 'foreign_bank_subsidiary',
            'financial_institution'
        )
    )
);

create unique index if not exists rbi_bank_source_key
    on public.rbi_bank (source_file, source_sheet, source_row_number);

create unique index if not exists rbi_bank_slug_key on public.rbi_bank (slug);

create index if not exists rbi_bank_name_norm_idx on public.rbi_bank (name_normalized);
create index if not exists rbi_bank_name_trgm_idx
    on public.rbi_bank using gin (name_normalized gin_trgm_ops);
create index if not exists rbi_bank_name_core_trgm_idx
    on public.rbi_bank using gin (name_core gin_trgm_ops);
create index if not exists rbi_bank_hostnames_idx on public.rbi_bank using gin (hostnames);
create index if not exists rbi_bank_category_idx on public.rbi_bank (category);

alter table public.rbi_bank enable row level security;
grant all privileges on table public.rbi_bank to service_role;

-- =============================================================================
-- 2. MODEL REGISTRY
--
-- One row per training run of the entity-matching model. `metrics` holds the
-- whole ml/artifacts/metrics.json document, so the held-out numbers displayed
-- on /technical can always be traced back to the run that produced them.
--
-- Only one row may be active at a time; the partial unique index enforces it.
-- =============================================================================
create table if not exists public.ml_model (
    id                uuid primary key default gen_random_uuid(),
    model_version     text not null,
    algorithm         text not null,
    task              text not null default 'entity_identity_resolution',
    trained_at        timestamptz not null,
    feature_count     integer not null,
    feature_names     text[] not null default '{}',
    threshold         double precision not null,

    train_pairs       integer,
    validation_pairs  integer,
    test_pairs        integer,

    test_precision    double precision,
    test_recall       double precision,
    test_f1           double precision,
    test_accuracy     double precision,
    test_roc_auc      double precision,
    test_pr_auc       double precision,
    test_true_positives   integer,
    test_true_negatives   integer,
    test_false_positives  integer,
    test_false_negatives  integer,

    -- The complete metrics artifact, verbatim.
    metrics           jsonb not null default '{}'::jsonb,
    -- Assumed relative FP / FN costs used to pick the threshold. Not money.
    cost_model        jsonb not null default '{}'::jsonb,

    is_active         boolean not null default false,
    published_at      timestamptz not null default now(),
    created_at        timestamptz not null default now()
);

create unique index if not exists ml_model_version_key on public.ml_model (model_version, trained_at);
create unique index if not exists ml_model_single_active
    on public.ml_model (is_active) where is_active;

alter table public.ml_model enable row level security;
grant all privileges on table public.ml_model to service_role;

-- =============================================================================
-- 3. VERIFICATION AUDIT
--
-- Deliberately contains NO personal data:
--   - no IP address, hashed or otherwise
--   - no e-mail address, no website, no free text the user typed
--   - no loan amounts
--   - the lender's name only as a peppered SHA-256 digest
--
-- What is kept is what makes the system auditable: which layer decided the
-- outcome, which signals fired, what the model said, and how long it took.
-- =============================================================================
create table if not exists public.verification_event (
    id                    uuid primary key default gen_random_uuid(),
    occurred_at           timestamptz not null default now(),

    verdict               text not null,
    regulatory_status     text,
    company_status        text,
    website_status        text,
    email_status          text,
    loan_terms_status     text,
    scam_signal_level     text,

    lender_name_digest    text,
    matched_entity_id     text,
    matched_entity_source text,

    model_version         text,
    model_score           double precision,
    model_threshold       double precision,
    candidates_scored     integer,

    signal_ids            text[] not null default '{}',
    signal_count          integer not null default 0,
    -- Which kinds of input were supplied, as booleans; never the values.
    inputs_supplied       jsonb not null default '{}'::jsonb,

    duration_ms           integer,

    constraint verification_event_verdict_check
        check (verdict in ('green', 'amber', 'red', 'gray'))
);

create index if not exists verification_event_occurred_idx
    on public.verification_event (occurred_at desc);
create index if not exists verification_event_verdict_idx
    on public.verification_event (verdict);
create index if not exists verification_event_digest_idx
    on public.verification_event (lender_name_digest);

alter table public.verification_event enable row level security;
grant all privileges on table public.verification_event to service_role;

-- =============================================================================
-- 4. FUZZY NAME SEARCH FOR BANKS
--
-- Mirrors the RPCs added in 0002 for the other tables, so that a caller using
-- the database directly gets the same behaviour across every dataset.
-- =============================================================================
drop function if exists public.search_rbi_bank_by_name(text, text, real, integer);
create function public.search_rbi_bank_by_name(
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
        from public.rbi_bank t
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

grant execute on function public.search_rbi_bank_by_name(text, text, real, integer) to service_role;

-- =============================================================================
-- 5. SCHEMA VERSION MARKER
-- =============================================================================
insert into public.schema_migrations (version) values ('0003_lenderlens_schema')
    on conflict (version) do nothing;

-- Make PostgREST pick up the new tables and functions immediately.
notify pgrst, 'reload schema';
