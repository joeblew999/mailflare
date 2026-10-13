#!/usr/bin/env node
// The one entry point. Everything this system does - onboarding, mailboxes, accounts,
// routing rules, MCP keys, the license, web push - is a Resource (see
// ./resources/registry.ts) applied by one loop, and every capability can be declared
// in JSON. There is no per-capability command.
//
//   npm run state -- --spec scripts/state/specs/example.json
//   npm run state -- --domain example.com --roles office,admin
//   npm run state -- --all --dry-run
//   npm run state -- --plan team        # global capabilities need no domain
//   npm run state -- --push
//
// ⚠ MX WARNING — `--onboard` publishes Mailflare's Email Routing MX for the domain.
//   On a domain that already receives mail (a live company domain) that redirects its
//   real mail, so the script refuses unless you pass --confirm-mx.
import { parseCli, usage } from "./args";
import { loadSpec, rolesFor } from "./document";
import { loadSpecs, runSpecs, type SpecEntry } from "./runner";
import { makeContext } from "./context";
import { run } from "./driver";
import { pushRunbook } from "./resources/push";
import { withStore } from "./app";
import type { Role, Spec } from "./spec";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const { values, flags } = parseCli();

if (values.help) {
	usage();
	process.exit(0);
}
if (flags.steps) {
	pushRunbook(flags.db, flags.local);
	process.exit(0);
}

// --all/--spec load many documents; the global convenience flags run a single target.
const specMode = Boolean(values.all) || Boolean(values.spec);
const useSpecs = specMode && !flags.licenseStatus;
let entries: SpecEntry[];
let singleRoles: Role[] = [];

try {
	if (flags.licenseStatus) {
		flags.status = true;
		entries = [{ name: "", spec: { license: {} } }];
	} else if (useSpecs) {
		entries = loadSpecs({ spec: values.spec ? String(values.spec) : undefined, dir: String(values.dir) });
	} else {
		const project: Spec | null = values.spec ? loadSpec(String(values.spec)) : null;
		const domainValue = String(values.domain ?? project?.domain ?? "").trim();
		const target: Spec = project ?? { domain: domainValue };
		// The convenience flags are just shorthand for document sections.
		if (flags.plan !== undefined && !target.license) target.license = { plan: flags.plan };
		if (flags.push && !target.push) target.push = {};
		const global = Boolean(target.fresh) || Boolean(target.license) || Boolean(target.push);
		singleRoles = rolesFor(values, target, flags);
		if (!domainValue && !global) {
			console.error("Nothing to do. Pass a document (--spec <path>), --all, --domain <hostname>, --plan <team|pro|community>, or --push.\n");
			usage();
			process.exit(1);
		}
		if (domainValue && singleRoles.length === 0 && !global) {
			console.error("Nothing to do for this domain. Use a document (--spec <path>), --roles a,b,c, or --roles-file <path>.\n");
			usage();
			process.exit(1);
		}
		entries = [{ name: domainValue, spec: target }];
	}
} catch (error) {
	console.error(message(error));
	process.exit(1);
}

let exitCode = 1;
try {
	exitCode = await withStore({ db: flags.db, local: flags.local, url: flags.url }, async (store) => {
		if (useSpecs) return await runSpecs(store, flags, values, entries);
		const [entry] = entries;
		return await run(makeContext(store, flags, entry.spec, entry.name.toLowerCase()), singleRoles);
	});
} catch (error) {
	console.error(message(error));
}
process.exit(exitCode);
