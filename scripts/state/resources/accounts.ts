import { newId } from "@/lib/ids";
import { validateBody } from "../app";
import { requireDomain } from "../context";
import { mailboxesForDomain } from "./mailboxes";
import type { Context } from "../context";
import type { AccountEntry, ApiAccount } from "../spec";
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
		} else {
			console.log(`  · account ${email} — already exists`);
		}
		return await ensureAccountMailbox(ctx, existing, username, email);
	}

	const fromEnv = entry.passwordEnv ? process.env[entry.passwordEnv] : null;
	const password = entry.password || fromEnv || newId();
	const generated = !entry.password && !fromEnv;
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

// The app has no user-delete, so tearing an account down means disabling it.
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
	const res = await ctx.store.updateAccount(account.id, updateBody(account, username, true));
	console.log(`${res.status === 200 ? "✓ disabled" : `✗ disable failed (HTTP ${res.status}) — ${JSON.stringify(res.json?.error ?? "")}`} account ${email}`);
	return res.status === 200 ? 0 : 1;
}

// Read-only report: each declared account exists, is enabled, and owns its mailbox.
export const accountsResource: Resource = {
	section: "accounts",
	needsDomain: true,
	declared: (ctx) => (ctx.spec?.accounts?.length ?? 0) > 0,
	async items(ctx) {
		const accounts = await ctx.store.listAccounts();
		const boxes = await mailboxesForDomain(ctx);
		return (ctx.spec?.accounts ?? []).map((entry) => {
			const username = String(entry.username ?? entry.name ?? "").trim().toLowerCase();
			const email = `${username}@${ctx.domainName}`;
			const account = accounts.find((row) => String(row.email).toLowerCase() === email) ?? null;
			return {
				address: `account.${username}`,
				wants: entry.role ?? "user",
				actual: async () => account,
				// An existing, enabled account that owns its mailbox is already what we want.
				satisfied: (actual: unknown) => {
					const found = actual as ApiAccount | null;
					return !!found && !found.disabled && boxes.has(username);
				},
				create: async () => ensureAccount(ctx, entry),
				update: async () => ensureAccount(ctx, entry),
				remove: async () => (ctx.spec?.teardown?.accounts === "disable" ? disableAccount(ctx, entry) : 0),
			};
		});
	},
};
