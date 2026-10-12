#!/usr/bin/env node
// Provision role mailboxes for a project (e.g. the remy-sport office) on any domain.
// One mailbox per role, mirroring the roles an app has. Idempotent: addresses that
// already exist are left alone. Pass --onboard to add the domain to Mailflare first.
//
//   npm run provision:roles -- --domain ubuntusoftware.net --roles office,admin,events
//     --onboard        add the domain to Mailflare first (this publishes MX)
//     --replace-mx     when onboarding, take over MX from another provider
//     --share          create them as shared mailboxes (Team plan)
//     --dry-run        show what it would do, change nothing
//     --cleanup        delete exactly the role mailboxes on that domain
//
// Runs under tsx (it imports app code via ./lib-app.mjs).
import { parseArgs } from "node:util";
import { d1 as libD1, findAdmin, request, resolveInstanceUrl, sqlEscape } from "./lib.mjs";
import { mintAdminKey } from "./lib-app.mjs";

const { values } = parseArgs({
	options: {
		domain: { type: "string" },
		roles: { type: "string", default: "" },
		onboard: { type: "boolean", default: false },
		"replace-mx": { type: "boolean", default: false },
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
	console.log(`provision-roles — create one Mailflare mailbox per role on any domain.

  npm run provision:roles -- --domain <hostname> --roles a,b,c [--onboard] [--share] [--dry-run]
  npm run provision:roles -- --domain <hostname> --roles a,b,c --cleanup

Flags:
  --domain <hostname>   the domain to provision on
  --roles <a,b,c>       role names to create (one mailbox each)
  --onboard             add the domain to Mailflare first (publishes MX)
  --replace-mx          when onboarding, take MX over from another provider
  --share               create them as shared mailboxes (needs Team)
  --dry-run             list what would change, create nothing
  --cleanup             delete the role mailboxes instead of creating them
  --url <base>          instance URL (else MAILFLARE_URL, else derived from Cloudflare)
  --db / --local        target a different D1 database / the local one
  -h, --help            show this help`);
}

const findDomain = (list, name) => (list ?? []).find((entry) => String(entry.hostname).toLowerCase() === name);
const d1 = (sql) => libD1(sql, { db: values.db, local: values.local });

async function main() {
	const base = await resolveInstanceUrl({ url: values.url });
	if (!base) {
		console.error("Could not determine the instance URL. Pass --url or set MAILFLARE_URL.");
		return 1;
	}

	const admin = findAdmin({ db: values.db, local: values.local });
	if (!admin) {
		console.error("No admin user found — is the instance set up?");
		return 1;
	}

	const domainName = values.domain.toLowerCase();
	const { fullKey, keyId } = mintAdminKey({ db: values.db, local: values.local, adminId: admin.id, name: "provision" });
	try {
		let domains = await request(base, "/api/v1/domains", { key: fullKey });
		let domain = findDomain(domains.json?.domains, domainName);

		// Add the domain to Mailflare first when asked (publishes MX).
		if (!domain) {
			if (!values.onboard) {
				console.error(`"${values.domain}" is not onboarded in Mailflare.`);
				console.error("Add it under Admin → Domains, or pass --onboard to add it now (this publishes MX).");
				return 1;
			}
			if (values["dry-run"]) {
				console.log(`  → would onboard ${values.domain}, then create ${roles.map((role) => `${role}@${values.domain}`).join(", ")}`);
				return 0;
			}
			console.log(`Onboarding ${values.domain} into Mailflare…`);
			const added = await request(base, "/api/v1/domains", {
				method: "POST",
				key: fullKey,
				body: { hostname: values.domain, enableRouting: true, replaceMxRecords: values["replace-mx"] },
			});
			if (added.status !== 200 && added.status !== 201) {
				console.error(`Could not onboard ${values.domain}: HTTP ${added.status} ${added.json?.error ?? ""}`);
				return 1;
			}
			domains = await request(base, "/api/v1/domains", { key: fullKey });
			domain = findDomain(domains.json?.domains, domainName);
			if (!domain) {
				console.error(`Onboarded ${values.domain} but it is not listed afterwards.`);
				return 1;
			}
		}

		const boxes = await request(base, "/api/v1/mailboxes", { key: fullKey });
		const existing = new Map(
			(boxes.json?.mailboxes ?? [])
				.filter((entry) => String(entry.hostname).toLowerCase() === domainName)
				.map((entry) => [String(entry.localPart).toLowerCase(), entry]),
		);

		console.log(`${values.cleanup ? "Removing" : "Provisioning"} ${roles.length} role(s) on ${values.domain}:\n`);
		let failures = 0;

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
				if (removed.status === 200) {
					console.log(`  ✓ deleted ${address}`);
				} else {
					failures += 1;
					console.log(`  ✗ delete failed (HTTP ${removed.status}) ${address}`);
				}
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
			if (created.status === 201) {
				console.log(`  ✓ created ${address}${values.share ? " (shared)" : ""}`);
			} else {
				failures += 1;
				console.log(`  ✗ failed (HTTP ${created.status}) ${address} — ${created.json?.error ?? ""}`);
			}
		}

		if (!values["dry-run"]) console.log(`\nMailboxes: ${base}/mailboxes`);
		return failures === 0 ? 0 : 1;
	} finally {
		// Always remove the temporary key, even when we return early.
		d1(`DELETE FROM api_keys WHERE id='${sqlEscape(keyId)}';`);
	}
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

process.exit(await main());
