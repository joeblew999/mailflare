import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/ids";
import { newPassword } from "../vault";
import type { Resource } from "./resource";

// Give an instance its primary admin. `reset` wipes first, so a wrecked server and a brand-new
// one are brought up the same way; an EMPTY instance gets its admin on a plain apply, because
// until it has one nothing else can be done to it.
export const freshResource: Resource = {
	section: "fresh",
	prerequisite: true,
	// The reset VERB triggers the wipe; the document only configures it. A plain apply never wipes.
	declared: (ctx) => ctx.flags.fresh || ctx.bootstrap,
	async items(ctx) {
		const entry = ctx.spec.fresh ?? {};
		const email = (entry.admin?.email ?? "admin@localhost").trim().toLowerCase();
		const wipe = ctx.flags.fresh;
		// A brand-new database has no tables to count yet.
		const domains = wipe && (await ctx.store.schemaPresent()) ? await ctx.store.domainCount() : 0;
		return [{
			address: "instance",
			wants: wipe
				? `wipe every table${domains > 0 ? ` (${domains} domain(s) — their Cloudflare DNS and Email Routing are left in place)` : ""}, then make ${email} the primary admin`
				: `the instance is empty: make ${email} its primary admin`,
			// Always work: a reset is never already done, and an empty instance has no admin.
			actual: async () => null,
			create: async () => {
				await ctx.store.applyMigrations();
				if (!(await ctx.store.schemaPresent())) throw new Error("the schema is still missing after applying the migrations");
				if (wipe) {
					await ctx.store.wipeData();
					ctx.vault.clear();
				} else if ((await ctx.store.userCount()) !== 0) throw new Error("the instance is not empty after all — refusing to add a second primary admin");
				const password = entry.admin?.password ?? ctx.vault.password(email) ?? newPassword();
				await ctx.store.insertAdmin({ id: newId("usr"), email, name: email.split("@")[0], passwordHash: hashPassword(password) });
				ctx.vault.recordLogin(email, { name: email.split("@")[0], role: "primary admin", password });
				return `${wipe ? "wiped; " : ""}primary admin ${email} — login written to ${ctx.vault.where}`;
			},
			removable: async () => null,
			remove: async () => undefined,
		}];
	},
};
