import { parseArgs } from "node:util";
import type { Flags } from "./types";

export function parseCli() {
	const { values } = parseArgs({
		options: {
			domain: { type: "string" },
			project: { type: "string" },
			file: { type: "string" },
			all: { type: "boolean", default: false },
			dir: { type: "string", default: "scripts/joeblew999/projects" },
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
			db: { type: "string", default: "mailflare" },
			local: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});

	const flags: Flags = {
		dryRun: Boolean(values["dry-run"]),
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
		db: String(values.db),
		local: Boolean(values.local),
	};

	return { values, flags };
}

export function usage() {
	console.log(`joeblew999 — one provisioning system for a Mailflare instance.

Everything is declared in JSON and applied by one run loop: domain onboarding,
mailboxes, accounts, routing rules, MCP keys, the license, and web push. The same
sections drive --status and --cleanup, so nothing has its own command.

  npm run joeblew999 -- --file scripts/joeblew999/projects/example.json
  npm run joeblew999 -- --domain <hostname> --roles a,b,c [--onboard]
  npm run joeblew999 -- --all --dry-run
  npm run joeblew999 -- --plan team               # license only, no domain
  npm run joeblew999 -- --push                    # web push round trip
  npm run joeblew999 -- --fresh --file <project>   # reset an empty/new server, then provision
  npm run joeblew999 -- --fresh --remote          # same, against a deployed Cloudflare D1

⚠ Onboarding publishes Mailflare's Email Routing MX. The script refuses to onboard a
  domain that already has MX records unless you pass --confirm-mx.

Project file (JSON) — any subset of these sections:
  { "domain": "...",
    "onboard":   { "replaceMxRecords": false },
    "mailboxes": [ { "role": "office" }, { "role": "support", "shared": true,
                     "access": [ { "email": "you@example.com", "permission": "full_access" } ] } ],
    "accounts":  [ { "username": "sam", "role": "user", "passwordEnv": "PROV_PASSWORD" } ],
    "routing":   [ { "pattern": "*", "action": "forward", "forwardTo": "you@example.com" } ],
    "mcpKeys":   [ { "name": "agent", "mailboxes": ["office"] } ],
    "license":   { "plan": "team" },
    "push":      { "to": "you@example.com" } }

  A mass input is one file: { "projects": [ <project>, <project>, ... ] }, loaded once,
  with ONE admin key for the whole run.

Flags:
  --project/--file <p>  apply one project, or many via { "projects": [...] }
  --all                 apply every project in --dir (skips example.json, _*.json)
  --dir <path>          projects folder for --all (default: scripts/joeblew999/projects)
  --domain <hostname>   provision a domain without a manifest
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
  --status              report what exists vs the manifest, change nothing
  --cleanup             remove each section instead of applying it
  --disable-accounts    with --cleanup, also disable the accounts
  --remove-domain       with --cleanup, also remove the domain (drops its DNS/MX)
  --url <base>          instance URL (else MAILFLARE_URL, else derived from Cloudflare)
  --db / --local        target a different D1 database / the local one
  -h, --help            show this help`);
}
