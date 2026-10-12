#!/usr/bin/env node
// Exercise the licensed (Pro/Team) capability gates against a deployed instance.
//
// Mints a temporary admin API key directly in D1, drives the public /api/v1
// surface, proves the gates actually block, exercises branding through the public
// icon endpoint, round-trips a shared-mailbox access grant, and (optionally) sends
// a forwarding test. Everything it creates is cleaned up and the plan restored.
//
//   node scripts/features-smoke.mjs
//   node scripts/features-smoke.mjs --url https://mailflare.example.workers.dev
//   node scripts/features-smoke.mjs --forward-to you@gmail.com
//   node scripts/features-smoke.mjs --no-gate        # read-only API checks only
//
// What is proven where:
//   • canManageAccounts    — GET /api/v1/accounts flips 403 (community) → 200 (team)
//   • canShareMailboxes    — shared mailbox POST flips 403 → 201 (Team-only)
//   • canCustomizeBranding — /api/branding/icon serves the custom object on Team,
//                            the packaged default on Community (public route)
//   • canForwardEmail      — needs --forward-to: sets users.forwarding_email, checks
//                            the destination is a verified Email Routing address,
//                            then sends a real inbound test to forward
//   • mailbox access grant — inserts a mailbox_access row and reads it back
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";

const DEFAULT_URL = "https://mailflare.gedw99.workers.dev";
const BRANDING_KEY = "branding/app-icon";
const BRANDING_MARKER = "MAILFLARE-BRANDING-SMOKE";

const { values } = parseArgs({
	options: {
		url: { type: "string", default: DEFAULT_URL },
		db: { type: "string", default: "mailflare" },
		bucket: { type: "string", default: "mailflare-raw" },
		local: { type: "boolean", default: false },
		"no-gate": { type: "boolean", default: false },
		"forward-to": { type: "string" },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (values.help) {
	console.log("Usage: node scripts/features-smoke.mjs [--url <base>] [--db mailflare] [--bucket mailflare-raw] [--local] [--no-gate] [--forward-to <email>]");
	process.exit(0);
}

const base = values.url.replace(/\/+$/, "");
const location = values.local ? "--local" : "--remote";
const flipGate = !values["no-gate"];

function run(command, args) {
	return spawnSync(command, args, { encoding: "utf8" });
}

function d1(sql) {
	const result = run("npx", ["wrangler", "d1", "execute", values.db, location, "--json", "--command", sql]);
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || "wrangler d1 execute failed");
	const parsed = JSON.parse(result.stdout);
	const first = Array.isArray(parsed) ? parsed[0] : parsed;
	return first?.results ?? [];
}

function keychain(account, service = "fnox") {
	const result = run("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
	return result.status === 0 ? result.stdout.trim() : null;
}

const LICENCE_ON = "UPDATE license_settings SET plan='team', state='active', features='[]', updated_at=strftime('%s','now') WHERE id='default';";
const LICENCE_OFF = "UPDATE license_settings SET plan='community', state='inactive', features='[]', updated_at=strftime('%s','now') WHERE id='default';";

async function api(path, { method = "GET", key, body } = {}) {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// Not JSON (e.g. the icon endpoint returns image bytes).
	}
	return { status: response.status, text, json };
}

const results = [];
function record(name, ok, detail = "") {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// --- target + temporary admin key -------------------------------------------
const [admin] = d1("SELECT id, email FROM users WHERE role='admin' ORDER BY created_at LIMIT 1;");
if (!admin) {
	console.error("No admin user found — is the instance set up?");
	process.exit(1);
}
console.log(`Instance: ${base}\nAdmin:    ${admin.email}\n`);

// Mint a short-lived admin key in D1. The lookup uses the first 12 chars as a
// prefix, and the value is bcrypt-hashed exactly as src/lib/api-keys.ts does, so
// the Worker accepts it without any session or Turnstile.
const fullKey = `ep_${randomBytes(24).toString("base64url")}`;
const keyId = `key_smoke_${randomBytes(6).toString("hex")}`;
const scopes = JSON.stringify(["accounts", "mailboxes", "domains", "storage"]);
const esc = (value) => value.replace(/'/g, "''");
d1(`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
    VALUES ('${esc(keyId)}', 'legacy', '${esc(admin.id)}', 'features-smoke', '${esc(fullKey.slice(0, 12))}', '${esc(bcrypt.hashSync(fullKey, 10))}', '${esc(scopes)}', 0, strftime('%s','now'));`);
console.log(`Minted temporary key ${keyId} (prefix ${fullKey.slice(0, 12)})\n`);

// --- cleanup stack (runs in finally, LIFO) ----------------------------------
// Cleanups run in reverse in the finally block, so anything we create is removed
// even if a check throws partway through.
const cleanups = [];
const onCleanup = (fn) => cleanups.push(fn);

try {
	// --- read checks (Team active) -------------------------------------------
	const domains = await api("/api/v1/domains", { key: fullKey });
	record("GET /api/v1/domains", domains.status === 200, `HTTP ${domains.status}`);
	const domainId = domains.json?.domains?.[0]?.id ?? null;

	record("GET /api/v1/mailboxes", (await api("/api/v1/mailboxes", { key: fullKey })).status === 200);

	const storage = await api("/api/v1/storage", { method: "POST", key: fullKey });
	record("POST /api/v1/storage (round-trip)", storage.status === 200, `HTTP ${storage.status}`);

	const accountsActive = await api("/api/v1/accounts", { key: fullKey });
	record("GET /api/v1/accounts (Team)", accountsActive.status === 200, `HTTP ${accountsActive.status} — ${accountsActive.json?.accounts?.length ?? "?"} accounts`);

	if (flipGate) {
		// --- branding: stage a custom icon, then flip the gate -----------------
		// Stage a custom icon: /api/branding/icon is public and branches on
		// canCustomizeBranding, so a marker object proves the gate flips without a session.
		const markerPath = join(tmpdir(), `mailflare-branding-${Date.now()}.txt`);
		writeFileSync(markerPath, BRANDING_MARKER);
		const put = run("npx", ["wrangler", "r2", "object", "put", `${values.bucket}/${BRANDING_KEY}`, "--file", markerPath, "--content-type", "text/plain", "--remote"]);
		rmSync(markerPath, { force: true });
		if (put.status === 0) {
			const [previous] = d1("SELECT icon_key FROM app_settings WHERE id='default';");
			d1(`INSERT INTO app_settings (id, icon_key, updated_at) VALUES ('default', '${BRANDING_KEY}', strftime('%s','now'))
			    ON CONFLICT(id) DO UPDATE SET icon_key=excluded.icon_key, updated_at=excluded.updated_at;`);
			onCleanup(() => d1(`UPDATE app_settings SET icon_key=${previous?.icon_key ? `'${esc(previous.icon_key)}'` : "NULL"} WHERE id='default';`));
			onCleanup(() => run("npx", ["wrangler", "r2", "object", "delete", `${values.bucket}/${BRANDING_KEY}`, "--remote"]));
		} else {
			record("stage custom branding icon", false, (put.stderr || "r2 put failed").trim().slice(0, 90));
		}

		// --- prove the gates block under Community ----------------------------
		// Flip to Community to prove the gates actually block, then back to Team below.
		d1(LICENCE_OFF);
		record("accounts blocked on Community", (await api("/api/v1/accounts", { key: fullKey })).status === 403);

		const sharedBlocked = domainId
			? await api("/api/v1/mailboxes", { method: "POST", key: fullKey, body: { domainId, localPart: `smoke-${randomBytes(3).toString("hex")}`, displayName: "Smoke test", type: "shared" } })
			: { status: 0 };
		record("shared mailbox blocked on Community", sharedBlocked.status === 403, `HTTP ${sharedBlocked.status}`);

		const iconDefault = await api("/api/branding/icon");
		record("branding icon is the default on Community", !iconDefault.text.includes(BRANDING_MARKER), `HTTP ${iconDefault.status}`);

		// --- and allow again under Team --------------------------------------
		d1(LICENCE_ON);
		record("accounts allowed on Team", (await api("/api/v1/accounts", { key: fullKey })).status === 200);

		const iconCustom = await api("/api/branding/icon");
		record("branding icon is custom on Team", iconCustom.text.includes(BRANDING_MARKER), `HTTP ${iconCustom.status}`);

		if (domainId) {
			const localPart = `smoke-${randomBytes(3).toString("hex")}`;
			const created = await api("/api/v1/mailboxes", { method: "POST", key: fullKey, body: { domainId, localPart, displayName: "Smoke test", type: "shared" } });
			record("shared mailbox allowed on Team", created.status === 201, `HTTP ${created.status} — ${created.json?.address ?? created.json?.error ?? ""}`);
			const mailboxId = created.status === 201 ? created.json.id : null;
			if (mailboxId) {
				onCleanup(() => api(`/api/v1/mailboxes/${mailboxId}`, { method: "DELETE", key: fullKey }));

				// --- sharing: round-trip an access grant ----------------------
				const grantId = `mac_smoke_${randomBytes(6).toString("hex")}`;
				d1(`INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('${esc(grantId)}', '${esc(mailboxId)}', '${esc(admin.id)}', 'full_access', strftime('%s','now'));`);
				onCleanup(() => d1(`DELETE FROM mailbox_access WHERE id='${esc(grantId)}';`));
				const [grant] = d1(`SELECT permission FROM mailbox_access WHERE id='${esc(grantId)}';`);
				record("mailbox access grant round-trip", grant?.permission === "full_access", grant?.permission ?? "missing");

				const removed = await api(`/api/v1/mailboxes/${mailboxId}`, { method: "DELETE", key: fullKey });
				record("delete the shared mailbox", removed.status === 200, `HTTP ${removed.status}`);
				if (removed.status === 200) d1(`DELETE FROM mailbox_access WHERE id='${esc(grantId)}';`);
			}
		}
	}

	// --- forwarding (opt-in: needs a real external destination) --------------
	if (values["forward-to"]) {
		const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || keychain("CLOUDFLARE_API_TOKEN");
		const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || keychain("CLOUDFLARE_ACCOUNT_ID");
		if (!token || !account) {
			record("forwarding setup", false, "no Cloudflare credentials available for the destination check");
		} else {
			const destination = values["forward-to"].trim();
			const addresses = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/email/routing/addresses?per_page=100`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => null);
			const match = addresses?.result?.find((a) => String(a.email).toLowerCase() === destination.toLowerCase());
			record("forward destination is a verified Email Routing address", !!match && (match.verified === true || match.verified === "true" || match.status === "verified"), match ? `verified=${JSON.stringify(match.verified)}` : "not registered");

			const [previous] = d1(`SELECT forwarding_email FROM users WHERE id='${esc(admin.id)}';`);
			d1(`UPDATE users SET forwarding_email='${esc(destination)}' WHERE id='${esc(admin.id)}';`);
			onCleanup(() => d1(`UPDATE users SET forwarding_email=${previous?.forwarding_email ? `'${esc(previous.forwarding_email)}'` : "NULL"} WHERE id='${esc(admin.id)}';`));

			const subject = `Mailflare forwarding test ${new Date().toISOString()}`;
			const sent = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ from: admin.email, to: admin.email, subject, text: "Forwarding smoke test." }),
			}).then((r) => r.json()).catch(() => null);
			record("forwarding test email queued", sent?.success === true, sent?.result?.message_id ?? JSON.stringify(sent?.errors ?? {}));
			console.log(`\n  → check ${destination} for "${subject}" (the forward leaves the Mailflare inbox).`);
		}
	}
} catch (error) {
	record("smoke run completed", false, error instanceof Error ? error.message : String(error));
} finally {
	for (const cleanup of cleanups.reverse()) {
		try {
			await cleanup();
		} catch {
			// best effort
		}
	}
	d1(LICENCE_ON);
	d1(`DELETE FROM api_keys WHERE id='${esc(keyId)}';`);
	console.log(`\nCleaned up temporary key ${keyId}; license restored to Team.`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "All checks passed" : `${failed.length} check(s) failed`}: ${results.length - failed.length}/${results.length}.`);
process.exit(failed.length === 0 ? 0 : 1);
