/* eslint-disable @typescript-eslint/no-explicit-any -- external HTTP JSON. */
import { randomBytes } from "node:crypto";
import { sqlEscape } from "../joeblew999-lib";
import { validateBody } from "../joeblew999-lib-app";
import type { AccessGrant, Context, Role } from "./types";

const PERMISSIONS = new Set(["read_only", "send_as", "send_on_behalf", "full_access"]);

// Apply a mailbox's `access: [{ email, permission }]` grants straight to
// mailbox_access (what the app reads). Deleting the mailbox cascades them away.
export function applyAccess(ctx: Context, mailboxId: string, address: string, grants: AccessGrant[]): number {
	let failures = 0;
	for (const grant of grants) {
		const email = String(grant.email ?? "").trim().toLowerCase();
		const permission = String(grant.permission ?? "full_access").trim();
		if (!email || !PERMISSIONS.has(permission)) {
			console.log(`     ✗ ${address}: bad access entry ${JSON.stringify(grant)}`);
			failures += 1;
			continue;
		}
		const [user] = ctx.d1(`SELECT id FROM users WHERE lower(email)='${sqlEscape(email)}' LIMIT 1;`);
		if (!user) {
			console.log(`     ✗ ${address}: no user with email ${email}`);
			failures += 1;
			continue;
		}
		// Grants share a mailbox with OTHER users; the owner already has full access.
		// Skipping owner grants also stops the mailbox appearing twice in listings that
		// merge owned + shared rows.
		const [owner] = ctx.d1(`SELECT user_id FROM mailboxes WHERE id='${sqlEscape(mailboxId)}';`);
		if (owner && owner.user_id === user.id) {
			if (!ctx.flags.dryRun) ctx.d1(`DELETE FROM mailbox_access WHERE mailbox_id='${sqlEscape(mailboxId)}' AND user_id='${sqlEscape(user.id)}';`);
			console.log(`     · ${email} owns ${address} — grant not needed, skipped`);
			continue;
		}
		if (ctx.flags.dryRun) {
			console.log(`     → would grant ${permission} on ${address} to ${email}`);
			continue;
		}
		ctx.d1(`INSERT INTO mailbox_access (id, mailbox_id, user_id, permission, created_at)
		    VALUES ('mac_${randomBytes(6).toString("hex")}', '${sqlEscape(mailboxId)}', '${sqlEscape(user.id)}', '${sqlEscape(permission)}', strftime('%s','now'))
		    ON CONFLICT(mailbox_id, user_id) DO UPDATE SET permission=excluded.permission;`);
		console.log(`     ✓ ${permission} on ${address} → ${email}`);
	}
	return failures;
}

// Create (or delete, under --cleanup) the role mailboxes, and return each role's
// mailbox id so MCP keys can be scoped to them.
export async function syncMailboxes(ctx: Context, roles: Role[]): Promise<{ failures: number; mailboxIdsByRole: Map<string, string> }> {
	const boxes = await ctx.api("/api/v1/mailboxes");
	const existing = new Map<string, any>(
		(boxes.json?.mailboxes ?? [])
			.filter((entry: any) => String(entry.hostname).toLowerCase() === ctx.domainName)
			.map((entry: any) => [String(entry.localPart).toLowerCase(), entry]),
	);

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
			const removed = await ctx.api(`/api/v1/mailboxes/${current.id}`, { method: "DELETE" });
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
			const created = await ctx.api("/api/v1/mailboxes", {
				method: "POST",
				body: validateBody("mailbox", { domainId: ctx.domain.id, localPart: role, displayName, type: share ? "shared" : "personal" }),
			});
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
