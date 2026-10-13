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

  6. Verify: add "push": {} to the project's instance.json, then
       npm run state -- <project> apply`);
}

// Verify Web Push end to end: send a real email back into our own inbox, then wait for it to
// land. A round trip is not a state to converge on: declaring it means "run the test".
export const pushResource: Resource = {
	section: "push",
	declared: (ctx) => ctx.spec.push !== undefined,
	async items(ctx) {
		const entry = ctx.spec.push ?? {};
		const to = (entry.to ?? (await ctx.store.firstAdminEmail()))?.trim();
		// Null means the secrets could not be listed, which says nothing about what is set.
		const secrets = to ? await ctx.store.workerSecrets() : null;
		const lacking = secrets ? VAPID.filter((name) => !secrets.includes(name)) : [];
		return [{
			address: "push",
			problem: !to ? "no recipient: set push.to, or give the instance an admin" : undefined,
			wants: `test email to ${to}${lacking.length > 0 ? ` (the Worker is missing ${lacking.join(", ")})` : ""}`,
			actual: async () => null,
			create: async () => {
				const subject = entry.subject ?? `Mailflare push test ${new Date().toISOString()}`;
				await ctx.store.sendViaCloudflare({
					from: (entry.from ?? to ?? "").trim(), to: to ?? "", subject,
					text: "If your device shows a notification, Web Push is working.",
					html: "<p>If your device shows a notification, <strong>Web Push</strong> is working.</p>",
				});
				const seconds = entry.timeout ?? 40;
				const deadline = Date.now() + seconds * 1000;
				for (;;) {
					const arrived = await ctx.store.messageStatusBySubject(subject);
					if (arrived) return `arrived (${arrived.status}) — check your devices for the notification`;
					if (Date.now() >= deadline) throw new Error(`sent, but not seen in the inbox within ${seconds}s — check Email Routing, MX and the inbound queue`);
					await ctx.store.wait(3000);
				}
			},
			// Destroy drops the subscriptions, which are bound to the key pair being retired.
			removable: async () => (await ctx.store.pushSubscriptionCount()) || null,
			remove: async (present) => {
				await ctx.store.clearPushSubscriptions();
				return `${present} subscription(s) cleared — re-enable the toggle on each device`;
			},
		}];
	},
};
