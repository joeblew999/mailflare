import type { Resource } from "./resource";

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

// Verify Web Push end to end: send a real email back into our own inbox, then wait
// for it to land. No domain needed - it uses the instance's own admin address.
export const pushResource: Resource = {
	section: "push",
	needsDomain: false,
	declared: (ctx) => Boolean(ctx.spec?.push),
	async items(ctx) {
		const entry = ctx.spec?.push ?? {};
		const missing = VAPID.filter((name) => !(ctx.store.workerSecrets() ?? []).includes(name));
		const to = (entry.to ?? ctx.store.firstAdminEmail())?.trim();
		return [{
			address: "push",
			problem: !to ? "no recipient: set push.to, or give the instance a user" : undefined,
			wants: to && missing.length > 0 ? `test email to ${to} (worker missing ${missing.join(", ")})` : to ? `test email to ${to}` : undefined,
			// A round trip is not a state to converge on: declaring it means "run the test".
			actual: async () => null,
			create: async () => {
				const from = (entry.from ?? to ?? "").trim();
				const subject = entry.subject ?? `Mailflare push test ${new Date().toISOString()}`;
				const { messageId } = await ctx.store.sendViaCloudflare({
					from, to: to ?? "", subject,
					text: "If your device shows a notification, Web Push is working.",
					html: "<p>If your device shows a notification, <strong>Web Push</strong> is working.</p>",
				});
				console.log(`  ✓ queued (${messageId ?? "sent"})`);
				const seconds = entry.timeout ?? 40;
				const deadline = Date.now() + seconds * 1000;
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
				console.log(`  ✗ not seen in the inbox within ${seconds}s — check Email Routing/MX and the inbound queue`);
				return 1;
			},
			remove: async () => {
				ctx.store.clearPushSubscriptions();
				console.log("  ✓ cleared push_subscriptions — re-enable the toggle on each device");
				return 0;
			},
		}];
	},
};
