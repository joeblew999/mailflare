import { newId } from "@/lib/ids";
import { validateBody } from "../joeblew999-lib-app";
import { requireDomain } from "./context";
import type { AccountEntry, ApiAccount, ApiMailbox, Context } from "./types";

// Create a login account (`accounts: [{ username, name?, role?, password? | passwordEnv? }]`).
// Existing accounts are re-enabled, since the app cannot delete a user.
export async function ensureAccount(ctx: Context, entry: AccountEntry): Promise<number> {
	const username = String(entry.username ?? entry.name ?? "").trim().toLowerCase();
	if (!username) {
		console.log(`  ✗ account entry needs a username: ${JSON.stringify(entry)}`);
		return 1;
	}
	const email = `${username}@${ctx.domainName}`;
	const list = await ctx.api("/api/v1/accounts");
	const accounts = (list.json?.accounts ?? []) as ApiAccount[];
	const existing = accounts.find((account) => String(account.email).toLowerCase() === email);

	if (existing) {
		if (existing.disabled) {
			if (ctx.flags.dryRun) {
				console.log(`  → would re-enable account ${email}`);
			} else {
				const res = await ctx.api(`/api/v1/accounts/${existing.id}`, {
					method: "PATCH",
					body: validateBody("accountUpdate", {
						name: existing.name ?? username,
						role: existing.role ?? "user",
						disabled: false,
						canManageMailboxes: Boolean(existing.canManageMailboxes),
					}),
				});
				console.log(`  ${res.status === 200 ? "✓ re-enabled" : `✗ re-enable failed (HTTP ${res.status})`} account ${email}`);
				if (res.status !== 200) return 1;
			}
		} else {
			console.log(`  · account ${email} — already exists`);
		}
		return await ensureAccountMailbox(ctx, existing, username, email);
	}

	const fromEnv = entry.passwordEnv ? process.env[entry.passwordEnv] : null;
	const password = entry.password || fromEnv || newId();
	const generated = !entry.password && !fromEnv;
	if (ctx.flags.dryRun) {
		console.log(`  → would create account ${email} (${entry.role === "admin" ? "admin" : "user"})`);
		return 0;
	}
	const created = await ctx.api("/api/v1/accounts", {
		method: "POST",
		body: validateBody("account", { username, domainId: requireDomain(ctx).id, password, role: entry.role === "admin" ? "admin" : "user", useAllDomains: false, aliases: [] }),
	});
	if (created.status !== 200 && created.status !== 201) {
		console.log(`  ✗ account failed (HTTP ${created.status}) ${email} — ${created.json?.error ?? ""}`);
		return 1;
	}
	console.log(`  ✓ created account ${email}${generated ? `  ⚠ password (shown once): ${password}` : ""}`);
	return 0;
}

// An account's own mailbox is cascaded away when its domain is removed, and the
// account itself cannot be recreated (no user-delete), so rebuild the mailbox owned
// by that account (POST /api/v1/mailboxes accepts ownerUserId).
async function ensureAccountMailbox(ctx: Context, account: ApiAccount, username: string, email: string): Promise<number> {
	const boxes = await ctx.api("/api/v1/mailboxes");
	const exists = ((boxes.json?.mailboxes ?? []) as ApiMailbox[]).some(
		(row) => String(row.hostname).toLowerCase() === ctx.domainName && String(row.localPart).toLowerCase() === username,
	);
	if (exists) return 0;
	if (ctx.flags.dryRun) {
		console.log(`  → would create mailbox ${email}`);
		return 0;
	}
	const created = await ctx.api("/api/v1/mailboxes", {
		method: "POST",
		body: validateBody("mailbox", { domainId: requireDomain(ctx).id, localPart: username, displayName: account.name ?? username, type: "personal", ownerUserId: account.id }),
	});
	if (created.status === 201) {
		console.log(`  ✓ created mailbox ${email}`);
		return 0;
	}
	console.log(`  ✗ mailbox ${email} failed (HTTP ${created.status}) — ${created.json?.error ?? ""}`);
	return 1;
}

// The app has no user-delete, so de-provisioning an account means disabling it.
export async function disableAccount(ctx: Context, entry: AccountEntry): Promise<number> {
	const username = String(entry.username ?? entry.name ?? "").trim().toLowerCase();
	const email = `${username}@${ctx.domainName}`;
	const list = await ctx.api("/api/v1/accounts");
	const accounts = (list.json?.accounts ?? []) as ApiAccount[];
	const account = accounts.find((row) => String(row.email).toLowerCase() === email);
	if (!account) {
		console.log(`  · account ${email} — not found, skipping`);
		return 0;
	}
	if (account.isPrimaryAdmin) {
		console.log(`  ⚠ ${email} is the primary admin — not disabling`);
		return 0;
	}
	if (ctx.flags.dryRun) {
		console.log(`  → would disable account ${email}`);
		return 0;
	}
	const res = await ctx.api(`/api/v1/accounts/${account.id}`, {
		method: "PATCH",
		// updateManagedAccountSchema requires name, role, disabled and canManageMailboxes.
		body: validateBody("accountUpdate", {
			name: account.name ?? username,
			role: account.role ?? "user",
			disabled: true,
			canManageMailboxes: Boolean(account.canManageMailboxes),
		}),
	});
	console.log(`  ${res.status === 200 ? "✓ disabled" : `✗ disable failed (HTTP ${res.status})`} account ${email}`);
	return res.status === 200 ? 0 : 1;
}
