import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/ids";
import type { Resource } from "./resource";

// Reset the instance to nothing and give it a primary admin, so a brand-new server
// needs no manual clicking before this system can drive it. It targets whatever
// --db/--local/--remote points at: the same command readies a local dev database and
// a deployed Cloudflare D1.
//
// The first admin normally comes from POST /api/auth/register, which also wants
// Turnstile and a domain - unusable as a bootstrap. This writes the row directly.
export const freshResource: Resource = {
	section: "fresh",
	needsDomain: false,
	prerequisite: true,
	// The reset VERB triggers it; the document only configures it. So a plain apply never wipes.
	declared: (ctx) => ctx.flags.fresh,
	async items(ctx) {
		const entry = ctx.spec?.fresh ?? {};
		const email = (entry.admin?.email ?? "admin@localhost").trim().toLowerCase();
		const password = entry.admin?.password ?? newId();
		const domains = ctx.store.domainCount();
		return [{
			address: "instance",
			wants: `wipes ${domains} domain(s) and every table, then makes ${email}`,
			// A reset is always work: there is no state in which it is already done.
			actual: async () => null,
			create: async () => {
				if (domains > 0) {
					console.log(`  ⚠ ${domains} domain(s) exist — wiping the database does NOT remove their Cloudflare MX/Email Routing/DNS, which will be left orphaned`);
				}
				ctx.store.applyMigrations();
				if (!ctx.store.schemaPresent()) {
					console.log("  ✗ the schema is still missing after applying migrations");
					return 1;
				}
				ctx.store.wipeData();
				ctx.store.insertAdmin({ id: newId("usr"), email, name: email.split("@")[0], passwordHash: hashPassword(password) });
				console.log(`  ✓ fresh instance — every table emptied, primary admin ${email} created`);
				console.log(`     password: ${entry.admin?.password ? "as given" : `${password}  (generated — shown once)`}`);
				return 0;
			},
			remove: async () => {
				console.log("  · fresh — nothing to undo; a wiped instance cannot be un-reset");
				return 0;
			},
		}];
	},
};
