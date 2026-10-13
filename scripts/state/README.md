# `scripts/state` — the reconciler

Declarative, idempotent **state reconciliation for a Mailflare instance**. JSON documents
are the source of truth; one loop makes the instance match them.

Everything the system can do — reset the instance, onboard a domain, mailboxes, accounts,
routing rules, MCP keys, the licence, web push — is a **Resource** with a uniform
`status` / `apply` / `remove`, so `--status` and `--cleanup` work for every capability and
there is no per-capability command.

---

## Hard constraint: do NOT modify `src/`

This system must **never** change the application. It drives `src/` through the app's HTTP
API and its database; those endpoints are the contract, and the app is the product.

Everything the reconciler does is implemented here, in `scripts/state/`. Where a capability
genuinely cannot be completed from the scripts, the command **says so and names the file** -
it never fails silently and never implies completeness it does not have:

```bash
npm run state -- --source-changes
```

That catalogue is `src-changes.ts`, and a test asserts every entry points at something under
`src/` (or `worker.ts`) with a usable reason - so the code and this file cannot drift.

Deploying a server is a thin passthrough for the same reason: it shells `npm run build` and
`npm run deploy:worker -- --env <name>`, and creates nothing. Reimplementing `wrangler d1
create` - parsing its output, detecting "already exists", recovering a half-finished attempt -
would be rebuilding wrangler for no gain.

| Cannot be done from here | Where the change goes | Why it cannot be worked around |
|---|---|---|
| Erase a subject from **backup history** | `src/lib/backups/` + restore | A backup holds every subject; rewriting one would destroy other people's data. Crypto-shredding — a per-subject key whose destruction *is* the erasure — is the fix. |
| Attribute **`ai_usage`** rows to a person | `src/db/schema/index.ts:755` (`aiUsage`) | No user/owner column, so erasure cannot find them. |
| Pin the **realtime Durable Object** to a jurisdiction | `worker.ts:44`, `src/lib/realtime/utils.ts:61` | `getByName()` takes a jurisdiction; without it residency is not guaranteed. |

## Read this first — current state

The live instance was wiped by a `--fresh` test and has now been **restored from its
documents** using the new instance layer.

| | |
|---|---|
| Live instance | https://mailflare.gedw99.workers.dev |
| Root admin | `root@amplifycms.com` / `fresh-admin-2026` |
| Restored | `amplifycms.com`, `amplifycms.net`, `ubuntudesign.com` — domains, mailboxes, accounts, routing rules, MCP keys |
| Cloudflare side | untouched throughout — `--fresh` only resets the database |

Accounts created during the restore printed one-time passwords; put them in
`passwordEnv` (e.g. `MAILFLARE_PROV_PASSWORD`) to supply them instead.

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
| `--data-subject <email> --erase` | destroys that person's rows **and their R2 objects** |

Always `--dry-run` or `--status` first. `--fresh` touches the database only: Cloudflare MX,
Email Routing and DNS survive, so on a live instance it **orphans infrastructure**.

## The model: it is Terraform

Point the CLI at a project folder and it reconciles the server, the instance and the tenants
to match. Three verbs, as you would expect:

| Verb | Does |
|---|---|
| `plan` | read-only: what exists vs what the documents declare (alias of `--status`) |
| `apply` | make it so — the default |
| `destroy` | remove what the documents declare, the server included (alias of `--cleanup`) |

```bash
npm run state -- --project mailflare plan
npm run state -- --project mailflare apply
npm run state -- --project mailflare destroy --confirm-destroy
```

**One deliberate difference: there is no state file.** Terraform needs one because cloud APIs
are hard to query, and a stale state file is the source of most of its pain — the plan and
reality disagree. Here, existence is *queried* every run (D1, the Cloudflare API,
`server.json`), so drift between a state file and the world cannot exist. The documents are
the desired state; the world is the actual state; there is nothing in between to rot.

**The plan is a real diff.** One line per resource, an action, and a reason:

```
Plan for ubuntusoftware.net: 5 to create, 0 to update, 0 to destroy

  + domain.ubuntusoftware.net                             onboard (publishes MX)
  + mailbox.office@ubuntusoftware.net                     personal
  + mailbox_access.support.gerard.webb@ubuntudesign.com   full_access
```

`plan` is a method on the Resource contract, called over the **same ordered registry** apply
uses, publishing the same mailbox ids into `RunState` so routing rules and MCP keys can
resolve themselves. So **the plan and apply are the same walk** — a plan built from a parallel
implementation could promise something apply would not do, and this one cannot. That is what
makes it safe to read before a destroy.

## The order you actually do things

**1. Deploy a server** (once per server). This shells the repo's own deploy path and records
the server in the fleet — it creates no cloud resources:

```bash
# the project folder holds server.json (database, jurisdiction); the env.<name> block in
# wrangler.jsonc must agree with it - the two are checked against each other, not merged
npm run state -- --deploy eu1 --dry-run     # the two commands it will run, and what it records
npm run state -- --deploy eu1               # build, deploy, record the origin
npm run state -- --undeploy eu1 --dry-run   # its inverse: undeploy and deregister
npm run state -- --undeploy eu1 --confirm-destroy

#    The top-level config in wrangler.jsonc is itself a server — the DEFAULT environment,
#    deployed by `npm run deploy` with no --env — so it needs no env block. Every additional
#    server does. `--project <name>` deploys whichever kind is missing, so you rarely call
#    --deploy by hand.
```

**2. Reset it and give it a primary admin.** Nothing else in the app can do this.

```bash
npm run state -- --fresh --project eu1 --admin-email root@example.com --admin-password '…'
```

**3. Run a project.** A project is one folder: its `instance.json` (the server's facts), then
every tenant in it, in one process under one admin key.

```bash
npm run state -- --project mailflare            # instance.json, then every tenant
npm run state -- --project mailflare --status   # drift report, writes nothing
npm run state -- --project mailflare --dry-run  # what would change
```

**Pointing at a folder reconciles the server too, not just its contents.** If the project is
not registered (its `server.json` has no origin) it is deployed first; if it is, it is left
alone, so this is idempotent. One command per project, whether that project is one tenant or
a hundred.

```bash
npm run state -- --project mailflare --cleanup                     # everything goes: tenants, then the server
npm run state -- --project mailflare --cleanup --confirm-destroy    # ...and actually undeploy
```

**4. Change things over time.** Edit a document and run it again — every resource is
idempotent and reconciles drift, so this is the only supported way to change things.

```bash
npm run state -- --project mailflare
```

**5. Tear down.** Reverse order, and safe to re-run. `--project <name> --cleanup` removes
the tenants *and* the server (the Worker — undeploying needs `--confirm-destroy`); the
database, bucket and queues are left alone and their exact wrangler commands printed, because
this system does not create them either.

```bash
npm run state -- --project mailflare --cleanup --disable-accounts --confirm-destroy
npm run state -- --spec <path> --cleanup --disable-accounts --remove-domain   # one tenant
```

**Everything, and the checks:**

```bash
npm run state -- --all --dry-run                # every project in specs/projects/
npm run state -- --all --concurrency 4          # a few in flight, for thousands
npm run state:test                              # 37 tests, no D1/network/bindings
npm run state:typecheck
```

**One-off and global** (these need no domain and no project):

```bash
npm run state -- --domain <host> --roles a,b,c  # ad hoc, no document
npm run state -- --plan team                    # licence
npm run state -- --license-status
npm run state -- --push                         # web push round trip
npm run state -- --steps                        # VAPID rotation runbook
npm run state -- --source-changes               # what needs a src/ change, and where
```

**Data subjects** — the index, and the erasure:

```bash
npm run state -- --data-subject <email>              # where one person's data lives (read-only)
npm run state -- --data-subject <email> --erase --dry-run   # what would be destroyed
npm run state -- --data-subject <email> --erase             # DESTROY it
```

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
  "mcpKeys":   [ { "name": "agent", "mailboxes": ["office"] } ]
}

// license / push / fresh are NOT tenant sections — they belong to the instance document
// (specs/instances/<server>.json), applied before the tenants. A mailbox `access` grant
// must name a LOCAL user the document creates; an external address cannot resolve.
```

`specs/` holds one document per domain. `example.json` (template) and `_*.json`
(`_sandbox.json`, a runnable dev fixture) are **skipped by `--all`**.

---

## Standing up a new server

This is the point of the whole system: from nothing to a provisioned instance with no manual
clicking. Nothing else in the app can do it — `POST /api/auth/register` creates the first
admin but also demands Turnstile and a domain, so it is unusable as a bootstrap.

```bash
# 1. Add an env.<name> block to wrangler.jsonc - its own name, d1 database_id, r2 bucket and
#    queues - then deploy it. This shells the repo's own deploy path and registers the server:
npm run state -- --deploy eu1 --dry-run   # the two commands it will run, and what it records
npm run state -- --deploy eu1             # npm run build + npm run deploy:worker -- --env eu1
#    It creates NO cloud resources (that is wrangler's job) and needs no src/ changes. The
#    env block is the source of truth for the database; without one it stops rather than
#    inventing a database_id. The Worker `name`, CF_EMAIL_WORKER_NAME and the
#    WORKER_SELF_REFERENCE service must still agree.

# 2. Reset it and give it a primary admin. The instance document is applied FIRST, so
#    server-wide facts (the licence) stop being repeated in every tenant document:
#    specs/instances/<server>.json — copy instances/example.json
npm run state -- --fresh --instance mailflare --admin-email root@example.com --admin-password '…'
#    (this runs `wrangler d1 migrations apply DB --remote` first)

# 3. Run the project (its instance document, then every tenant), then confirm
npm run state -- --project mailflare
npm run state -- --spec scripts/state/specs/<domain>.json --status
```

The app now shows its normal login, and `root@example.com` is the primary admin.

## Everyday workflow

- **Add a tenant** — drop `<domain>.json` into the project folder and `npm run state --
  --project <name>`. If the domain is not onboarded, add `--onboard` (publishes MX).
- **Server-wide change** (licence, web push) — edit `specs/instances/<server>.json` and pass
  it as `--instance`; it is applied before the tenant documents, in the same run and key.
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
├── subject-scope.ts      where a data subject's data lives — the erasure index
├── specs/
│   └── projects/           ONE FOLDER PER PROJECT — the thing a user runs
│       └── mailflare/
│           ├── server.json        the SERVER: database, origin, jurisdiction
│           ├── instance.json      the instance: licence, web push
│           ├── amplifycms.com.json  the tenants
│           └── ...
│       ├── example/        the template (skipped by --all)
│       └── _sandbox/       a runnable dev fixture (skipped by --all)
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
   rules and DNS survive, so a from-zero reset on a live instance *orphans* them. It counts
   the domains and warns before wiping — in `--dry-run` as well as a real run — which makes
   it visible; making tenant de-provision own both sides is still the real fix.
3. **Specs are one flat layer.** They should split into `fleet` / `instance` / `tenant` —
   see *Design direction*.
4. **The migrations exit code: cause found.** Wrangler's *confirmation prompt* path was the
   unreliable one — it applied every migration and still exited non-zero. The spawn now sets
   `CI=1` to skip the prompt, and `schemaPresent` remains the real proof regardless, so this
   is fixed at both ends.
5. ~~Mass runs are sequential.~~ **Done**: `--concurrency <n>` runs documents in bounded
   batches, still one process and one admin key. Defaults to 1, so nothing changed unless
   you ask.
6. **Erasure exists but does not reach backups.** `--data-subject <email>` reports and
   `--erase` destroys every row and R2 object. Backup history and trash retention are still
   out of scope, so the guarantee is "gone from the live instance", not yet "gone". See
   *Data subjects* below.
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
- **A mailbox `access` grant must name a LOCAL user**, not an external address. Grants are
  written to `mailbox_access`, which needs a user id; an outside address silently fails the
  run. Three checked-in documents had stale grants of exactly this kind.
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

**Built:** a project folder declares its own server (`server.json`: database, origin,
`jurisdiction`, `region`), so the **fleet is derived by scanning the folders** — there is no
separate registry to drift, and `--instance <name>` needs no `--url`/`--db`. `--deploy` and
`--destroy` are inverses over the same structure. **Declaring jurisdiction is intent, not
enforcement** — pinning where a Worker actually executes needs the source changes
`--source-changes` lists, and the realtime Durable Object is the one already identified.

### Data subjects — the index, not the erasure

`npm run state -- --data-subject alice@acme.de` finds the account and reports every table
holding a row for that person, biggest first, plus the total. Read-only, exits non-zero if
anything remains, so it is usable as a check. It needs no domain and no document.

The scope in `subject-scope.ts` is **derived from the database** (`pragma_table_info`), not
from the schema file, so it describes what an erasure would actually run against. It is
data, not SQL: `store/live.ts` builds the predicate, and a table that links both ways
(`messages` names a user *and* a mailbox) is ORed.

Indirectly-owned tables are resolved through their parent chain (`INDIRECT_SCOPE`):
`message_attachments` -> messages, `agent_chat_messages` -> agent_conversations,
`webhook_deliveries` -> webhooks, and `shared_attachment_links` -> message_attachments ->
messages in two hops. The predicate builder lives in `store/live.ts`; the links are data.

`ai_usage` has **no user, owner or mailbox column at all**, so a row cannot be attributed
to anyone. It is reported as unattributable rather than counted as clean - a distinction
the report keeps, because "we found nothing" and "we cannot look" are different answers.

**Erasure is implemented**, on top of that index. `--erase` deletes every in-scope row in a
single SQL batch (children before parents, the `users` row last, so it cannot half-apply)
and the objects in `SUBJECT_OBJECT_KEYS` — because deleting rows without the bytes leaves
the mail itself behind. It then re-reports and fails if anything remains, so the result is
verified rather than assumed. `--erase --dry-run` shows exactly what would go first.

- the rows: every table in `SUBJECT_SCOPE` plus the `INDIRECT_SCOPE` chain
- the bytes: `SUBJECT_OBJECT_KEYS` — `messages.raw_r2_key`, `message_attachments.r2_key`,
  `drive_items.r2_key`, `users.avatar_key`. **Deleting rows without these leaves the mail
  itself behind**, which is the whole trap
- the order: children before parents, and the `users` row last

Two deliberate exclusions, printed by the command rather than hidden: **`domains`** are
infrastructure — deleting one orphans its Cloudflare DNS and Email Routing, so remove it
with `--cleanup --remove-domain` — and **`ai_usage`** cannot be attributed to anyone.

**Trash retention is not an obstacle** — worth stating because it looks like one: the
erasure deletes rows with no `status` filter at all, so trash, spam and retention windows
cannot hold data back. (Retention governs the app's *scheduled* purge, not this.)

Still open: **backup history** — which cannot be closed from here. `--erase` prints a
`SOURCE CHANGE NEEDED` block naming `src/lib/backups/` and why, rather than implying a clean
bill of health. See *Hard constraint* above and `npm run state -- --source-changes`.

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
