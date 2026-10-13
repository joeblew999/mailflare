#!/usr/bin/env node
// The one entry point. Everything this system does - onboarding, mailboxes, accounts,
// routing rules, MCP keys, the license, web push - is a Resource (see
// ./provision/resources.ts) applied by one loop, and every capability can be declared
// in JSON. There is no per-capability command.
//
//   npm run joeblew999 -- --file scripts/joeblew999/projects/example.json
//   npm run joeblew999 -- --domain example.com --roles office,admin
//   npm run joeblew999 -- --all --dry-run
//   npm run joeblew999 -- --plan team        # global capabilities need no domain
//   npm run joeblew999 -- --push
//
// ⚠ MX WARNING — `--onboard` publishes Mailflare's Email Routing MX for the domain.
//   On a domain that already receives mail (a live company domain) that redirects its
//   real mail, so the script refuses unless you pass --confirm-mx.
import { parseCli, usage } from "./provision/args";
import { loadProject, loadRoles } from "./provision/manifest";
import { loadProjects, runBatch, type ProjectEntry } from "./provision/batch";
import { makeContext } from "./provision/context";
import { run } from "./provision/commands";
import { pushRunbook } from "./provision/push";
import { withProvisionStore } from "./lib-app";
import type { ProjectManifest, Role } from "./provision/types";

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

// --all/--file load many projects; the global convenience flags run a single target.
const fileMode = Boolean(values.all) || Boolean(values.file);
const useBatch = fileMode && !flags.licenseStatus;
let entries: ProjectEntry[];
let singleRoles: Role[] = [];

try {
	if (flags.licenseStatus) {
		flags.status = true;
		entries = [{ name: "", project: { license: {} } }];
	} else if (useBatch) {
		entries = loadProjects({ file: values.file ? String(values.file) : undefined, dir: String(values.dir) });
	} else {
		const project: ProjectManifest | null = values.project ? loadProject(String(values.project)) : null;
		const domainValue = String(values.domain ?? project?.domain ?? "").trim();
		const target: ProjectManifest = project ?? { domain: domainValue };
		// The convenience flags are just shorthand for manifest sections.
		if (flags.plan !== undefined && !target.license) target.license = { plan: flags.plan };
		if (flags.push && !target.push) target.push = {};
		const global = Boolean(target.license) || Boolean(target.push);
		singleRoles = loadRoles(values, target, flags);
		if (!domainValue && !global) {
			console.error("Nothing to do. Pass --project/--file, --all, --domain <hostname>, --plan <team|pro|community>, or --push.\n");
			usage();
			process.exit(1);
		}
		if (domainValue && singleRoles.length === 0 && !global) {
			console.error("No mailboxes to provision. Use --project/--file <path>, --roles a,b,c, or --roles-file <path>.\n");
			usage();
			process.exit(1);
		}
		entries = [{ name: domainValue, project: target }];
	}
} catch (error) {
	console.error(message(error));
	process.exit(1);
}

let exitCode = 1;
try {
	exitCode = await withProvisionStore({ db: flags.db, local: flags.local, url: flags.url }, async (store) => {
		if (useBatch) return await runBatch(store, flags, values, entries);
		const [entry] = entries;
		return await run(makeContext(store, flags, entry.project, entry.name.toLowerCase()), singleRoles);
	});
} catch (error) {
	console.error(message(error));
}
process.exit(exitCode);
