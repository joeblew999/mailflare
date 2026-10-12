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
		url: values.url,
		db: String(values.db),
		local: Boolean(values.local),
	};

	return { values, flags };
}

export function usage() {
	console.log(`provision — stand up (or tear down) domains from a JSON manifest.

⚠ Onboarding publishes Mailflare's Email Routing MX. The script refuses to onboard a
  domain that already has MX records unless you pass --confirm-mx.

  npm run joeblew999:provision -- --file scripts/joeblew999/projects/example.json
  npm run joeblew999:provision -- --domain <hostname> --roles a,b,c [--onboard]
  npm run joeblew999:provision -- --all --dry-run
  npm run joeblew999:provision -- --file <multi.json>          # { "projects": [ ... ] }

Project file (JSON):
  { "domain": "...", "onboard": { "replaceMxRecords": false },
    "mailboxes": [ { "role": "office", "displayName": "Office" },
                   { "role": "support", "shared": true,
                     "access": [ { "email": "you@example.com", "permission": "full_access" } ] } ],
    "accounts": [ { "username": "sam", "role": "user", "passwordEnv": "PROV_PASSWORD" } ],
    "routing":  [ { "pattern": "*", "action": "forward", "forwardTo": "you@example.com" } ],
    "mcpKeys":  [ { "name": "agent", "mailboxes": ["office"] } ] }

  A mass input is one file: { "projects": [ <project>, <project>, ... ] }. The whole
  file is loaded once and ONE admin key covers the run.

Flags:
  --project <path>      apply one project manifest (a typo of --file is harmless)
  --file <path>         apply one project, or many via { "projects": [...] }
  --all                 apply every project in --dir (skips example.json, _*.json)
  --dir <path>          projects folder for --all (default: scripts/joeblew999/projects)
  --domain <hostname>   provision a domain without a manifest
  --roles <a,b,c>       ad-hoc role names (with --domain)
  --roles-file <path>   read role names from a file (JSON array or one per line)
  --onboard             add the domain to Mailflare first (publishes MX)
  --replace-mx          when onboarding, take MX over from another provider
  --confirm-mx          allow onboarding a domain that already has MX records
  --share               create the mailboxes as shared (needs Team)
  --dry-run             list what would change, create nothing
  --status              report what exists vs the manifest, change nothing
  --cleanup             delete the mailboxes instead of creating them
  --disable-accounts    with --cleanup, also disable the manifest's accounts
  --remove-domain       with --cleanup, also remove the domain (drops its DNS/MX)
  --url <base>          instance URL (else MAILFLARE_URL, else derived from Cloudflare)
  --db / --local        target a different D1 database / the local one
  -h, --help            show this help`);
}
