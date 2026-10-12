import { newId } from "@/lib/ids";
import { domainRoutingRuleSchema } from "@/lib/validators";
import { sqlEscape } from "../joeblew999-lib";
import type { Context, RoutingEntry } from "./types";

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
		domainId: ctx.domain.id,
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
	const forwardTo = rule.forwardTo ?? null;
	const label = `routing ${pattern} → ${rule.action}${forwardTo ? ` ${forwardTo}` : ""}`;
	const existing = ctx.d1(`SELECT id, match_value, forward_to, keep_copy, mailbox_id, reject_reason, priority, enabled FROM routing_rules WHERE domain_id='${sqlEscape(ctx.domain.id)}' AND scope='domain' AND pattern='${sqlEscape(pattern)}' AND action='${sqlEscape(rule.action)}';`);
	if (existing.length > 0) {
		// Reconcile the stored row with the manifest rather than assuming it matches.
		const row = existing[0];
		const desired = {
			matchValue: rule.matchValue,
			forwardTo,
			keepCopy: rule.keepCopy ? 1 : 0,
			mailboxId,
			rejectReason: rule.rejectReason ?? null,
			priority: rule.priority,
			enabled: rule.enabled ? 1 : 0,
		};
		const same =
			String(row.match_value ?? "") === desired.matchValue &&
			(row.forward_to ?? null) === desired.forwardTo &&
			Number(row.keep_copy) === desired.keepCopy &&
			(row.mailbox_id ?? null) === desired.mailboxId &&
			(row.reject_reason ?? null) === desired.rejectReason &&
			Number(row.priority) === desired.priority &&
			Number(row.enabled) === desired.enabled;
		if (same) {
			console.log(`  · ${label} — already exists`);
			return 0;
		}
		if (ctx.flags.dryRun) {
			console.log(`  → would update ${label}`);
			return 0;
		}
		ctx.d1(`UPDATE routing_rules SET match_value='${sqlEscape(desired.matchValue)}', forward_to=${desired.forwardTo ? `'${sqlEscape(desired.forwardTo)}'` : "NULL"}, keep_copy=${desired.keepCopy}, mailbox_id=${desired.mailboxId ? `'${sqlEscape(desired.mailboxId)}'` : "NULL"}, reject_reason=${desired.rejectReason ? `'${sqlEscape(desired.rejectReason)}'` : "NULL"}, priority=${desired.priority}, enabled=${desired.enabled} WHERE id='${sqlEscape(row.id)}';`);
		console.log(`  ✓ updated ${label}`);
		return 0;
	}
	if (ctx.flags.dryRun) {
		console.log(`  → would add ${label}`);
		return 0;
	}
	ctx.d1(`INSERT INTO routing_rules (id, user_id, domain_id, scope, name, enabled, pattern, match_field, match_operator, match_value, action, forward_to, keep_copy, reject_reason, priority, created_at)
	    VALUES ('${newId("rr")}', '${sqlEscape(ctx.admin.id)}', '${sqlEscape(ctx.domain.id)}', 'domain', '${sqlEscape(rule.name ?? pattern)}', ${rule.enabled ? 1 : 0}, '${sqlEscape(pattern)}', '${sqlEscape(rule.matchField)}', '${sqlEscape(rule.matchOperator)}', '${sqlEscape(rule.matchValue)}', '${sqlEscape(rule.action)}', ${forwardTo ? `'${sqlEscape(forwardTo)}'` : "NULL"}, ${rule.keepCopy ? 1 : 0}, ${rule.rejectReason ? `'${sqlEscape(rule.rejectReason)}'` : "NULL"}, ${rule.priority}, strftime('%s','now'));`);
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
	ctx.d1(`DELETE FROM routing_rules WHERE domain_id='${sqlEscape(ctx.domain.id)}' AND scope='domain' AND pattern='${sqlEscape(pattern)}' AND action='${sqlEscape(action)}';`);
	console.log(`  ✓ removed routing ${pattern} → ${action}`);
	return 0;
}
