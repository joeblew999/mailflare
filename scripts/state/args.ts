import { existsSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROJECTS_DIR } from "./document";
import { CREDENTIALS_DIR } from "./vault";
import type { Flags } from "./flags";

export const VERBS = ["plan", "apply", "destroy", "reset"] as const;
export type Verb = (typeof VERBS)[number];

export type Target =
	| { kind: "project"; name: string }
	| { kind: "document"; path: string }
	| { kind: "folder"; path: string }
	/** No target: every project in the projects folder. */
	| { kind: "all" };

export type Command =
	| { kind: "help" }
	| { kind: "source-changes" }
	| { kind: "steps" }
	/** Where one person's data is, on every server, and what erasing them would take. Read-only. */
	| { kind: "subject"; email: string }
	/** Does the system still do what it says? Run on disposable servers, which it resets. */
	| { kind: "conform"; target: Target | null; quick: boolean }
	/** The live fleet, read-only: logins sign in, data is where declared, the front door is right. */
	| { kind: "verify"; target: Target }
	/** Roll the current code and bindings out to servers that already exist. */
	| { kind: "deploy"; target: Target }
	/** Every login on record, as JSON: for one server, or for all of them. */
	| { kind: "logins"; project?: string }
	/** Pull Cloudflare's list of data centers again: which country each airport code is in. */
	| { kind: "colos" }
	/** Keep every server answering from its country: ask each, and move any that is not. For a schedule. */
	| { kind: "place"; target: Target }
	/** The fleet's front door, which sends each person to the server their domain lives on. */
	| { kind: "router"; verb: "plan" | "apply" | "destroy" }
	| { kind: "run"; verb: Verb; target: Target };

export type Cli = {
	command: Command;
	flags: Flags;
	/** The projects folder. */
	dir: string;
	/** Documents in flight at once, across every server in the run. */
	concurrency: number;
	/** Where the logins and keys a run creates are written. */
	credentials: string;
	/** The router Worker's name, when it is not the fleet's. */
	router?: string;
	/** Which instance flags were typed. A typed flag wins over a server document. */
	explicit: { url: boolean; db: boolean };
};

/** The command line was wrong. Reported with the usage, never as a stack trace. */
export class UsageError extends Error {}

export const LOCAL_URL = "http://localhost:3000";
const isVerb = (word: string | undefined): word is Verb => (VERBS as readonly string[]).includes(String(word));

function targetOf(word: string): Target {
	if (word.endsWith(".json")) return { kind: "document", path: word };
	if (word.includes("/") || (existsSync(word) && statSync(word).isDirectory())) return { kind: "folder", path: word };
	return { kind: "project", name: word };
}

export function parseCli(argv: string[] = process.argv.slice(2)): Cli {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				// How to run it.
				dir: { type: "string", default: PROJECTS_DIR },
				local: { type: "boolean", default: false },
				db: { type: "string" },
				url: { type: "string" },
				concurrency: { type: "string", default: "1" },
				credentials: { type: "string", default: CREDENTIALS_DIR },
				router: { type: "string" },
				quick: { type: "boolean", default: false },
				"rotate-passwords": { type: "boolean", default: false },
				// Destructive actions need approval, as in terraform.
				"confirm-mx": { type: "boolean", default: false },
				"confirm-destroy": { type: "boolean", default: false },
				// About the system rather than an instance.
				"source-changes": { type: "boolean", default: false },
				steps: { type: "boolean", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message.split(". To specify")[0] : String(error));
	}
	const { values, positionals } = parsed;

	const concurrency = Number(values.concurrency);
	if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError(`--concurrency must be a whole number of 1 or more, not "${values.concurrency}"`);

	const local = Boolean(values.local);
	const flags: Flags = {
		status: false,
		cleanup: false,
		fresh: false,
		confirmMx: Boolean(values["confirm-mx"]),
		confirmDestroy: Boolean(values["confirm-destroy"]),
		rotatePasswords: Boolean(values["rotate-passwords"]),
		// Local means the dev server, never an origin derived from the deployed Worker.
		url: values.url ?? (local ? process.env.MAILFLARE_URL ?? LOCAL_URL : undefined),
		db: values.db ?? "mailflare",
		local,
	};
	const cli = (command: Command): Cli => ({ command, flags, dir: String(values.dir), concurrency, credentials: String(values.credentials), router: values.router, explicit: { url: values.url !== undefined, db: values.db !== undefined } });

	if (values.help) return cli({ kind: "help" });
	if (values["source-changes"]) return cli({ kind: "source-changes" });
	if (values.steps) return cli({ kind: "steps" });

	const [first, second, third] = positionals;
	if (first === "subject") {
		// A report on one person. Erasing them is desired state: it is written in a document.
		if (!second || !second.includes("@")) throw new UsageError("subject needs an address: state subject <email>");
		if (third === "destroy") throw new UsageError(`a person is erased by a document, not by a command: write ${second} under "erased" and apply with --confirm-destroy (state subject ${second} says where, and what it will take)`);
		if (third !== undefined && third !== "plan") throw new UsageError(`unexpected "${third}"`);
		if (positionals.length > 3) throw new UsageError(`unexpected "${positionals[3]}"`);
		flags.status = true;
		return cli({ kind: "subject", email: second.trim().toLowerCase() });
	}

	for (const word of ["conform", "verify"] as const) {
		if (first !== word && second !== word) continue;
		if (positionals.length > 2) throw new UsageError(`unexpected "${third}"`);
		const named = first === word ? second : first;
		if (word === "conform") return cli({ kind: "conform", target: named ? targetOf(named) : null, quick: Boolean(values.quick) });
		flags.status = true;
		return cli({ kind: "verify", target: named ? targetOf(named) : { kind: "all" } });
	}
	if (first === "deploy" || second === "deploy") {
		if (positionals.length > 2) throw new UsageError(`unexpected "${third}"`);
		const word = first === "deploy" ? second : first;
		return cli({ kind: "deploy", target: word ? targetOf(word) : { kind: "all" } });
	}
	if (first === "logins" || second === "logins") {
		if (positionals.length > 2) throw new UsageError(`unexpected "${third}"`);
		return cli({ kind: "logins", project: first === "logins" ? second : first });
	}
	if (first === "place" || second === "place") {
		if (positionals.length > 2) throw new UsageError(`unexpected "${third}"`);
		const word = first === "place" ? second : first;
		return cli({ kind: "place", target: word ? targetOf(word) : { kind: "all" } });
	}
	if (first === "colos") {
		if (positionals.length > 1) throw new UsageError(`unexpected "${second}"`);
		return cli({ kind: "colos" });
	}
	if (first === "router") {
		if (second !== "plan" && second !== "apply" && second !== "destroy") throw new UsageError("router needs a verb: state router plan|apply|destroy");
		if (positionals.length > 2) throw new UsageError(`unexpected "${third}"`);
		flags.cleanup = second === "destroy";
		flags.status = second === "plan" || (second === "destroy" && !flags.confirmDestroy);
		return cli({ kind: "router", verb: second });
	}

	if (positionals.length === 0) throw new UsageError("nothing to do — give a verb, and usually a target");
	if (positionals.length > 2) throw new UsageError(`unexpected "${third}" — the command is: state <target> <verb>`);

	// `<target> <verb>`, and `<verb> <target>` reads the same. One word is a verb for every project.
	let verb: Verb;
	let word: string | undefined;
	if (isVerb(second)) [word, verb] = [first, second];
	else if (isVerb(first)) [word, verb] = [second, first];
	else if (second) throw new UsageError(`unknown verb "${second}" — use ${VERBS.join(", ")}`);
	else throw new UsageError(`"${first}" needs a verb: state ${first} ${VERBS.join("|")}`);

	// Wiping every server because a target was forgotten is not a default anyone wants.
	if (verb === "reset" && !word) throw new UsageError("reset needs a target: state <project> reset");

	flags.cleanup = verb === "destroy";
	flags.fresh = verb === "reset";
	// Unconfirmed, a destroy or a reset is its own plan: it reports and writes nothing.
	flags.status = verb === "plan" || ((verb === "destroy" || verb === "reset") && !flags.confirmDestroy);
	return cli({ kind: "run", verb, target: word ? targetOf(word) : { kind: "all" } });
}

export function usage() {
	console.log(`state — a Terraform-like reconciler for a fleet of Mailflare servers.

The JSON documents are the desired state: plan shows the diff, apply makes it so, destroy
removes it. There is no state file: every run reads the servers and compares. A section a
document writes is complete, so what you delete from it is removed (-); a section it leaves
out is not managed.

  npm run state -- <target> <verb> [flags]

  npm run state -- plan                         the whole fleet, each project on its own server
  npm run state -- apply                        make it so: deploy what is missing, reconcile the rest
  npm run state -- mailflare plan               one project
  npm run state -- mailflare destroy            what it would remove
  npm run state -- mailflare destroy --confirm-destroy
  npm run state -- mailflare reset --confirm-destroy    wipe it, make its admin, apply
  npm run state -- <path>/<file>.json plan      one document (on its project's server)
  npm run state -- verify                       the live fleet, read-only: logins, jurisdictions, the front door
  npm run state -- conform                      does it all still work? on real, disposable servers (--quick: no rebuild)
  npm run state -- deploy                       roll the current code out to every server (or: <project> deploy)
  npm run state -- place                        keep every server answering from its country; moves one that is not (seconds)
  npm run state -- router apply                 the front door: each person to their home server
  npm run state -- logins                       every login on record, as JSON (or: <project> logins)
  npm run state -- colos                        pull Cloudflare's data-center list again (which country each is in)
  npm run state -- subject <email>              where one person's data is, fleet-wide, and how to erase them

The target is a project name, a folder, or a document. The verb is ${VERBS.join(", ")}.
Everything else lives in the documents of a project folder:

  server.json     the server: the country it runs in, whom it serves, its jurisdiction (or "local": true)
  instance.json   the instance: license, settings, backups, push, and fresh (its admin)
  <domain>.json   a tenant: onboard, mailboxes, accounts, routing, mcpKeys, teardown
  either          erased: people who must not exist here — found, they are deleted, backups included

Flags:
  --dir <path>            projects folder (default: ${PROJECTS_DIR})
  --concurrency <n>       documents in flight across the run (default 1)
  --credentials <path>    where logins and keys are written (default: ${CREDENTIALS_DIR})
  --rotate-passwords      new passwords and keys for everything declared, recorded as they are set
  --router <name>         the router Worker's name (default: <worker>-router)
  --local                 the local dev instance (${LOCAL_URL}), never a deployed one
  --db <name>             the database, when not the server document's
  --url <base>            the origin, when not the server document's
  --confirm-mx            onboard a domain whose mail someone else receives
  --confirm-destroy       actually destroy, reset, erase whom a document declares erased,
                          or remove what it no longer holds; without it you get the plan
  --source-changes        what this system needs from src/, and where
  --steps                 the Web Push (VAPID) key-rotation runbook
  -h, --help              this

Exit status is 0 when everything is as the verb wants it, and 1 when it is not.`);
}
