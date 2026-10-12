#!/usr/bin/env node
// Provision a domain's mailboxes from a per-project manifest (or an ad-hoc role list).
// Idempotent: addresses that already exist are left alone.
//
// ⚠ MX WARNING — `--onboard` publishes Mailflare's Email Routing MX for the domain.
//   On a domain that already receives mail (a live company domain), that redirects
//   its real mail. The script REFUSES to onboard a domain that already has MX
//   records unless you pass --confirm-mx.
//
//   npm run joeblew999:provision -- --project scripts/joeblew999-project.example.json
//   npm run joeblew999:provision -- --domain example.com --roles office,admin
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
// Flags:
//   --project <path>      apply a project manifest (domain + mailboxes + onboard)
//   --domain <hostname>   domain to provision on (overrides the manifest)
//   --roles <a,b,c>       ad-hoc role names (alternative to a manifest)
//   --roles-file <path>   read roles from a file (JSON array or one per line)
//   --onboard             add the domain to Mailflare first (publishes MX)
//   --replace-mx          when onboarding, take MX over from another provider
//   --confirm-mx          allow onboarding a domain that already has MX records
//   --share               create the mailboxes as shared (Team plan)
//   --dry-run             show what it would do, change nothing
//   --status              report what exists vs the manifest (no changes)
//   --cleanup             delete the mailboxes instead of creating them
//
// De-provisioning (reverse order; only paths the app supports):
//   --cleanup            remove the manifest's mailboxes, routing rules and MCP keys
//   --disable-accounts   also DISABLE its accounts (the app has no user-delete)
//   --remove-domain      also remove the domain itself (drops its DNS/MX)
//
// Runs under tsx (it imports app code via ./joeblew999-lib-app.mjs).
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { d1 as libD1, keychain, request, sqlEscape } from "./joeblew999-lib.mjs";
import { mintMcpKey, withAdminKey } from "./joeblew999-lib-app.mjs";

const { values } = parseArgs({
	options: {
		domain: { type: "string" },
		project: { type: "string" },
		roles: { type: "string", default: "" },
		"roles-file": { type: "string" },
		onboard: { type: "boolean", default: false },
		"replace-mx": { type: "boolean", default: false },
		"confirm-mx": { type: "boolean", default: false },
		share: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		status: { type: "boolean", default: false },
		cleanup: { type: "boolean", default: false },
		"disable-accounts": { type: "boolean", default: false },
		"remove-domain": { type: "boolean", default: false },
		url: { type: "string" },
		db: { type: "string", default: "mailflare" },
		local: { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

function usage() {
	console.log(`provision — stand up a domain's mailboxes from a project manifest.

⚠ Onboarding publishes Mailflare's Email Routing MX. The script refuses to onboard a
  domain that already has MX records unless you pass --confirm-mx.

  npm run joeblew999:provision -- --project scripts/joeblew999-project.example.json
  npm run joeblew999:provision -- --domain <hostname> --roles a,b,c [--onboard] [--share]
  npm run joeblew999:provision -- --domain <hostname> --roles a,b,c --cleanup

Project file (JSON):
  { "domain": "...", "onboard": { "replaceMxRecords": false },
    "mailboxes": [ { "role": "office", "displayName": "Office" },
                   { "role": "support", "shared": true,
                     "access": [ { "email": "you@example.com", "permission": "full_access" } ] } ],
    "accounts": [ { "username": "sam", "role": "user", "passwordEnv": "PROV_PASSWORD" } ],
    "routing":  [ { "pattern": "*", "action": "forward", "forwardTo": "you@example.com" } ],
    "mcpKeys":  [ { "name": "agent", "mailboxes": ["office"] } ] }

Flags:
  --project <path>      apply a project manifest (domain + mailboxes + onboard)
  --domain <hostname>   domain to provision on (overrides the manifest)
  --roles <a,b,c>       ad-hoc role names (alternative to a manifest)
  --roles-file <path>   read role names from a file (JSON array or one per line)
  --onboard             add the domain to Mailflare first (publishes MX)
  --replace-mx          when onboarding, take MX over from another provider
  --confirm-mx          allow onboarding a domain that already has MX records
  --share               create the mailboxes as shared (needs Team)
  --dry-run             list what would change, create nothing
  --status              report what exists vs the manifest, change nothing
  --cleanup             delete the mailboxes instead of creating them
  --disable-accounts    with --cleanup, also disable the manifest's accounts
  --remove-domain       with --cleanup, also remove the domain (drops its DNS/MX)
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

// The domain's current MX records, from the Cloudflare API (null when unavailable).
// Used to refuse taking over a domain that already receives mail.
async function currentMx(hostname) {
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || keychain("CLOUDFLARE_API_TOKEN");
	if (!token) return null;
	const zone = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(hostname)}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => null);
	const zoneId = zone?.result?.[0]?.id;
	if (!zoneId) return null;
	const records = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=MX&per_page=100`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => null);
	return records?.result ?? null;
}

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
		// Grants exist to share a mailbox with OTHER users; the owner already has full
		// access. Skipping owner grants keeps the data meaningful (and stops the mailbox
		// appearing twice in listings that merge owned + shared rows).
		const [owner] = d1(`SELECT user_id FROM mailboxes WHERE id='${sqlEscape(mailboxId)}';`);
		if (owner && owner.user_id === user.id) {
			if (!dryRun) d1(`DELETE FROM mailbox_access WHERE mailbox_id='${sqlEscape(mailboxId)}' AND user_id='${sqlEscape(user.id)}';`);
			console.log(`     · ${email} owns ${address} — grant not needed, skipped`);
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

// Create login accounts (`accounts: [{ username, name?, role?, password? | passwordEnv? }]`).
// A password is taken from the entry, the named env var, or generated and printed once.
async function ensureAccount(entry, domain, key, base, dryRun) {
	const username = String(entry.username ?? entry.name ?? "").trim().toLowerCase();
	if (!username) {
		console.log(`  ✗ account entry needs a username: ${JSON.stringify(entry)}`);
		return 1;
	}
	const email = `${username}@${domain.hostname}`;
	const list = await request(base, "/api/v1/accounts", { key });
	const exists = (list.json?.accounts ?? []).some((account) => String(account.email).toLowerCase() === email);
	if (exists) {
		console.log(`  · account ${email} — already exists`);
		return 0;
	}

	const fromEnv = entry.passwordEnv ? process.env[entry.passwordEnv] : null;
	const password = entry.password || fromEnv || randomBytes(12).toString("base64url");
	const generated = !entry.password && !fromEnv;
	if (dryRun) {
		console.log(`  → would create account ${email} (${entry.role === "admin" ? "admin" : "user"})`);
		return 0;
	}
	const created = await request(base, "/api/v1/accounts", {
		method: "POST",
		key,
		body: { username, domainId: domain.id, password, role: entry.role === "admin" ? "admin" : "user", useAllDomains: false, aliases: [] },
	});
	if (created.status !== 200 && created.status !== 201) {
		console.log(`  ✗ account failed (HTTP ${created.status}) ${email} — ${created.json?.error ?? ""}`);
		return 1;
	}
	console.log(`  ✓ created account ${email}${generated ? `  ⚠ password (shown once): ${password}` : ""}`);
	return 0;
}

// Provision domain-scope routing rules (`routing: [{ pattern, action, forwardTo?, rejectReason?, keepCopy?, priority? }]`).
// Domain rules decide, during address resolution: reject, forward, or store (catch-all).
function ensureRouting(entry, domain, adminId, dryRun) {
	const pattern = String(entry.pattern ?? "*").trim();
	const action = String(entry.action ?? "forward").trim();
	if (!["store", "forward", "reject"].includes(action)) {
		console.log(`  ✗ routing action must be store|forward|reject (got "${action}")`);
		return 1;
	}
	const forwardTo = entry.forwardTo ? String(entry.forwardTo).trim() : null;
	if (action === "forward" && !forwardTo) {
		console.log(`  ✗ routing "${pattern}" forwards but has no forwardTo`);
		return 1;
	}
	const label = `routing ${pattern} → ${action}${forwardTo ? ` ${forwardTo}` : ""}`;
	const existing = d1(`SELECT id FROM routing_rules WHERE domain_id='${sqlEscape(domain.id)}' AND scope='domain' AND pattern='${sqlEscape(pattern)}' AND action='${sqlEscape(action)}';`);
	if (existing.length > 0) {
		console.log(`  · ${label} — already exists`);
		return 0;
	}
	if (dryRun) {
		console.log(`  → would add ${label}`);
		return 0;
	}
	d1(`INSERT INTO routing_rules (id, user_id, domain_id, scope, name, enabled, pattern, match_field, match_operator, match_value, action, forward_to, keep_copy, reject_reason, priority, created_at)
	    VALUES ('rr_${randomBytes(6).toString("hex")}', '${sqlEscape(adminId)}', '${sqlEscape(domain.id)}', 'domain', '${sqlEscape(entry.name ?? pattern)}', 1, '${sqlEscape(pattern)}', 'email', 'contains', '${sqlEscape(entry.matchValue ?? "")}', '${sqlEscape(action)}', ${forwardTo ? `'${sqlEscape(forwardTo)}'` : "NULL"}, ${entry.keepCopy ? 1 : 0}, ${entry.rejectReason ? `'${sqlEscape(entry.rejectReason)}'` : "NULL"}, ${Number(entry.priority) || 0}, strftime('%s','now'));`);
	console.log(`  ✓ added ${label}`);
	return 0;
}

function removeRouting(entry, domain, dryRun) {
	const pattern = String(entry.pattern ?? "*").trim();
	const action = String(entry.action ?? "forward").trim();
	if (dryRun) {
		console.log(`  → would remove routing ${pattern} → ${action}`);
		return 0;
	}
	d1(`DELETE FROM routing_rules WHERE domain_id='${sqlEscape(domain.id)}' AND scope='domain' AND pattern='${sqlEscape(pattern)}' AND action='${sqlEscape(action)}';`);
	console.log(`  ✓ removed routing ${pattern} → ${action}`);
	return 0;
}

// MCP tool scopes (mirrors MCP_SCOPES in src/lib/mcp/auth.ts).
const MCP_SCOPES = ["mcp:read", "mcp:draft", "mcp:organize", "mcp:request-send", "mcp:calendar-read", "mcp:calendar-write"];

// Mint an MCP key (`mcpKeys: [{ name, mailboxes?, scopes? }]`) and print the
// ready-to-paste client config. The key is shown once.
function ensureMcpKey(entry, domain, adminId, mailboxIdsByRole, base, dryRun) {
	const name = String(entry.name ?? "agent").trim();
	const scopes = Array.isArray(entry.scopes) && entry.scopes.length > 0 ? entry.scopes.map(String) : MCP_SCOPES;
	const bad = scopes.filter((scope) => !MCP_SCOPES.includes(scope));
	if (bad.length > 0) {
		console.log(`  ✗ mcp key "${name}": unknown scope(s) ${bad.join(", ")}`);
		return 1;
	}
	const mailboxIds = [];
	for (const role of entry.mailboxes ?? []) {
		const id = mailboxIdsByRole.get(String(role).toLowerCase());
		if (!id) {
			console.log(`  ⚠ mcp key "${name}": mailbox "${role}" not found, skipping it`);
			continue;
		}
		mailboxIds.push(id);
	}
	const existing = d1(`SELECT id FROM api_keys WHERE user_id='${sqlEscape(adminId)}' AND kind='mcp' AND name='${sqlEscape(name)}';`);
	if (existing.length > 0) {
		console.log(`  · mcp key "${name}" — already exists`);
		return 0;
	}
	if (dryRun) {
		console.log(`  → would create mcp key "${name}" (${scopes.length} scope(s), ${mailboxIds.length} mailbox(es))`);
		return 0;
	}
	const { fullKey } = mintMcpKey({ db: values.db, local: values.local, adminId, name, scopes, mailboxIds });
	console.log(`  ✓ created mcp key "${name}"  ⚠ key (shown once): ${fullKey}`);
	console.log(`     client JSON: {"mcpServers":{"mailflare":{"type":"http","url":"${base}/mcp","headers":{"Authorization":"Bearer ${fullKey}"}}}}`);
	return 0;
}

function removeMcpKey(entry, adminId, dryRun) {
	const name = String(entry.name ?? "agent").trim();
	if (dryRun) {
		console.log(`  → would remove mcp key "${name}"`);
		return 0;
	}
	d1(`DELETE FROM api_keys WHERE user_id='${sqlEscape(adminId)}' AND kind='mcp' AND name='${sqlEscape(name)}';`);
	console.log(`  ✓ removed mcp key "${name}"`);
	return 0;
}

// The app has no user-delete, so de-provisioning an account means disabling it.
async function disableAccount(entry, domain, key, base, dryRun) {
	const username = String(entry.username ?? entry.name ?? "").trim().toLowerCase();
	const email = `${username}@${domain.hostname}`;
	const list = await request(base, "/api/v1/accounts", { key });
	const account = (list.json?.accounts ?? []).find((row) => String(row.email).toLowerCase() === email);
	if (!account) {
		console.log(`  · account ${email} — not found, skipping`);
		return 0;
	}
	if (account.isPrimaryAdmin) {
		console.log(`  ⚠ ${email} is the primary admin — not disabling`);
		return 0;
	}
	if (dryRun) {
		console.log(`  → would disable account ${email}`);
		return 0;
	}
	const res = await request(base, `/api/v1/accounts/${account.id}`, { method: "PATCH", key, body: { name: account.name ?? username, disabled: true } });
	console.log(`  ${res.status === 200 ? "✓ disabled" : `✗ disable failed (HTTP ${res.status})`} account ${email}`);
	return res.status === 200 ? 0 : 1;
}

// Removing the domain (app API) also drops its Email Routing/DNS config.
async function removeDomain(domain, key, base, dryRun) {
	if (dryRun) {
		console.log(`  → would remove domain ${domain.hostname} from Mailflare (drops its DNS/MX)`);
		return 0;
	}
	const res = await request(base, `/api/v1/domains/${domain.id}`, { method: "DELETE", key });
	console.log(`  ${res.status === 200 ? "✓ removed" : `✗ remove failed (HTTP ${res.status})`} domain ${domain.hostname}`);
	return res.status === 200 ? 0 : 1;
}

async function main() {
	const domainName = domainValue.toLowerCase();
	try {
		return await withAdminKey({ db: values.db, local: values.local, url: values.url, name: "provision" }, async ({ base, key, admin }) => {
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
				const mx = await currentMx(domainValue);
				if (mx?.length) {
					console.log(`  ⚠ ${domainValue} already has MX records — onboarding changes where its mail goes:`);
					for (const record of mx) console.log(`      ${record.priority ?? ""} ${record.content}`);
				}
				if (values["dry-run"]) {
					const extras = `${project?.accounts?.length ? ` + ${project.accounts.length} account(s)` : ""}${project?.routing?.length ? ` + ${project.routing.length} routing rule(s)` : ""}`;
					console.log(`  → would onboard ${domainValue}, then create ${roles.map(({ role }) => `${role}@${domainValue}`).join(", ")}${extras}`);
					return 0;
				}
				if (mx?.length && !values["confirm-mx"]) {
					console.error(`\nRefusing to onboard ${domainValue}: it already receives mail.`);
					console.error("Re-run with --confirm-mx to knowingly take over its MX, or pick a domain with no mail.");
					return 1;
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
			const mailboxIdsByRole = new Map();

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

				if (mailboxId) mailboxIdsByRole.set(role, mailboxId);

				if (access.length && (mailboxId || values["dry-run"])) {
					failures += applyAccess(mailboxId ?? "«new»", address, access, values["dry-run"]);
				}
			}

			// Accounts (logins), domain-scope routing rules, and MCP keys.
			const accounts = project?.accounts ?? [];
			const routing = project?.routing ?? [];
			const mcpKeys = project?.mcpKeys ?? [];
			if (accounts.length || routing.length || mcpKeys.length) console.log("");

			if (values.cleanup) {
				for (const rule of routing) failures += removeRouting(rule, domain, values["dry-run"]);
				for (const entry of mcpKeys) failures += removeMcpKey(entry, admin.id, values["dry-run"]);
				if (values["disable-accounts"]) {
					for (const account of accounts) failures += await disableAccount(account, domain, key, base, values["dry-run"]);
				}
				// Last: dropping the domain also removes its mailboxes and routing.
				if (values["remove-domain"]) failures += await removeDomain(domain, key, base, values["dry-run"]);
			} else {
				for (const account of accounts) failures += await ensureAccount(account, domain, key, base, values["dry-run"]);
				for (const rule of routing) failures += ensureRouting(rule, domain, admin.id, values["dry-run"]);
				for (const entry of mcpKeys) failures += ensureMcpKey(entry, domain, admin.id, mailboxIdsByRole, base, values["dry-run"]);
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
