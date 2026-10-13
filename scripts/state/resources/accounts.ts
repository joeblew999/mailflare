import { validateBody } from "../app";
import { requireDomain, usernameOf } from "../context";
import { newPassword } from "../vault";
import { credential } from "../wrangler";
import { digestOf } from "../subject-scope";
import { erasePerson, erasedDigests } from "./erased";
import { mailboxesForDomain } from "./mailboxes";
import { expectOk, type Item, type Resource } from "./resource";
import type { AccountEntry, ApiAccount } from "../spec";

/** The password to set: the declared one, else the one on record, else a new one. */
const passwordFor = (entry: AccountEntry, onRecord: string | null): string =>
	entry.password ?? (entry.passwordEnv ? credential(entry.passwordEnv) : null) ?? onRecord ?? newPassword();

// updateManagedAccountSchema requires the whole object, so every update carries all of it.
const updateBody = (account: ApiAccount, values: { name: string; role: string; disabled: boolean; password?: string }) =>
	validateBody("accountUpdate", { ...values, canManageMailboxes: Boolean(account.canManageMailboxes) });

export const accountsResource: Resource = {
	section: "accounts",
	declared: (ctx) => ctx.spec.accounts !== undefined,
	async items(ctx) {
		const accounts = await ctx.store.listAccounts();
		const boxes = await mailboxesForDomain(ctx);
		const declared: Item[] = (ctx.spec.accounts ?? []).map((entry) => {
			const username = usernameOf(entry);
			const email = `${username}@${ctx.domainName}`;
			const account = accounts.find((row) => String(row.email).toLowerCase() === email) ?? null;
			const role = entry.role ?? "user";
			// The app names a new account after its username, so a declared name is a follow-up.
			const name = entry.name?.trim() ?? null;
			// A stored hash cannot be read back, so a password is only known when this system set it.
			// Rotating sets a fresh one, which signs the person out everywhere.
			const rotate = !!account && ctx.flags.rotatePasswords && !account.isPrimaryAdmin;
			const differs = account
				? [
					...(rotate ? ["set a new password"] : []),
					...(account.disabled ? ["re-enable"] : []),
					// The primary admin is always an admin, whatever a document says.
					...(account.role !== role && !account.isPrimaryAdmin ? [`role ${account.role} → ${role}`] : []),
					...(name !== null && account.name !== name ? [`name "${account.name}" → "${name}"`] : []),
				]
				: [];
			const lacksMailbox = !!account && !boxes.has(username);
			const leaving = ctx.spec.teardown?.accounts === "disable" || ctx.spec.teardown?.accounts === "erase" ? ctx.spec.teardown.accounts : null;

			const record = (password: string) => {
				ctx.vault.at(ctx.store.base);
				ctx.vault.recordLogin(email, { name: name ?? username, role, password });
			};
			const patch = async (target: ApiAccount, password?: string) => {
				expectOk(await ctx.store.updateAccount(target.id, updateBody(target, { name: name ?? (target.name?.trim() || username), role: target.isPrimaryAdmin ? "admin" : role, disabled: false, ...(password ? { password } : {}) })));
				if (password) record(password);
			};
			// An account's own mailbox goes when its domain is removed; the account itself stays.
			const restoreMailbox = async (target: ApiAccount) => {
				expectOk(await ctx.store.createMailbox(validateBody("mailbox", { domainId: requireDomain(ctx).id, localPart: username, displayName: name ?? username, type: "personal" as const, ownerUserId: target.id })));
			};

			return {
				address: `account.${username}`,
				wants: account ? [...differs, ...(lacksMailbox ? ["restore its mailbox"] : [])].join(", ") : `${role}${name ? ` "${name}"` : ""}`,
				keep: !leaving ? 'teardown.accounts is not "disable" or "erase"' : account?.isPrimaryAdmin ? "the primary admin is never disabled" : undefined,
				actual: async () => account,
				satisfied: (actual) => !!actual && differs.length === 0 && !lacksMailbox,
				create: async () => {
					const password = passwordFor(entry, ctx.vault.password(email));
					const res = expectOk(await ctx.store.createAccount(validateBody("account", { username, domainId: requireDomain(ctx).id, password, role, useAllDomains: false, aliases: [] })));
					record(password);
					const created = res.json?.account as ApiAccount | undefined;
					if (name !== null && name !== username && created) await patch(created);
					return `login written to ${ctx.vault.where}`;
				},
				update: async (actual) => {
					// A rotation never reuses the password on record: that is the one being retired.
					if (differs.length > 0) await patch(actual as ApiAccount, rotate ? passwordFor(entry, null) : undefined);
					if (lacksMailbox) await restoreMailbox(actual as ApiAccount);
					return [...differs, ...(lacksMailbox ? ["mailbox restored"] : [])].join(", ");
				},
				// Tearing an account down disables it, and keeps what is theirs - unless the tenant is
				// leaving for good, when each of its people is erased as `erased` would erase them.
				removable: async () => (account && (leaving === "erase" || !account.disabled) ? account : null),
				remove: async (present) => {
					const target = present as ApiAccount;
					if (leaving === "erase") return erasePerson(ctx, await ctx.store.subjectReport(email));
					expectOk(await ctx.store.updateAccount(target.id, updateBody(target, { name: target.name?.trim() || username, role: target.role, disabled: true })));
					return "disabled";
				},
			};
		});

		// Anyone else with a login on this domain is not in the document. Leaving a document is
		// not being erased: they are disabled, and everything of theirs is kept - never the admin
		// whose key this is, and never the primary one. Those declared erased are that section's.
		const admin = await ctx.store.admin();
		const named = new Set((ctx.spec.accounts ?? []).map((entry) => `${usernameOf(entry)}@${ctx.domainName}`));
		const erased = erasedDigests(ctx);
		const others = accounts.filter((account) => {
			const email = String(account.email).toLowerCase();
			return email.endsWith(`@${ctx.domainName}`) && !named.has(email) && !erased.has(digestOf(email)) && !account.disabled && !account.isPrimaryAdmin && account.id !== admin.id;
		});
		return [...declared, ...others.map((account): Item => ({
			address: `account.${String(account.email).split("@")[0].toLowerCase()}`,
			undeclared: true,
			wants: "it is disabled, and its mail and files are kept — `erased` is what deletes a person",
			actual: async () => account,
			remove: async () => {
				expectOk(await ctx.store.updateAccount(account.id, updateBody(account, { name: account.name?.trim() || String(account.email).split("@")[0], role: account.role, disabled: true })));
				return "disabled";
			},
		}))];
	},
};
