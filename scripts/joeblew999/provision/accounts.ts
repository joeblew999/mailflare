import { newId } from "@/lib/ids";
import { validateBody } from "../lib-app";
import { requireDomain } from "./context";
import { mailboxesForDomain } from "./mailboxes";
import type { AccountEntry, ApiAccount, Context } from "./types";
import type { Resource } from "./resource";

// Create a login account (`accounts: [{ username, name?, role?, password? | passwordEnv? }]`).
// Existing accounts are re-enabled, since the app cannot delete a user.
export async function ensureAccount(ctx: Context, entry: AccountEntry): Promise<number> {
	const username = String(entry.username ?? entry.name ?? "").trim().toLowerCase();
	if (!username) {
		console.log(`  ✗ account entry needs a username: ${JSON.stringify(entry)}`);
		return 1;
	}
	const email = `${username}@${ctx.domainName}`;
	const accounts = await ctx.store.listAccounts();
	const existing = accounts.find((account) => String(account.email).toLowerCase() === email);

	if (existing) {
		if (existing.disabled) {
			if (ctx.flags.dryRun) {
				console.log(`  → would re-enable account ${email}`);
			} else {
				const res = await ctx.store.updateAccount(existing.id, updateBody(existing, username, false));
				console.log(`${res.status === 200 ? "✓ re-enabled" : `✗ re-enable failed (HTTP ${res.status}) — ${JSON.stringify(res.json?.error ?? "")}`} account ${email}`);
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
	const created = await ctx.store.createAccount(
		validateBody("account", {
			username,
			domainId: requireDomain(ctx).id,
			password,
			role: entry.role === "admin" ? "admin" : "user",
			useAllDomains: false,
			aliases: [],
		}),
	);
	if (created.status !== 200 && created.status !== 201) {
		console.log(`  ✗ account failed (HTTP ${created.status}) ${email} — ${created.json?.error ?? ""}`);
		return 1;
	}
	console.log(`  ✓ created account ${email}${generated ? `  ⚠ password (shown once): ${password}` : ""}`);
	return 0;
}

// updateManagedAccountSchema requires the whole object, so every update carries the
// account's current name/role/permissions rather than a partial patch.
//
// It returns the INPUT, not validateBody's result: that schema transforms an omitted
// password/forwardingEmail into null, and sending those back fails the app's own
// parse (null is not allowed where undefined is) with a 400. Validating first still
// catches drift before the request is made.
function updateBody(account: ApiAccount, username: string, disabled: boolean) {
	const body = {
		name: account.name?.trim() || username,
		role: account.role ?? "user",
		disabled,
		canManageMailboxes: Boolean(account.canManageMailboxes),
	};
	validateBody("accountUpdate", body);
	return body;
}

// An account's own mailbox is cascaded away when its domain is removed, and the
// account itself cannot be recreated (no user-delete), so rebuild the mailbox owned
// by that account (POST /api/v1/mailboxes accepts ownerUserId).
async function ensureAccountMailbox(ctx: Context, account: ApiAccount, username: string, email: string): Promise<number> {
	const boxes = await mailboxesForDomain(ctx);
	if (boxes.has(username)) return 0;
	if (ctx.flags.dryRun) {
		console.log(`  → would create mailbox ${email}`);
		return 0;
	}
	const created = await ctx.store.createMailbox(
		validateBody("mailbox", {
			domainId: requireDomain(ctx).id,
			localPart: username,
			displayName: account.name ?? username,
			type: "personal",
			ownerUserId: account.id,
		}),
	);
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
	const accounts = await ctx.store.listAccounts();
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
	const res = await ctx.store.updateAccount(account.id, updateBody(account, username, true));
	console.log(`${res.status === 200 ? "✓ disabled" : `✗ disable failed (HTTP ${res.status}) — ${JSON.stringify(res.json?.error ?? "")}`} account ${email}`);
	return res.status === 200 ? 0 : 1;
}

// Read-only report: each wanted account exists, is enabled, and owns its mailbox.
async function statusAccounts(ctx: Context): Promise<number> {
	const accounts = await ctx.store.listAccounts();
	const boxes = await mailboxesForDomain(ctx);
	let missing = 0;
	for (const entry of ctx.project?.accounts ?? []) {
		const username = String(entry.username ?? entry.name ?? "").trim().toLowerCase();
		const email = `${username}@${ctx.domainName}`;
		const account = accounts.find((row) => String(row.email).toLowerCase() === email);
		const why = !account ? " — missing" : account.disabled ? " — disabled" : !boxes.has(username) ? " — mailbox missing" : "";
		if (why) missing += 1;
		console.log(`  ${why ? "✗" : "✓"} ${email}${why}`);
	}
	return missing;
}

export const accountsResource: Resource = {
	section: "accounts",
	needsDomain: true,
	wanted: (ctx) => (ctx.project?.accounts?.length ?? 0) > 0,
	status: (ctx) => statusAccounts(ctx),
	async apply(ctx) {
		let failures = 0;
		for (const account of ctx.project?.accounts ?? []) failures += await ensureAccount(ctx, account);
		return failures;
	},
	async remove(ctx) {
		if (!ctx.flags.disableAccounts) return 0;
		let failures = 0;
		for (const account of ctx.project?.accounts ?? []) failures += await disableAccount(ctx, account);
		return failures;
	},
};
