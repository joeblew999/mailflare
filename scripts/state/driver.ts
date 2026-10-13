import { RESOURCES } from "./resources/registry";
import { resolveDomain } from "./resources/domain";
import { freshResource } from "./resources/fresh";
import { hasWork, type Change, type ChangeAction, type Item, type Resource } from "./resources/resource";
import { message } from "./wrangler";
import type { Context } from "./context";

const SYMBOL: Record<ChangeAction, string> = { create: "+", update: "~", remove: "-", unchanged: "·", keep: "·", problem: "!", unmanaged: "?" };

export function formatPlan(changes: Change[], heading = "Plan", kind: "plan" | "destroy" = "plan"): string {
	const count = (action: ChangeAction) => changes.filter((change) => change.action === action).length;
	const width = Math.max(0, ...changes.map((change) => change.address.length));
	const lines = changes.map((change) => `  ${SYMBOL[change.action]} ${change.address.padEnd(width)}${change.detail ? `  ${change.detail}` : ""}`.trimEnd());
	const problems = count("problem");
	const totals = kind === "destroy" ? `${count("remove")} to remove` : `${count("create")} to create, ${count("update")} to update${count("remove") > 0 ? `, ${count("remove")} to remove` : ""}`;
	return `${heading}: ${totals}${problems > 0 ? `, ${problems} PROBLEM(S)` : ""}${lines.length > 0 ? `\n\n${lines.join("\n")}` : ""}`;
}

/** Nothing, a create, an update, or a removal: one comparison, used by plan and apply alike. */
async function evaluate(item: Item): Promise<{ change: Change; actual?: unknown }> {
	if (item.unmanaged) return { change: { address: item.address, action: "unmanaged", detail: item.unmanaged } };
	if (item.problem) return { change: { address: item.address, action: "problem", detail: item.problem } };
	const actual = await item.actual();
	const absent = actual === null || actual === undefined;
	// On the server, in a section the document writes, and not in it: the document wins.
	if (item.undeclared) return { change: { address: item.address, action: absent ? "unchanged" : "remove", detail: absent ? undefined : "not in the document" }, actual };
	// `satisfied` is the whole truth when an item has one: some things are wanted absent.
	if (item.satisfied ? item.satisfied(actual) : !absent) return { change: { address: item.address, action: "unchanged" }, actual };
	return { change: { address: item.address, action: absent ? "create" : "update", detail: item.wants }, actual };
}

/** What the document declares, in the registry's order - the only order there is. */
const declared = (ctx: Context): Resource[] => RESOURCES.filter((resource) => resource.declared(ctx));

const title = (ctx: Context) => ctx.domainName || "the instance";

async function plan(ctx: Context, active: Resource[]): Promise<number> {
	const changes: Change[] = [];
	if (ctx.flags.fresh || ctx.bootstrap) {
		// A reset wipes first, and an empty instance has no admin to ask: either way, nothing
		// read from the instance now says what it will hold.
		for (const item of await freshResource.items(ctx)) changes.push((await evaluate(item)).change);
		if (active.some((resource) => resource !== freshResource)) changes.push({ address: "everything declared", action: "create", detail: "applied from nothing, once the instance has its admin" });
	} else {
		for (const resource of active) for (const item of await resource.items(ctx)) changes.push((await evaluate(item)).change);
	}
	ctx.changes = changes;
	ctx.log(formatPlan(changes, `Plan for ${title(ctx)}`));
	if (!hasWork(changes)) ctx.log("\nNo changes. Everything reconciled.");
	ctx.failed = changes.some((change) => change.action === "problem");
	return hasWork(changes) ? 1 : 0;
}

async function apply(ctx: Context, active: Resource[]): Promise<number> {
	ctx.log(`Applying ${title(ctx)}:\n`);
	let failures = 0;
	let changed = 0;
	let unapproved = 0;
	for (const resource of active) {
		for (const item of await resource.items(ctx)) {
			try {
				const { change, actual } = await evaluate(item);
				if (change.action === "problem") {
					ctx.changes.push(change);
					ctx.log(`  ! ${item.address}  ${change.detail}`);
					failures += 1;
				} else if (change.action === "unmanaged") {
					ctx.log(`  ? ${item.address}  ${change.detail}`);
				} else if (change.action === "remove") {
					// Removing is destroying, so it waits for the same approval a destroy does.
					if (ctx.flags.confirmDestroy) {
						const note = await item.remove(actual);
						ctx.changes.push(change);
						ctx.log(`  - ${item.address}  ${note ? `${note} — ` : ""}not in the document`);
						changed += 1;
					} else {
						ctx.changes.push({ ...change, action: "keep", detail: "left in place: removing it was not approved" });
						ctx.log(`  - ${item.address}  not in the document — left in place (--confirm-destroy removes it)`);
						unapproved += 1;
					}
				} else if (change.action !== "unchanged") {
					if (change.action === "update" ? !item.update : !item.create) throw new Error("exists but differs, and cannot be changed in place");
					const note = change.action === "create" ? await item.create!() : await item.update!(actual);
					ctx.changes.push(change);
					ctx.log(`  ${SYMBOL[change.action]} ${item.address}${note ? `  ${note}` : ""}`);
					changed += 1;
				}
			} catch (error) {
				ctx.changes.push({ address: item.address, action: "problem", detail: message(error) });
				ctx.log(`  ✗ ${item.address}  ${message(error)}`);
				failures += 1;
			}
			// A prerequisite that cannot do its job stops the document, rather than letting
			// everything after it fail against a world that was never set up.
			ctx.failed = failures > 0;
			if (failures > 0 && resource.prerequisite) {
				ctx.log(`\n  stopped: nothing else in this document can work without ${resource.section}`);
				return 1;
			}
		}
	}
	if (changed === 0 && failures === 0 && unapproved === 0) ctx.log("  · nothing to change");
	if (ctx.domain && ctx.store.base) ctx.log(`\nMailboxes: ${ctx.store.base}/mailboxes`);
	ctx.unapproved = unapproved > 0 && failures === 0;
	return failures === 0 && unapproved === 0 ? 0 : 1;
}

// Destroy walks the same list in reverse, so the domain - which cascades everything - goes after
// the things on it, and the licence that gates account management goes after the accounts.
async function destroy(ctx: Context, active: Resource[]): Promise<number> {
	const dry = ctx.flags.status;
	// The domain resource is reached last, and everything before it needs the domain resolved.
	if (ctx.domainName) await resolveDomain(ctx);

	const changes: Change[] = [];
	let failures = 0;
	if (!dry) ctx.log(`Destroying ${title(ctx)}:\n`);
	for (const resource of [...active].reverse()) {
		for (const item of [...(await resource.items(ctx))].reverse()) {
			if (item.unmanaged) continue;
			try {
				const present = await (item.removable ?? item.actual)();
				if (present === null || present === undefined) continue;
				if (item.keep) {
					changes.push({ address: item.address, action: "keep", detail: `kept — ${item.keep}` });
					if (!dry) ctx.log(`  · ${item.address}  kept — ${item.keep}`);
					continue;
				}
				changes.push({ address: item.address, action: "remove" });
				if (dry) continue;
				const note = await item.remove(present);
				ctx.log(`  - ${item.address}${note ? `  ${note}` : ""}`);
			} catch (error) {
				ctx.log(`  ✗ ${item.address}  ${message(error)}`);
				failures += 1;
			}
		}
	}
	ctx.changes = changes;
	ctx.failed = failures > 0;
	if (dry) {
		ctx.log(formatPlan(changes, `Destroy plan for ${title(ctx)}`, "destroy"));
		return hasWork(changes) || failures > 0 ? 1 : 0;
	}
	if (changes.length === 0 && failures === 0) ctx.log("  · nothing to remove");
	return failures === 0 ? 0 : 1;
}

/** Reconcile one document. Returns 0 when the instance is as the verb wants it, else 1. */
export async function run(ctx: Context): Promise<number> {
	const active = declared(ctx);
	if (active.length === 0) return 0;
	if (ctx.flags.cleanup) return destroy(ctx, active);
	return ctx.flags.status ? plan(ctx, active) : apply(ctx, active);
}

export { declared as declaredResources };
