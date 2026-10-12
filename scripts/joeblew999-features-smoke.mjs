#!/usr/bin/env node
// Exercise the licensed (Pro/Team) capability gates on a deployed instance, and
// show you where each one lives in the app.
//
// WHAT IT DOES
//   Mints a temporary admin API key, drives /api/v1, proves each gate flips with
//   the plan, creates a few throwaway fixtures (shared mailbox, branding icon and
//   forwarding), then removes them. Nothing is left behind unless you ask.
//
// PICK ONE
//   1) Verify it all works, leave the instance clean:
//        npm run joeblew999:features:smoke
//   2) Show the licensed features off (creates + keeps the fixtures, prints URLs):
//        npm run joeblew999:features:smoke -- --demo
//        npm run joeblew999:features:smoke -- --demo --plan pro      # showcase Pro instead
//        npm run joeblew999:features:smoke -- --cleanup              # when you're done
//   3) Look around without changing anything:
//        npm run joeblew999:features:smoke -- --status    # what fixtures exist right now
//        npm run joeblew999:features:smoke -- --guide     # feature → URL map
//
//   Run `npm run joeblew999:features:smoke -- --help` for every flag.
//
// WHAT IS PROVEN (and where it shows in the app)
//   • canManageAccounts    GET /api/v1/accounts flips 403 (community) → 200 (team)
//   • canShareMailboxes    shared mailbox POST flips 403 → 201 (Team-only)
//   • canCustomizeBranding /api/branding/icon serves the custom object on Team,
//                          the packaged default on Community
//   • canForwardEmail      needs --forward-to: sets users.forwarding_email, checks
//                          the destination is a verified address, sends a test
//   • mailbox access grant inserts a mailbox_access row and reads it back
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
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { d1 as libD1, keychain, licenceSql, request, resolveInstanceUrl, run, sqlEscape } from "./joeblew999-lib.mjs";
import { withAdminKey } from "./joeblew999-lib-app.mjs";

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
		plan: { type: "string", default: "team" },
		demo: { type: "boolean", default: false },
		keep: { type: "boolean", default: false },
		setup: { type: "boolean", default: false },
		cleanup: { type: "boolean", default: false },
		status: { type: "boolean", default: false },
		guide: { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

const location = values.local ? "--local" : "--remote";
const flipGate = !values["no-gate"];
const planName = (values.plan ?? "team").toLowerCase();
if (planName !== "team" && planName !== "pro") {
	console.error(`--plan must be "team" or "pro" (got "${values.plan}")`);
	process.exit(1);
}
// Team unlocks shared mailboxes; Pro caps seats but cannot create shared inboxes.
const supportsSharing = planName === "team";
// --setup/--demo/--keep all mean "create the fixtures and don't clean up".
const keepArtifacts = values.keep || values.setup || values.demo;

// License SQL is shared via scripts/joeblew999-lib.mjs.
const licenceOn = licenceSql.on;
const LICENCE_OFF = licenceSql.off;

if (values.help) {
	usage();
	process.exit(0);
}
if (values.cleanup) {
	console.log("Removing fixtures from a previous --setup/--demo run…");
	await cleanupAll();
	console.log("Done — smoke artifacts removed and the license set back to Team.");
	process.exit(0);
}
if (values.status) {
	await printStatus();
	process.exit(0);
}
if (values.guide) {
	console.log(guiMap(await resolveBaseUrl(), planName));
	process.exit(0);
}

const base = await resolveBaseUrl();

// Shared helpers (scripts/joeblew999-lib.mjs) with this script's database baked in. Kept as
// function declarations so the module-level --cleanup/--status paths can call them.
function d1(sql) {
	return libD1(sql, { db: values.db, local: values.local });
}
function esc(value) {
	return sqlEscape(value);
}

async function resolveBaseUrl() {
	const base = await resolveInstanceUrl({ url: values.url });
	if (!base) {
		console.error("Could not determine the instance URL.");
		console.error("Pass --url, set MAILFLARE_URL, or provide CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID so it can be derived.");
		process.exit(1);
	}
	return base;
}

function guiMap(origin, plan) {
	return `
Where each check maps in the app (${plan} active), at ${origin}:${plan === "team" ? "" : "  — shared-mailbox screens need Team"}
  • Shared mailboxes ..... ${origin}/mailboxes                "${'smoke-*'}@<domain>" row, "Shared" badge
                           ${origin}/mailboxes/<id>           grant / revoke access
  • Branding ............. ${origin}/branding                 app name + icon
  • Accounts & seats ..... ${origin}/accounts                 seat usage; create an account
  • Email forwarding ..... ${origin}/settings/account         forwarding address field
  • Plan & seats ......... ${origin}/licenses
  • Push subscriptions ... ${origin}/settings/inbox`;
}

// Plain-language help, also shown by `--help`.
function usage() {
	console.log(`features-smoke — exercise the licensed (Pro/Team) gates on a deployed instance.

Pick one:
  npm run joeblew999:features:smoke                        verify everything, then clean up (default)
  npm run joeblew999:features:smoke -- --demo              showcase: create + keep fixtures, print URLs
  npm run joeblew999:features:smoke -- --demo --plan pro   showcase the Pro plan instead of Team
  npm run joeblew999:features:smoke -- --cleanup           remove fixtures from a previous --demo/--setup
  npm run joeblew999:features:smoke -- --status            print which fixtures exist right now
  npm run joeblew999:features:smoke -- --guide             print the feature → URL map

Flags:
  --setup | --keep      create the fixtures and keep them (skip auto-cleanup)
  --demo                alias of --setup, for showing the features off
  --plan <team|pro>     plan to activate for the checks (default: team)
  --cleanup             remove fixtures created by --setup/--keep
  --status              read-only: list existing fixtures
  --guide               read-only: feature → URL map
  --forward-to <email>  include the forwarding test (destination must be a verified
                        Email Routing address)
  --no-gate             read-only checks; never flip the license or create anything
  --url <base>          instance URL (else MAILFLARE_URL, else derived from Cloudflare)
  --db <name>           D1 database name (default: mailflare)
  --bucket <name>       R2 bucket name (default: mailflare-raw)
  --local               target the local dev D1 instead of remote
  -h, --help            show this help

Notes:
  • With npm pass flags after "--", e.g.  npm run joeblew999:features:smoke -- --setup
  • Credentials come from CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, or the
    macOS keychain (fnox), so usually nothing to configure.`);
}

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
	console.log(present ? "\nFixtures present — remove them with: npm run joeblew999:features:smoke -- --cleanup" : "\nNo fixtures present.");
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
	d1(licenceOn("team"));
}

// Thin binding to the shared request helper with this script's base URL baked in.
const api = (path, options) => request(base, path, options);

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
// withAdminKey resolves the instance, finds the admin, mints a short-lived key,
// runs the checks below, and always deletes the key afterwards.
await withAdminKey({ db: values.db, local: values.local, base, name: "features-smoke" }, async ({ key, admin, keyId, prefix }) => {
		console.log(`Instance: ${base}\nAdmin:    ${admin.email}\n`);
		console.log(`Minted temporary key ${keyId} (prefix ${prefix})\n`);

	// --- cleanup stack (runs in finally, LIFO) ----------------------------------
	// Cleanups run in reverse in the finally block, so anything we create is removed
	// even if a check throws partway through.
	const cleanups = [];
	const onCleanup = (fn) => cleanups.push(fn);

	try {
		// --- read checks (Team active) -------------------------------------------
		const domains = await api("/api/v1/domains", { key: key });
		record("GET /api/v1/domains", domains.status === 200, `HTTP ${domains.status}`);
		const domainId = domains.json?.domains?.[0]?.id ?? null;

		record("GET /api/v1/mailboxes", (await api("/api/v1/mailboxes", { key: key })).status === 200);

		const storage = await api("/api/v1/storage", { method: "POST", key: key });
		record("POST /api/v1/storage (round-trip)", storage.status === 200, `HTTP ${storage.status}`);

		const accountsActive = await api("/api/v1/accounts", { key: key });
		record(`GET /api/v1/accounts (${planName})`, accountsActive.status === 200, `HTTP ${accountsActive.status} — ${accountsActive.json?.accounts?.length ?? "?"} accounts`);

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
			record("accounts blocked on Community", (await api("/api/v1/accounts", { key: key })).status === 403);

			const sharedBlocked = domainId
				? await api("/api/v1/mailboxes", { method: "POST", key: key, body: { domainId, localPart: `smoke-${randomBytes(3).toString("hex")}`, displayName: "Smoke test", type: "shared" } })
				: { status: 0 };
			record("shared mailbox blocked on Community", sharedBlocked.status === 403, `HTTP ${sharedBlocked.status}`);

			const iconDefault = await fetchBytes("/api/branding/icon");
			record("branding icon is the default on Community", sha256(iconDefault) !== sha256(BRANDING_PNG), `${iconDefault.length} bytes`);

			// --- and allow again under the chosen plan ----------------------------
			d1(licenceOn(planName));
			record(`accounts allowed (${planName})`, (await api("/api/v1/accounts", { key: key })).status === 200);

			const iconCustom = await fetchBytes("/api/branding/icon");
			record(`branding icon is custom (${planName})`, sha256(iconCustom) === sha256(BRANDING_PNG), `${iconCustom.length} bytes`);

			if (domainId && supportsSharing) {
				const localPart = `smoke-${randomBytes(3).toString("hex")}`;
				const created = await api("/api/v1/mailboxes", { method: "POST", key: key, body: { domainId, localPart, displayName: "Smoke test", type: "shared" } });
				record(`shared mailbox allowed (${planName})`, created.status === 201, `HTTP ${created.status} — ${created.json?.address ?? created.json?.error ?? ""}`);
				const mailboxId = created.status === 201 ? created.json.id : null;
				if (mailboxId) {
					onCleanup(() => api(`/api/v1/mailboxes/${mailboxId}`, { method: "DELETE", key: key }));

					// --- sharing: round-trip an access grant ----------------------
					const grantId = `mac_smoke_${randomBytes(6).toString("hex")}`;
					d1(`INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at) VALUES ('${esc(grantId)}', '${esc(mailboxId)}', '${esc(admin.id)}', 'full_access', strftime('%s','now'));`);
					onCleanup(() => d1(`DELETE FROM mailbox_access WHERE id='${esc(grantId)}';`));
					const [grant] = d1(`SELECT permission FROM mailbox_access WHERE id='${esc(grantId)}';`);
					record("mailbox access grant round-trip", grant?.permission === "full_access", grant?.permission ?? "missing");

					if (keepArtifacts) {
						console.log(`\n  → kept ${created.json.address} and its full_access grant for inspection.`);
					} else {
						const removed = await api(`/api/v1/mailboxes/${mailboxId}`, { method: "DELETE", key: key });
						record("delete the shared mailbox", removed.status === 200, `HTTP ${removed.status}`);
						if (removed.status === 200) d1(`DELETE FROM mailbox_access WHERE id='${esc(grantId)}';`);
					}
				}
			}

			if (domainId && !supportsSharing) {
				const refused = await api("/api/v1/mailboxes", { method: "POST", key: key, body: { domainId, localPart: `smoke-${randomBytes(3).toString("hex")}`, displayName: "Smoke test", type: "shared" } });
				record("shared mailbox refused on Pro (Team-only)", refused.status === 403, `HTTP ${refused.status}`);
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
		if (keepArtifacts) {
			console.log(`\nTemporary key removed; artifacts kept (see the guide above).`);
		} else {
			for (const cleanup of cleanups.reverse()) {
				try {
					await cleanup();
				} catch {
					// best effort
				}
			}
			d1(licenceOn("team"));
			console.log(`\nCleaned up temporary key; license restored to Team.`);
		}
	}
});

const failed = results.filter((r) => !r.ok);
console.log(guiMap(base, planName));
if (keepArtifacts) console.log(`\nFixtures kept — inspect the screens above, then remove them with: npm run joeblew999:features:smoke -- --cleanup`);
console.log(`\n${failed.length === 0 ? "All checks passed" : `${failed.length} check(s) failed`}: ${results.length - failed.length}/${results.length}.`);
process.exit(failed.length === 0 ? 0 : 1);
