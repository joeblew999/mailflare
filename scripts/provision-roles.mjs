#!/usr/bin/env node
// Provision role mailboxes for a project (e.g. the remy-sport office) on a domain
// that is already onboarded in Mailflare. One mailbox per role, mirroring the roles
// an app has. Idempotent: addresses that already exist are left alone.
//
//   npm run provision:roles -- --domain ubuntusoftware.net --roles office,admin,events
//     --share      create them as shared mailboxes (Team plan)
//     --dry-run    show what it would do, change nothing
//     --cleanup    delete exactly the role mailboxes on that domain
//
// Runs under tsx (it imports app code via ./lib-app.mjs).
import { parseArgs } from "node:util";
import { d1 as libD1, findAdmin, request, resolveInstanceUrl, sqlEscape } from "./lib.mjs";
import { mintAdminKey } from "./lib-app.mjs";

const { values } = parseArgs({
	options: {
		domain: { type: "string" },
		roles: { type: "string", default: "" },
		share: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		cleanup: { type: "boolean", default: false },
		url: { type: "string" },
		db: { type: "string", default: "mailflare" },
		local: { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

function usage() {
	console.log(`provision-roles — create one Mailflare mailbox per role on a domain.

  npm run provision:roles -- --domain <hostname> --roles a,b,c [--share] [--dry-run]
  npm run provision:roles -- --domain <hostname> --roles a,b,c --cleanup

Flags:
  --domain <hostname>   domain already onboarded in Mailflare (Admin → Domains)
  --roles <a,b,c>       role names to create (one mailbox each)
  --share               create them as shared mailboxes (needs Team)
  --dry-run             list what would change, create nothing
  --cleanup             delete the role mailboxes instead of creating them
  --url <base>          instance URL (else derived from Cloudflare)
  --db / --local        target a different D1 database / the local one
  -h, --help            show this help`);
}

if (values.help) {
	usage();
	process.exit(0);
}
if (!values.domain) {
	console.error("--domain is required.\n");
	usage();
	process.exit(1);
}

const roles = values.roles.split(",").map((role) => role.trim().toLowerCase()).filter(Boolean);
if (roles.length === 0) {
	console.error("--roles is required (comma-separated).\n");
	usage();
	process.exit(1);
}

function d1(sql) {
	return libD1(sql, { db: values.db, local: values.local });
}

const base = await resolveInstanceUrl({ url: values.url });
if (!base) {
	console.error("Could not determine the instance URL. Pass --url or set MAILFLARE_URL.");
	process.exit(1);
}

const admin = findAdmin({ db: values.db, local: values.local });
if (!admin) {
	console.error("No admin user found — is the instance set up?");
	process.exit(1);
}

const domainName = values.domain.toLowerCase();
const { fullKey, keyId } = mintAdminKey({ db: values.db, local: values.local, adminId: admin.id, name: "provision" });

try {
	const domains = await request(base, "/api/v1/domains", { key: fullKey });
	const domain = (domains.json?.domains ?? []).find((entry) => String(entry.hostname).toLowerCase() === domainName);
	if (!domain) {
		console.error(`"${values.domain}" is not onboarded in Mailflare.`);
		console.error("Add it under Admin → Domains first (or POST /api/v1/domains).");
		process.exit(1);
	}

	const boxes = await request(base, "/api/v1/mailboxes", { key: fullKey });
	const existing = new Map(
		(boxes.json?.mailboxes ?? [])
			.filter((entry) => String(entry.hostname).toLowerCase() === domainName)
			.map((entry) => [String(entry.localPart).toLowerCase(), entry]),
	);

	console.log(`${values.cleanup ? "Removing" : "Provisioning"} ${roles.length} role(s) on ${values.domain}:\n`);

	for (const role of roles) {
		const address = `${role}@${values.domain}`;
		const current = existing.get(role);

		if (values.cleanup) {
			if (!current) {
				console.log(`  · ${address} — not present, skipping`);
				continue;
			}
			if (values["dry-run"]) {
				console.log(`  → would delete ${address}`);
				continue;
			}
			const removed = await request(base, `/api/v1/mailboxes/${current.id}`, { method: "DELETE", key: fullKey });
			console.log(`  ${removed.status === 200 ? "✓ deleted" : `✗ delete failed (HTTP ${removed.status})`} ${address}`);
			continue;
		}

		if (current) {
			console.log(`  · ${address} — already exists, skipping`);
			continue;
		}
		if (values["dry-run"]) {
			console.log(`  → would create ${address}${values.share ? " (shared)" : ""}`);
			continue;
		}
		const created = await request(base, "/api/v1/mailboxes", {
			method: "POST",
			key: fullKey,
			body: { domainId: domain.id, localPart: role, displayName: role, type: values.share ? "shared" : "personal" },
		});
		console.log(`  ${created.status === 201 ? "✓ created" : `✗ failed (HTTP ${created.status})`} ${address}${values.share ? " (shared)" : ""}`);
	}

	if (!values["dry-run"]) {
		console.log(`\nMailboxes: ${base}/mailboxes`);
	}
} finally {
	d1(`DELETE FROM api_keys WHERE id='${sqlEscape(keyId)}';`);
}
