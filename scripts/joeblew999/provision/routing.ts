import { domainRoutingRuleSchema } from "@/lib/validators";
import { requireDomain } from "./context";
import type { Context, RoutingEntry } from "./types";
import type { RoutingRulePatch } from "./store-types";

// Provision domain-scope routing rules. These decide, during address resolution:
// reject, forward, or store (catch-all). Validated with the app's own
// domainRoutingRuleSchema so the shape and its forward/store rules cannot drift.
export function ensureRouting(ctx: Context, entry: RoutingEntry, mailboxIdsByRole: Map<string, string>): number {
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
	if (!parsed.success) {
		console.log(`  ✗ routing ${pattern}: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
		return 1;
	}

	const rule = parsed.data;
	const label = `routing ${pattern} → ${rule.action}${rule.forwardTo ? ` ${rule.forwardTo}` : ""}`;
	const desired: RoutingRulePatch = {
		matchValue: rule.matchValue,
		forwardTo: rule.forwardTo ?? null,
		keepCopy: rule.keepCopy ? 1 : 0,
		mailboxId,
		rejectReason: rule.rejectReason ?? null,
		priority: rule.priority,
		enabled: rule.enabled ? 1 : 0,
	};

	const existing = ctx.store.routingRule(requireDomain(ctx).id, pattern, rule.action);
	if (existing) {
		// Reconcile the stored row with the manifest rather than assuming it matches.
		const same =
			String(existing.match_value ?? "") === desired.matchValue &&
			(existing.forward_to ?? null) === desired.forwardTo &&
			Number(existing.keep_copy) === desired.keepCopy &&
			(existing.mailbox_id ?? null) === desired.mailboxId &&
			(existing.reject_reason ?? null) === desired.rejectReason &&
			Number(existing.priority) === desired.priority &&
			Number(existing.enabled) === desired.enabled;
		if (same) {
			console.log(`  · ${label} — already exists`);
			return 0;
		}
		if (ctx.flags.dryRun) {
			console.log(`  → would update ${label}`);
			return 0;
		}
		ctx.store.updateRoutingRule(existing.id, desired);
		console.log(`  ✓ updated ${label}`);
		return 0;
	}
	if (ctx.flags.dryRun) {
		console.log(`  → would add ${label}`);
		return 0;
	}
	ctx.store.insertRoutingRule({
		userId: ctx.store.admin.id,
		domainId: requireDomain(ctx).id,
		name: rule.name ?? pattern,
		pattern,
		matchField: rule.matchField,
		matchOperator: rule.matchOperator,
		action: rule.action,
		...desired,
	});
	console.log(`  ✓ added ${label}`);
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
