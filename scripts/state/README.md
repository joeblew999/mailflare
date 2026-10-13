# scripts/state

**A Terraform-like reconciler for a Mailflare instance.** The JSON documents are the desired
state; `plan` shows the diff, `apply` makes it so, `destroy` removes it. One codebase, many
servers.

| Terraform | Here |
|---|---|
| `plan` / `apply` / `destroy` | `npm run state -- <target> plan` / `apply` / `destroy` |
| a directory of `.tf` files | a project folder of JSON documents |
| resources and a provider | items, declared per resource; the app's API and D1 behind the store seam |
| state file | **none** — existence is queried every run, so the plan and the world cannot drift |
| workspaces | projects: one folder per server |

> **Do not change anything in `src/`.** This tool drives the app through its HTTP API and its
> database; `src/` is the product. Where a capability would need a change there, the command
> says so and names the file: `npm run state -- --source-changes`.

Reconciles a Mailflare instance with JSON documents. Point it at a project folder; `plan`,
`apply` and `destroy` make the instance match.

```bash
npm run state -- <target> <verb> [flags]
```

## Commands

```bash
npm run state -- mailflare plan          # what differs, writes nothing
npm run state -- mailflare apply         # make it so
npm run state -- mailflare destroy       # remove it, the Worker included
npm run state -- mailflare reset         # wipe it, make a primary admin
npm run state -- plan                    # every project in specs/projects/
npm run state -- <file>.json plan        # one document
npm run state -- <folder> plan           # every project in that folder
npm run state -- subject <email> plan    # where one person's data lives
npm run state -- subject <email> destroy # erase it, rows and R2 objects

npm run state:check                      # the gate: types + lint + tests + sandbox
npm run state:sandbox                    # the sandbox alone (needs `npm run dev`)
npm run state:test                       # unit tests only
```

The target is a project name, a folder, or a document. The verb is `plan`, `apply`, `destroy`,
`reset` or `subject`. A verb with no target means every project — except `reset`, which needs
one.

Flags are how to run it, never what to build:

| Flag | |
|---|---|
| `--dir <path>` | projects folder (default `scripts/state/specs/projects`) |
| `--local` / `--db <name>` / `--url <base>` | which instance |
| `--concurrency <n>` | mass runs: documents in flight (default 1) |
| `--confirm-mx` | onboard a domain that already has MX |
| `--confirm-destroy` | actually undeploy; without it you get the plan |
| `--source-changes` | what would need a change in `src/`, and where |
| `--steps` | the Web Push (VAPID) key-rotation runbook |

## Documents

```
specs/
└── projects/
    └── mailflare/
        ├── server.json      the server: database, origin, jurisdiction
        ├── instance.json    the instance: licence, web push, fresh.admin
        └── <domain>.json    the tenants
```

```jsonc
{
  "domain": "acme.de",
  "onboard":   { "receivingProvider": "cloudflare", "replaceMxRecords": false },
  "mailboxes": [ { "role": "office" },
                 { "role": "support", "shared": true,
                   "access": [ { "email": "sam@acme.de", "permission": "read_only" } ] } ],
  "accounts":  [ { "username": "sam", "name": "Sam", "role": "user", "passwordEnv": "PROV_PASSWORD" } ],
  "routing":   [ { "pattern": "*", "action": "forward", "forwardTo": "ops@example.com" } ],
  "mcpKeys":   [ { "name": "agent", "mailboxes": ["office"] } ],
  "teardown":  { "accounts": "disable", "domain": "remove" }
}
```

`example/` and `_*` projects are skipped by `--all`.

`license`, `push` and `fresh` are **instance** sections, not tenant ones. A mailbox `access`
grant must name a local account the document creates — an outside address cannot resolve, and
the plan reports it as a problem.

## Layout

```
apply.ts            entry: target + verb
driver.ts           the walk, and the plan renderer
document.ts         loading documents and servers
spec.ts             the document model
validate.ts         checking documents against it
resources/          one file per capability, plus registry.ts (the order)
store/              types.ts (the seam), live.ts (the only SQL)
subject-scope.ts    where a person's data lives
src-changes.ts      what would need a change in src/
deploy.ts           deploy/undeploy a server
wrangler.ts         d1, fetch, keychain, R2 helpers
```

## The rules

- **A resource declares items; the driver executes them.** `plan`, `apply` and `destroy` are
  the same walk, so they cannot disagree.
- **All outside access goes through the store seam** (`store/types.ts`). SQL lives only in
  `store/live.ts`. That is what makes the unit tests possible.
- **No state file.** Existence is queried every run, so the plan and the world cannot drift.
- **Documents are the only input.** Nothing describing what to build is a flag.
- **Never modify `src/`.** It is driven through its API and its database. Where a change is
  needed, `--source-changes` names the file.
- **The order in `registry.ts` is load-bearing.** Every position is there for a reason; read
  the comments before moving one.

## Verifying

`npm run state:check` is the definition of done: types, lint, unit tests, and the sandbox.

The sandbox runs the real app against the real local database — reset, apply, plan, apply
again, destroy, plan again — then the refusals (an unresolvable grant, a bad enum, an unknown
section, a mailbox with no role). It asserts exit codes and messages.

Unit tests use an in-memory fake, so they encode our assumptions and can pass while the real
flow is broken. Only the sandbox exercises the app; a green unit suite is not evidence.

`npm run dev` must be running for the sandbox. It uses `--local` and a `.test` domain, so
nothing real is touched.

## Outstanding

- Backup history cannot be erased from here; it needs crypto-shredding in the app. See
  `--source-changes`.
- `ai_usage` has no user column, so erasure cannot attribute its rows.
- The realtime Durable Object is not jurisdiction-pinned.
- `reset` empties the database but leaves the domains' Cloudflare MX and DNS in place.
