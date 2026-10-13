import { ensureDomain } from "./resources/domain";
import { declaredResources } from "./resources/registry";
import { formatPlan, hasWork, type Change } from "./plan";
import type { Context } from "./context";
import type { Role } from "./spec";
import type { RunState } from "./resources/resource";

// The reconcile loop. There is no per-capability command path: reset, domain, license,
// accounts, mailboxes, routing, MCP keys and push all go through here, in the order
// registry.ts sets out, against the documents the folder declared.
export async function run(ctx: Context, roles: Role[]): Promise<number> {
	const active = declaredResources(ctx, roles);
	if (active.length === 0) return 0;

	const state: RunState = { mailboxIdsByRole: new Map() };

	if (ctx.flags.status) {
		// One walk, one diff. The plan and apply share every resource, so the plan cannot
		// promise something apply would not do.
		const changes: Change[] = [];
		for (const resource of active) changes.push(...(await resource.plan(ctx, roles, state)));
		console.log(formatPlan(changes, `Plan for ${ctx.domainName || "instance"}`));
		if (!hasWork(changes)) console.log("\nNo changes. Everything reconciled.");
		return hasWork(changes) ? 1 : 0;
	}

	// The two prerequisites bracket everything else and do not follow the reversible order:
	//   fresh  resets the instance, so it must precede all of it;
	//   domain resolves the domain everything scoped acts on. On destroy it is only RESOLVED
	//          here - its removal must come last, since it cascades the rest.
	const reset = active.find((resource) => resource.section === "fresh");
	const domain = active.find((resource) => resource.section === "domain");
	const rest = active.filter((resource) => resource !== reset && resource !== domain);

	if (reset) {
		const code = await (ctx.flags.cleanup ? reset.remove : reset.apply)(ctx, roles, state);
		if (code > 0) return 1;
	}

	console.log(`${ctx.flags.cleanup ? "Destroying" : "Applying"} ${ctx.domainName || "instance"}:\n`);
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
