import { ensureDomain, removeDomain } from "./domain";
import { wantedResources } from "./resources";
import type { RunState } from "./resource";
import type { Context, Role } from "./types";

// One run, one loop: resolve/onboard the domain if any requested resource needs it,
// then apply - or, under --cleanup, remove - everything the manifest asks for. There
// is no per-capability command path: license, web push and the domain-scoped
// resources all go through here.
export async function run(ctx: Context, roles: Role[]): Promise<number> {
	const active = wantedResources(ctx, roles);
	if (active.length === 0) return 0;

	if (active.some((resource) => resource.needsDomain)) {
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
		for (const resource of active) failures += await resource.remove(ctx, roles, state);
		if (ctx.flags.removeDomain && ctx.domain) failures += await removeDomain(ctx);
	} else {
		for (const resource of active) failures += await resource.apply(ctx, roles, state);
	}

	if (ctx.domain && !ctx.flags.dryRun) console.log(`\nMailboxes: ${ctx.store.base}/mailboxes`);
	return failures === 0 ? 0 : 1;
}
