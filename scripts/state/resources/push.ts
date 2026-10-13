import type { Resource } from "./resource";
import type { Context } from "../types";

// The secrets the Worker needs to encrypt a push payload.
const VAPID = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];

// Rotating the VAPID pair, since Cloudflare secrets are write-only.
export function pushRunbook(db: string, local: boolean) {
	const location = local ? "--local" : "--remote";
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
       wrangler d1 execute ${db} ${location} --command "DELETE FROM push_subscriptions;"

  5. In the app: Settings → Inbox → toggle "Browser push notifications" OFF, then ON.

  6. Verify
       npm run state:push`);
}

function reportSecrets(ctx: Context) {
	const secrets = ctx.store.workerSecrets();
	if (!secrets) {
		console.log("  ⚠ could not read the Worker's secret list (is wrangler logged in?)");
		return;
	}
	const missing = VAPID.filter((name) => !secrets.includes(name));
	console.log(missing.length ? `  ⚠ Worker is missing: ${missing.join(", ")}` : "  ✓ VAPID secrets present on the Worker");
}

// Verify Web Push end to end: send a real email back into our own inbox, then wait
// for it to land. No domain needed - it uses the instance's own admin address.
export const pushResource: Resource = {
	section: "push",
	needsDomain: false,
	declared: (ctx) => ctx.flags.push || Boolean(ctx.project?.push),
	async status(ctx) {
		reportSecrets(ctx);
		const subscriptions = ctx.store.pushSubscriptionCount();
		console.log(`  push_subscriptions: ${subscriptions}`);
		if (subscriptions === 0) {
			console.log('  ⚠ none — enable Settings → Inbox → "Browser push notifications" on the device first');
			return 1;
		}
		return 0;
	},
	async apply(ctx) {
		const entry = ctx.project?.push ?? {};
		reportSecrets(ctx);
		const subscriptions = ctx.store.pushSubscriptionCount();
		console.log(`  push_subscriptions: ${subscriptions}`);
		if (subscriptions === 0) {
			console.log('  ⚠ none — enable Settings → Inbox → "Browser push notifications" on the device first');
		}

		const to = (ctx.flags.to ?? entry.to ?? ctx.store.firstAdminEmail())?.trim();
		if (!to) {
			console.log("  ✗ no recipient: pass --to, or give the instance a user");
			return 1;
		}
		const from = (ctx.flags.from ?? entry.from ?? to).trim();
		const subject = ctx.flags.subject ?? entry.subject ?? `Mailflare push test ${new Date().toISOString()}`;
		if (ctx.flags.dryRun) {
			console.log(`  → would send a test email ${from} → ${to} and wait for it to land`);
			return 0;
		}

		const { messageId } = await ctx.store.sendViaCloudflare({
			from,
			to,
			subject,
			text: "If your device shows a notification, Web Push is working.",
			html: "<p>If your device shows a notification, <strong>Web Push</strong> is working.</p>",
		});
		console.log(`  ✓ queued (${messageId ?? "sent"})`);

		// Match on the unique subject, since the inbound copy gets its own id.
		const deadline = Date.now() + Number(ctx.flags.timeout) * 1000;
		let arrived: { status: string } | null = null;
		while (Date.now() < deadline) {
			arrived = await ctx.store.messageStatusBySubject(subject);
			if (arrived) break;
			await ctx.store.wait(3000);
		}
		if (arrived) {
			console.log(`  ✓ arrived in the inbox (status: ${arrived.status}) — check your devices for the notification`);
			return 0;
		}
		console.log(`  ✗ not seen in the inbox within ${ctx.flags.timeout}s — check Email Routing/MX and the inbound queue`);
		return 1;
	},
	async remove(ctx) {
		if (ctx.flags.dryRun) {
			console.log("  → would delete every push_subscriptions row (re-enable the toggle on each device afterwards)");
			return 0;
		}
		ctx.store.clearPushSubscriptions();
		console.log("  ✓ cleared push_subscriptions — re-enable the toggle on each device");
		return 0;
	},
};
