import { ensureDomain, removeDomain } from "./domain";
import { declaredResources } from "./resources/registry";
import type { RunState } from "./resources/resource";
import type { Context, Role } from "./types";

// One run, one loop: reset the instance if asked, resolve/onboard the domain if any
// requested resource needs it, then apply - or, under --cleanup, remove - everything
// the manifest asks for. There is no per-capability command path: fresh, license, web
// push and the domain-scoped resources all go through here.
export async function run(ctx: Context, roles: Role[]): Promise<number> {
	const active = declaredResources(ctx, roles);
	if (active.length === 0) return 0;

	// A reset destroys the domain and admin everything else depends on, so it runs
	// first and the normal flow then resolves both from scratch.
	const reset = active.find((resource) => resource.section === "fresh");
	if (reset && !ctx.flags.status) {
		const failures = await reset.apply(ctx, roles, { mailboxIdsByRole: new Map() });
		if (failures > 0) return 1;
	}
	const rest = active.filter((resource) => resource !== reset);

	if (rest.some((resource) => resource.needsDomain)) {
		const early = await ensureDomain(ctx, roles);
		if (early !== null) return early;
	}

	const state: RunState = { mailboxIdsByRole: new Map() };

	if (ctx.flags.status) {
		let missing = 0;
		for (const resource of active) {
			console.log(`\n${resource.section}:`);
			missing += await resource.status(ctx, roles, state);
		}
		console.log(missing === 0 ? "\nEverything provisioned." : `\n${missing} item(s) missing — run without --status to apply.`);
		return missing === 0 ? 0 : 1;
	}

	console.log(`${ctx.flags.cleanup ? "Removing" : "Provisioning"} ${ctx.domainName || "instance"}:\n`);
	let failures = 0;
	if (ctx.flags.cleanup) {
		// Reverse of the apply order, so the license (which GATES account management)
		// is the last thing to go. Reverting it first 403s the account disable and
		// silently leaves accounts enabled.
		for (const resource of [...rest].reverse()) failures += await resource.remove(ctx, roles, state);
		if (ctx.flags.removeDomain && ctx.domain) failures += await removeDomain(ctx);
	} else {
		for (const resource of rest) failures += await resource.apply(ctx, roles, state);
	}

	if (ctx.domain && !ctx.flags.dryRun) console.log(`\nMailboxes: ${ctx.store.base}/mailboxes`);
	return failures === 0 ? 0 : 1;
}
