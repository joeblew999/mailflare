#!/usr/bin/env node
// Provision (or tear down) domains from a JSON manifest.
// Idempotent: addresses that already exist are left alone, and drift is reconciled.
//
// ⚠ MX WARNING — `--onboard` publishes Mailflare's Email Routing MX for the domain.
//   On a domain that already receives mail (a live company domain) that redirects its
//   real mail. The script REFUSES to onboard a domain that already has MX records
//   unless you pass --confirm-mx.
//
//   npm run joeblew999:provision -- --file scripts/joeblew999-project.example.json
//   npm run joeblew999:provision -- --domain example.com --roles office,admin
//   npm run joeblew999:provision -- --all --dry-run
//   npm run joeblew999:provision -- --file big.json      # { "projects": [ ... ] }
//
// Mass input is ONE file holding many projects; it is loaded once and a single admin
// key covers the whole run. The implementation lives in ./joeblew999-provision/, and
// all data access goes through the Store seam in store-types.ts.
//
// De-provisioning (reverse order; only paths the app supports):
//   --cleanup            remove the manifest's mailboxes, routing rules and MCP keys
//   --disable-accounts   also DISABLE its accounts (the app has no user-delete)
//   --remove-domain      also remove the domain itself (drops its DNS/MX)
import { parseCli, usage } from "./joeblew999-provision/cli";
import { loadProject, loadRoles } from "./joeblew999-provision/manifest";
import { loadProjects, runBatch, type ProjectEntry } from "./joeblew999-provision/batch";
import { makeContext } from "./joeblew999-provision/context";
import { run } from "./joeblew999-provision/commands";
import { withProvisionStore } from "./joeblew999-lib-app";
import type { ProjectManifest, Role } from "./joeblew999-provision/types";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const { values, flags } = parseCli();

if (values.help) {
	usage();
	process.exit(0);
}

const batch = Boolean(values.all) || Boolean(values.file);
let entries: ProjectEntry[];
let singleRoles: Role[] = [];

try {
	if (batch) {
		entries = loadProjects({ file: values.file ? String(values.file) : undefined, dir: String(values.dir) });
	} else {
		const project: ProjectManifest | null = values.project ? loadProject(String(values.project)) : null;
		const domainValue = String(values.domain ?? project?.domain ?? "").trim();
		if (!domainValue) {
			console.error("No domain. Pass --project/--file <path>, --all, or --domain <hostname>.\n");
			usage();
			process.exit(1);
		}
		const target: ProjectManifest = project ?? { domain: domainValue };
		singleRoles = loadRoles(values, target, flags);
		if (singleRoles.length === 0) {
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
		if (batch) return await runBatch(store, flags, values, entries);
		const [entry] = entries;
		return await run(makeContext(store, flags, entry.project, entry.name.toLowerCase()), singleRoles);
	});
} catch (error) {
	console.error(message(error));
}
process.exit(exitCode);
