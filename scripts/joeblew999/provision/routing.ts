import { domainRoutingRuleSchema } from "@/lib/validators";
import { requireDomain } from "./context";
import type { Context, RoutingEntry } from "./types";
import type { Resource } from "./resource";
import type { RoutingRulePatch, RoutingRuleRow } from "./store-types";

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
	// keepCopy / store need a destination mailbox; the manifest names one by role.
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

// Does the stored row already match what the manifest wants?
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
		if (ctx.flags.dryRun) {
			console.log(`  → would update ${plan.label}`);
			return 0;
		}
		ctx.store.updateRoutingRule(plan.existing.id, plan.patch);
		console.log(`  ✓ updated ${plan.label}`);
		return 0;
	}
	if (ctx.flags.dryRun) {
		console.log(`  → would add ${plan.label}`);
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
	if (ctx.flags.dryRun) {
		console.log(`  → would remove routing ${pattern} → ${action}`);
		return 0;
	}
	ctx.store.deleteRoutingRule(requireDomain(ctx).id, pattern, action);
	console.log(`  ✓ removed routing ${pattern} → ${action}`);
	return 0;
}

async function statusRouting(ctx: Context, entries: RoutingEntry[], mailboxIdsByRole: Map<string, string>): Promise<number> {
	let missing = 0;
	for (const entry of entries) {
		const plan = planRouting(ctx, entry, mailboxIdsByRole);
		if (!plan.ok) {
			missing += 1;
			console.log(`  ✗ routing ${entry.pattern ?? "*"} — invalid: ${plan.error}`);
			continue;
		}
		const ok = plan.existing !== null && matches(plan.existing, plan.patch);
		if (!ok) missing += 1;
		console.log(`  ${ok ? "✓" : "✗"} ${plan.label}${plan.existing && !ok ? " — drifted" : ""}`);
	}
	return missing;
}

export const routingResource: Resource = {
	section: "routing",
	needsDomain: true,
	wanted: (ctx) => (ctx.project?.routing?.length ?? 0) > 0,
	status: (ctx, _roles, state) => statusRouting(ctx, ctx.project?.routing ?? [], state.mailboxIdsByRole),
	async apply(ctx, _roles, state) {
		let failures = 0;
		for (const entry of ctx.project?.routing ?? []) failures += ensureRouting(ctx, entry, state.mailboxIdsByRole);
		return failures;
	},
	async remove(ctx) {
		let failures = 0;
		for (const entry of ctx.project?.routing ?? []) failures += removeRouting(ctx, entry);
		return failures;
	},
};
