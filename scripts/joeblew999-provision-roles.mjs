#!/usr/bin/env node
// Provision role mailboxes for a project (e.g. the remy-sport office) on any domain.
// One mailbox per role, mirroring the roles an app has. Idempotent: addresses that
// already exist are left alone. Pass --onboard to add the domain to Mailflare first.
//
//   npm run joeblew999:provision:roles -- --domain ubuntusoftware.net --roles office,admin,events
//     --onboard        add the domain to Mailflare first (this publishes MX)
//     --replace-mx     when onboarding, take over MX from another provider
//     --share          create them as shared mailboxes (Team plan)
//     --dry-run        show what it would do, change nothing
//     --cleanup        delete exactly the role mailboxes on that domain
//     --roles-file <p> read the role list from a file (JSON array or one per line)
//
// Runs under tsx (it imports app code via ./joeblew999-lib-app.mjs).
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { request } from "./joeblew999-lib.mjs";
import { withAdminKey } from "./joeblew999-lib-app.mjs";

const { values } = parseArgs({
	options: {
		domain: { type: "string" },
		roles: { type: "string", default: "" },
		"roles-file": { type: "string" },
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

  npm run joeblew999:provision:roles -- --domain <hostname> --roles a,b,c [--onboard] [--share] [--dry-run]
  npm run joeblew999:provision:roles -- --domain <hostname> --roles a,b,c --cleanup

Flags:
  --domain <hostname>   the domain to provision on
  --roles <a,b,c>       role names to create (one mailbox each)
  --roles-file <path>   read the role names from a file instead (JSON array or one per line)
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

async function main() {
	const domainName = values.domain.toLowerCase();
	try {
		return await withAdminKey({ db: values.db, local: values.local, url: values.url, name: "provision" }, async ({ base, key }) => {
			let domains = await request(base, "/api/v1/domains", { key: key });
			let domain = findDomain(domains.json?.domains, domainName);

			// Add the domain to Mailflare first when asked (publishes MX).
			if (!domain) {
				if (!values.onboard) {
					console.error(`"${values.domain}" is not onboarded in Mailflare.`);
					console.error("Add it under Admin → Domains, or pass --onboard to add it now (this publishes MX).");
					return 1;
				}
				if (values["dry-run"]) {
					console.log(`  → would onboard ${values.domain}, then create ${roles.map(({ role }) => `${role}@${values.domain}`).join(", ")}`);
					return 0;
				}
				console.log(`Onboarding ${values.domain} into Mailflare…`);
				const added = await request(base, "/api/v1/domains", {
					method: "POST",
					key: key,
					body: { hostname: values.domain, enableRouting: true, replaceMxRecords: values["replace-mx"] },
				});
				if (added.status !== 200 && added.status !== 201) {
					console.error(`Could not onboard ${values.domain}: HTTP ${added.status} ${added.json?.error ?? ""}`);
					return 1;
				}
				domains = await request(base, "/api/v1/domains", { key: key });
				domain = findDomain(domains.json?.domains, domainName);
				if (!domain) {
					console.error(`Onboarded ${values.domain} but it is not listed afterwards.`);
					return 1;
				}
			}

			const boxes = await request(base, "/api/v1/mailboxes", { key: key });
			const existing = new Map(
				(boxes.json?.mailboxes ?? [])
					.filter((entry) => String(entry.hostname).toLowerCase() === domainName)
					.map((entry) => [String(entry.localPart).toLowerCase(), entry]),
			);

			console.log(`${values.cleanup ? "Removing" : "Provisioning"} ${roles.length} role(s) on ${values.domain}:\n`);
			let failures = 0;

			for (const { role, displayName, share } of roles) {
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
					const removed = await request(base, `/api/v1/mailboxes/${current.id}`, { method: "DELETE", key: key });
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
					console.log(`  → would create ${address}${share ? " (shared)" : ""}`);
					continue;
				}
				const created = await request(base, "/api/v1/mailboxes", {
					method: "POST",
					key: key,
					body: { domainId: domain.id, localPart: role, displayName, type: share ? "shared" : "personal" },
				});
				if (created.status === 201) {
					console.log(`  ✓ created ${address}${share ? " (shared)" : ""}`);
				} else {
					failures += 1;
					console.log(`  ✗ failed (HTTP ${created.status}) ${address} — ${created.json?.error ?? ""}`);
				}
			}

			if (!values["dry-run"]) console.log(`\nMailboxes: ${base}/mailboxes`);
			return failures === 0 ? 0 : 1;
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
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

// Roles come from --roles a,b,c or --roles-file <path>. Each entry is normalised
// to { role, displayName, share } so both sources behave identically.
function readRolesFile(path) {
	const text = readFileSync(path, "utf8");
	if (path.toLowerCase().endsWith(".json")) {
		const parsed = JSON.parse(text);
		if (!Array.isArray(parsed)) throw new Error("roles file must be a JSON array");
		return parsed.map((entry) => (typeof entry === "string" ? { role: entry } : entry));
	}
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((role) => ({ role }));
}

function loadRoles() {
	const entries = values["roles-file"]
		? readRolesFile(values["roles-file"])
		: values.roles.split(",").filter(Boolean).map((role) => ({ role }));
	return entries
		.map((entry) => {
			const role = String(entry.role ?? entry.localPart ?? "").trim().toLowerCase();
			if (!role) return null;
			return { role, displayName: entry.displayName?.trim() || role, share: typeof entry.share === "boolean" ? entry.share : values.share };
		})
		.filter(Boolean);
}

const roles = loadRoles();
if (roles.length === 0) {
	console.error("No roles given. Pass --roles a,b,c or --roles-file <path>.\n");
	usage();
	process.exit(1);
}

process.exit(await main());
