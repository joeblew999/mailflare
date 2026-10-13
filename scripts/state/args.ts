import { parseArgs } from "node:util";
import type { Flags } from "./flags";

export function parseCli() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			domain: { type: "string" },
			spec: { type: "string" },
			instance: { type: "string" },
			project: { type: "string" },
			// Set from the positional target, not typed by the user.
			target: { type: "string" },
			"data-subject": { type: "string" },
			erase: { type: "boolean", default: false },
			"source-changes": { type: "boolean", default: false },
			concurrency: { type: "string", default: "1" },
			deploy: { type: "string" },
			undeploy: { type: "string" },
			"confirm-destroy": { type: "boolean", default: false },
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
		confirmDestroy: Boolean(values["confirm-destroy"]),
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

	// Terraform's shape: a TARGET and a VERB, both positional. The target absorbs --project,
	// --spec and --all - a bare name is a project, a .json is one document, a path is a
	// projects folder, and no target at all means every project.
	const VERBS = ["plan", "apply", "destroy", "reset", "subject"];
	const [first, second] = positionals;
	let target: string | undefined;
	let verb: string | undefined;
	if (first && VERBS.includes(first)) verb = first;
	else {
		target = first;
		if (second && VERBS.includes(second)) verb = second;
	}
	if (second && !verb) {
		console.error(`Unknown verb "${second}". Use ${VERBS.join(", ")}.`);
		process.exit(1);
	}

	if (verb === "plan") flags.status = true;
	else if (verb === "destroy") flags.cleanup = true;
	else if (verb === "reset") flags.fresh = true;
	else if (verb === "subject") {
		if (!target) {
			console.error("The subject verb needs an address: state subject <email> plan|destroy");
			process.exit(1);
		}
		values["data-subject"] = target;
		target = undefined;
	}
	values.target = target;

	return { values, flags };
}

export function usage() {
	console.log(`state — reconcile a Mailflare instance with its JSON desired state.

Point it at a project folder and it makes everything in it exist, or not exist:

  npm run state -- --project <name> plan      what exists vs the documents (read-only)
  npm run state -- --project <name> apply     make it so — the default
  npm run state -- --project <name> destroy   remove it, the server included

A project is specs/projects/<name>/: server.json (the server), instance.json (the instance),
and one document per tenant. --project reconciles all of them, and deploys the server first if
it is not registered, so create and destroy are the same command either way.

What to point at:
  --project <name>        a project folder: its server, instance and every tenant
  --spec <path>           one document, or many via { "specs": [...] }
  --all                   every project in --dir (skips example and _*)
  --dir <path>            projects folder (default: scripts/state/specs/projects)
  --instance <name|path>  only a server's instance document
  --domain <hostname>     apply a domain without a document
  --roles <a,b,c>         ad-hoc role names (with --domain)
  --roles-file <path>     role names from a file (JSON array or one per line)

The server itself:
  --deploy <name>         deploy it and record its origin (apply does this anyway)
  --undeploy <name>       undeploy the Worker and deregister it
  --confirm-destroy       actually destroy/undeploy; without it you get the plan

What to change:
  --fresh                 reset the instance to empty and make a primary admin
  --admin-email/--admin-password   the admin --fresh creates
  --onboard               add a missing domain (publishes MX)
  --confirm-mx            allow onboarding a domain that already has MX
  --replace-mx            when onboarding, take MX over from another provider
  --share                 create the mailboxes as shared
  --disable-accounts      with destroy, also disable the accounts
  --remove-domain         with destroy, also remove the domain

How:
  --dry-run               show what would change, change nothing
  --concurrency <n>       mass runs: how many documents in flight (default 1)
  --url <base>            instance URL (else MAILFLARE_URL, else derived from Cloudflare)
  --db <name> / --local   which database / the local dev one

Server-wide, no project needed:
  --plan <team|pro|community>   set the licence plan (community reverts)
  --license-status        report the licence and its gates
  --push                  web push round trip
  --to/--from/--subject/--timeout   web push overrides
  --steps                 the Web Push (VAPID) key-rotation runbook

One person's data:
  --data-subject <email>  where their data lives (read-only)
  --erase                 with --data-subject: destroy those rows and their R2 objects

About this system:
  --source-changes        what cannot be done without modifying src/, and where
  -h, --help              this`);
}
