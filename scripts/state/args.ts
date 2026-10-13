import { parseArgs } from "node:util";
import type { Flags } from "./flags";

export function parseCli() {
	const { values } = parseArgs({
		options: {
			domain: { type: "string" },
			spec: { type: "string" },
			instance: { type: "string" },
			project: { type: "string" },
			"data-subject": { type: "string" },
			erase: { type: "boolean", default: false },
			"source-changes": { type: "boolean", default: false },
			concurrency: { type: "string", default: "1" },
			deploy: { type: "string" },
			all: { type: "boolean", default: false },
			dir: { type: "string", default: "scripts/state/specs/projects" },
			roles: { type: "string", default: "" },
			"roles-file": { type: "string" },
			onboard: { type: "boolean", default: false },
			"replace-mx": { type: "boolean", default: false },
			"confirm-mx": { type: "boolean", default: false },
			share: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			status: { type: "boolean", default: false },
			cleanup: { type: "boolean", default: false },
			"disable-accounts": { type: "boolean", default: false },
			"remove-domain": { type: "boolean", default: false },
			fresh: { type: "boolean", default: false },
			"admin-email": { type: "string" },
			"admin-password": { type: "string" },
			plan: { type: "string" },
			"license-status": { type: "boolean", default: false },
			push: { type: "boolean", default: false },
			steps: { type: "boolean", default: false },
			to: { type: "string" },
			from: { type: "string" },
			subject: { type: "string" },
			timeout: { type: "string", default: "40" },
			url: { type: "string" },
			db: { type: "string" },
			local: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});

	const flags: Flags = {
		dryRun: Boolean(values["dry-run"]),
		erase: Boolean(values.erase),
		status: Boolean(values.status),
		cleanup: Boolean(values.cleanup),
		onboard: Boolean(values.onboard),
		confirmMx: Boolean(values["confirm-mx"]),
		replaceMx: Boolean(values["replace-mx"]),
		share: Boolean(values.share),
		disableAccounts: Boolean(values["disable-accounts"]),
		removeDomain: Boolean(values["remove-domain"]),
		fresh: Boolean(values.fresh),
		adminEmail: values["admin-email"],
		adminPassword: values["admin-password"],
		plan: values.plan,
		licenseStatus: Boolean(values["license-status"]),
		push: Boolean(values.push),
		steps: Boolean(values.steps),
		to: values.to,
		from: values.from,
		subject: values.subject,
		timeout: String(values.timeout),
		url: values.url,
		db: String(values.db ?? "mailflare"),
		local: Boolean(values.local),
	};

	return { values, flags };
}

export function usage() {
	console.log(`state — reconcile a Mailflare instance with its JSON desired state.

Everything is declared in JSON and applied by one run loop: domain onboarding,
mailboxes, accounts, routing rules, MCP keys, the license, and web push. The same
sections drive --status and --cleanup, so nothing has its own command.

  npm run state -- --spec scripts/state/specs/example.json
  npm run state -- --instance mailflare --spec scripts/state/specs/<domain>.json
  npm run state -- --domain <hostname> --roles a,b,c [--onboard]
  npm run state -- --all --dry-run
  npm run state -- --plan team               # license only, no domain
  npm run state -- --push                    # web push round trip
  npm run state -- --fresh --spec <path>      # reset a new server, then apply
  npm run state -- --fresh --remote          # same, against a deployed Cloudflare D1

⚠ Onboarding publishes Mailflare's Email Routing MX. The script refuses to onboard a
  domain that already has MX records unless you pass --confirm-mx.

Instance documents (specs/instances/) carry things that belong to the server rather than
a tenant - the licence, web push - and are applied before every tenant document.

Desired-state document (JSON) — any subset of these sections:
  { "domain": "...",
    "onboard":   { "replaceMxRecords": false },
    "mailboxes": [ { "role": "office" }, { "role": "support", "shared": true,
                     "access": [ { "email": "you@example.com", "permission": "full_access" } ] } ],
    "accounts":  [ { "username": "sam", "role": "user", "passwordEnv": "PROV_PASSWORD" } ],
    "routing":   [ { "pattern": "*", "action": "forward", "forwardTo": "you@example.com" } ],
    "mcpKeys":   [ { "name": "agent", "mailboxes": ["office"] } ],
    "license":   { "plan": "team" },
    "push":      { "to": "you@example.com" } }

  Many at once is one file: { "projects": [ <project>, <project>, ... ] }, loaded once, with ONE admin key for the whole run.

Flags:
  --spec <path>         one document, or many via { "specs": [...] }
  --project <name>        run a whole project: its instance.json, then every tenant
  --instance <name|path>  just a server's instance document (or a path)
  --data-subject <email>  report where one person's data lives (read-only)
  --deploy <name>         deploy the server's env block and register it in the fleet
  --concurrency <n>       mass runs: how many documents in flight (default 1)
  --source-changes        list what cannot be done without modifying src/, and where
  --erase                 with --data-subject: DESTROY those rows and their R2 objects
                          (add --dry-run to see exactly what would go first)
  --all                 apply every project in --dir (skips example.json, _*.json)
  --dir <path>          specs folder for --all (default: scripts/state/specs)
  --domain <hostname>   apply a domain without a document
  --roles <a,b,c>       ad-hoc role names (with --domain)
  --roles-file <path>   read role names from a file (JSON array or one per line)
  --onboard             add the domain to Mailflare first (publishes MX)
  --replace-mx          when onboarding, take MX over from another provider
  --confirm-mx          allow onboarding a domain that already has MX records
  --share               create the mailboxes as shared (needs Team)
  --plan <team|pro|community>   set the license plan (community reverts); no domain needed
  --license-status      just report the license and its gates
  --push                send a web push test email and wait for it to arrive
  --to/--from/--subject/--timeout   web push test overrides
  --steps               print the Web Push (VAPID) key-rotation runbook
  --dry-run             list what would change, create nothing
  --status              report what exists vs the document, change nothing
  --cleanup             remove each section instead of applying it
  --disable-accounts    with --cleanup, also disable the accounts
  --remove-domain       with --cleanup, also remove the domain (drops its DNS/MX)
  --url <base>          instance URL (else MAILFLARE_URL, else derived from Cloudflare)
  --db / --local        target a different D1 database / the local one
  -h, --help            show this help`);
}
