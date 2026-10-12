#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any -- external HTTP JSON is validated by the app's zod schemas at runtime, not by these types. */
// Verify Web Push end to end: sends a test email through the Cloudflare Email
// Sending API back into your own Mailflare inbox, then confirms it arrived and
// that a push subscription exists. Watch your devices for the notification.
//
//   node scripts/joeblew999-push-test.mjs                 # send + verify (uses the primary admin address)
//   node scripts/joeblew999-push-test.mjs --to a@b.com     # override recipient
//   node scripts/joeblew999-push-test.mjs --steps          # print the key-rotation runbook
//
// Credentials come from the environment first (so `fnox exec -- ...` works),
// then fall back to the macOS keychain (service "fnox").
// GUI: turn notifications on at <instance>/settings/inbox (Browser push notifications).
import { parseArgs } from "node:util";
import { d1 as libD1, keychain, sleep, workerSecretNames } from "./joeblew999-lib";

const API = "https://api.cloudflare.com/client/v4";

const { values } = parseArgs({
	options: {
		to: { type: "string" },
		from: { type: "string" },
		subject: { type: "string" },
		db: { type: "string", default: "mailflare" },
		local: { type: "boolean", default: false },
		steps: { type: "boolean", default: false },
		timeout: { type: "string", default: "40" },
		help: { type: "boolean", short: "h", default: false },
	},
});

const location = values.local ? "--local" : "--remote";

// Shared helpers (scripts/joeblew999-lib.ts) with this script's database baked in.
const d1 = (sql) => libD1(sql, { db: values.db, local: values.local });

function printSteps() {
	console.log(`Rotating Web Push (VAPID) keys
──────────
Because Cloudflare secrets are write-only, you cannot back up the current pair.
To rotate and keep a copy in fnox:

  1. Generate a pair
       npm run push:keys

  2. Store it in the project keychain (service = "mailflare", per fnox.toml)
       security add-generic-password -U -s mailflare -a VAPID_PUBLIC_KEY  -w "<public>"
       security add-generic-password -U -s mailflare -a VAPID_PRIVATE_KEY -w "<private>"
       security add-generic-password -U -s mailflare -a VAPID_SUBJECT     -w "mailto:you@example.com"

  3. Push it to the Worker
       wrangler secret put VAPID_PUBLIC_KEY
       wrangler secret put VAPID_PRIVATE_KEY
       wrangler secret put VAPID_SUBJECT

  4. Drop subscriptions bound to the old key
       wrangler d1 execute ${values.db} ${location} --command "DELETE FROM push_subscriptions;"

  5. In the app: Settings → Inbox → toggle "Browser push notifications" OFF, then ON.

  6. Verify
       node scripts/joeblew999-push-test.mjs`);
}

if (values.help) {
	console.log("Usage: node scripts/joeblew999-push-test.mjs [--to <addr>] [--from <addr>] [--db mailflare] [--local] [--steps]");
	process.exit(0);
}
if (values.steps) {
	printSteps();
	process.exit(0);
}

const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || keychain("CLOUDFLARE_API_TOKEN");
const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || keychain("CLOUDFLARE_ACCOUNT_ID");
if (!token || !account) {
	console.error("Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.");
	console.error("Export them, run via `fnox exec -- node scripts/joeblew999-push-test.mjs`, or store them in the keychain (service \"fnox\").");
	process.exit(1);
}

const secrets = workerSecretNames();
if (secrets) {
	const missing = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"].filter((name) => !secrets.includes(name));
	console.log(missing.length ? `⚠️  Worker is missing: ${missing.join(", ")}` : "✓ VAPID secrets present on the Worker");
}

let subscriptions = [];
try {
	subscriptions = d1("SELECT id FROM push_subscriptions;");
	console.log(`✓ push_subscriptions: ${subscriptions.length} registered`);
} catch (error) {
	console.log(`⚠️  Could not read push_subscriptions (${error instanceof Error ? error.message : String(error)})`);
}
if (subscriptions.length === 0) {
	console.log("⚠️  No subscription — enable Settings → Inbox → \"Browser push notifications\" on the device first.");
}

let recipient = values.to?.trim();
if (!recipient) {
	const [admin] = d1("SELECT email FROM users LIMIT 1;");
	recipient = admin?.email;
}
if (!recipient) {
	console.error("No recipient: pass --to, or ensure the instance has a user.");
	process.exit(1);
}

const sender = values.from?.trim() || recipient;
const subject = values.subject?.trim() || `Mailflare push test ${new Date().toISOString()}`;

console.log(`\nSending from ${sender} to ${recipient}\n  subject: ${subject}`);

const response = await fetch(`${API}/accounts/${account}/email/sending/send`, {
	method: "POST",
	headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	body: JSON.stringify({
		from: sender,
		to: recipient,
		subject,
		text: "If your device shows a notification, Web Push is working.",
		html: "<p>If your device shows a notification, <strong>Web Push</strong> is working.</p>",
	}),
});
const payload = (await response.json()) as {
	success?: boolean;
	errors?: unknown;
	result?: { message_id?: string };
};
if (!response.ok || !payload.success) {
	console.error(`Send failed (${response.status}): ${JSON.stringify(payload.errors ?? payload)}`);
	process.exit(1);
}
console.log(`✓ Queued (${payload.result?.message_id})`);

// Poll until the message lands. We match on the unique subject generated above
// because the inbound copy gets its own id.
const deadline = Date.now() + Number(values.timeout) * 1000;
const escaped = subject.replace(/'/g, "''");
let arrived: any = null;
while (Date.now() < deadline) {
	[arrived] = d1(`SELECT subject, from_addr, status, created_at FROM messages WHERE subject = '${escaped}' LIMIT 1;`);
	if (arrived) break;
	sleep(3000);
}

if (arrived) {
	console.log(`✓ Arrived in the inbox (status: ${arrived.status}) after poll`);
	console.log("\nNow check your devices — a notification should have popped. If not, re-enable the toggle and retry.");
} else {
	console.log(`✗ Not seen in the inbox within ${values.timeout}s. Check Email Routing/MX and the inbound queue.`);
	process.exit(1);
}
