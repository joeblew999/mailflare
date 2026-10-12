#!/usr/bin/env node
// Provision a domain's mailboxes from a per-project manifest (or an ad-hoc role list).
// Idempotent: addresses that already exist are left alone.
//
// ⚠ MX WARNING — `--onboard` publishes Mailflare's Email Routing MX for the domain.
//   On a domain that already receives mail (a live company domain) that redirects its
//   real mail. The script REFUSES to onboard a domain that already has MX records
//   unless you pass --confirm-mx.
//
//   npm run joeblew999:provision -- --project scripts/joeblew999-project.example.json
//   npm run joeblew999:provision -- --domain example.com --roles office,admin
//   npm run joeblew999:provision -- --all [--dry-run|--status]
//
// Project file (JSON):
//   {
//     "domain": "example.com",
//     "onboard": { "enableRouting": true, "replaceMxRecords": false },
//     "mailboxes": [
//       { "role": "office",  "displayName": "Office" },
//       { "role": "support", "shared": true,
//         "access": [ { "email": "you@example.com", "permission": "full_access" } ] }
//     ],
//     "accounts": [ { "username": "sam", "role": "user", "passwordEnv": "PROV_PASSWORD" } ],
//     "routing":  [ { "pattern": "*", "action": "forward", "forwardTo": "you@example.com" } ],
//     "mcpKeys":  [ { "name": "agent", "mailboxes": ["office"], "scopes": ["mcp:read", "mcp:draft"] } ]
//   }
//
// Manifest sections:
//   onboard   domain options (enableRouting / enableSending / providers / replaceMxRecords)
//   mailboxes role mailboxes, shared inboxes, and access grants (to OTHER users)
//   accounts  login accounts (password, or passwordEnv, else a generated one printed once)
//   routing   domain-scope rules run during address resolution: forward / reject / store
//   mcpKeys   MCP keys for AI agents; prints the ready-to-paste client config
//
// De-provisioning (reverse order; only paths the app supports):
//   --cleanup            remove the manifest's mailboxes, routing rules and MCP keys
//   --disable-accounts   also DISABLE its accounts (the app has no user-delete)
//   --remove-domain      also remove the domain itself (drops its DNS/MX)
//
// Runs under tsx; the implementation lives in ./joeblew999-provision/.
import { parseCli, usage } from "./joeblew999-provision/cli";
import { loadProject, loadRoles } from "./joeblew999-provision/manifest";
import { withContext } from "./joeblew999-provision/context";
import { run } from "./joeblew999-provision/commands";
import { runAll } from "./joeblew999-provision/mass";
import type { ProjectManifest } from "./joeblew999-provision/types";

const { values, flags } = parseCli();

if (values.help) {
	usage();
	process.exit(0);
}
if (values.all) {
	process.exit(await runAll(values));
}

let project: ProjectManifest | null = null;
if (values.project) {
	try {
		project = loadProject(values.project);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

const domainValue = String(values.domain ?? project?.domain ?? "").trim();
if (!domainValue) {
	console.error("No domain. Pass --project <file> or --domain <hostname>.\n");
	usage();
	process.exit(1);
}

const roles = loadRoles(values, project, flags);
if (roles.length === 0) {
	console.error("No mailboxes to provision. Use --project <file>, --roles a,b,c, or --roles-file <path>.\n");
	usage();
	process.exit(1);
}

process.exit(await withContext(flags, project, domainValue.toLowerCase(), (ctx) => run(ctx, roles)));
