# `scripts/state` — the reconciler

Declarative, idempotent **state reconciliation for a Mailflare instance**. JSON documents
are the source of truth; one loop makes the instance match them.

Everything the system can do — reset the instance, onboard a domain, mailboxes, accounts,
routing rules, MCP keys, the licence, web push — is a **Resource** with a uniform
`status` / `apply` / `remove`, so `--status` and `--cleanup` work for every capability and
there is no per-capability command.

---

## Read this first — the live instance is currently broken

The live D1 was **deliberately wiped** during a `--fresh` test and is only partly restored.

| | |
|---|---|
| Live D1 now | 1 user, 1 domain, 2 mailboxes |
| `amplifycms.com` | **half-provisioned** — mailboxes `admin@`/`hello@` exist; the account and both shared inboxes failed; routing failed |
| `amplifycms.net` | **gone** (wiped, not re-applied) |
| `ubuntudesign.com` | **gone** (wiped, not re-applied) |
| Root admin | `root@amplifycms.com` / `fresh-admin-2026` |
| Cloudflare side | MX, Email Routing rules and DNS for those domains **still exist** — `fresh` does not touch Cloudflare (see below) |

**To restore**: add a `license` section to the tenant specs (see *Known bugs* #1), then

```bash
npm run state -- --spec scripts/state/specs/amplifycms.com.json --onboard --confirm-mx
npm run state -- --spec scripts/state/specs/amplifycms.net.json --onboard --confirm-mx
npm run state -- --spec scripts/state/specs/ubuntudesign.com.json --onboard
```

`--confirm-mx` is required because the records are already Mailflare's own.

---

## Prerequisites

- **Node 24+** and `npm install` (tsx, wrangler and typescript are devDependencies).
- **Cloudflare credentials**, read from the environment first, then the macOS keychain
  (service `fnox`): `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The usual route is
  `fnox exec -- npm run state -- ...`. `npx wrangler whoami` must succeed for anything that
  touches D1. A run that only touches *global* data (licence, web push) needs neither — the
  store resolves the instance URL and mints its admin key lazily, on the first HTTP call.
- **The instance URL** resolves as: `--url` → `MAILFLARE_URL` → `<worker>.<account>.workers.dev`,
  derived from `wrangler.jsonc`'s `name` plus the Cloudflare API. The live instance is
  **https://mailflare.gedw99.workers.dev**.
- This file documents the *operations* layer. The application itself is `src/`, described in
  the repo-root `README.md` and `CLAUDE.md`.

## Safety — these destroy data

| Flag | Effect |
|---|---|
| `--fresh` | deletes **every row** in the target D1 and makes a new admin. Not reversible. |
| `--cleanup` | deletes the document's mailboxes, routing rules and MCP keys |
| `--cleanup --disable-accounts` | also disables the accounts (the app cannot delete users) |
| `--cleanup --remove-domain` | also removes the domain — drops its Cloudflare DNS/MX config |
| `--all` | applies **every** document in `specs/` |

Always `--dry-run` or `--status` first. `--fresh` touches the database only: Cloudflare MX,
Email Routing and DNS survive, so on a live instance it **orphans infrastructure**.

## Commands

```bash
npm run state -- --spec scripts/state/specs/example.json    # one document
npm run state -- --all --dry-run                            # every document in specs/
npm run state -- --spec <file> --status                     # drift report, writes nothing
npm run state -- --spec <file> --cleanup                    # tear the document down
npm run state -- --fresh --spec <file>                      # reset the DB, then apply
npm run state -- --domain <host> --roles a,b,c              # ad hoc, no document
npm run state -- --plan team            # licence only (no domain needed)
npm run state -- --license-status
npm run state -- --push                 # web push round trip
npm run state -- --steps                # VAPID rotation runbook

npm run state:test       # 28 tests, in-memory fake — no D1, no network, no bindings
npm run state:typecheck
```

**`--remote` is not a flag** — the default target *is* remote. Use `--local` for the dev
database. Both are read at the moment of use, so a run that only touches global data
(licence, push) needs neither Cloudflare credentials nor an instance URL.

Other flags: `--onboard --confirm-mx --replace-mx --share --disable-accounts
--remove-domain --dir <path> --url <base> --db <name>`.

### Document shape

Any subset of these sections; one file may hold many via `{ "specs": [ ... ] }`.

```jsonc
{
  "domain": "acme.de",
  "onboard":   { "receivingProvider": "none", "replaceMxRecords": false },
  "mailboxes": [ { "role": "office" },
                 { "role": "support", "shared": true,
                   "access": [ { "email": "sam@acme.de", "permission": "read_only" } ] } ],
  "accounts":  [ { "username": "sam", "role": "user", "passwordEnv": "PROV_PASSWORD" } ],
  "routing":   [ { "pattern": "*", "action": "forward", "forwardTo": "ops@example.com" } ],
  "mcpKeys":   [ { "name": "agent", "mailboxes": ["office"] } ],
  "license":   { "plan": "team" },
  "push":      { "to": "ops@example.com" },
  "fresh":     { "admin": { "email": "root@acme.de", "password": "..." } }
}
```

`specs/` holds one document per domain. `example.json` (template) and `_*.json`
(`_sandbox.json`, a runnable dev fixture) are **skipped by `--all`**.

---

## Standing up a new server

This is the point of the whole system: from nothing to a provisioned instance with no manual
clicking. Nothing else in the app can do it — `POST /api/auth/register` creates the first
admin but also demands Turnstile and a domain, so it is unusable as a bootstrap.

```bash
# 1. Deploy the Worker and its D1 (npm run deploy). wrangler.jsonc must have the real
#    database_id, and the Worker `name`, CF_EMAIL_WORKER_NAME and the WORKER_SELF_REFERENCE
#    service must all agree.

# 2. Reset it and give it a primary admin. One document, applied against the new database:
cat > /tmp/fresh.json <<'JSON'
{ "fresh": { "admin": { "email": "root@example.com", "password": "…" } } }
JSON
npm run state -- --fresh --spec /tmp/fresh.json --admin-email root@example.com --admin-password '…'
#    (this runs `wrangler d1 migrations apply DB --remote` first)

# 3. Apply each tenant document, then confirm
npm run state -- --spec scripts/state/specs/<domain>.json --onboard
npm run state -- --spec scripts/state/specs/<domain>.json --status
```

The app now shows its normal login, and `root@example.com` is the primary admin.

## Everyday workflow

- **Add a tenant** — drop `specs/<domain>.json` in and `npm run state -- --spec …`. If the
  domain is not onboarded, add `--onboard` (publishes MX).
- **Change one** — edit the document and apply again. Every resource is idempotent and
  reconciles drift, so this is safe and is the only supported way to change things.
- **Remove one** — `--cleanup` (add `--disable-accounts`, `--remove-domain` as needed).
  Safe to re-run.
- **Mass** — `npm run state -- --all --dry-run` first, then without `--dry-run`. One admin
  key covers the whole run.

## Layout

```
scripts/state/
├── apply.ts              entry: parse → load → run
├── args.ts               CLI parsing + usage
├── driver.ts             THE reconcile loop
├── runner.ts             many documents in one process, one admin key
├── context.ts            per-document Context, makeContext, requireDomain
├── spec.ts               the document model + the app-shaped row types (Api*)
├── flags.ts              what the command line asked for
├── document.ts           loading documents; rolesFor; onboardBody
├── wrangler.ts           d1/fetch/keychain/migrations helpers
├── app.ts                app-coupled: validateBody, withStore (lazy auth)
├── store/
│   ├── types.ts          the Store seam  ← the contract
│   └── live.ts           the ONLY module that talks to D1 (or the CF API)
├── resources/
│   ├── resource.ts       the Resource contract
│   ├── registry.ts       RESOURCES — the order, and why
│   └── fresh domain license accounts mailboxes routing mcp-keys push .ts
├── specs/                the documents (source of truth)
└── roles.example.txt
```

### The two rules that keep this honest

1. **All outside access goes through the `Store` seam.** Logic modules never call D1, fetch
   or wrangler directly. That is what makes the whole system testable against an in-memory
   fake — and it has already caught two bugs that only appeared at the seams
   (`applyMigrations` spawning remote migrations in tests; `currentMx` hitting the keychain
   during a dry run).
2. **SQL lives only in `store/live.ts`.** Everything else is logic.

### Ordering is load-bearing

`resources/registry.ts` order *is* the design, and every position encodes a bug that was
found the hard way:

| # | Resource | Why it is here |
|---|---|---|
| 1 | `fresh` | wipes the instance — nothing may precede it |
| 2 | `domain` | resolves/onboards the domain; **aborts** the run when it cannot |
| 3 | `license` | **gates** shared inboxes *and* account management (403 without Pro/Team) |
| 4 | `accounts` | before mailboxes: `access` grants name users, and on a fresh server the only users are the ones accounts creates |
| 5 | `mailboxes` | before the rules/keys that name mailbox ids by role |
| 6 | `routing` | |
| 7 | `mcpKeys` | |
| 8 | `push` | |

`--cleanup` walks this **in reverse** → the licence is reverted **last**, so the account
disable still has a plan to work under. The two prerequisites (`fresh`, `domain`) are
handled explicitly in `driver.ts` because on cleanup the domain must be **resolved first
but removed last** (it cascades everything else).

Adding a resource: implement the contract in `resources/<name>.ts`, insert it at the
correct position in `registry.ts`, add a test, and say *why* it sits there.

---

## Verifying the whole thing from zero

The only way to test this properly is a **fresh, disposable instance**. Never validate a
from-zero flow against an already-populated database — it hides exactly the ordering bugs
this system exists to prevent.

```bash
# 1. a genuinely empty local instance, with NO Cloudflare credentials so provisioning
#    records a manual zone instead of touching real DNS
rm -rf .wrangler/state
env -u CF_TOKEN -u CF_API_KEY -u CF_EMAIL -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npm run dev

# 2. reset + provision from nothing
npm run state -- --fresh --onboard --local --url http://localhost:3000 \
  --spec scripts/state/specs/_sandbox.json \
  --admin-email root@sandbox.test --admin-password sandbox-admin-pass-123

# 3. drift, idempotency, teardown
npm run state -- --local --url http://localhost:3000 --spec scripts/state/specs/_sandbox.json --status
npm run state -- --local --url http://localhost:3000 --spec scripts/state/specs/_sandbox.json
npm run state -- --local --url http://localhost:3000 --spec scripts/state/specs/_sandbox.json \
  --cleanup --disable-accounts --remove-domain
```

`_sandbox.json` uses `receivingProvider: "none"` on purpose — mailbox routing only calls
Cloudflare when the receiving provider **is** cloudflare, so a local run stays offline.

**Stop the dev server before wiping `.wrangler/state`** — they share the local D1. The
`kill` guard in this environment rejects a variable PID; use a literal one from
`lsof -ti:3000`.

---

### Testing a new resource

Tests drive the **whole** run through an in-memory fake, so they need no D1, no network and
no bindings. See `tests/state.test.ts`: build the fake with `fakeStore({...seed})`, run
`runOn(store, flags({...}), spec, roles)`, then assert on the recorded `calls` array and the
mutated `state`. Add a seed field for anything new the resource touches. Any test that needs
wrangler or Cloudflare is a bug in the seam — `applyMigrations` was exactly that once.

## Known bugs and outstanding work

1. **A document that uses gated features must declare `license`.** `amplifycms.com.json`
   does not, so on a fresh instance its account and shared inboxes 403. Either add the
   section or move the licence to an instance-level document (preferred — see below).
2. **`fresh` resets the database, not the infrastructure.** Cloudflare MX, Email Routing
   rules and DNS survive, so a from-zero reset on a live instance *orphans* them. Document
   it, or make tenant de-provision own both sides.
3. **Specs are one flat layer.** They should split into `fleet` / `instance` / `tenant` —
   see *Design direction*.
4. **`applyMigrations` only warns on a non-zero exit.** In a non-interactive context
   wrangler applies every migration and can still exit non-zero; we verify `schemaPresent`
   instead. The root cause is not fully understood — worth pinning down.
5. **Mass runs are sequential** (one process, one key) — correct and fast enough, but
   thousands of documents want bounded parallelism.
6. **No `erasure` / subject index yet.** See *Design direction*.
7. **`--fresh --remote` leaves the app showing "Prepare Installation".** Expected — the
   setup wizard sees no admin. Not a bug, just surprising.
8. Pre-existing, unrelated: `tests/i18n.test.mjs` fails 1 of 8 (138/139 overall).
9. `src/` is the application. The reconciler drives it through its API and D1; **do not**
   modify `src/` to make provisioning easier — the app's endpoints are the contract.

### Gotchas that have already cost time

- **`tsconfig.scripts.json` must restate the app's `types` array.** A `types` array
  *overrides* rather than merges, and dropping it was what made app types unresolvable and
  pushed this system toward hand-written guesses.
- **`validateBody` returns zod's transformed output.** Posting it back fails the app's own
  schema (an omitted `password` becomes `null`, which the server rejects but our local
  parse accepts). Validate for drift, **send the input**.
- **`??` does not catch an empty string** — accounts created via the API have `name: ""`.
- **`wrangler.jsonc`**: `migrations_dir` must be repo-relative (`drizzle/migrations`, *not*
  `../../drizzle/migrations` — that is what the Vite plugin writes into
  `dist/server/wrangler.json`), and `--remote` needs a concrete `database_id`.
- **`wrangler d1 export` does not work** on a database with FTS virtual tables.
- The wipe **excludes** `d1_migrations`, `sqlite_%`, `_cf_%` and `%_fts%` — FTS shadow
  tables must not be deleted directly; the triggers keep the index in step.

---

## Design direction: multi-region, and GDPR erasure

Cloudflare runs in many locations and residency must be a design input, not an afterthought.
The goal is to go from nothing to servers in several countries with users provisioned, and
to **take a user and their data down** wherever it lives.

### Three layers, because they have different lifecycles

| Layer | Holds | Personal data? |
|---|---|---|
| `fleet.json` | which instances exist and where: jurisdiction, region, url, db | no |
| `instances/<name>.json` | instance-level: **licence**, providers, settings | no |
| `tenants/<domain>.json` | domain, mailboxes, accounts, routing, mcpKeys | **yes** |

Bug #1 above is the argument for this: instance-level facts should not be repeated in every
tenant document, and a tenant must not silently depend on something it never declared.

### Erasure is per *subject*, not per tenant

A person may exist in several tenants across regions. The index
(`email → [(instance, domain, user_id)]`) must be **derived by scanning instances**, never
declared in JSON, or it will drift and you will miss data. Erasure then fits the existing
contract: a resource whose `apply` reports what exists and whose `remove` destroys it —
idempotent and auditable. Two hard parts: it must reach **R2 backups** (the scalable answer
is crypto-shredding — a per-subject key whose destruction is the erasure), and it must
**bypass trash retention**.

### What Cloudflare gives you — and the traps

Verified in this repo: Durable Object `jurisdiction` is **used nowhere**, and `wrangler.jsonc`
has no `jurisdiction`/`placement`/`dispatch`. Bindings present: D1, R2, Queues, Durable
Objects, AI.

- **Durable Objects** support `jurisdiction: "eu"` — real pinning. The realtime hub should use it.
- **R2** supports jurisdiction-scoped buckets.
- **D1 is not jurisdiction-pinnable** — a location hint with a single primary.
- **Workers execute globally by default.** So DO/R2 jurisdiction is *not* sufficient for a
  "no US processing" requirement; that is Data Localization Suite / Regional Services /
  Customer Metadata Boundary (Enterprise), and it should be confirmed with Cloudflare
  rather than assumed.
- **Traps: Queues, KV and Analytics Engine are global.** Keep PII out of queue payloads
  (carry the R2 key, not the MIME) and out of logs. Email Routing's ingress location is an
  open question worth verifying.

### Getting a user to their instance

Key by **domain**, not user: a mailbox domain belongs to exactly one instance, so MX already
delivers correctly and `.well-known` on that domain gives mail clients the right endpoint —
no global directory on the mail path. For web login, either a per-tenant hostname
(Cloudflare for SaaS / Custom Hostnames) or a thin global login that resolves email-domain →
instance and redirects with a short-lived one-time handoff token. **Keep sessions
instance-local** — a global session store would itself be the cross-border flow you are
avoiding.

### Scaling out

Jurisdiction → instance(s) → domains. Splitting one instance into two is a *fleet mapping*
change; tenant documents do not change, only which folder they sit in. Because MX/DNS is
per-domain, **moving** an existing domain between instances is the invasive operation — so
pick the instance at domain creation and treat relocation as a planned migration.

---

## Status

`tsc` and `eslint` clean; **28 tests** pass in well under a second with no D1, no network and
no bindings. Verified end to end on a disposable local instance (reset → provision → status
→ idempotent re-apply → teardown) and against the **live** instance for status, licence and
cleanup. `src/` untouched throughout.
