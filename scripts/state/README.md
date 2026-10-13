# scripts/state

**A Terraform-like reconciler for a fleet of Mailflare servers.** The JSON documents are the
desired state: `plan` shows the diff, `apply` makes it so, `destroy` removes it. One folder
per server, one codebase, any number of servers, each in its own Cloudflare jurisdiction.

## Run it, in this order

This is the whole system, start to finish, on every spec. Each step must pass before the next.

```bash
# 0. Once per machine: Cloudflare access. Either works.
npx wrangler login
#    …or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment or the keychain.
#    The token is also what a NEW server is given as its CF_TOKEN, unless CF_TOKEN is set.

# 1. After any change to this tool: the fast checks. No network, under a minute.
npm run state:check                 # types + lint + unit tests, conformance on the in-memory store included

# 1b. Before trusting a change with the fleet: the same conformance, on real Cloudflare.
npm run state -- conform            # two disposable servers: built, edited, a person erased, destroyed, rebuilt (~13 min)
npm run state -- conform --quick    # the same without the destroy and rebuild (~11 min)

# 2. See what the fleet needs. Writes nothing.
npm run state -- plan               # mailflare, mailflare-eu, and the router

# 3. Make it so. Creates servers that do not exist yet (database, bucket and queues in their
#    jurisdiction, the Worker, its secrets, its schema, its admin), takes each server's first
#    backup, reconciles every tenant, and publishes the router. It adds and changes on its own
#    word; anything the plan marks `-` is only removed with --confirm-destroy.
npm run state -- apply

# 4. Confirm. Exit 0 means every document on every server is reconciled…
npm run state -- plan
#    …and this, read-only, that every recorded login signs in, each server's data is where its
#    document says, its latest backup completed, nobody declared erased is on a server or in a
#    backup of one, and the front door sends each domain to its own server.
npm run state -- verify

# 5. The logins and keys it created, to use and to hand out.
ls scripts/state/credentials/       # one file per server, and one per person; never committed
npm run state -- logins             # every person's login as JSON, ready to send each of them

# 6. On a schedule, every few minutes: keep each server running in its country. Cloudflare stops
#    honouring a placement for a while now and then; this notices in one request and moves it.
npm run state -- place              # ✓ mailflare-eu: answers from DE        (about two seconds)

# 7. When someone must be erased (a takedown). Taking them out of the JSON only disables them.
npm run state -- subject sam@acme.de        # where they are, on every server, and what to write
#    …write them under "erased" in a document of that server, then steps 2 and 4, and between them:
npm run state -- apply --confirm-destroy    # their account, mail and files — and out of every backup
```

Run it again any time: every step is idempotent, and one that stopped half way is finished
by running it again. When the app's code or `wrangler.jsonc` changes, `npm run state -- deploy`
rolls it out to every server before step 2: one build, then the servers four at a time, each
about twenty seconds. Add `--concurrency 8` to steps 2-4 to drive servers
in parallel. `npm run state -- apply --rotate-passwords` gives every declared account a new
password and every declared key a new secret, for when the folder must hold all of them.

**The fleet today** (last run: 6 of 6 documents reconciled, every recorded login signs in, each server's latest backup completed):

| Server | Jurisdiction | Origin | Domains |
|---|---|---|---|
| `mailflare` | none (the default server) | https://mailflare.gedw99.workers.dev | `amplifycms.com`, `amplifycms.net`, `ubuntudesign.com` |
| `mailflare-eu` | `eu`; runs in Germany (answers from Frankfurt); home to the EU | https://mailflare-eu.gedw99.workers.dev | `ubuntusoftware.net` |
| router | — | https://mailflare-router.gedw99.workers.dev | sends each of the four to its server |

| Spec | What it is | Run |
|---|---|---|
| `mailflare` | the default server: `amplifycms.net` (small), `ubuntudesign.com` (medium), `amplifycms.com` (large) | steps 2-4, or `npm run state -- mailflare plan` |
| `mailflare-eu` | a server pinned to the EU jurisdiction: `ubuntusoftware.net` | steps 2-4, or `npm run state -- mailflare-eu plan` |
| `_sandbox` | the local dev instance, for trying documents with no Cloudflare at all: `small.test`, `medium.test`, `large.test` | `npm run dev`, then `npm run state -- _sandbox plan` and `apply` — or `_sandbox conform --quick` for conformance on your own machine |
| `specs/conformance/` | two disposable servers conformance builds, wipes and destroys — `mailflare-conformance` (EU) and `mailflare-conformance-2` (unpinned) — with no Cloudflare token, so they can touch no zone | step 1b; by hand: `npm run state -- mailflare-conformance plan --dir scripts/state/specs/conformance` |
| `example` | a template for a new server: `example.org` (small), `example.net` (medium), `example.com` (large) | `npm run state -- example plan` shows what building it would do; it is never applied — copy it |

## Requirements

What this system is for, and where each requirement is met. Kept current: a requirement that
is not met says so.

| # | Requirement | How it is met | Proven by |
|---|---|---|---|
| 1 | The documents are the desired state; plan, apply and destroy agree | one walk over declared items for every verb ([driver.ts](driver.ts)); no state file | conformance: converges, and a second apply writes nothing |
| 2 | Editing the JSON does what Terraform would: add, change, **and remove** | every run reads the servers and compares; what a written section no longer holds is a `-` | conformance: one of every kind of thing is added, changed and removed, and each plan must say exactly that |
| 3 | Works on every spec | every project loads and validates in the unit tests | `state:check`; `verify` on the live fleet |
| 4 | A fleet: many servers at once | each project runs against its own server through its own store and key, with one shared `--concurrency` limit ([fleet.ts](fleet.ts)) | conformance runs two real servers at once; the live fleet at `--concurrency 4` |
| 5 | Hundreds of servers, easily | a server is a folder; its Worker, database, bucket and queues are named after it and created by `apply` ([deploy.ts](deploy.ts)). One build is every server's, so a rollout is uploads, several at a time | conformance: built from their folders, destroyed, and built again; both rolled out at once from one build |
| 6 | GDPR: data stays in its jurisdiction, and a server runs in a chosen country | `server.json` declares `jurisdiction` (database, bucket, Durable Objects: a guarantee) and `country` (the Worker is placed there, and kept there: a placement is a hint Cloudflare stops honouring now and then, so each country is named several ways and a server is moved to the next) | conformance and `verify` ask Cloudflare: database and bucket in `eu`, the placement set as declared — and, as a fact, that the data center which answered is in that country ([colos.json](colos.json)). Conformance puts each server in another country and requires `apply` to bring it home. Limits under Outstanding |
| 6a | A tenant lives on a server that is home to its country | a tenant's `country` must be one its server `serves`; someone new is suggested the server for their country | unit: a tenant on the wrong server is refused at load. Conformance and `verify`: the router's suggestion per country |
| 7 | A person is always sent to their home server, wherever they are | routing is by identity, never geography: a domain's mail is delivered to its own server's Worker, and the router sends a sign-in to the server holding the domain ([router.ts](router.ts)) | conformance: a router across two servers sends each domain home; `verify` asks the fleet's own |
| 8 | Every aspect is controlled: administration, mail, calendar, drive, integrations | licence, settings, backups; signatures, auto-replies, aliases, folders, inbox rules, the assistant; preferences, templates, contacts, booking pages, events, drive folders, API keys, webhooks | conformance: each is added, then read back from the deployed app signed in as the person |
| 9 | Mail really flows | — | conformance: messages put on the real inbound queue arrive in a mailbox, through an alias, filed by a rule, stored or turned away by a domain rule; the webhook is called |
| 10 | Every user name and password comes out, as JSON to send each person | [credentials/](credentials/): one file per server and one per person; `npm run state -- logins` | conformance and `verify`: every recorded login signs in |
| 11 | Each spec has small, medium and large things to try | `_sandbox` and `example` hold three tenants of increasing size | unit: project sizes |
| 12 | Destructive actions need approval | `destroy`, `reset`, erasures and removals are previews until `--confirm-destroy` | conformance: each is refused first, then approved |
| 13 | A person's data can be found | `subject <email>`: on every server, their rows by table, their objects, the backups holding them, and what other people's data names them | unit: the scope covers the real schema, every table classified |
| 16 | A takedown erases a person everywhere this system keeps them, backups included, and it lasts | a document's `erased` list: account, mailboxes (through the app, so Cloudflare stops routing to them), rows, objects, and every backup in the bucket rewritten without them. The entry is a tombstone, checked on every run | conformance, on real servers: gone from the database, the bucket and every backup; the rewritten backup **restores**; a copy that still held them, restored, is found by the digest alone and erased again. `verify` checks every tombstone against every backup |
| 17 | Backups are provisioned, and proven to work | `backups` in `instance.json`; the first is taken as the server is provisioned, so one that cannot be made fails the `apply` | conformance: a backup is taken, read, rewritten and restored. `verify`: each server's latest backup completed, and is not old |
| 14 | It can be changed and improved without fear | conformance is part of the CLI and runs the same properties on real servers and on the in-memory store ([conform.ts](conform.ts)) | see Verifying |
| 15 | Lean, and this file says how to run all of it | you are reading it | — |

## Commands

```bash
npm run state -- <target> <verb> [flags]

npm run state -- plan                         # the whole fleet, and the router
npm run state -- apply
npm run state -- mailflare plan               # one project
npm run state -- mailflare destroy            # what it WOULD remove
npm run state -- mailflare destroy --confirm-destroy
npm run state -- mailflare reset --confirm-destroy    # wipe it, make its admin, apply
npm run state -- <path>/<file>.json apply     # one document, on its project's server
npm run state -- verify                       # the live fleet, read-only: logins, jurisdictions, the front door
npm run state -- conform [--quick]            # does it all still work? on real, disposable servers
npm run state -- deploy                       # roll the current code out to every server
npm run state -- place                        # keep every server answering from its country (for a schedule)
npm run state -- router plan|apply|destroy    # the front door alone
npm run state -- logins                       # every login on record, as JSON (or: <project> logins)
npm run state -- subject <email>              # where one person's data is, on every server, and how to erase them
npm run state -- colos                        # pull Cloudflare's data-center list again
```

The target is a project name, a folder, or a document; none means every project. `<verb>
<target>` reads the same as `<target> <verb>`. Exit status is 0 when everything is as the verb
wants it and 1 when it is not, so a plan with work to do exits 1.

| Flag | |
|---|---|
| `--dir <path>` | projects folder (default `scripts/state/specs/projects`) |
| `--concurrency <n>` | documents in flight across the run (default 1) |
| `--credentials <path>` | where logins and keys are written (default `scripts/state/credentials`) |
| `--rotate-passwords` | give every declared account a new password, and record it |
| `--local` | the local dev instance, never a deployed one |
| `--db <name>` / `--url <base>` | override the server document |
| `--confirm-mx` | onboard a domain whose mail someone else receives |
| `--confirm-destroy` | actually destroy, reset, erase whom a document declares erased, or remove what it no longer holds; without it you get the plan |
| `--source-changes` | what this system needs from `src/`, and what it changed there |
| `--steps` | the Web Push (VAPID) key-rotation runbook |

Plan symbols: `+` create, `~` update, `-` remove, `·` unchanged or kept, `?` on the server
and nobody's to manage, `!` a problem that cannot be applied until the document or the world
is fixed.

## Documents

```
specs/conformance/              the servers conformance builds, wipes and destroys
specs/projects/                 the fleet
└── mailflare-eu/               the folder names the server — and its Worker, database, bucket, queues
    ├── server.json             where it lives
    ├── instance.json           the instance
    └── <domain>.json           a tenant, named after its domain
```

`example/`, folders starting with `_`, and servers marked `disposable` are left out of a fleet
run; files starting with `_` are drafts. Everything is validated before anything runs, with the field path of each mistake.

**server.json**

```jsonc
{ "country": "de",              // where it RUNS: its Worker is placed beside a cloud region in that country
  "serves": ["eu", "ch"],       // whose tenants are at home here ("eu" is every member); default: its own country
  "jurisdiction": "eu" }        // where its data is KEPT: "eu" | "fedramp", a guarantee. Or "region": "weur" (a hint)
// "placement": "gcp:europe-west3" names the exact cloud region, for a country with no built-in one.
// Written back by apply: "databaseId", "url". Give "url" yourself for a custom domain.
// "local": true is the dev instance. "template": true can be planned, never applied.
// "disposable": true keeps it out of fleet runs and the router: it is run by name.
// "managesDns": false gives it no Cloudflare token: it can touch no zone, and any name will do for a domain.
```

**instance.json** — what is true of the whole server

```jsonc
{
  "license":  { "plan": "team" },                     // community | pro | team
  "settings": { "appName": "Acme Mail", "outboundAttachmentMaxMb": 25, "driveStorageLimitGb": 10,
                "assistant": { "enabled": true, "provider": "compatible", "preset": "openai",
                               "models": ["gpt-4o-mini"], "apiKeyEnv": "OPENAI_API_KEY" },
                "resendApiKeyEnv": "RESEND_API_KEY",
                "aws": { "accessKeyIdEnv": "AWS_ACCESS_KEY_ID", "secretAccessKeyEnv": "AWS_SECRET_ACCESS_KEY", "region": "eu-west-1" } },
  "backups":  { "enabled": true, "schedule": "daily", "retentionDays": 30 },   // see Backups, below
  "erased":   ["sha256:9f86d0…"],                     // people who must not exist here: see Removing a person
  "push":     { "to": "you@example.com" },            // not a state: declaring it runs the round trip
  "fresh":    { "admin": { "email": "admin@acme.de" } },  // the primary admin of an empty or reset instance
  "admin":    { "preferences": { "timeZone": "Europe/Berlin" },   // the primary admin's own settings:
                "webhooks": [ { "url": "https://hooks.partner.example/mail", "events": ["message.inbound"] } ],
                "contacts": [], "drive": { "folders": ["Policies"] } }   // everything an account can say, bar a mailbox
}
```

A secret is never written in a document: a field ending in `Env` names an environment
variable (or keychain entry) that holds it. Only declared fields are managed.

### Changing a document

Nothing is recorded locally. Every run reads the servers and compares them with the JSON:

| You | `plan` shows | `apply` |
|---|---|---|
| add an entry | `+` | creates it |
| change a field | `~` | updates it in place |
| delete an entry | `-` | removes it, with `--confirm-destroy`; without, it is left and the run exits 1 |
| write someone under `erased` | `-` | erases them, with `--confirm-destroy`: see [Removing a person, and erasing one](#removing-a-person-and-erasing-one) |

**A section you write is complete; a section you leave out is not managed.** So:

- `mailboxes` present: any other mailbox of the admin's on the domain is removed (with its mail).
  An account's own mailbox belongs to the account, not to this section.
- a mailbox with an `access` list: any other grant on it is revoked. `"access": []` means none;
  no `access` key means "not managed".
- `accounts` present: anyone else with a login on the domain is **disabled**, and their mailbox,
  mail and files are kept. Never the primary admin. Deleting a person is `erased`, not this.
- `routing` present: any other domain rule is removed.
- `mcpKeys` in any document of the project: a key no document names is removed. This one is
  checked only when the whole project is run, because one document cannot speak for the others.
- a domain on the server that no document declares is reported with `?` and never removed.

Renaming is a removal and a creation: a mailbox's `role`, or a rule's `pattern` or `action`,
is its identity. Three things are fixed when they are created and cannot be edited afterwards:
a domain's `onboard` options, whether a mailbox is shared, and a server's jurisdiction. A
password only changes with `--rotate-passwords`.

**`<domain>.json`** — one tenant

```jsonc
{
  "domain": "acme.de",
  "country": "de",                 // its home country: the server must be one that serves it, or the documents are refused
  "onboard":   { "enableRouting": true, "receivingProvider": "cloudflare", "sendingProvider": "cloudflare" },
  "mailboxes": [ { "role": "office", "displayName": "Office", "signature": "<p>Acme</p>" },
                 { "role": "support", "shared": true,
                   "access":    [ { "email": "sam@acme.de", "permission": "read_only" } ],
                   "autoReply": { "enabled": true, "subject": "We have your message", "body": "…" },
                   "aliases":   ["help"],
                   "folders":   [ { "name": "Invoices", "color": "#2563eb" } ],
                   "rules":     [ { "field": "title", "value": "invoice", "folder": "Invoices" },
                                  { "value": "noreply@spam.example", "action": "spam" } ],
                   "assistant": { "enabled": true, "autoDraft": false, "instructions": "Be brief.", "dailyLimit": 25, "reviewer": "sam@acme.de" } } ],
  "accounts":  [ { "username": "sam", "name": "Sam", "role": "user",
                   "resetEmail": "sam@elsewhere.example", "forwardingEmail": null, "canManageMailboxes": true,
                   "preferences": { "timeZone": "Europe/Berlin", "keyboardShortcuts": true, "spamProtection": true,
                                    "trashRetentionDays": 30, "showFullRecipientAddresses": false },
                   "mailbox":   { "signature": "Sam, Acme", "folders": [ { "name": "Receipts" } ] },
                   "templates": [ { "name": "Welcome", "body": "Hello, and welcome." } ],
                   "contacts":  [ { "email": "ops@partner.example", "name": "Ops", "blocked": false } ],
                   "calendar":  { "bookingUsername": "sam",
                                  "bookingPages": [ { "name": "Intro call", "durationMinutes": 30, "weekdays": [1, 2, 3, 4],
                                                      "startTime": "09:00", "endTime": "17:00", "timeZone": "Europe/Berlin" } ],
                                  "events": [ { "title": "Standup", "startsAt": "2026-11-02T09:00:00Z", "endsAt": "2026-11-02T09:15:00Z", "repeat": "weekdays" } ] },
                   "drive":     { "folders": ["Contracts/2026", "Scans"] },
                   "apiKeys":   [ { "name": "ci", "scopes": ["send", "read"] } ] } ],
  "routing":   [ { "pattern": "*", "action": "forward", "forwardTo": "ops@example.com", "keepCopy": true, "mailbox": "support" },
                 { "pattern": "no-reply", "action": "reject", "rejectReason": "No such user" } ],
  "mcpKeys":   [ { "name": "acme-agent", "mailboxes": ["support"], "scopes": ["mcp:read", "mcp:draft"] } ],
  "erased":    ["kim"],            // kim@acme.de must not exist here; or "sha256:…" to keep no address
  "teardown":  { "accounts": "disable", "domain": "remove" }
}
```

What each part controls, and what deleting it from the document does:

| | Where | Deleted from the document |
|---|---|---|
| **Mail** — signature, auto-reply | a mailbox entry; an account's `mailbox` (the one of its own name) | left as it is |
| aliases, folders, inbox rules | the same | removed (mail in a removed folder stays in the mailbox) |
| the assistant for a mailbox | `assistant` on the same | left as it is |
| templates | an account | removed |
| contacts | an account | kept — they are the person's |
| **Calendar** — booking username, booking pages | `calendar` on an account | pages removed |
| events | `calendar.events` | kept — a calendar is its owner's |
| **Drive** — folders, as paths | `drive.folders` | kept — they may hold files |
| the per-user storage limit | `settings.driveStorageLimitGb` in instance.json | — |
| **Integrations** — API keys | an account | removed; a new key goes to the credentials folder |
| webhooks | `admin` in instance.json only — the app lets nobody but the primary admin keep them | removed; a new one's signing secret goes to the credentials folder |
| **The person** — preferences, reset and forwarding addresses, what they may manage | an account | left as it is |
| **The primary admin** — all of the above for them | `admin` in instance.json | as above |

A single value is only managed while it is written; a list is complete once it is written.
The lists that are a person's own — contacts, events, drive folders — are added to and never
taken from, whatever the document says.

- An account's password is generated and written to the credentials folder. `password` or
  `passwordEnv` sets one instead. An account owns a mailbox of its own name.
- An alias has no Cloudflare rule of its own: its mail arrives through the domain's catch-all.
  `forwardingEmail` needs a Pro or Team licence to take effect.
- A grant, a rule's `mailbox` and a key's `mailboxes` may name anything the same document
  creates. Anything that cannot resolve is a `!` problem, never a guess.
- A mailbox whose address a Cloudflare Email Routing rule already sends elsewhere is a `!`
  problem: the app will not take it over. Remove that rule in Cloudflare, or use another address.
- A key with no `mailboxes` reaches every mailbox, so that has to be written, not arrived at.
  Key names are instance-wide.
- `onboard` applies when the domain is first added. `teardown` says what `destroy` does to
  what it cannot simply delete; the default is to keep the domain and the accounts.
  `"accounts": "disable"` disables them and keeps what is theirs; `"accounts": "erase"` is a
  tenant leaving for good — each of its people is erased as `erased` would erase them, backups
  included, before the domain goes.
- A mailbox that is removed takes its mail with it: the rows, and each message's bytes in the bucket.

## Removing a person, and erasing one

Two different things. The documents say which.

| You | What happens | Undone by |
|---|---|---|
| take them out of `accounts` | the account is **disabled**: they cannot sign in. Their mailbox, mail, files and keys stay exactly where they were | putting them back |
| write them under `erased` | they are **erased**, as below | nothing |

So deleting someone from the JSON deletes nothing of theirs, and the plan says so on the line:
``- account.sam  not in the document: it is disabled, and its mail and files are kept — `erased` is what deletes a person``.

### A takedown

```bash
npm run state -- subject sam@acme.de                    # 1. where they are, on every server, and what stands in the way
# 2. in that server's <domain>.json: take them out of "accounts", and add  "erased": ["sam"]
npm run state -- mailflare-eu plan                      # 3. the diff, below
npm run state -- mailflare-eu apply --confirm-destroy   # 4. without the flag, it is left and the run exits 1
npm run state -- verify                                 # 5. nobody declared erased is on a server, or in a backup of one
```

```
- erased.sam@acme.de  declared erased: an account, 1 mailbox, 412 rows, 37 objects — and they are taken out of every backup
```

Step 4 does this, in this order, so that a run which stops is finished by running it again:

1. **Every backup in the bucket is read**, whether or not the app still has a record of it. One
   that holds them is rewritten without them — by the same scope as the database, then by
   what the database itself would have removed or blanked, so that it still restores. One
   that cannot be read, or that shows them owning a domain, is deleted: a backup nobody can
   check is one that may hold them.
2. **Their objects** — raw mail, attachments, drive files, avatars — are deleted from the bucket.
   If any cannot be, it stops here with nothing else changed.
3. **Their rows**, in every table that names them or a mailbox of theirs
   ([subject-scope.ts](subject-scope.ts), which a test holds to the app's schema).
4. **Their mailboxes**, through the app, which takes each address out of Cloudflare Email Routing.
5. **Their account**, last. Then any backup taken while this ran is rewritten too, and their
   login and keys leave the credentials folder.

An entry of `erased` is an address, a name on the tenant's domain, or `sha256:` and the digest
of the address — which `subject` prints, for when the document must not keep the address
either. `instance.json` may hold entries too, for any address. A person both declared and
erased is refused before anything runs.

**The entry is a tombstone: leave it there.** It is checked on every run. If a restore brings
them back — from a copy of a backup this system never reached, or Cloudflare's own recovery —
the next `plan` says `- erased.…` again and `verify` fails until it is applied. That is what
makes an erasure last, and it needs no more than the digest. Take it out only when no copy of
anything from before the takedown can still exist.

A whole tenant is taken down by its own document: `"teardown": { "accounts": "erase", "domain":
"remove" }`, then `npm run state -- <server>/<domain>.json destroy --confirm-destroy`. Its
shared mailboxes go with their mail, each person is erased, and the domain is removed. If a
restore ever brings the tenant back, the next plan says `? domain.<name>  on the server, and
no document declares it`.

### What a takedown does not reach

| | Why | So |
|---|---|---|
| Cloudflare's point-in-time recovery of the database | D1 keeps every database restorable to any minute of the last 30 days, and it cannot be shortened | it ages out by itself; the tombstone erases them again after any such restore |
| The Worker's logs | log lines name addresses, and Cloudflare keeps them for some days (`observability` is on in `wrangler.jsonc`) | they age out by themselves |
| What other people hold that names them | mail they sent, a contact in someone's address book: those are the other person's | `subject` counts them, so nobody is surprised |
| Copies that have left | a webhook receiver, a forwarding address, a backup someone downloaded | outside this system; a restore of such a backup is caught by the tombstone |
| Mail that arrives for them afterwards | their address is now one nobody has: a catch-all rule sends it where it says, and otherwise it is dropped, leaving nothing in the bucket | to refuse it instead, declare a `reject` rule for the address under `routing` |
| The primary admin, and whoever owns a domain | deleting them would delete every mailbox on it | a `!` in the plan; tear the tenant down instead |
| `ai_usage` | the table has no column saying whose a row is | see `--source-changes` |
| The documents | a name in a JSON file, and in the history of the repository it is committed to | write the digest, not the address |

### Backups

`backups` in `instance.json` switches the app's own backups on: `schedule` (`daily`, or
`weekly`/`monthly` with a `scheduleValue`), and `retentionDays` (`null` keeps them all).

- **The first is taken as the server is provisioned** — `+ backups.first` — not at the next
  02:00 UTC. A server whose backups cannot be made fails its `apply`, instead of being found
  out on the day one is needed. `verify` then checks that the latest completed and is not old.
- A backup is one JSON object in the server's own bucket, `backups/database/<id>/…json`, so it
  is in the server's jurisdiction. It holds every row, password hashes and provider secrets
  included, unencrypted.
- It is the database, **not the bucket**: message text is in it, raw mail, attachments and
  drive files are not, and nothing else backs those up.
- `exclude` leaves table groups out, and the app will not restore a backup that leaves any
  out. It is for exports, not for recovery.
- `destroy` never deletes a backup.

## A new server

```bash
cp -R scripts/state/specs/projects/example scripts/state/specs/projects/acme-eu
# In acme-eu/: remove "template" from server.json, set the jurisdiction, name each tenant file
# after its domain (the zone must be on this Cloudflare account), edit the documents.
npm run state -- acme-eu plan       # what it would create
npm run state -- acme-eu apply      # creates and deploys it, then reconciles its tenants
npm run state -- router apply       # tell the front door (or run the fleet-wide apply)
```

`apply` creates the database `acme-eu`, the bucket `acme-eu-raw` and the queues
`acme-eu-inbound|outbound|agent`, uploads the Worker with those bound, puts its secrets, applies
the migrations, records `databaseId` and `url` in `server.json`, and gives the empty instance
the admin `instance.json` names. `wrangler.jsonc` itself is the default server, `mailflare`,
and the template for all the others (each gets a generated `wrangler.acme-eu.json`, not
committed). `apply` creates a server only when it does not exist yet. To roll new code, or a
changed binding, out to the ones that do:

```bash
npm run state -- deploy             # every server: one build, uploads four at a time, then its migrations
npm run state -- acme-eu deploy     # one
```

### How long a deploy takes, and where the time goes

| | Measured | Whose time it is |
|---|---|---|
| the build | 8 s, **once per run** however many servers | ours |
| a server that exists | 15–30 s | Cloudflare's: taking the Worker (5 MB) and its triggers, queues and schedules |
| a server that does not exist yet | about 50 s | the same, plus its database, bucket, queues and secrets |
| in its country | about 5 s after the upload | Cloudflare's; the deploy waits for it and prints it |

**One build is every server's.** Nothing a build writes names a server except the config
wrangler deploys with (`dist/server/wrangler.json`), so that file is rewritten beside itself
for each server and the same build is uploaded to all of them. A fleet costs its uploads, not
a build each, and they run side by side. Keep it so: what differs between servers belongs in
a binding or a variable, never in the bundle.

`STATE_TRACE=1 npm run state -- <anything>` prints every command and request this tool makes
with how long it took, and the totals by kind at the end. Database statements go straight to
Cloudflare's API when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are on record (a third
of a second each); without them each one starts a `wrangler` (about a second).

Secrets a new server is given, when they are in the environment or keychain: `CF_TOKEN`
(required; falls back to `CLOUDFLARE_API_TOKEN`), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`, `GITHUB_UPDATE_TOKEN`, `GITHUB_UPDATE_REPO`.

## Home: country, jurisdiction, and getting there

A person belongs to one server — the one holding their domain — and is sent there by who they
are, never by where they happen to be. Three things say where "there" is:

| In `server.json` | Decides | How | Strength |
|---|---|---|---|
| `country` | where the Worker **runs** | a placement hint: Cloudflare runs it in the data center nearest a cloud region in that country (`de` → `gcp:europe-west3`, Frankfurt) | a hint, kept true by checking the fact: every response of a placed Worker carries `cf-placement`, naming the data center that answered. `plan` and `verify` fail when that is not in the country; `apply` and `place` move the server until it is |
| `jurisdiction` | where the data is **kept** | the database and bucket are created in it; the Durable Objects are pinned to it | a guarantee, for `eu` and `fedramp` |
| `serves` | whose tenants are **at home** here | a tenant's `country` must be one the server serves, or the documents are refused before anything runs | checked at load |

Which country a data center is in comes from [colos.json](colos.json): Cloudflare's data
centers by airport code (`FRA` → `DE`), saved from
[Netrvin/cloudflare-colo-list](https://github.com/Netrvin/cloudflare-colo-list). The same list
refuses a `country` Cloudflare has no data center in before anything runs. Cloudflare opens
data centers; when one answers that the list has not heard of, the check says so, and
`npm run state -- colos` pulls the list again and prints what changed.

### Keeping a server in its country

A placement takes effect about five seconds after a deploy — measured for new servers and
redeployed ones, in London and Frankfurt, and the deploy waits for it and says so. What does
not hold is that it *stays*:

- **Cloudflare stops honouring one placement target at a time**, for every Worker on it, old
  or new, for tens of minutes. Seen here in one evening: `aws:eu-west-2` (London) for about
  half an hour, then `aws:eu-central-1` (Frankfurt) for longer, then `aws:eu-west-2` again.
  While it lasts, those Workers run wherever a request arrives.
- **Another name for the same city goes on working.** During the Frankfurt lapse a Worker
  beside `gcp:europe-west3` or `azure:germanywestcentral` ran in Frankfurt throughout.
- **A Worker takes one target only** (Cloudflare refuses two), so it cannot carry its own
  fallback. But the target can be changed with one API call, in a second or two, with no upload.

So a country is named several ways ([spec.ts](spec.ts), `PLACEMENTS`), and a server is moved to
the next when the one it is on is not being honoured:

```
$ npm run state -- plan
~ server mailflare-eu: it is not answering from DE: Cloudflare is not honouring aws:eu-central-1 — apply moves it beside gcp:europe-west3
$ npm run state -- apply          # or, for this alone:  npm run state -- place
~ server mailflare-eu: it is not answering from DE: Cloudflare is not honouring aws:eu-central-1. Moved beside gcp:europe-west3, and it answers from DE (the data center FRA)
```

`npm run state -- place` does only this, for every server, in about two seconds when all is
well: put it on a schedule. Between a lapse and the next run, requests are processed where
they arrive; the data stays in its jurisdiction.

```cron
# every five minutes; it needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in its environment
*/5 * * * *  cd /path/to/mailflare && npm run --silent state -- place >> place.log 2>&1
```

It exits 1 when a server could not be brought home (every name for its country is being
ignored at once), which is the thing to alert on.

Every name in `PLACEMENTS` was *seen* to run in its country — 107 cloud regions were tried
and the answering data center looked up — not assumed from the region's name. `aws:eu-west-1`
is Ireland's and runs in London; both regions in the UAE run in Mumbai; so neither is in the
table. A `"placement"` in `server.json` names one exact region instead, and then there is no
other to move to.

So a server can run in a chosen country, on any plan, with nothing Enterprise. Changing
`country` or `placement` on a server that exists is a plan line of its own —
`~ server mailflare-eu: it runs wherever a request arrives, not beside aws:eu-central-1` — and
`apply` deploys it again.

Getting there:

- **Mail**: a domain's MX points at Cloudflare Email Routing, whose rules deliver to that
  server's own Worker.
- **Sign-in**: the router (`<worker>-router`, generated from the project folders) maps a
  domain to its server and redirects. The address is split in the browser and only the domain
  is sent, so the router never sees whose mailbox it is. It holds no data and proxies nothing.
  `GET /.well-known/mailflare-home?domain=acme.de` answers with the server and its jurisdiction.
- **Someone new**, with no domain yet: `GET /.well-known/mailflare-home?country=de` — or with
  no country, the one the request came from — answers with the server that country is at home
  on. That is a suggestion for where to put a new tenant. It never routes anyone who has a domain.

What these do **not** cover is listed under Outstanding. Read it before making a residency claim.

## Credentials

Everything under `scripts/state/credentials/` is mode 600 and git-ignored.

```
credentials/
├── mailflare-eu.json               everything for the server
└── mailflare-eu/
    └── sam@acme.de.json            one person's login: the file to send them
```

```jsonc
// mailflare-eu/sam@acme.de.json — also what `npm run state -- logins` prints, as a list
{ "email": "sam@acme.de", "name": "Sam", "role": "user", "password": "…",
  "login": "https://mailflare-eu.example.workers.dev/login", "server": "mailflare-eu", "updated": "…" }

// mailflare-eu.json
{ "server": "https://mailflare-eu.example.workers.dev",
  "logins":   { "sam@acme.de": { "name": "Sam", "role": "user", "password": "…", "login": "https://…/login", "updated": "…" } },
  "mcpKeys":  { "acme-agent": { "key": "…", "url": "https://…/mcp", "updated": "…" } },
  "apiKeys":  { "sam@acme.de/ci": { "value": "…", "updated": "…" } },
  "webhooks": { "sam@acme.de https://hooks.partner.example/mail": { "value": "…", "updated": "…" } } }
```

`npm run state -- logins` prints every person's login as JSON; `npm run state -- mailflare-eu
logins` prints one server's. Passwords are stored and sent in the clear: that is acceptable
only while these are test accounts. Before real people use them, send each person a
reset link instead, and stop keeping this folder.

Every account, primary admin, MCP key, API key and webhook secret this system creates is
recorded there as it is made, and nothing secret is printed. A password can only be known when this system set it, so an
account that existed before has none on record until `--rotate-passwords` sets a new one
(which signs that person out everywhere). The primary admin is never rotated.

## Layout

```
apply.ts            entry: target + verb
args.ts             the command line
conform.ts          conformance: the properties, and the edits that test them
probes.ts           what conformance and verify ask the app and Cloudflare
fleet.ts            many servers: each project on its own instance
runner.ts           one server: its instance document, then its tenants
driver.ts           one document: the walk, and the plan
document.ts         loading and validating projects
spec.ts             the document model       validate.ts   checking documents against it
resources/          one file per capability, plus registry.ts (the order);
                    collection.ts reconciles any list, people.ts uses it for mail, calendar and drive,
                    erased.ts is the takedown
store/              types.ts (the seam), live.ts (the only SQL)
deploy.ts           creating and removing a server
router.ts           the front door           router/worker.js   the Worker itself
colos.ts            which country a data center is in     colos.json   the saved list
vault.ts            the credentials folder
subject-scope.ts    where a person's data lives, and how one is named once erased
backup.ts           reading a backup, and taking a person out of one so that it still restores
src-changes.ts      what this system needs from src/
wrangler.ts         wrangler, the Cloudflare API, the app's HTTP API
```

## The rules

- **A resource declares items; the driver executes them.** `plan`, `apply` and `destroy` are
  the same walk, so they cannot disagree. An item throws on failure and never prints.
- **All outside access goes through the store seam** (`store/types.ts`). SQL lives only in
  `store/live.ts`. That is what makes the unit tests possible.
- **No state file.** What exists is read from the servers on every run, including what is
  there and should not be. A written section is complete; one left out is not managed.
- **Documents are the only input.** Flags say how to run, never what to build.
- **A failure is never an empty answer.** A list that cannot be read stops the document;
  it is not "nothing exists".
- **`src/` is the product.** It is driven from outside, through its API and its database.
  The places it needed a change there — two for the fleet, and three faults that had to be
  fixed (backups that aborted, a restore that failed on a server in use, mail for nobody kept
  forever) — are listed by `--source-changes`, and a test fails if one is reverted.
- **The order in `registry.ts` is load-bearing.** Read its comment before moving anything.

## Verifying, and changing this tool

Conformance is part of the CLI, and it is one set of properties ([conform.ts](conform.ts)):

| A reconciler is right when it… | which is checked by |
|---|---|
| **builds** | `apply` creates each server from its folder; `reset` is refused unconfirmed, then wipes and rebuilds from the documents |
| **converges** | after an apply a plan finds nothing to do, and a second apply writes nothing |
| **follows an edit** | one of *every kind of thing* is added, then changed, then removed. Each time the plan must say **exactly** that — a line missing or a line extra fails — and a removal must wait for approval |
| **forgets** | a person is declared erased: the plan says exactly that, it waits for approval, and then they are gone from the database, the bucket and every backup. The rewritten backup is restored. A copy that still held them is restored, and the plan finds them again from the digest alone |
| **leaves** | `destroy` is refused unconfirmed, then takes everything declared and the server itself; `apply` builds it again |

The edits are the suite's own entries (`zz-conform…`), added to whatever a project's documents
already say — so the properties hold for any documents, and a new kind of thing is covered by
adding it to `additions()` in one place.

The same code runs in three places:

| | `npm run state:check` | `npm run state -- _sandbox conform` | `npm run state -- conform` |
|---|---|---|---|
| Runs the properties on | the in-memory store | the real app, on `npm run dev` | two real Cloudflare servers, at once |
| Takes | under a minute | ~10 minutes | ~13 minutes; ~11 with `--quick` (no destroy and rebuild) |
| Run it | after every change | to try a change against the app with no Cloudflare | before trusting a change with the fleet |
| Also | types, lint, the safety rules, and the tests that hold this system to `src/` | the probes that need no Cloudflare | all the probes, below |

On real servers the **probes** ([probes.ts](probes.ts)) ask what a plan cannot know:

- Cloudflare itself: the database and bucket are in the jurisdiction declared; the Worker is
  told its name and jurisdiction, its placement names its country, and it holds no
  Cloudflare token.
- Where it runs: each server is put beside another country's region on purpose. The plan must
  say so, an `apply` must bring it home without deploying it, and it must then answer from a
  data center in its country.
- The deployed app, signed in as the people: every generated login works; signatures, folders,
  inbox rules, templates, contacts, booking pages (and the public page), calendar, drive, API
  keys, the assistant and webhooks are all shown as written.
- Keys: a personal API key and an MCP key open what they should; made-up ones are refused.
- Realtime: a signed-in WebSocket opens, on Durable Objects pinned to the jurisdiction.
- Mail, through the real pipeline from the inbound queue on: delivered to a mailbox, through
  an alias, filed by an inbox rule, stored by one domain rule and turned away by another; the
  admin's webhook is called.
- Mail that is stored for nobody: it leaves nothing behind in the bucket.
- Backups: one is taken as the server is built, and another on request; each completes, is
  read back from the bucket, and holds what the database holds. Restores are made with the
  server in use throughout, since that is when a restore is needed.
- A takedown: before it, the person is merely disabled and a backup holds them. After it,
  nothing of theirs is in the database, their mail is gone from the bucket, no backup holds
  them, every backup is still whole, they cannot sign in and everyone else can. The rewritten
  backup is restored over the live server and the documents still match it. A copy from before
  is restored, the plan says they are back, and they are erased again. The domain's owner is refused.
- The fleet: a router across both servers sends each domain home, then is removed.

It ends by naming what it did **not** check, so a green run is never read as covering it: mail
arriving through Cloudflare Email Routing itself, an account's forwarding address, and Email
Routing no longer delivering to an erased address (all three need a zone whose MX points at a
server, and a conformance server is given no token so that it can touch none); the `fedramp`
jurisdiction; processing confined to a region; and Cloudflare's own 30-day recovery of a database.

It starts by rolling the current code out to the servers it runs on. An `apply` does not do
that, so without it conformance would be a verdict on whatever was deployed last.

Conformance resets what it runs on, so it only runs on servers whose `server.json` says
`"disposable": true`. `npm run state -- verify` is the read-only half for servers people use.

**Adding or changing a capability.** Do all of these, or it is not done:

1. the model and its validation — [spec.ts](spec.ts), [validate.ts](validate.ts);
2. the resource — a file in [resources/](resources/), placed in [registry.ts](resources/registry.ts);
   a list of rows goes through [collection.ts](resources/collection.ts), a single value is a field;
3. conformance — add one to `additions()` and its lines to `rounds()` in [conform.ts](conform.ts),
   and a probe in [probes.ts](probes.ts) that reads it back from the app. `state:check` runs it at once;
4. a unit test only for a rule conformance cannot state: something that must be refused;
5. this file: the document reference, and the Requirements row it serves.

## Outstanding

Limits of the platform or the app. None is hidden by a green run.

- **Placement is where a Worker's web requests run, not a legal boundary, and not a promise.**
  Cloudflare stops honouring a placement for tens of minutes at a time; this system notices
  and moves the server, but only when `place`, `plan` or `apply` runs, so between a lapse and
  the next run requests are processed wherever they arrive. When it holds, it covers the
  requests people and clients make; the handlers for incoming mail, queues and schedules run
  where Cloudflare starts them, static files are served from the nearest edge, and Queues have
  no jurisdiction (their messages carry references and envelope addresses, not bodies).
  Cloudflare may also spread a very busy Worker more widely. A contractual promise that
  nothing is processed outside a region is Cloudflare's Regional Services, an Enterprise
  product this system does not set up. The `eu` jurisdiction for data at rest is a guarantee.
- A database or bucket can be pinned to the EU, not to one country: `country` places the
  Worker, and the data sits in the jurisdiction (or near the `region` hint).
- **An erasure cannot reach Cloudflare's own recovery of a database** (D1 keeps 30 days), a
  copy of a backup that has left the bucket, or what a webhook or a forwarding address was
  already sent. The tombstone erases a person again after any restore; the rest is outside.
  The full list is under [What a takedown does not reach](#what-a-takedown-does-not-reach).
- **A backup is the database only.** Raw mail, attachments and drive files live in the bucket
  and nothing backs them up. A backup is unencrypted, and holds password hashes, TOTP secrets
  and provider keys. It is restored by wiping every table and inserting, which is not one transaction: a restore
  on a server in use now completes (it used to fail and leave the database half restored), but
  what people do during it can be lost or mixed in, and one that fails leaves it part-restored.
- A restore replaces the app's record of its own backups, so backups made since are in the
  bucket with no record: the app never lists or expires them. This system finds them by
  listing the bucket; deleting them is by hand. See `--source-changes`.
- Erasing and rewriting backups reach the bucket through Cloudflare. A server whose objects
  are kept in Backblaze B2 or AWS S3 instead (`B2_*`, `S3_*`) is not supported for either.
- The app cannot delete an account, so a person is erased in the database by a scope this
  system keeps ([subject-scope.ts](subject-scope.ts)); a test fails when the schema gains a
  table or a column it does not classify. `ai_usage` has no user column, so its rows cannot
  be attributed to anyone.
- A domain's providers, and a mailbox's kind, cannot be changed after creation through the
  key-authenticated API. Both are reported, never guessed at. See `--source-changes`.
- `reset` empties the database but leaves the domains' Cloudflare DNS and Email Routing in
  place; `destroy` with `teardown.domain: "remove"` is what removes them.
- `destroy` removes a server's Worker and keeps its database, bucket and queues: deleting
  data is a decision, made with wrangler.
- Moving a domain between servers is a `destroy` on one and an `apply` on the other; mail is
  not carried across.
- Onboarding a domain points its Email Routing catch-all at the server's Worker. Rules for
  single addresses made by hand in Cloudflare keep working, and are reported when a document
  wants the same address.
- Parallel runs share wrangler's one login. It is refreshed before fanning out and a refused
  statement is retried; with `CLOUDFLARE_API_TOKEN` set there is nothing to refresh.
