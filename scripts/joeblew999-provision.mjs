#!/usr/bin/env node
// Provision a domain's mailboxes from a per-project manifest (or an ad-hoc role
// list). Idempotent: addresses that already exist are left alone. `--onboard` adds
// the domain to Mailflare first (which publishes MX).
//
//   npm run joeblew999:provision -- --project scripts/joeblew999-project.example.json
//   npm run joeblew999:provision -- --domain ubuntusoftware.net --roles office,admin
//
// Project file (JSON):
//   {
//     "domain": "ubuntusoftware.net",
//     "onboard": { "enableRouting": true, "replaceMxRecords": true },
//     "mailboxes": [
//       { "role": "office",  "displayName": "Office" },
//       { "role": "support", "shared": true,
//         "access": [ { "email": "gedw99@gmail.com", "permission": "full_access" } ] }
//     ]
//   }
//
// Flags:
//   --project <path>      apply a project manifest (domain + mailboxes + onboard)
//   --domain <hostname>   domain to provision on (overrides the manifest)
//   --roles <a,b,c>       ad-hoc role names (alternative to a manifest)
//   --roles-file <path>   read roles from a file (JSON array or one per line)
//   --onboard             add the domain to Mailflare first (publishes MX)
//   --replace-mx          when onboarding, take MX over from another provider
//   --share               create the mailboxes as shared (Team plan)
//   --dry-run             show what it would do, change nothing
//   --status              report what exists vs the manifest (no changes)
//   --cleanup             delete the mailboxes instead of creating them
//
// Runs under tsx (it imports app code via ./joeblew999-lib-app.mjs).
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { d1 as libD1, request, sqlEscape } from "./joeblew999-lib.mjs";
import { withAdminKey } from "./joeblew999-lib-app.mjs";

const { values } = parseArgs({
	options: {
		domain: { type: "string" },
		project: { type: "string" },
		roles: { type: "string", default: "" },
		"roles-file": { type: "string" },
		onboard: { type: "boolean", default: false },
		"replace-mx": { type: "boolean", default: false },
		share: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		status: { type: "boolean", default: false },
		cleanup: { type: "boolean", default: false },
		url: { type: "string" },
		db: { type: "string", default: "mailflare" },
		local: { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

function usage() {
	console.log(`provision — stand up a domain's mailboxes from a project manifest.

  npm run joeblew999:provision -- --project scripts/joeblew999-project.example.json
  npm run joeblew999:provision -- --domain <hostname> --roles a,b,c [--onboard] [--share]
  npm run joeblew999:provision -- --domain <hostname> --roles a,b,c --cleanup

Project file (JSON):
  { "domain": "...", "onboard": { "replaceMxRecords": true },
    "mailboxes": [ { "role": "office", "displayName": "Office" },
                   { "role": "support", "shared": true } ] }

Flags:
  --project <path>      apply a project manifest (domain + mailboxes + onboard)
  --domain <hostname>   domain to provision on (overrides the manifest)
  --roles <a,b,c>       ad-hoc role names (alternative to a manifest)
  --roles-file <path>   read role names from a file (JSON array or one per line)
  --onboard             add the domain to Mailflare first (publishes MX)
  --replace-mx          when onboarding, take MX over from another provider
  --share               create the mailboxes as shared (needs Team)
  --dry-run             list what would change, create nothing
  --status              report what exists vs the manifest, change nothing
  --cleanup             delete the mailboxes instead of creating them
  --url <base>          instance URL (else MAILFLARE_URL, else derived from Cloudflare)
  --db / --local        target a different D1 database / the local one
  -h, --help            show this help`);
}

const findDomain = (list, name) => (list ?? []).find((entry) => String(entry.hostname).toLowerCase() === name);

// A project manifest carries the domain plus what to create on it.
let project = null;
if (values.project) {
	try {
		project = JSON.parse(readFileSync(values.project, "utf8"));
		if (!project || typeof project !== "object" || Array.isArray(project)) throw new Error("must be a JSON object");
	} catch (error) {
		console.error(`Could not read project file ${values.project}: ${error.message}`);
		process.exit(1);
	}
}

// Effective values: an explicit flag wins over the manifest.
const domainValue = (values.domain ?? project?.domain ?? "").trim();
const onboardValue = values.onboard || Boolean(project?.onboard);
const replaceMxValue = values["replace-mx"] || Boolean(project?.onboard?.replaceMxRecords);

const d1 = (sql) => libD1(sql, { db: values.db, local: values.local });

// Onboard body: manifest options with sane defaults.
function onboardBody(hostname) {
	const o = project?.onboard ?? {};
	const body = { hostname, enableRouting: o.enableRouting ?? true, replaceMxRecords: replaceMxValue };
	if (typeof o.enableSending === "boolean") body.enableSending = o.enableSending;
	if (o.sendingProvider) body.sendingProvider = o.sendingProvider;
	if (o.receivingProvider) body.receivingProvider = o.receivingProvider;
	return body;
}

const PERMISSIONS = new Set(["read_only", "send_as", "send_on_behalf", "full_access"]);

// Apply a mailbox's `access: [{ email, permission }]` grants straight to
// mailbox_access (what the app reads). Deleting the mailbox cascades them away.
function applyAccess(mailboxId, address, grants, dryRun) {
	let failures = 0;
	for (const grant of grants) {
		const email = String(grant.email ?? "").trim().toLowerCase();
		const permission = String(grant.permission ?? "full_access").trim();
		if (!email || !PERMISSIONS.has(permission)) {
			console.log(`     ✗ ${address}: bad access entry ${JSON.stringify(grant)}`);
			failures += 1;
			continue;
		}
		const [user] = d1(`SELECT id FROM users WHERE lower(email)='${sqlEscape(email)}' LIMIT 1;`);
		if (!user) {
			console.log(`     ✗ ${address}: no user with email ${email}`);
			failures += 1;
			continue;
		}
		if (dryRun) {
			console.log(`     → would grant ${permission} on ${address} to ${email}`);
			continue;
		}
		d1(`INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at)
		    VALUES ('mac_${randomBytes(6).toString("hex")}', '${sqlEscape(mailboxId)}', '${sqlEscape(user.id)}', '${sqlEscape(permission)}', strftime('%s','now'))
		    ON CONFLICT(mailbox_id, user_id) DO UPDATE SET permission=excluded.permission;`);
		console.log(`     ✓ ${permission} on ${address} → ${email}`);
	}
	return failures;
}

async function main() {
	const domainName = domainValue.toLowerCase();
	try {
		return await withAdminKey({ db: values.db, local: values.local, url: values.url, name: "provision" }, async ({ base, key }) => {
			let domains = await request(base, "/api/v1/domains", { key: key });
			let domain = findDomain(domains.json?.domains, domainName);

			// --status: report what the manifest wants vs what exists, change nothing.
			if (values.status) {
				if (!domain) {
					console.log(`✗ ${domainValue} is not onboarded in Mailflare.`);
					return 1;
				}
				const boxes = await request(base, "/api/v1/mailboxes", { key: key });
				const present = new Map(
					(boxes.json?.mailboxes ?? [])
						.filter((entry) => String(entry.hostname).toLowerCase() === domainName)
						.map((entry) => [String(entry.localPart).toLowerCase(), entry]),
				);
				console.log(`Status for ${domainValue} — ${roles.length} mailbox(es) wanted:\n`);
				let missing = 0;
				for (const { role, share, access } of roles) {
					const box = present.get(role);
					if (!box) missing += 1;
					console.log(`  ${box ? "✓" : "✗"} ${role}@${domainValue}${share ? " (shared)" : ""}${box ? ` — ${box.type}` : " — missing"}`);
					for (const grant of access) {
						const email = String(grant.email ?? "").toLowerCase();
						const permission = String(grant.permission ?? "full_access");
						const [user] = d1(`SELECT id FROM users WHERE lower(email)='${sqlEscape(email)}' LIMIT 1;`);
						const [row] = user && box ? d1(`SELECT permission FROM mailbox_access WHERE mailbox_id='${sqlEscape(box.id)}' AND user_id='${sqlEscape(user.id)}';`) : [];
						const ok = row?.permission === permission;
						if (!ok) missing += 1;
						console.log(`      ${ok ? "✓" : "✗"} ${email} → ${permission}${row ? ` (is ${row.permission})` : ""}`);
					}
				}
				console.log(missing === 0 ? "\nEverything provisioned." : `\n${missing} item(s) missing — run without --status to apply.`);
				return missing === 0 ? 0 : 1;
			}

			// Add the domain to Mailflare first when asked (publishes MX).
			if (!domain) {
				if (!onboardValue) {
					console.error(`"${domainValue}" is not onboarded in Mailflare.`);
					console.error("Add it under Admin → Domains, or pass --onboard to add it now (this publishes MX).");
					return 1;
				}
				if (values["dry-run"]) {
					console.log(`  → would onboard ${domainValue}, then create ${roles.map(({ role }) => `${role}@${domainValue}`).join(", ")}`);
					return 0;
				}
				console.log(`Onboarding ${domainValue} into Mailflare…`);
				const added = await request(base, "/api/v1/domains", {
					method: "POST",
					key: key,
					body: onboardBody(domainValue),
				});
				if (added.status !== 200 && added.status !== 201) {
					console.error(`Could not onboard ${domainValue}: HTTP ${added.status} ${added.json?.error ?? ""}`);
					return 1;
				}
				domains = await request(base, "/api/v1/domains", { key: key });
				domain = findDomain(domains.json?.domains, domainName);
				if (!domain) {
					console.error(`Onboarded ${domainValue} but it is not listed afterwards.`);
					return 1;
				}
			}

			const boxes = await request(base, "/api/v1/mailboxes", { key: key });
			const existing = new Map(
				(boxes.json?.mailboxes ?? [])
					.filter((entry) => String(entry.hostname).toLowerCase() === domainName)
					.map((entry) => [String(entry.localPart).toLowerCase(), entry]),
			);

			console.log(`${values.cleanup ? "Removing" : "Provisioning"} ${roles.length} role(s) on ${domainValue}:\n`);
			let failures = 0;

			for (const { role, displayName, share, access } of roles) {
				const address = `${role}@${domainValue}`;
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

				let mailboxId = current?.id ?? null;
				if (mailboxId) {
					console.log(`  · ${address} — already exists`);
				} else if (values["dry-run"]) {
					console.log(`  → would create ${address}${share ? " (shared)" : ""}`);
				} else {
					const created = await request(base, "/api/v1/mailboxes", {
						method: "POST",
						key: key,
						body: { domainId: domain.id, localPart: role, displayName, type: share ? "shared" : "personal" },
					});
					if (created.status === 201) {
						mailboxId = created.json.id;
						console.log(`  ✓ created ${address}${share ? " (shared)" : ""}`);
					} else {
						failures += 1;
						console.log(`  ✗ failed (HTTP ${created.status}) ${address} — ${created.json?.error ?? ""}`);
					}
				}

				if (access.length && (mailboxId || values["dry-run"])) {
					failures += applyAccess(mailboxId ?? "«new»", address, access, values["dry-run"]);
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
if (!domainValue) {
	console.error("No domain. Pass --project <file> or --domain <hostname>.\n");
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
	// Precedence: project manifest → roles file → ad-hoc --roles.
	const entries = project?.mailboxes?.length
		? project.mailboxes
		: values["roles-file"]
			? readRolesFile(values["roles-file"])
			: values.roles.split(",").filter(Boolean).map((role) => ({ role }));
	return entries
		.map((entry) => {
			const role = String(entry.role ?? entry.localPart ?? "").trim().toLowerCase();
			if (!role) return null;
			const share = typeof entry.share === "boolean" ? entry.share : typeof entry.shared === "boolean" ? entry.shared : values.share;
			const access = Array.isArray(entry.access) ? entry.access : [];
			return { role, displayName: entry.displayName?.trim() || role, share, access };
		})
		.filter(Boolean);
}

const roles = loadRoles();
if (roles.length === 0) {
	console.error("No mailboxes to provision. Use --project <file>, --roles a,b,c, or --roles-file <path>.\n");
	usage();
	process.exit(1);
}

process.exit(await main());
