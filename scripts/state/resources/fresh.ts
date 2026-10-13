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
	declared: (ctx) => ctx.flags.fresh || Boolean(ctx.spec?.fresh),
	async plan(ctx) {
		const domains = ctx.store.domainCount();
		const admin = ctx.store.schemaPresent() ? ctx.store.firstAdminEmail() : null;
		return [{ address: "instance", action: "update", detail: `wipes ${domains} domain(s) and every table, then makes ${admin ?? "a new admin"}` }];
	},
	async apply(ctx) {
		const entry = typeof ctx.spec?.fresh === "object" ? ctx.spec.fresh : {};
		const email = (ctx.flags.adminEmail ?? entry.admin?.email ?? "admin@localhost").trim().toLowerCase();
		const password = ctx.flags.adminPassword ?? entry.admin?.password ?? newId();
		const generated = !ctx.flags.adminPassword && !entry.admin?.password;

		// A reset touches the database only. Saying so is the difference between a reset and a
		// surprise: the domains' Cloudflare MX, Email Routing and DNS survive and are orphaned.
		// Reported in the preview as well as the real run - the preview is where you look.
		const domains = ctx.store.domainCount();
		if (domains > 0) {
			console.log(`  ⚠ ${domains} domain(s) exist — wiping the database does NOT remove their Cloudflare MX/Email Routing/DNS, which will be left orphaned`);
		}

		if (ctx.flags.dryRun) {
			console.log(`  → would wipe ${ctx.flags.local ? "the local" : "the remote"} database to empty and create admin ${email}`);
			return 0;
		}

		ctx.store.applyMigrations();
		if (!ctx.store.schemaPresent()) {
			console.log("  ✗ the schema is still missing after applying migrations");
			return 1;
		}
		ctx.store.wipeData();
		ctx.store.insertAdmin({ id: newId("usr"), email, name: email.split("@")[0], passwordHash: hashPassword(password) });
		console.log(`  ✓ fresh instance — every table emptied, primary admin ${email} created`);
		console.log(`     password: ${generated ? `${password}  (generated — shown once)` : "as given"}`);
		return 0;
	},
	async remove() {
		console.log("  · fresh — nothing to undo; a wiped instance cannot be un-reset");
		return 0;
	},
};
