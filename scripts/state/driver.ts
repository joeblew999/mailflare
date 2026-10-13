import { ensureDomain } from "./resources/domain";
import { declaredResources } from "./resources/registry";
import type { Context } from "./context";
import type { Role } from "./spec";
import type { RunState } from "./resources/resource";

// The reconcile loop. There is no per-capability command path: reset, domain,
// license, accounts, mailboxes, routing, MCP keys and push all go through here, in
// the order registry.ts sets out, against the document the JSON declared.
export async function run(ctx: Context, roles: Role[]): Promise<number> {
	const active = declaredResources(ctx, roles);
	if (active.length === 0) return 0;

	const state: RunState = { mailboxIdsByRole: new Map() };

	if (ctx.flags.status) {
		let missing = 0;
		for (const resource of active) {
			console.log(`\n${resource.section}:`);
			missing += await resource.status(ctx, roles, state);
		}
		console.log(missing === 0 ? "\nEverything reconciled." : `\n${missing} item(s) missing — run without --status to apply.`);
		return missing === 0 ? 0 : 1;
	}

	// The two prerequisites are handled explicitly, because they bracket everything
	// else and do not follow the reversible order:
	//   fresh  resets the instance, so it must precede all of it;
	//   domain resolves the domain everything scoped acts on. On cleanup it is only
	//          RESOLVED here - its removal must come last, since it cascades the rest.
	const reset = active.find((resource) => resource.section === "fresh");
	const domain = active.find((resource) => resource.section === "domain");
	const rest = active.filter((resource) => resource !== reset && resource !== domain);

	if (reset) {
		const code = await (ctx.flags.cleanup ? reset.remove : reset.apply)(ctx, roles, state);
		if (code > 0) return 1;
	}

	console.log(`${ctx.flags.cleanup ? "Removing" : "Applying"} ${ctx.domainName || "instance"}:\n`);
	let failures = 0;
	if (ctx.flags.cleanup) {
		await ensureDomain(ctx, roles);
		for (const resource of [...rest].reverse()) failures += await resource.remove(ctx, roles, state);
		if (domain) failures += await domain.remove(ctx, roles, state);
	} else {
		if (domain && (await domain.apply(ctx, roles, state)) > 0) return 1;
		for (const resource of rest) failures += await resource.apply(ctx, roles, state);
	}

	if (ctx.domain && !ctx.flags.dryRun) console.log(`\nMailboxes: ${ctx.store.base}/mailboxes`);
	return failures === 0 ? 0 : 1;
}
