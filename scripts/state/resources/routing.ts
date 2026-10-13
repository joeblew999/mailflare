import { domainRoutingRuleSchema } from "@/lib/validators";
import { declaresMailbox, requireDomain, type Context } from "../context";
import { publishMailboxIds } from "./mailboxes";
import type { RoutingEntry } from "../spec";
import type { Item, Resource } from "./resource";
import type { RoutingRulePatch, RoutingRuleRow } from "../store/types";

type Wanted = { name: string; matchField: string; matchOperator: string; action: string; patch: RoutingRulePatch };

const PENDING = "pending";

/**
 * Check an entry against the app's own schema and reduce it to what a rule stores. Throws with
 * the schema's reason. `mailboxId` is null when the rule names no mailbox.
 */
function wanted(entry: RoutingEntry, domainId: string, mailboxId: string | null): Wanted {
	const pattern = entry.pattern.trim();
	const parsed = domainRoutingRuleSchema.safeParse({
		domainId,
		name: entry.name,
		enabled: true,
		matchField: "recipient",
		matchOperator: "contains",
		matchValue: entry.matchValue ?? pattern,
		action: entry.action ?? "forward",
		mailboxId,
		forwardTo: entry.forwardTo ?? null,
		keepCopy: Boolean(entry.keepCopy),
		rejectReason: entry.rejectReason ?? null,
		priority: entry.priority ?? 0,
	});
	if (!parsed.success) throw new Error(JSON.stringify(parsed.error.flatten().fieldErrors));
	const rule = parsed.data;
	return {
		name: rule.name ?? pattern,
		matchField: rule.matchField,
		matchOperator: rule.matchOperator,
		action: rule.action,
		patch: {
			matchValue: rule.matchValue,
			forwardTo: rule.forwardTo ?? null,
			keepCopy: rule.keepCopy ? 1 : 0,
			mailboxId,
			rejectReason: rule.rejectReason ?? null,
			priority: rule.priority,
			enabled: rule.enabled ? 1 : 0,
		},
	};
}

// Does the stored row already match what the document wants?
function matches(row: RoutingRuleRow, patch: RoutingRulePatch): boolean {
	return (
		String(row.match_value ?? "") === patch.matchValue &&
		(row.forward_to ?? null) === patch.forwardTo &&
		Number(row.keep_copy) === patch.keepCopy &&
		(row.mailbox_id ?? null) === patch.mailboxId &&
		(row.reject_reason ?? null) === patch.rejectReason &&
		Number(row.priority) === patch.priority &&
		Number(row.enabled) === patch.enabled
	);
}

/** The mailbox a rule delivers to: its id, or why there is not one yet. */
function destination(ctx: Context, entry: RoutingEntry): { id: string | null; pending: boolean; missing?: string } {
	if (!entry.mailbox) return { id: entry.mailboxId ?? null, pending: false };
	const role = entry.mailbox.trim().toLowerCase();
	const id = ctx.mailboxIds.get(role);
	if (id) return { id, pending: false };
	// Not there yet, but this document makes it: the rule follows the mailbox.
	if (declaresMailbox(ctx, role)) return { id: null, pending: true };
	return { id: null, pending: false, missing: `mailbox "${role}" is neither on the domain nor declared in this document` };
}

export const routingResource: Resource = {
	section: "routing",
	declared: (ctx) => ctx.spec.routing !== undefined,
	async items(ctx) {
		// A rule may name any mailbox on the domain, declared here or not - an account's own, say.
		if (ctx.domain) await publishMailboxIds(ctx);
		const rows = ctx.domain ? await ctx.store.routingRules(ctx.domain.id) : [];
		const claimed = new Set<string>();
		const remove = async (present: unknown) => ctx.store.deleteRoutingRule((present as RoutingRuleRow).id);
		const items: Item[] = [];
		for (const entry of ctx.spec.routing ?? []) {
			const pattern = entry.pattern.trim();
			const action = entry.action ?? "forward";
			const address = `routing.${pattern}.${action}`;
			const existing = rows.find((row) => row.pattern === pattern && row.action === action) ?? null;
			if (existing) claimed.add(existing.id);
			const target = destination(ctx, entry);

			let rule: Wanted | null = null;
			let problem = target.missing;
			if (!problem) {
				try {
					rule = wanted(entry, ctx.domain?.id ?? PENDING, target.pending ? PENDING : target.id);
				} catch (error) {
					problem = error instanceof Error ? error.message : String(error);
				}
			}
			// Written at the moment of the write, when a mailbox made earlier in the run has its id.
			const write = async () => {
				const now = destination(ctx, entry);
				if (now.missing || now.pending) throw new Error(now.missing ?? `mailbox "${entry.mailbox}" was not created, so the rule has nowhere to deliver`);
				const domain = requireDomain(ctx);
				const fresh = wanted(entry, domain.id, now.id);
				if (existing) await ctx.store.updateRoutingRule(existing.id, fresh.patch);
				else await ctx.store.insertRoutingRule({ userId: (await ctx.store.admin()).id, domainId: domain.id, name: fresh.name, pattern, matchField: fresh.matchField, matchOperator: fresh.matchOperator, action: fresh.action, ...fresh.patch });
			};
			items.push({
				address,
				wants: `${action}${entry.forwardTo ? ` to ${entry.forwardTo}` : ""}${entry.mailbox ? ` (mailbox ${entry.mailbox})` : ""}`,
				problem,
				// Even a rule the document gets wrong must stay removable, or it leaves litter behind.
				actual: async () => existing,
				satisfied: (actual) => !!actual && !!rule && !target.pending && matches(actual as RoutingRuleRow, rule.patch),
				create: write,
				update: write,
				remove,
			});
		}
		// Every other domain rule is one the document does not have.
		for (const row of rows.filter((entry) => !claimed.has(entry.id))) {
			items.push({ address: `routing.${row.pattern}.${row.action}`, undeclared: true, actual: async () => row, remove });
		}
		return items;
	},
};
