import { parseArgs } from "node:util";
import type { Flags } from "./flags";

export function parseCli() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			// Set from the positionals, never typed by the user.
			target: { type: "string" },
			verb: { type: "string" },
			"data-subject": { type: "string" },
			// Derived from the target. Declared so the entry point can hold them, never
			// advertised: there is one way to point this at something.
			spec: { type: "string" },
			project: { type: "string" },
			all: { type: "boolean", default: false },

			// How to run it.
			dir: { type: "string", default: "scripts/state/specs/projects" },
			local: { type: "boolean", default: false },
			db: { type: "string" },
			url: { type: "string" },
			concurrency: { type: "string", default: "1" },

			// Destructive actions need approval, as in terraform.
			"confirm-mx": { type: "boolean", default: false },
			"confirm-destroy": { type: "boolean", default: false },

			// About the system rather than the instance.
			"source-changes": { type: "boolean", default: false },
			steps: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});

	// Flags are INTERNAL: the documents say WHAT to build, these say HOW to run it. What used
	// to be flags - onboard, share, the licence plan, web push, the admin, teardown - is read
	// from the documents, and the globals are derived from the instance document in apply.ts
	// so the resources keep one source of truth.
	const flags: Flags = {
		dryRun: false,
		status: false,
		cleanup: false,
		onboard: false,
		confirmMx: Boolean(values["confirm-mx"]),
		replaceMx: false,
		share: false,
		disableAccounts: false,
		removeDomain: false,
		fresh: false,
		erase: false,
		confirmDestroy: Boolean(values["confirm-destroy"]),
		licenseStatus: false,
		push: false,
		steps: Boolean(values.steps),
		timeout: "40",
		url: values.url,
		db: String(values.db ?? "mailflare"),
		local: Boolean(values.local),
	};

	// Terraform's shape: a TARGET and a VERB, both positional. The target absorbs --project,
	// --spec and --all - a bare name is a project, a .json is one document, a path is a
	// projects folder, and no target at all means every project.
	const VERBS = ["plan", "apply", "destroy", "reset", "subject"];
	const [first, second, third] = positionals;
	let target: string | undefined;
	let verb: string | undefined;
	let action: string | undefined;

	if (first === "subject") {
		// `subject <address> plan|destroy` - the address is the target, the action is the verb.
		verb = "subject";
		target = second;
		action = third ?? "plan";
		if (action !== "plan" && action !== "destroy") {
			console.error(`Unknown action "${action}" for a subject. Use plan or destroy.`);
			process.exit(1);
		}
	} else if (first && VERBS.includes(first)) {
		verb = first;
	} else {
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
		if (action === "destroy") flags.cleanup = true;
	}

	values.target = target;
	values.verb = verb;

	return { values, flags };
}

export function usage() {
	console.log(`state — reconcile a Mailflare instance with its JSON desired state.

  npm run state -- <target> <verb> [flags]

  npm run state -- plan                        every project
  npm run state -- mailflare plan              a project
  npm run state -- mailflare apply
  npm run state -- mailflare destroy
  npm run state -- mailflare reset             wipe it and make a primary admin
  npm run state -- <path>/<file>.json plan     one document
  npm run state -- subject <email> plan        where one person's data lives
  npm run state -- subject <email> destroy     DESTROY it

The target is a project name, a projects folder, or a document. The verb is plan, apply,
destroy, reset or subject. Everything else lives in the documents:

  server.json     the server: database, origin, jurisdiction
  instance.json   the instance: licence, web push, and fresh.admin for reset
  <domain>.json   the tenants: mailboxes, accounts, routing, mcpKeys, onboard, teardown

Flags:
  --dir <path>            projects folder (default: scripts/state/specs/projects)
  --local / --db <name>   which database (default: the deployed one)
  --url <base>            instance URL (else MAILFLARE_URL, else derived from Cloudflare)
  --concurrency <n>       mass runs: how many documents in flight (default 1)
  --confirm-mx            allow onboarding a domain that already has MX records
  --confirm-destroy       actually destroy/undeploy; without it you get the plan
  --source-changes        what cannot be done without modifying src/, and where
  --steps                 the Web Push (VAPID) key-rotation runbook
  -h, --help              this`);
}
