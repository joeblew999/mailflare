import { mailboxAccessSchema } from "@/lib/validators";
import { validateBody } from "../app";
import { requireDomain } from "../context";
import type { Context } from "../context";
import type { AccessGrant, ApiMailbox, Role } from "../spec";
import type { Resource, RunState } from "./resource";
import type { Change } from "../plan";

// The domain's mailboxes, keyed by lower-cased local part. One helper so the
// "list mailboxes and keep this domain's" step is not rewritten in three places.
export async function mailboxesForDomain(ctx: Context): Promise<Map<string, ApiMailbox>> {
	const rows = await ctx.store.listMailboxes();
	return new Map(
		rows
			.filter((row) => String(row.hostname).toLowerCase() === ctx.domainName)
			.map((row) => [String(row.localPart).toLowerCase(), row]),
	);
}

// Apply a mailbox's `access: [{ email, permission }]` grants. Grants share a mailbox
// with OTHER users; the owner already has full access.
export function applyAccess(ctx: Context, mailboxId: string, address: string, grants: AccessGrant[]): number {
	let failures = 0;
	for (const grant of grants) {
		const email = String(grant.email ?? "").trim().toLowerCase();
		const permission = String(grant.permission ?? "full_access").trim();
		if (!email) {
			console.log(`     ✗ ${address}: access entry needs an email ${JSON.stringify(grant)}`);
			failures += 1;
			continue;
		}
		const userId = ctx.store.userIdByEmail(email);
		if (!userId) {
			console.log(`     ✗ ${address}: no user with email ${email}`);
			failures += 1;
			continue;
		}
		// Validate against the app's own schema so permissions cannot drift.
		const parsed = mailboxAccessSchema.safeParse({ userId, permission });
		if (!parsed.success) {
			console.log(`     ✗ ${address}: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
			failures += 1;
			continue;
		}
		// Skipping owner grants also stops the mailbox appearing twice in listings that
		// merge owned + shared rows.
		const owner = ctx.store.mailboxOwnerId(mailboxId);
		if (owner && owner === userId) {
			if (!ctx.flags.dryRun) ctx.store.revokeAccess(mailboxId, userId);
			console.log(`     · ${email} owns ${address} — grant not needed, skipped`);
			continue;
		}
		if (ctx.flags.dryRun) {
			console.log(`     → would grant ${permission} on ${address} to ${email}`);
			continue;
		}
		ctx.store.grantAccess(mailboxId, userId, parsed.data.permission);
		console.log(`     ✓ ${permission} on ${address} → ${email}`);
	}
	return failures;
}

// Create (or delete, under --cleanup) the role mailboxes, and return each role's
// mailbox id so MCP keys and routing rules can be scoped to them.
export async function syncMailboxes(ctx: Context, roles: Role[]): Promise<{ failures: number; mailboxIdsByRole: Map<string, string> }> {
	const existing = await mailboxesForDomain(ctx);

	let failures = 0;
	const mailboxIdsByRole = new Map<string, string>();

	for (const { role, displayName, share, access } of roles) {
		const address = `${role}@${ctx.domainName}`;
		const current = existing.get(role);

		if (ctx.flags.cleanup) {
			if (!current) {
				console.log(`  · ${address} — not present, skipping`);
				continue;
			}
			if (ctx.flags.dryRun) {
				console.log(`  → would delete ${address}`);
				continue;
			}
			const removed = await ctx.store.deleteMailbox(current.id);
			if (removed.status === 200) {
				console.log(`  ✓ deleted ${address}`);
			} else {
				failures += 1;
				console.log(`  ✗ delete failed (HTTP ${removed.status}) ${address}`);
			}
			continue;
		}

		let mailboxId: string | null = current?.id ?? null;
		if (mailboxId) {
			console.log(`  · ${address} — already exists`);
		} else if (ctx.flags.dryRun) {
			console.log(`  → would create ${address}${share ? " (shared)" : ""}`);
		} else {
			const created = await ctx.store.createMailbox(
				validateBody("mailbox", { domainId: requireDomain(ctx).id, localPart: role, displayName, type: share ? "shared" : "personal" }),
			);
			if (created.status === 201) {
				mailboxId = created.json.id;
				console.log(`  ✓ created ${address}${share ? " (shared)" : ""}`);
			} else {
				failures += 1;
				console.log(`  ✗ failed (HTTP ${created.status}) ${address} — ${created.json?.error ?? ""}`);
			}
		}

		if (mailboxId) mailboxIdsByRole.set(role, mailboxId);
		if (access.length > 0 && (mailboxId || ctx.flags.dryRun)) failures += applyAccess(ctx, mailboxId ?? "«new»", address, access);
	}

	return { failures, mailboxIdsByRole };
}

// Read-only report: which declared mailboxes and access grants are missing. It also
// publishes the ids it found, because routing rules and MCP keys name mailboxes by
// role and cannot resolve their destination without them.
async function planMailboxes(ctx: Context, roles: Role[], state: RunState): Promise<Change[]> {
	const present = await mailboxesForDomain(ctx);
	// Routing rules and MCP keys name mailboxes by role, so the plan publishes the ids it
	// found exactly as apply does - otherwise they could not classify themselves.
	for (const [role, box] of present) state.mailboxIdsByRole.set(role, box.id);
	const changes: Change[] = [];
	for (const { role, share, access } of roles) {
		const box = present.get(role);
		changes.push({ address: `mailbox.${role}@${ctx.domainName}`, action: box ? "unchanged" : "create", detail: share ? "shared" : "personal" });
		for (const grant of access) {
			const email = String(grant.email ?? "").toLowerCase();
			const permission = String(grant.permission ?? "full_access");
			const userId = ctx.store.userIdByEmail(email);
			const actual = box && userId ? ctx.store.accessPermission(box.id, userId) : null;
			// A grant names a LOCAL user. One that names an outside address can never resolve,
			// so it is reported as a problem rather than a create that will fail on apply.
			const action = !userId ? "problem" : actual === permission ? "unchanged" : actual ? "update" : "create";
			changes.push({
				address: `mailbox_access.${role}.${email}`,
				action,
				detail: !userId ? "no local user with that address - the grant cannot resolve" : actual && actual !== permission ? `${actual} -> ${permission}` : permission,
			});
		}
	}
	return changes;
}

export const mailboxesResource: Resource = {
	section: "mailboxes",
	needsDomain: true,
	declared: (_ctx, roles) => roles.length > 0,
	plan: (ctx, roles, state) => planMailboxes(ctx, roles, state),
	async apply(ctx, roles, state) {
		const { failures, mailboxIdsByRole } = await syncMailboxes(ctx, roles);
		for (const [role, id] of mailboxIdsByRole) state.mailboxIdsByRole.set(role, id);
		return failures;
	},
	async remove(ctx, roles) {
		return (await syncMailboxes(ctx, roles)).failures;
	},
};
