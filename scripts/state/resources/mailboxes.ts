import { validateBody } from "../app";
import { requireDomain } from "../context";
import type { Context } from "../context";
import type { ApiMailbox } from "../spec";
import type { Item, Resource } from "./resource";

/** This domain's mailboxes, by local part. Read once per walk. */
export async function mailboxesForDomain(ctx: Context): Promise<Map<string, ApiMailbox>> {
	const boxes = new Map<string, ApiMailbox>();
	for (const box of await ctx.store.listMailboxes()) {
		if (String(box.hostname).toLowerCase() === ctx.domainName) boxes.set(String(box.localPart).toLowerCase(), box);
	}
	return boxes;
}

const idOf = async (ctx: Context, role: string) => (await mailboxesForDomain(ctx)).get(role)?.id ?? null;

/** Publish this domain's mailbox ids into the run state. Destroy walks in reverse, so the
 *  rules and keys need them before the mailboxes resource is reached. */
export async function publishMailboxIds(ctx: Context, state: { mailboxIdsByRole: Map<string, string> }): Promise<void> {
	for (const [role, box] of await mailboxesForDomain(ctx)) state.mailboxIdsByRole.set(role, box.id);
}

export const mailboxesResource: Resource = {
	section: "mailboxes",
	needsDomain: true,
	declared: (_ctx, roles) => roles.length > 0,
	async items(ctx, roles, state) {
		const boxes = await mailboxesForDomain(ctx);
		// Routing rules and MCP keys name mailboxes by role, so publish what we found.
		for (const [role, box] of boxes) state.mailboxIdsByRole.set(role, box.id);

		const items: Item[] = [];
		for (const { role, share, access } of roles) {
			const box = boxes.get(role);
			items.push({
				address: `mailbox.${role}@${ctx.domainName}`,
				wants: share ? "shared" : "personal",
				actual: async () => box ?? null,
				create: async () => {
					const res = await ctx.store.createMailbox(validateBody("mailbox", {
						domainId: requireDomain(ctx).id, localPart: role, displayName: role, type: share ? "shared" : "personal",
					}));
					if (res.status !== 200 && res.status !== 201) {
						console.log(`  ✗ create ${role}@${ctx.domainName} (HTTP ${res.status}) ${JSON.stringify(res.json?.error ?? "")}`);
						return 1;
					}
					console.log(`  ✓ created ${role}@${ctx.domainName}${share ? " (shared)" : ""}`);
					// Publish the id straight away: routing rules and MCP keys name mailboxes by
					// role, and they run after this.
					const created = res.json?.mailbox?.id ?? res.json?.id ?? (await idOf(ctx, role));
					if (created) state.mailboxIdsByRole.set(role, String(created));
					return 0;
				},
				remove: async () => {
					const id = box?.id ?? (await idOf(ctx, role));
					if (!id) return 0;
					const res = await ctx.store.deleteMailbox(id);
					console.log(`${res.status === 200 ? "✓ deleted" : `✗ delete failed (HTTP ${res.status})`} ${role}@${ctx.domainName}`);
					return res.status === 200 ? 0 : 1;
				},
			});

			for (const grant of access) {
				const email = String(grant.email ?? "").trim().toLowerCase();
				const permission = String(grant.permission ?? "full_access");
				const userId = ctx.store.userIdByEmail(email);
				const owner = box ? ctx.store.mailboxOwnerId(box.id) : null;
				// The owner of a mailbox needs no grant for it, and one that exists is redundant.
				const isOwner = Boolean(userId && owner && userId === owner);
				items.push({
					address: `mailbox_access.${role}.${email}`,
					wants: isOwner ? "owner needs no grant" : permission,
					// A grant names a LOCAL user. An outside address can never resolve, so it is
					// reported as a problem rather than attempted.
					problem: userId ? undefined : "no local user with that address - the grant cannot resolve",
					actual: async () => {
						const id = box?.id ?? (await idOf(ctx, role));
						return id && userId ? ctx.store.accessPermission(id, userId) : null;
					},
					satisfied: (actual) => (isOwner ? actual === null : actual === permission),
					create: async () => write(ctx, box?.id ?? (await idOf(ctx, role)), userId, permission, isOwner, role, email),
					update: async () => write(ctx, box?.id ?? (await idOf(ctx, role)), userId, permission, isOwner, role, email),
					remove: async () => {
						const id = box?.id ?? (await idOf(ctx, role));
						if (id && userId) ctx.store.revokeAccess(id, userId);
						console.log(`  ✓ revoked ${permission} on ${role}@${ctx.domainName} → ${email}`);
						return 0;
					},
				});
			}
		}
		return items;
	},
};

/** Grant, or clear the redundant grant an owner should never have had. */
async function write(ctx: Context, mailboxId: string | null, userId: string | null, permission: string, isOwner: boolean, role: string, email: string): Promise<number> {
	if (!mailboxId || !userId) return 1;
	if (isOwner) {
		ctx.store.revokeAccess(mailboxId, userId);
		console.log(`  ✓ cleared a redundant grant: ${role}@${ctx.domainName} is owned by ${email}`);
		return 0;
	}
	ctx.store.grantAccess(mailboxId, userId, permission);
	console.log(`  ✓ ${permission} on ${role}@${ctx.domainName} → ${email}`);
	return 0;
}
