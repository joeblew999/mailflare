import { randomBytes } from "node:crypto";
import { sqlEscape } from "../joeblew999-lib";
import type { Context, RoutingEntry } from "./types";

// Provision domain-scope routing rules. These decide, during address resolution:
// reject, forward, or store (catch-all).
export function ensureRouting(ctx: Context, entry: RoutingEntry): number {
	const pattern = String(entry.pattern ?? "*").trim();
	const action = String(entry.action ?? "forward").trim();
	if (!["store", "forward", "reject"].includes(action)) {
		console.log(`  ✗ routing action must be store|forward|reject (got "${action}")`);
		return 1;
	}
	const forwardTo = entry.forwardTo ? String(entry.forwardTo).trim() : null;
	if (action === "forward" && !forwardTo) {
		console.log(`  ✗ routing "${pattern}" forwards but has no forwardTo`);
		return 1;
	}
	const label = `routing ${pattern} → ${action}${forwardTo ? ` ${forwardTo}` : ""}`;
	const existing = ctx.d1(`SELECT id FROM routing_rules WHERE domain_id='${sqlEscape(ctx.domain.id)}' AND scope='domain' AND pattern='${sqlEscape(pattern)}' AND action='${sqlEscape(action)}';`);
	if (existing.length > 0) {
		console.log(`  · ${label} — already exists`);
		return 0;
	}
	if (ctx.flags.dryRun) {
		console.log(`  → would add ${label}`);
		return 0;
	}
	ctx.d1(`INSERT INTO routing_rules (id, user_id, domain_id, scope, name, enabled, pattern, match_field, match_operator, match_value, action, forward_to, keep_copy, reject_reason, priority, created_at)
	    VALUES ('rr_${randomBytes(6).toString("hex")}', '${sqlEscape(ctx.admin.id)}', '${sqlEscape(ctx.domain.id)}', 'domain', '${sqlEscape(entry.name ?? pattern)}', 1, '${sqlEscape(pattern)}', 'email', 'contains', '${sqlEscape(entry.matchValue ?? "")}', '${sqlEscape(action)}', ${forwardTo ? `'${sqlEscape(forwardTo)}'` : "NULL"}, ${entry.keepCopy ? 1 : 0}, ${entry.rejectReason ? `'${sqlEscape(entry.rejectReason)}'` : "NULL"}, ${Number(entry.priority) || 0}, strftime('%s','now'));`);
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
