#!/usr/bin/env node
// Exercise the licensed (Pro/Team) capability gates against a deployed instance.
//
// Mints a temporary admin API key directly in D1, drives the public /api/v1
// surface, proves the gates actually block, exercises branding through the public
// icon endpoint, round-trips a shared-mailbox access grant, and (optionally) sends
// a forwarding test. Everything it creates is cleaned up and the plan restored.
//
//   node scripts/features-smoke.mjs
//   node scripts/features-smoke.mjs --url https://<worker>.<subdomain>.workers.dev
//   node scripts/features-smoke.mjs --forward-to you@gmail.com
//   node scripts/features-smoke.mjs --setup         # create the fixtures and keep them
//   node scripts/features-smoke.mjs --cleanup       # remove fixtures from a prior --setup
//   node scripts/features-smoke.mjs --status        # report which fixtures exist right now
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
// GUI map, relative to the instance URL — where each gate is visible. These pages
// live in the (admin) route group, which does NOT add a path segment:
//   /mailboxes                shared mailboxes (the list shows a "Shared" badge)
//   /mailboxes/<id>           shared inbox access grants (grant / revoke)
//   /branding                 app name + icon               (canCustomizeBranding)
//   /accounts                 accounts + seat usage         (canManageAccounts)
//   /licenses                 plan, seats, activation
//   /settings/account         forwarding address            (canForwardEmail)
//   /settings/inbox           browser push notifications
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";

const BRANDING_KEY = "branding/app-icon";
// A 1x1 PNG staged as the custom icon. The public icon route serves it only when
// canCustomizeBranding is on, so comparing bytes proves the gate flips.
const BRANDING_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const { values } = parseArgs({
	options: {
		url: { type: "string" },
		db: { type: "string", default: "mailflare" },
		bucket: { type: "string", default: "mailflare-raw" },
		local: { type: "boolean", default: false },
		"no-gate": { type: "boolean", default: false },
		"forward-to": { type: "string" },
		keep: { type: "boolean", default: false },
		setup: { type: "boolean", default: false },
		cleanup: { type: "boolean", default: false },
		status: { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

const location = values.local ? "--local" : "--remote";
const flipGate = !values["no-gate"];
// --setup (create fixtures, leave them) shares the "don't clean up" path with --keep.
const keepArtifacts = values.keep || values.setup;

// License flips used to prove (and restore) the gates. Declared here so the
// module-level --cleanup path below can use them.
const LICENCE_ON = "UPDATE license_settings SET plan='team', state='active', features='[]', updated_at=strftime('%s','now') WHERE id='default';";
const LICENCE_OFF = "UPDATE license_settings SET plan='community', state='inactive', features='[]', updated_at=strftime('%s','now') WHERE id='default';";

if (values.help) {
	console.log("Usage: node scripts/features-smoke.mjs [--url <base>] [--db mailflare] [--bucket mailflare-raw] [--local] [--no-gate] [--forward-to <email>] [--setup|--keep] [--cleanup] [--status]");
	process.exit(0);
}
if (values.cleanup) {
	console.log("Removing fixtures from a previous --setup/--keep run…");
	await cleanupAll();
	console.log("Done — smoke artifacts removed and the license set back to Team.");
	process.exit(0);
}
if (values.status) {
	await printStatus();
	process.exit(0);
}

const base = await resolveBaseUrl();

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

// The Worker name is the first top-level "name" in wrangler.jsonc.
function workerNameFromConfig() {
	try {
		const match = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").match(/^\s*"name"\s*:\s*"([^"]+)"/m);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

// Resolve the instance URL at runtime instead of hard-coding it: --url, then
// MAILFLARE_URL, then <worker-name>.<account-subdomain>.workers.dev from the API.
async function resolveBaseUrl() {
	const explicit = values.url || process.env.MAILFLARE_URL;
	if (explicit) return explicit.replace(/\/+$/, "");

	const name = workerNameFromConfig();
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || keychain("CLOUDFLARE_API_TOKEN");
	const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || keychain("CLOUDFLARE_ACCOUNT_ID");
	if (name && token && account) {
		const subdomain = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => null);
		if (subdomain?.result?.subdomain) return `https://${name}.${subdomain.result.subdomain}.workers.dev`;
	}

	console.error("Could not determine the instance URL.");
	console.error("Pass --url, set MAILFLARE_URL, or provide CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID so it can be derived.");
	process.exit(1);
}

const guiGuide = (origin) => `
Where to see each feature (Team is active), at ${origin}:
  • Shared mailboxes ..... ${origin}/mailboxes                "${'smoke-*'}@<domain>" row, "Shared" badge
                           ${origin}/mailboxes/<id>           grant / revoke access
  • Branding ............. ${origin}/branding                 app name + icon
  • Accounts & seats ..... ${origin}/accounts                 seat usage; create an account
  • Email forwarding ..... ${origin}/settings/account         forwarding address field
  • Plan & seats ......... ${origin}/licenses
  • Push subscriptions ... ${origin}/settings/inbox
Next: inspect the screens above, then tear the fixtures down with
  npm run features:smoke -- --cleanup`;

// Report which fixtures a previous --setup/--keep left behind (read-only).
async function printStatus() {
	const [row] = d1(`SELECT
		(SELECT COUNT(*) FROM mailboxes WHERE local_part LIKE 'smoke-%') AS smokeMailboxes,
		(SELECT COUNT(*) FROM mailbox_access WHERE id LIKE 'mac_smoke_%') AS grants,
		(SELECT COUNT(*) FROM api_keys WHERE name='features-smoke') AS tempKeys,
		(SELECT COALESCE(icon_key,'') FROM app_settings WHERE id='default') AS iconKey,
		(SELECT COALESCE(forwarding_email,'') FROM users WHERE role='admin' LIMIT 1) AS forwarding;`);
	const [license] = d1("SELECT plan, state FROM license_settings WHERE id='default';");
	const present = row.smokeMailboxes > 0 || row.grants > 0 || row.tempKeys > 0 || !!row.iconKey || !!row.forwarding;

	console.log(`Fixture status (${values.db} ${location}):`);
	console.log(`  smoke mailboxes: ${row.smokeMailboxes}`);
	console.log(`  access grants:   ${row.grants}`);
	console.log(`  temp API keys:   ${row.tempKeys}`);
	console.log(`  branding icon:   ${row.iconKey || "—"}`);
	console.log(`  forwarding:      ${row.forwarding || "—"}`);
	console.log(`  license:         ${license ? `${license.plan}/${license.state}` : "—"}`);
	console.log(present ? "\nFixtures present — remove them with: npm run features:smoke -- --cleanup" : "\nNo fixtures present.");
}

// Remove everything a previous --setup/--keep run left behind, then restore Team.
async function cleanupAll() {
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || keychain("CLOUDFLARE_API_TOKEN");
	if (token) {
		for (const domain of d1("SELECT zone_id FROM domains;")) {
			if (!domain.zone_id || domain.zone_id === "manual") continue;
			const rules = await fetch(`https://api.cloudflare.com/client/v4/zones/${domain.zone_id}/email/routing/rules?per_page=100`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => null);
			for (const rule of rules?.result ?? []) {
				// Only the literal rules our smoke mailboxes created (smoke-…@host).
				const isSmoke = (rule.matchers ?? []).some((m) => String(m.value ?? "").startsWith("smoke-"));
				if (isSmoke) await fetch(`https://api.cloudflare.com/client/v4/zones/${domain.zone_id}/email/routing/rules/${rule.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
			}
		}
	}
	d1("DELETE FROM mailbox_access WHERE id LIKE 'mac_smoke_%';");
	d1("DELETE FROM mailboxes WHERE local_part LIKE 'smoke-%';");
	d1("DELETE FROM api_keys WHERE name='features-smoke';");
	d1("UPDATE app_settings SET icon_key=NULL WHERE id='default';");
	run("npx", ["wrangler", "r2", "object", "delete", `${values.bucket}/${BRANDING_KEY}`, "--remote"]);
	d1("UPDATE users SET forwarding_email=NULL;");
	d1(LICENCE_ON);
}

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

// Fetch a URL as raw bytes — the branding icon check compares exact content.
async function fetchBytes(path) {
	const response = await fetch(`${base}${path}`);
	return Buffer.from(await response.arrayBuffer());
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
		// Stage a real PNG icon in R2 and point app_settings at it.
		const markerPath = join(tmpdir(), `mailflare-branding-${Date.now()}.png`);
		writeFileSync(markerPath, BRANDING_PNG);
		const put = run("npx", ["wrangler", "r2", "object", "put", `${values.bucket}/${BRANDING_KEY}`, "--file", markerPath, "--content-type", "image/png", "--remote"]);
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

		const iconDefault = await fetchBytes("/api/branding/icon");
		record("branding icon is the default on Community", sha256(iconDefault) !== sha256(BRANDING_PNG), `${iconDefault.length} bytes`);

		// --- and allow again under Team --------------------------------------
		d1(LICENCE_ON);
		record("accounts allowed on Team", (await api("/api/v1/accounts", { key: fullKey })).status === 200);

		const iconCustom = await fetchBytes("/api/branding/icon");
		record("branding icon is custom on Team", sha256(iconCustom) === sha256(BRANDING_PNG), `${iconCustom.length} bytes`);

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

				if (keepArtifacts) {
					console.log(`\n  → kept ${created.json.address} and its full_access grant for inspection.`);
				} else {
					const removed = await api(`/api/v1/mailboxes/${mailboxId}`, { method: "DELETE", key: fullKey });
					record("delete the shared mailbox", removed.status === 200, `HTTP ${removed.status}`);
					if (removed.status === 200) d1(`DELETE FROM mailbox_access WHERE id='${esc(grantId)}';`);
				}
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
	// The temporary API key is always removed. With --keep, the other artifacts
	// (shared mailbox, branding icon, forwarding address) stay for inspection.
	d1(`DELETE FROM api_keys WHERE id='${esc(keyId)}';`);
	if (keepArtifacts) {
		console.log(`\nTemporary key ${keyId} removed; artifacts kept (see the guide above).`);
	} else {
		for (const cleanup of cleanups.reverse()) {
			try {
				await cleanup();
			} catch {
				// best effort
			}
		}
		d1(LICENCE_ON);
		console.log(`\nCleaned up temporary key ${keyId}; license restored to Team.`);
	}
}

const failed = results.filter((r) => !r.ok);
if (keepArtifacts) console.log(guiGuide(base));
console.log(`\n${failed.length === 0 ? "All checks passed" : `${failed.length} check(s) failed`}: ${results.length - failed.length}/${results.length}.`);
process.exit(failed.length === 0 ? 0 : 1);
