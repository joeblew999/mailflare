import { validateBody } from "../app";
import { declaresUser, requireDomain, usernameOf, type Context } from "../context";
import { expectOk, type Item, type Resource } from "./resource";
import type { ApiMailbox } from "../spec";

/** This domain's mailboxes, by local part. */
export async function mailboxesForDomain(ctx: Context): Promise<Map<string, ApiMailbox>> {
	const boxes = new Map<string, ApiMailbox>();
	for (const box of await ctx.store.listMailboxes()) {
		if (String(box.hostname).toLowerCase() === ctx.domainName) boxes.set(String(box.localPart).toLowerCase(), box);
	}
	return boxes;
}

/** Publish this domain's mailbox ids: routing rules and MCP keys name mailboxes by role. */
export async function publishMailboxIds(ctx: Context): Promise<Map<string, ApiMailbox>> {
	const boxes = await mailboxesForDomain(ctx);
	for (const [role, box] of boxes) ctx.mailboxIds.set(role, box.id);
	return boxes;
}

export const mailboxesResource: Resource = {
	section: "mailboxes",
	// A written section is complete, even when it is empty; one left out is not managed.
	declared: (ctx) => ctx.spec.mailboxes !== undefined,
	async items(ctx) {
		const boxes = await publishMailboxIds(ctx);
		// The app will not take an address over from a rule someone made in Cloudflare, and nor
		// should it: that rule is where the mail goes today.
		const receives = (ctx.domain?.receivingProvider ?? ctx.spec.onboard?.receivingProvider ?? "cloudflare") === "cloudflare";
		const elsewhere = receives && ctx.roles.some((entry) => !boxes.has(entry.role)) ? await ctx.store.routedElsewhere(ctx.domainName) : {};
		// Every grant on the declared mailboxes, read once.
		const declaredBoxes = ctx.roles.map((entry) => boxes.get(entry.role)).filter((box): box is ApiMailbox => !!box);
		const grants = await ctx.store.accessList(declaredBoxes.map((box) => box.id));
		const items: Item[] = [];
		for (const { role, displayName, shared, access, managesAccess } of ctx.roles) {
			const box = boxes.get(role);
			const address = `${role}@${ctx.domainName}`;
			const type = shared ? "shared" : "personal";
			items.push({
				address: `mailbox.${address}`,
				wants: box ? `display name "${box.displayName ?? ""}" → "${displayName}"` : type,
				// The app has no way to turn one kind of mailbox into the other.
				problem: box && box.type !== type
					? `exists as a ${box.type} mailbox, and the document wants ${type} — the app cannot convert one`
					: !box && elsewhere[address]
						? `Cloudflare already routes ${address} elsewhere (${elsewhere[address]}) — remove that Email Routing rule, or use another address`
						: undefined,
				actual: async () => box ?? null,
				satisfied: (actual) => !!actual && (displayName === null || (actual as ApiMailbox).displayName === displayName),
				create: async () => {
					const res = expectOk(await ctx.store.createMailbox(validateBody("mailbox", { domainId: requireDomain(ctx).id, localPart: role, displayName: displayName ?? role, type })));
					ctx.mailboxIds.set(role, String(res.json?.id));
					return type;
				},
				update: async (actual) => {
					expectOk(await ctx.store.updateMailbox((actual as ApiMailbox).id, validateBody("mailboxUpdate", { displayName })));
					return `display name "${displayName}"`;
				},
				remove: async (present) => {
					expectOk(await ctx.store.deleteMailbox((present as ApiMailbox).id));
					ctx.mailboxIds.delete(role);
				},
			});

			for (const grant of access) {
				const email = grant.email.trim().toLowerCase();
				const permission = grant.permission ?? "full_access";
				const userId = await ctx.store.userIdByEmail(email);
				// The owner of a mailbox needs no grant for it, and one that exists is redundant.
				const isOwner = Boolean(userId && box && box.userId === userId);
				const mailboxId = () => ctx.mailboxIds.get(role) ?? null;
				const current = async () => grants.find((entry) => entry.mailboxId === mailboxId() && entry.userId === userId)?.permission ?? null;
				const write = async () => {
					const user = userId ?? (await ctx.store.userIdByEmail(email));
					if (!mailboxId() || !user) throw new Error(`${!mailboxId() ? `${address} does not exist` : `${email} does not exist`}, so there is nothing to grant`);
					if (isOwner) {
						await ctx.store.revokeAccess(mailboxId()!, user);
						return "cleared — the owner needs no grant";
					}
					await ctx.store.grantAccess(mailboxId()!, user, permission);
					return permission;
				};
				items.push({
					address: `mailbox_access.${role}.${email}`,
					wants: isOwner ? "clear — the owner needs no grant" : permission,
					// A grant names a LOCAL user: one that exists, or one this document creates.
					problem: userId || declaresUser(ctx, email) ? undefined : "no local user with that address — declare the account, or the grant cannot resolve",
					actual: current,
					satisfied: (actual) => (isOwner ? actual === null : actual === permission),
					create: write,
					update: write,
					remove: async () => {
						if (mailboxId() && userId) await ctx.store.revokeAccess(mailboxId()!, userId);
					},
				});
			}
			// A mailbox that writes its `access` list has only those grants.
			const named = new Set(access.map((grant) => grant.email.trim().toLowerCase()));
			for (const grant of managesAccess && box ? grants.filter((entry) => entry.mailboxId === box.id && !named.has(entry.email)) : []) {
				items.push({ address: `mailbox_access.${role}.${grant.email}`, undeclared: true, actual: async () => grant, remove: async () => ctx.store.revokeAccess(grant.mailboxId, grant.userId) });
			}
		}

		// The admin's mailboxes on the domain are this section's; an account's own belongs to the account.
		const admin = await ctx.store.admin();
		const accounted = new Set([...ctx.roles.map((entry) => entry.role), ...(ctx.spec.accounts ?? []).map(usernameOf)]);
		for (const [role, box] of boxes) {
			if (box.userId !== admin.id || accounted.has(role)) continue;
			items.push({
				address: `mailbox.${role}@${ctx.domainName}`,
				undeclared: true,
				actual: async () => box,
				remove: async () => {
					expectOk(await ctx.store.deleteMailbox(box.id));
					ctx.mailboxIds.delete(role);
				},
			});
		}
		return items;
	},
};
