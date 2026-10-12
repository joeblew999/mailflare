#!/usr/bin/env node
// Exercise the licensed (Pro/Team) capability gates against a deployed instance.
//
// It mints a temporary admin API key directly in D1, drives the public /api/v1
// surface with it, flips the license plan to prove the gates actually block
// things, then restores everything (key, created mailbox, plan).
//
//   node scripts/features-smoke.mjs [--url https://mailflare.example.workers.dev]
//                                   [--db mailflare] [--local] [--no-gate]
//
// Notes:
//  - "accounts" (canManageAccounts) and "shared mailboxes" (canShareMailboxes,
//    Team-only) are proven by the 403/200 flip.
//  - branding and per-account forwarding are session-only routes (not on /api/v1),
//    so they are reported as informational, not exercised here.
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

const DEFAULT_URL = "https://mailflare.gedw99.workers.dev";

const { values } = parseArgs({
	options: {
		url: { type: "string", default: DEFAULT_URL },
		db: { type: "string", default: "mailflare" },
		local: { type: "boolean", default: false },
		"no-gate": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (values.help) {
	console.log("Usage: node scripts/features-smoke.mjs [--url <base>] [--db mailflare] [--local] [--no-gate]");
	process.exit(0);
}

const base = values.url.replace(/\/+$/, "");
const location = values.local ? "--local" : "--remote";

function d1(sql) {
	const result = spawnSync("npx", ["wrangler", "d1", "execute", values.db, location, "--json", "--command", sql], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || "wrangler d1 execute failed");
	const parsed = JSON.parse(result.stdout);
	const first = Array.isArray(parsed) ? parsed[0] : parsed;
	return first?.results ?? [];
}

const LICENCE_ON = "UPDATE license_settings SET plan='team', state='active', features='[]', updated_at=strftime('%s','now') WHERE id='default';";
const LICENCE_OFF = "UPDATE license_settings SET plan='community', state='inactive', features='[]', updated_at=strftime('%s','now') WHERE id='default';";

async function api(path, { method = "GET", key, body } = {}) {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	let json = null;
	try {
		json = await response.json();
	} catch {
		// Some responses (e.g. 404 pages) have no JSON body.
	}
	return { status: response.status, json };
}

const results = [];
function record(name, ok, detail = "") {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- mint a temporary admin key ---------------------------------------------
const [admin] = d1("SELECT id, email FROM users WHERE role='admin' ORDER BY created_at LIMIT 1;");
if (!admin) {
	console.error("No admin user found — is the instance set up?");
	process.exit(1);
}
console.log(`Instance: ${base}\nAdmin:    ${admin.email}\n`);

const fullKey = `ep_${randomBytes(24).toString("base64url")}`;
const keyId = `key_smoke_${randomBytes(6).toString("hex")}`;
const scopes = JSON.stringify(["accounts", "mailboxes", "domains", "storage"]);
const esc = (value) => value.replace(/'/g, "''");
d1(`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
    VALUES ('${esc(keyId)}', 'legacy', '${esc(admin.id)}', 'features-smoke', '${esc(fullKey.slice(0, 12))}', '${esc(bcrypt.hashSync(fullKey, 10))}', '${esc(scopes)}', 0, strftime('%s','now'));`);
console.log(`Minted temporary key ${keyId} (prefix ${fullKey.slice(0, 12)})\n`);

let createdMailboxId = null;
let restoredPlan = false;

try {
	// --- read checks (Team active) -------------------------------------------
	const domains = await api("/api/v1/domains", { key: fullKey });
	record("GET /api/v1/domains", domains.status === 200, `HTTP ${domains.status}`);
	const domainId = domains.json?.domains?.[0]?.id ?? null;

	const mailboxes = await api("/api/v1/mailboxes", { key: fullKey });
	record("GET /api/v1/mailboxes", mailboxes.status === 200, `HTTP ${mailboxes.status}`);

	const storage = await api("/api/v1/storage", { method: "POST", key: fullKey });
	record("POST /api/v1/storage (round-trip)", storage.status === 200, `HTTP ${storage.status}`);

	const accountsActive = await api("/api/v1/accounts", { key: fullKey });
	record("GET /api/v1/accounts (Team)", accountsActive.status === 200, `HTTP ${accountsActive.status} — ${accountsActive.json?.accounts?.length ?? "?"} accounts`);

	if (!values["no-gate"]) {
		// --- prove the gates block under Community ----------------------------
		d1(LICENCE_OFF);
		const accountsBlocked = await api("/api/v1/accounts", { key: fullKey });
		record("accounts blocked on Community", accountsBlocked.status === 403, `HTTP ${accountsBlocked.status}`);

		const sharedBlocked = domainId
			? await api("/api/v1/mailboxes", { method: "POST", key: fullKey, body: { domainId, localPart: `smoke-${randomBytes(3).toString("hex")}`, displayName: "Smoke test", type: "shared" } })
			: { status: 0 };
		record("shared mailbox blocked on Community", sharedBlocked.status === 403, `HTTP ${sharedBlocked.status}`);

		// --- and allow again under Team --------------------------------------
		d1(LICENCE_ON);
		const accountsAllowed = await api("/api/v1/accounts", { key: fullKey });
		record("accounts allowed on Team", accountsAllowed.status === 200, `HTTP ${accountsAllowed.status}`);

		if (domainId) {
			const localPart = `smoke-${randomBytes(3).toString("hex")}`;
			const created = await api("/api/v1/mailboxes", { method: "POST", key: fullKey, body: { domainId, localPart, displayName: "Smoke test", type: "shared" } });
			record("shared mailbox allowed on Team", created.status === 201, `HTTP ${created.status} — ${created.json?.address ?? created.json?.error ?? ""}`);
			createdMailboxId = created.status === 201 ? created.json.id : null;
			if (createdMailboxId) {
				const removed = await api(`/api/v1/mailboxes/${createdMailboxId}`, { method: "DELETE", key: fullKey });
				record("delete the shared mailbox", removed.status === 200, `HTTP ${removed.status}`);
				createdMailboxId = removed.status === 200 ? null : createdMailboxId;
			}
		}
	}
} finally {
	if (createdMailboxId) {
		console.log(`\nCleaning up mailbox ${createdMailboxId}…`);
		await api(`/api/v1/mailboxes/${createdMailboxId}`, { method: "DELETE", key: fullKey }).catch(() => {});
	}
	d1(LICENCE_ON);
	restoredPlan = true;
	d1(`DELETE FROM api_keys WHERE id='${esc(keyId)}';`);
	console.log(`Removed temporary key ${keyId}; license restored to Team.`);
}

console.log(`\nNot exercised here (session-only routes, not on /api/v1):`);
console.log(`  • canCustomizeBranding — Admin → Branding`);
console.log(`  • canForwardEmail      — Settings → forwarding`);
console.log(`  • mailbox access grants — /api/mailboxes/[id]/access`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "All checks passed" : `${failed.length} check(s) failed`}: ${results.length - failed.length}/${results.length}.`);
if (!restoredPlan) console.log("⚠️  License may not have been restored — run `npm run license:on`.");
process.exit(failed.length === 0 ? 0 : 1);
