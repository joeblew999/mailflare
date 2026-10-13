import { declaredResources } from "./resources/registry";
import { resolveDomain } from "./resources/domain";
import { publishMailboxIds } from "./resources/mailboxes";
import { hasWork, type Change, type ChangeAction, type Item } from "./resources/resource";
import type { Context } from "./context";
import type { Role } from "./spec";

const SYMBOL: Record<ChangeAction, string> = { create: "+", update: "~", unchanged: "·", problem: "!" };

export function formatPlan(changes: Change[], heading = "Plan"): string {
	const count = (action: ChangeAction) => changes.filter((change) => change.action === action).length;
	const width = Math.max(0, ...changes.map((change) => change.address.length));
	const lines = changes.map((change) => {
		const detail = change.action === "unchanged" ? "" : `  ${change.detail ?? change.action}`;
		return `  ${SYMBOL[change.action]} ${change.address.padEnd(width)}${detail}`.trimEnd();
	});
	if (changes.length === 0) return "No changes — nothing declared.";
	const problems = count("problem");
	return `${heading}: ${count("create")} to create, ${count("update")} to update${problems > 0 ? `, ${problems} PROBLEM(S)` : ""}\n\n${lines.join("\n")}`;
}

/** Nothing, a create, or an update: one comparison, used by every verb. */
async function evaluate(item: Item): Promise<{ change: Change; item: Item; actual?: unknown }> {
	if (item.problem) return { change: { address: item.address, action: "problem", detail: item.problem }, item };
	const actual = await item.actual();
	if (actual === null || actual === undefined) return { change: { address: item.address, action: "create", detail: item.wants }, item };
	const satisfied = item.satisfied ? item.satisfied(actual) : true;
	if (satisfied) return { change: { address: item.address, action: "unchanged" }, item, actual };
	return { change: { address: item.address, action: "update", detail: item.wants }, item, actual };
}

// The reconcile loop. No per-capability command path: the registry's order is the only order,
// and every verb walks it.
export async function run(ctx: Context, roles: Role[]): Promise<number> {
	const active = declaredResources(ctx, roles);
	if (active.length === 0) return 0;
	const state = { mailboxIdsByRole: new Map<string, string>() };

	if (ctx.flags.status) {
		const changes: Change[] = [];
		for (const resource of active) for (const item of await resource.items(ctx, roles, state)) changes.push((await evaluate(item)).change);
		console.log(formatPlan(changes, `Plan for ${ctx.domainName || "instance"}`));
		if (!hasWork(changes)) console.log("\nNo changes. Everything reconciled.");
		return hasWork(changes) ? 1 : 0;
	}

	// Destroy walks the same list in reverse, so the domain - which cascades everything - goes
	// last. It is resolved first, because the rules and keys need it while they are removed.
	const order = ctx.flags.cleanup ? [...active].reverse() : active;
	if (ctx.flags.cleanup) {
		await resolveDomain(ctx);
		await publishMailboxIds(ctx, state);
	}

	console.log(`${ctx.flags.cleanup ? "Destroying" : "Applying"} ${ctx.domainName || "instance"}:\n`);
	let failures = 0;
	for (const resource of order) {
		for (const item of await resource.items(ctx, roles, state)) {
			if (ctx.flags.cleanup) {
				failures += await item.remove();
				continue;
			}
			const { change, actual } = await evaluate(item);
			if (change.action === "problem") {
				console.log(`  ! ${change.address}: ${change.detail}`);
				failures += 1;
				continue;
			}
			if (change.action === "unchanged") continue;
			failures += change.action === "create" ? await item.create() : item.update ? await item.update(actual) : 0;
			// A prerequisite that cannot do its job stops the run rather than letting everything
			// after it fail against a world that was never set up.
			if (failures > 0 && resource.prerequisite) return 1;
		}
	}

	if (ctx.domain) console.log(`\nMailboxes: ${ctx.store.base}/mailboxes`);
	return failures === 0 ? 0 : 1;
}
