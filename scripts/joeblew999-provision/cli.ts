import { parseArgs } from "node:util";
import type { Flags } from "./types";

export function parseCli() {
	const { values } = parseArgs({
		options: {
			domain: { type: "string" },
			project: { type: "string" },
			all: { type: "boolean", default: false },
			dir: { type: "string", default: "scripts" },
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
	console.log(`provision — stand up a domain's mailboxes from a project manifest.

⚠ Onboarding publishes Mailflare's Email Routing MX. The script refuses to onboard a
  domain that already has MX records unless you pass --confirm-mx.

  npm run joeblew999:provision -- --project scripts/joeblew999-project.example.json
  npm run joeblew999:provision -- --domain <hostname> --roles a,b,c [--onboard] [--share]
  npm run joeblew999:provision -- --domain <hostname> --roles a,b,c --cleanup

Project file (JSON):
  { "domain": "...", "onboard": { "replaceMxRecords": false },
    "mailboxes": [ { "role": "office", "displayName": "Office" },
                   { "role": "support", "shared": true,
                     "access": [ { "email": "you@example.com", "permission": "full_access" } ] } ],
    "accounts": [ { "username": "sam", "role": "user", "passwordEnv": "PROV_PASSWORD" } ],
    "routing":  [ { "pattern": "*", "action": "forward", "forwardTo": "you@example.com" } ],
    "mcpKeys":  [ { "name": "agent", "mailboxes": ["office"] } ] }

Flags:
  --project <path>      apply a project manifest (domain + mailboxes + onboard)
  --all                 apply every joeblew999-project.*.json in --dir
  --dir <path>          directory to scan when using --all (default: scripts)
  --domain <hostname>   domain to provision on (overrides the manifest)
  --roles <a,b,c>       ad-hoc role names (alternative to a manifest)
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
