import { domainRoutingRuleSchema } from "@/lib/validators";
import { requireDomain } from "../context";
import type { Context } from "../context";
import type { RoutingEntry } from "../spec";
import type { Item, Resource } from "./resource";
import type { RoutingRulePatch, RoutingRuleRow } from "../store/types";

type RoutingPlan =
	| { ok: false; error: string }
	| {
			ok: true;
			pattern: string;
			name: string;
			matchField: string;
			matchOperator: string;
			action: string;
			label: string;
			patch: RoutingRulePatch;
			existing: RoutingRuleRow | null;
	  };

// Validate an entry with the app's own domainRoutingRuleSchema and reduce it to the
// values that get stored. apply, status and remove all agree on "the desired rule"
// because they all go through here.
function planRouting(ctx: Context, entry: RoutingEntry, mailboxIdsByRole: Map<string, string>): RoutingPlan {
	const pattern = String(entry.pattern ?? "*").trim();
	// keepCopy / store need a destination mailbox; the document names one by role.
	let mailboxId: string | null = entry.mailboxId ?? null;
	if (entry.mailbox) {
		mailboxId = mailboxIdsByRole.get(String(entry.mailbox).toLowerCase()) ?? null;
		if (!mailboxId) console.log(`  ⚠ routing "${pattern}": mailbox role "${entry.mailbox}" not found`);
	}
	const parsed = domainRoutingRuleSchema.safeParse({
		domainId: requireDomain(ctx).id,
		name: entry.name,
		enabled: true,
		matchField: "recipient",
		matchOperator: "contains",
		matchValue: String(entry.matchValue ?? pattern),
		action: entry.action ?? "forward",
		mailboxId,
		forwardTo: entry.forwardTo ?? null,
		keepCopy: Boolean(entry.keepCopy),
		rejectReason: entry.rejectReason ?? null,
		priority: Number(entry.priority) || 0,
	});
	if (!parsed.success) return { ok: false, error: JSON.stringify(parsed.error.flatten().fieldErrors) };

	const rule = parsed.data;
	return {
		ok: true,
		pattern,
		name: rule.name ?? pattern,
		matchField: rule.matchField,
		matchOperator: rule.matchOperator,
		action: rule.action,
		label: `routing ${pattern} → ${rule.action}${rule.forwardTo ? ` ${rule.forwardTo}` : ""}`,
		patch: {
			matchValue: rule.matchValue,
			forwardTo: rule.forwardTo ?? null,
			keepCopy: rule.keepCopy ? 1 : 0,
			mailboxId,
			rejectReason: rule.rejectReason ?? null,
			priority: rule.priority,
			enabled: rule.enabled ? 1 : 0,
		},
		existing: ctx.store.routingRule(requireDomain(ctx).id, pattern, rule.action),
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

// Provision (or reconcile) one domain-scope routing rule: reject, forward, or store.
export function ensureRouting(ctx: Context, entry: RoutingEntry, mailboxIdsByRole: Map<string, string>): number {
	const plan = planRouting(ctx, entry, mailboxIdsByRole);
	if (!plan.ok) {
		console.log(`  ✗ routing ${entry.pattern ?? "*"}: ${plan.error}`);
		return 1;
	}
	if (plan.existing) {
		if (matches(plan.existing, plan.patch)) {
			console.log(`  · ${plan.label} — already exists`);
			return 0;
		}
		ctx.store.updateRoutingRule(plan.existing.id, plan.patch);
		console.log(`  ✓ updated ${plan.label}`);
		return 0;
	}
	ctx.store.insertRoutingRule({
		userId: ctx.store.admin.id,
		domainId: requireDomain(ctx).id,
		name: plan.name,
		pattern: plan.pattern,
		matchField: plan.matchField,
		matchOperator: plan.matchOperator,
		action: plan.action,
		...plan.patch,
	});
	console.log(`  ✓ added ${plan.label}`);
	return 0;
}

export function removeRouting(ctx: Context, entry: RoutingEntry): number {
	const pattern = String(entry.pattern ?? "*").trim();
	const action = String(entry.action ?? "forward").trim();
	// Rules are domain-scoped and cascade with the domain, so a missing domain means
	// there is nothing left to remove - not an error.
	if (!ctx.domain) return 0;
	ctx.store.deleteRoutingRule(requireDomain(ctx).id, pattern, action);
	console.log(`  ✓ removed routing ${pattern} → ${action}`);
	return 0;
}

export const routingResource: Resource = {
	section: "routing",
	needsDomain: true,
	declared: (ctx) => (ctx.spec?.routing?.length ?? 0) > 0,
	async items(ctx, _roles, state) {
		const items: Item[] = [];
		for (const entry of ctx.spec?.routing ?? []) {
			const pattern = String(entry.pattern ?? "*").trim();
			const planned = planRouting(ctx, entry, state.mailboxIdsByRole);
			if (!planned.ok) {
				// It cannot be created, but if a rule with this pattern and action exists it must still be
				// removable - otherwise an invalid document leaves litter behind.
				items.push({ address: `routing.${pattern}`, problem: planned.error, actual: async () => null, create: async () => 1, remove: async () => removeRouting(ctx, entry) });
				continue;
			}
			items.push({
				address: `routing.${pattern}`,
				wants: planned.label,
				actual: async () => planned.existing,
				satisfied: (actual: unknown) => !!actual && matches(actual as RoutingRuleRow, planned.patch),
				// ensureRouting inserts or updates, so it is both the create and the update.
				create: async () => ensureRouting(ctx, entry, state.mailboxIdsByRole),
				update: async () => ensureRouting(ctx, entry, state.mailboxIdsByRole),
				remove: async () => removeRouting(ctx, entry),
			});
		}
		return items;
	},
};
