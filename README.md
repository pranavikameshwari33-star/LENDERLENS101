# LenderLens

**Verify a lender before you trust them.**

A defensive risk-assessment tool for the Razorpay AI Buildathon — *AI Risk Manager* track.
Strictly detection and verification; there is no offensive capability anywhere in this
repository.

---

## The problem

Fake loan apps and impersonated lenders prey on people who are already financially stressed and
looking for quick credit. By the time the fraud is obvious, the borrower has already sent an
"advance fee", handed over identity documents, or installed an app that harvested their contacts.

The tools available to an ordinary person do not help much:

| What they check | What they answer | Why it is not enough |
| --- | --- | --- |
| An RBI search | *Does this company exist?* | It does. A fraudster does not need to invent a company — it can impersonate a real one. |
| A website reputation checker | *Does this site look safe?* | A certificate costs nothing and a template costs less. |
| A blocklist | *Has this been reported before?* | Only after somebody has already lost money. |

## The insight

> **A fraudulent lender does not need a fake company. It needs a real one to hide behind.**

A caller says "we are XYZ Finance Limited". XYZ Finance Limited exists, holds a current
Certificate of Registration, and has a CIN that checks out. An RBI lookup says ✓. The website is
professional and serves HTTPS, so a website checker says ✓. And yet the domain, the e-mail
address and the bank account have nothing whatsoever to do with XYZ Finance Limited.

Neither tool can see the contradiction, because neither of them is comparing sources against each
other. That comparison is the entire product.

## What LenderLens does

Six independent evidence layers, each answering a different question, combined by explicit rules:

```
RBI REGULATORY IDENTITY   registered? cancelled? a bank? in which RBI source?
      ×
COMPANY IDENTITY          does the claimed name match the legal entity found?
      ×
WEBSITE IDENTITY          does this domain belong to that institution?
      ×
EMAIL IDENTITY            does this address belong to that institution?
      ×
LOAN TERMS                what is offered, and does the arithmetic hold together?
      ×
SCAM SIGNALS              what has the lender actually asked the borrower to do?
      +
ML ENTITY RESOLUTION      which RBI record is this, with what probability?
      =
EVIDENCE-BASED RISK ASSESSMENT   green / amber / red / gray, with every signal shown
```

**Remove the website entirely and five layers still run.** That is the test this project is
built to pass, and `tests/engine.test.ts` asserts it.

---

## The four verdicts

| Verdict | Meaning |
| --- | --- |
| **GREEN** | Positive regulatory corroboration and no contradiction. Not an endorsement of any offer. |
| **AMBER** | Some evidence supports the lender and some does not. Each inconsistency names what to ask for. |
| **RED** | A published regulatory fact against the lender, or a contradiction between sources, or a conclusive behaviour. |
| **GRAY** | Not enough evidence to say anything. **This is a real answer, not a failure.** |

The rule that matters most:

> **"Not found in the RBI data" is never "fraud".**

The NBFC and ARC lists cover NBFCs and ARCs. Banks are in a separate RBI source. Insurers,
stockbrokers, payment aggregators, co-operative societies and unregulated lenders are in none of
them. A lender absent from all of it is *unverified*, and `decision.ts` explicitly excludes the
"not found" signal from ever tipping a verdict into amber on its own — with a test that pins that
behaviour down.

---

## RBI data sources

Three published RBI sources, all captured with their dates and provenance.

### 1. Registered NBFCs and ARCs — `data/List_registered_with_the_RBI.XLSX`

Snapshot **as on 30 June 2026**, read from the title row of the workbook rather than assumed.

| Sheet | Entities parsed | Notes |
| --- | --- | --- |
| `List of NBFCs` | 8,561 | Matches the RBI's own stated figure. One further row is the "N.B.: NBFC-ICC category marked with asterisk…" footnote and is reported as skipped, not silently dropped. |
| `ARCs` | 27 | Matches the RBI's stated figure. |
| `Sheet3` | 27 values | Reference classification values, kept for documentation. Deliberately **not** used to validate imported rows: the live data contains classifications (HFC, AA, Factor, NOFHC, MGC, IDF) that Sheet3 never lists. |

Fields used beyond the name: regional office, public-deposit authorisation, classification, CIN,
layer, address and contact e-mail. The e-mail column is what makes NBFC domain checking possible
at all — 477 rows hold several addresses in one cell, and they are split, repaired where the
artefact is unambiguous, and indexed by domain.

The RBI also embeds aliases inside the name cell — `(Formerly: …)` on 544 rows and
`(Name as per MCA - …)` on 49 — which are lifted out so that searching an old name still finds
the company.

### 2. Cancelled registrations — `data/List_cancelled_by_the_RBI.XLSX`

| Sheet | Entities parsed | Notes |
| --- | --- | --- |
| `Cancelled List` | 6,703 | Companies whose Certificate of Registration the RBI has cancelled. Every name begins with a literal newline in the source. |
| `Record` | 24 | Two stacked tables in one sheet — companies *removed from* the list (registration restored) and companies *added to* it. Their SR No. counters both restart at 1, so the section heading is the only thing telling them apart. |

**This list publishes no CINs.** An entry can only be matched by name, which the interface says
every single time it reports one.

### 3. Banks in India — `https://www.rbi.org.in/commonman/english/scripts/BanksInIndia.aspx`

Captured by `npm run fetch:banks` into `data/rbi_banks.json`, with the fetch timestamp, the source
URL and the section headings recorded. 168 institutions across ten categories:

| Category | Count | | Category | Count |
| --- | --- | --- | --- | --- |
| Public Sector Banks | 12 | | Regional Rural Banks | 28 |
| Private Sector Banks | 21 | | State Co-operative Banks | 34 |
| Small Finance Banks | 12 | | Foreign Banks | 46 |
| Payments Banks | 6 | | Foreign Bank Subsidiaries | 2 |
| Local Area Banks | 3 | | Financial Institutions | 4 |

This source does something the workbooks cannot: **for 133 of these institutions the RBI links the
bank's own official website**, largely on the regulated `.bank.in` domain. That is the only
authoritative institution-to-domain mapping anywhere in the RBI's published data, and it turns
"is this the bank's real website?" from a guess into a lookup. It is why the demonstration case
where a real bank's name is paired with another bank's domain comes out as a **critical** signal
rather than a hunch.

The parser refuses to write a snapshot if it finds fewer than 120 banks or 100 websites, so a
change to the RBI page fails loudly instead of quietly producing an empty dataset.

---

## Architecture

```
                       user
                         │
        ┌────────────────▼────────────────┐
        │  Next.js 16 · React 19 · Tailwind 4
        │  progressive form: name → optional terms → optional behaviour
        └────────────────┬────────────────┘
                         │ POST /api/verify   (rate limited, server-only)
        ┌────────────────▼────────────────┐
        │  input validation + normalisation
        └────────────────┬────────────────┘
        ┌────────────────▼────────────────┐
        │  ENTITY RESOLUTION
        │    identifiers first  CIN · exact name · RBI former name · RBI website
        │    then the model     blocking → 19 features → gradient boosting
        └────────────────┬────────────────┘
   ┌─────────┬───────────┼───────────┬─────────┬──────────┐
   ▼         ▼           ▼           ▼         ▼          ▼
 LAYER 1   LAYER 2    LAYER 3     LAYER 4  LAYER 5a   LAYER 5b
regulatory company    website     e-mail   loan terms  behaviour
   │         │           │           │         │          │
   └─────────┴───────────┴─────┬─────┴─────────┴──────────┘
                               ▼
                  structured signals  (id, category, severity,
                  origin, explanation, evidence, source, confidence)
                               ▼
                  DETERMINISTIC VERDICT ENGINE
                  rules in order; the model's probability is not an input
                               ▼
                    green / amber / red / gray + evidence
```

### The three kinds of claim, kept apart

| Origin | Example | How it is treated |
| --- | --- | --- |
| **RBI record** | "This entity appears in the cancelled-registration list." | Deterministic. Nothing may override it. |
| **Rule** | "Money was demanded before disbursement." | Documented heuristic, traceable to one input. |
| **Model** | "0.92 that these are the same institution." | Inference. Always shown with its probability. |

Every signal carries its origin, and the interface labels it. They are never blended into one
unexplained number, and the verdict engine never sees the model's probability at all — which is
the structural reason a confident model cannot argue its way past a regulatory fact.

---

## Machine learning

### The task

> Given the lender name a user was given, and one candidate entity from the RBI reference data,
> **do the two names refer to the same institution?**

Binary classification. That is the whole task, and it is stated this narrowly on purpose.

### Why not "detect fraud"?

Because there is no public register of which fake lender impersonated which NBFC. Inventing fraud
labels to train on would make every metric downstream meaningless, and the buildathon asks for
honest ones. Entity resolution is a genuine, hard, useful ML problem with ground truth that
actually exists in the data — and it is the piece the rest of the system cannot do without.

Regulatory standing, digital identity, loan terms and scam signals are decided by deterministic
rules, because that is where the evidence for them lives.

### Labels

```
y = 1   the claimed name and the candidate entity are the same institution
y = 0   they are different institutions
```

Ground truth comes from the RBI data itself: two records are the same institution when they share
a normalised name or a CIN. That is how one company appears in both the registered and the
cancelled lists.

**Stated limitation:** this treats institutional identity as name identity. It is safe for these
sheets — no sheet contains a duplicate name — but it would not hold for a corpus that did.

### Queries

A user does not paste the RBI's exact string; they type what the lender told them. Two sources of
variation:

- **Real** — the `(Formerly: …)` and `(Name as per MCA - …)` aliases the RBI itself prints. No
  synthesis at all.
- **Synthetic** — documented, deterministic edits: legal form swapped or dropped, an interior word
  omitted, `&` spelled out, one character transposed/dropped/doubled, the initials of a long name
  with and without the legal form.

Each pair records which variant produced it, and the evaluation reports recall per variant so an
easy case cannot hide inside an average.

### Leakage control

This is the part that decides whether the numbers mean anything.

1. **Grouping.** Entities are grouped by the first distinctive word of their name. Every Bajaj
   entity is in one group.
2. **Groups, not rows, are split** into train / validation / test by a seeded hash.
3. **Hard negatives are retrieved from a per-split index**, so a training pair cannot even mention
   a test-set entity.
4. **IDF is computed over the full corpus**, matching what the request path sees. That is a
   property of the corpus rather than of the labels, so it carries no target information.
5. **The trainer asserts the split is clean** and refuses to run if any group appears in two
   splits.

Without (1), a model that saw "Bajaj Finance Limited" in training would match "Bajaj Housing
Finance Limited" at test time for reasons that have nothing to do with generalisation.

### Features

Nineteen, all computed by `src/lib/ml/features.ts`:

`exact_normalized_match` · `exact_core_match` · `alternate_name_match` · `token_jaccard` ·
`token_containment` · `idf_weighted_overlap` · `trigram_core` · `trigram_full` · `jaro_winkler` ·
`edit_similarity` · `prefix_ratio` · `length_ratio` · `token_count_gap` · `first_token_match` ·
`acronym_match` · `shared_rare_token` · `unmatched_rare_query_token` ·
`unmatched_rare_entity_token` · `digit_token_agreement`

The two most useful are the IDF-weighted ones. Agreeing on `FINANCE` is worth almost nothing;
agreeing on `YERROW` is worth almost everything — and an *unmatched* rare token is what separates
"Bajaj Finance" from "Bajaj Housing Finance".

### No train/serve skew, by construction

`src/lib/ml/features.ts` writes the training CSV **and** runs on every live request. The Python
trainer never computes a feature — it consumes the CSV. There is exactly one implementation of
every feature, in one language.

Three further guards:

- After training, the exported JSON model is re-scored over the whole test split and compared
  against scikit-learn's own probabilities. The trainer **refuses to write the artifact** if they
  differ by more than 1×10⁻⁹.
- `ml/train.py` writes a 300-case parity fixture; `tests/ml-model.test.ts` scores it with the
  TypeScript implementation that actually serves requests and asserts the same tolerance.
- The artifact records its feature order and the loader refuses a model whose order disagrees.

Together those close the loop from the model that was *measured* to the model that *runs*.

### Model selection

Three candidates are fitted and compared on the validation split — logistic regression, random
forest, gradient boosting — and the winner is chosen by lowest assumed relative cost, ties broken
by F1. **The test split is opened once, after selection.**

### Held-out results

Live figures are on **`/technical`**, read from `ml/artifacts/metrics.json` at request time, and
served verbatim at **`/api/model`**. Nothing is typed into the interface: if the model gets worse,
the page gets worse.

Run `npm run ml:all` to reproduce them from scratch; the seed is fixed, so the split and the
metrics are identical on every run.

### False-positive / false-negative cost

The positive class is "same institution", so:

| Error | What the user experiences | Assumed relative cost |
| --- | --- | --- |
| **False positive** | LenderLens says the lender matches a real registered entity when it does not — **a false reassurance handed to someone about to send money**. | **10** |
| **False negative** | LenderLens fails to connect a genuine lender to its record; the result degrades to GRAY and the user is told to check further. | **1** |

These are **assumed relative costs used to pick a threshold**. They are not measured monetary
losses and are never presented as such.

The conventional fraud-detection framing (a missed detection costing 10× a false alarm) is
reported alongside on `/technical` so the trade-off can be read either way — but the shipped
threshold optimises the framing above, because in *this* product the expensive error is telling
somebody their impersonator is genuine.

The threshold is chosen on the **validation** split by minimising that cost, then applied
unchanged to test. `/technical` shows the full sweep: precision, recall, FP, FN and relative cost
at every threshold, with the shipped one marked.

---

## Security

| Concern | How it is handled |
| --- | --- |
| **Service-role key** | Server-only, guarded by the `server-only` package so importing it from a client component is a build error. It never reaches the browser. |
| **SSRF** | The website check resolves the hostname first and refuses any private, loopback, link-local, CGNAT or multicast address — `http://169.254.169.254/` included. One request, 6 s timeout, 512 KB cap, no crawling, no redirect chasing to private space. |
| **Rate limiting** | `/api/verify` 20/min, `/api/search` 60/min, keyed on `SHA-256(pepper ‖ client identifier)` truncated to 128 bits. |
| **No raw IP is ever stored** | Not in memory beyond the hash, not in logs, not in the database. The pepper is a server-side secret without which the hash of a v4 address would be trivially reversible by enumeration. |
| **Audit privacy** | `verification_event` records layer verdicts, signal ids, model score and duration. No IP, no e-mail, no website, no loan amounts, no free text. The lender's name is stored only as a peppered digest. |
| **RLS** | Enabled on every table with no policies. Every read goes through the service role, server-side; the anon key can read nothing. |
| **Input validation** | Length caps, control-character rejection, strict CIN/e-mail/hostname shapes, a 16 KB body cap, and numeric fields that refuse what they cannot read rather than guessing. |
| **Headers** | CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. |
| **Errors** | No stack trace ever reaches a user. Configuration problems answer 503 with an actionable message; anything unexpected answers 500 and is logged server-side. |

**Defensive only.** LenderLens builds no attack tooling, no evasion, no scanning beyond a single
polite request to one home page, and nothing that could be used to defeat a fraud control.

---

## Supabase

The existing project and schema are **preserved and extended**. Migrations 0001 and 0002 are
unchanged; 0003 is purely additive.

| Migration | What it does |
| --- | --- |
| `0001_baseline_schema.sql` | *(unchanged)* The four RBI reference tables, trigram indexes, RLS. |
| `0002_verification_schema.sql` | *(unchanged)* Service-role grants, provenance and matching columns, idempotency keys, the fuzzy-search RPCs, import bookkeeping. |
| `0003_lenderlens_schema.sql` | **new** `rbi_bank`, `ml_model`, `verification_event`, and `search_rbi_bank_by_name`. |

### Why the runtime reads a file rather than the database

Two reasons, both about correctness:

1. The ML training pairs and the live request path must see byte-identical entity records.
   Training against a file while serving from a database is how a model quietly learns something
   the application never sees.
2. Candidate retrieval wants an in-process inverted index over ~15,000 names. A per-query round
   trip to `pg_trgm` cannot supply the same candidate set to the feature extractor at training
   time.

Supabase remains the durable store for the RBI corpus, the model registry and the audit log. It is
not on a request's critical path, which is why a verification still works when it is unreachable —
`/api/health` reports that honestly rather than failing the page.

> **Current state of this project's Supabase instance:** the database is reachable but **empty** —
> no migration has been applied to it. Apply 0001, 0002 and 0003 in the SQL Editor and then run
> `npm run import:rbi` and `npm run ml:publish`. `npm run db:status` reports exactly what is
> outstanding. The application works fully without this step.

---

## Local setup

```bash
npm install

# 1. Compile the RBI sources into the runtime entity index (~1 min)
npm run build:data          # fetch:banks + build:index

# 2. Build the training pairs and train the model (~9 min)
pip install numpy scikit-learn
npm run ml:all              # ml:pairs + ml:train

# 3. Run
npm run dev                 # http://localhost:3000
```

`data/*.XLSX` are git-ignored (large binaries, only needed at build time). The derived
`data/rbi_banks.json`, `data/index/entity-index.json` and `ml/artifacts/*` **are** committed,
because they are what the application reads at runtime.

### Checks

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # pure-function suites
npm run test:engine    # end-to-end against the real index (needs build:data)
npm run test:all       # both
npm run build          # production build
npm run demo           # the six demonstration cases, end to end
npm run demo -- --live # …including live website checks
```

### Optional: Supabase

```bash
# Apply supabase/migrations/000{1,2,3}_*.sql in the SQL Editor, then:
npm run db:status      # what is applied, what is missing
npm run import:rbi     # workbooks + bank snapshot → Supabase
npm run ml:publish     # model metadata + metrics → ml_model
```

---

## Environment variables

Copy `.env.example` to `.env.local`. Nothing in `.env.example` is a real secret.

| Variable | Required | Used by | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | optional | server | Only for the durable store, the model registry and the audit log. Verification works without it. |
| `SUPABASE_SERVICE_ROLE_KEY` | optional | **server only** | Bypasses RLS. Never expose it. `server-only` makes a client import a build error. |
| `RATE_LIMIT_PEPPER` | recommended | server | ≥16 chars. Without it a random per-process value is used and `/api/health` says so. Also peppers the lender-name digest in the audit log. **Never commit it.** |
| `WHOIS_API_KEY` | optional | server | Enables the domain-age signal. Absent, the signal reports itself unavailable and everything else is unaffected. |
| `WHOIS_API_PROVIDER` | optional | server | Defaults to `whoisxmlapi`. |

---

## Deployment

Standard Next.js. The compiled index and model artifacts are read from disk at request time, so
`next.config.ts` declares them in `outputFileTracingIncludes` — without that they are dropped from
a serverless build and every verification fails **on the deployed site only**, which is the worst
place to find out.

Set the environment variables above, keep `SUPABASE_SERVICE_ROLE_KEY` and `RATE_LIMIT_PEPPER`
server-side, and check `/api/health` after deploying.

---

## Three-minute demo

Run `npm run demo` for all six cases in the terminal, or use the buttons on the home page.

**0:00 – 0:20 — the framing**
> "Most scam checkers look at the website. LenderLens verifies the lender's identity across six
> independent sources and asks whether the whole thing holds together."

**0:20 – 1:00 — a genuine lender** *(home page: "A registered NBFC, checked against its own details")*
Registered NBFC, identified by CIN, contact domain corroborated by the RBI record.
→ **GREEN**, with every supporting signal listed and its source named.

**1:00 – 1:45 — the differentiator** *(home page: "The same NBFC — impersonated")*
Same real, registered company. A `.xyz` domain, a Gmail address, ₹24,999 demanded before
disbursement.
→ **RED — "…is a real institution, but the party contacting you may not be it."**
The matrix shows regulatory ✓ and company ✓ sitting beside website ✕, e-mail ✕, terms ✕,
behaviour ✕. *This is the slide an RBI lookup and a website checker both get wrong.*

Then, if there is time: **a bank's name on another bank's RBI-published domain** → a *critical*
signal, because the RBI publishes that mapping and this is a lookup, not a guess.

**1:45 – 2:20 — the ML** *(`/technical`)*
Held-out precision and recall, the confusion matrix, recall broken down by name variant and by
RBI source, the threshold sweep with FP/FN cost, and the parity check proving the served model is
the measured model. All read from the artifact — the same JSON is at `/api/model`.

**2:20 – 3:00 — the honesty** *(home page: "A lender in none of the RBI sources")*
→ **GRAY — insufficient evidence.** Not red.
> "Absence from the RBI's lists is not evidence of fraud. Getting this wrong is how a tool like
> this does real damage, so 'I don't know' is a first-class answer here — and there is a test that
> keeps it that way."

---

## Known limitations

Stated plainly, because a risk tool that overstates itself is a risk in its own right.

1. **The RBI data is a dated snapshot, not a live feed.** Every answer is only as current as the
   date shown with it, and the interface shows it everywhere.
2. **It will miss fraudulent lenders.** A careful impersonator who registers a lookalike domain,
   uses a matching e-mail and asks for nothing up front passes every check here.
3. **Absence from the RBI data is not evidence of anything.** Banks' subsidiaries trading under
   other names, insurers, brokers, payment companies and co-operative societies are regulated
   under other frameworks.
4. **The cancelled list publishes no CINs.** A cancellation match rests on the name alone, and a
   similar name may be an entirely different company. The interface says so every time.
5. **Website identity is uncorroborated for most NBFCs.** The RBI publishes official websites for
   banks, not for NBFCs. For an NBFC the strongest available link is the contact e-mail domain,
   and where that is absent the layer honestly reports UNCORROBORATED rather than inventing a
   finding.
6. **Loan-term and behaviour analysis depends entirely on user-supplied input.** Nothing is
   assumed, and nothing left blank is guessed — but nothing left blank is checked either.
7. **The model resolves identity, not fraud.** Its labels are derived from regulatory records, and
   it is described that way throughout. It should not be quoted as a fraud probability.
8. **Name identity is a proxy for institutional identity** in the labelling rule. Safe for these
   sheets; not a general rule.
9. **The rate limiter is per-process and in-memory.** Correct for a single instance; it does not
   coordinate across replicas, and it says so rather than pretending otherwise.
10. **LenderLens is not affiliated with the Reserve Bank of India,** gives no financial advice, and
    cannot certify that any lender is safe.

---

## Repository map

```
data/
  List_registered_with_the_RBI.XLSX   RBI NBFC + ARC workbook (git-ignored)
  List_cancelled_by_the_RBI.XLSX      RBI cancellation workbook (git-ignored)
  rbi_banks.json                      Banks-in-India snapshot, with fetch date
  index/entity-index.json             the compiled runtime index

ml/
  train.py                            training, evaluation, threshold, export
  data/pairs.csv                      training pairs with pre-computed features
  artifacts/model.json                the model the application serves
  artifacts/metrics.json              every number on /technical
  artifacts/parity-fixture.json       train/serve parity cases for the TS tests

scripts/
  fetch-rbi-banks.ts                  RBI Banks-in-India → snapshot
  build-index.ts                      workbooks + snapshot → entity index
  import-rbi.ts                       the same rows → Supabase
  publish-model.ts                    metrics → ml_model
  db-status.ts                        what is applied, what is missing
  demo-cases.ts                       the six demonstration cases
  ml/build-pairs.ts                   training pairs + features + splits
  lib/rbi-sheets.ts                   one parser, shared by index and importer
  lib/rbi-banks.ts                    one snapshot reader, likewise

src/lib/
  normalize.ts                        text normalisation + similarity primitives
  rbi/dataset.ts                      source descriptors, dates, bank categories
  rbi/types.ts                        published-record shapes (banks, sources)
  index/                              entity index: types, store, search, clustering
  ml/                                 features, model scoring, metrics artifacts
  verify/
    input.ts                          validation and parsing
    matcher.ts                        entity resolution (identifiers, then model)
    layers/                           the six evidence layers
    signals.ts                        the structured signal model
    decision.ts                       the deterministic verdict engine
    engine.ts                         orchestration
  security/rate-limit.ts              peppered, privacy-preserving throttling
  audit/record.ts                     privacy-conscious Supabase audit write

src/app/
  page.tsx                            home + the check
  technical/                          model, metrics, cost analysis
  record/[id]/                        one RBI record, permanently linkable
  api/verify · api/search · api/model · api/health
```

---

## Positioning

**LenderLens is a defensive AI risk system for lender impersonation and legitimacy verification.**

Its differentiator is cross-source consistency: not *does this company exist*, and not *does this
website look safe*, but **does the entity exist, is it recognised by the right RBI source, is it
not cancelled, does it match the claimed company, does it match the digital identity, is it
consistent with the loan offer, and is it free of serious scam signals** — with ML doing the one
job ML is genuinely better at, and measured honestly on data it has never seen.

## Contributor note
This project uses evidence-based verification to help users assess lender legitimacy.
