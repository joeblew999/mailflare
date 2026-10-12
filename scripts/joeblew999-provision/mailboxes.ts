import { mailboxAccessSchema } from "@/lib/validators";
import { validateBody } from "../joeblew999-lib-app";
import { requireDomain } from "./context";
import type { AccessGrant, ApiMailbox, Context, Role } from "./types";

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

	console.log(`${ctx.flags.cleanup ? "Removing" : "Provisioning"} ${roles.length} role(s) on ${ctx.domainName}:\n`);
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
