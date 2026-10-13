import { entitlementsFor } from "../wrangler";
import type { LicenseEntry } from "../types";
import type { Resource } from "./resource";

// The plan the license resource should write: null means "revert to community".
export function declaredPlan(entry: LicenseEntry | undefined, flag: string | undefined): string | null {
	const raw = typeof entry === "string" ? entry : entry?.plan;
	const plan = (raw ?? flag ?? "").trim().toLowerCase();
	if (!plan || plan === "community" || plan === "off") return null;
	return plan;
}

export function reportLicense(ctx: Parameters<Resource["status"]>[0]) {
	const row = ctx.store.licenseRow();
	if (!row) {
		console.log("  ⚠ no license_settings row yet — open Settings → License in the app once, then retry.");
		return;
	}
	const active = row.state === "active" && (row.plan === "pro" || row.plan === "team");
	const gates = entitlementsFor(row.plan, active);
	console.log(`  plan=${row.plan}  state=${row.state}  active=${active}`);
	console.log(`     custom branding: ${gates.branding ? "on" : "off"}   manage accounts: ${gates.accounts ? "on" : "off"}`);
	console.log(`     forwarding:      ${gates.forwarding ? "on" : "off"}   shared mailboxes: ${gates.sharing ? "on" : "off"}`);
	console.log(`     account seats:   ${gates.seatLimit}`);
}

// The self-hosted license plan is one row, so this is pure data - no domain needed.
export const licenseResource: Resource = {
	section: "license",
	needsDomain: false,
	declared: (ctx) => ctx.flags.plan !== undefined || Boolean(ctx.project?.license),
	async status(ctx) {
		reportLicense(ctx);
		return 0;
	},
	async apply(ctx) {
		const plan = declaredPlan(ctx.project?.license, ctx.flags.plan);
		if (!plan) {
			console.log("  · license — no plan requested");
			return 0;
		}
		if (ctx.flags.dryRun) {
			console.log(`  → would activate the ${plan} license`);
			return 0;
		}
		ctx.store.setLicense(plan);
		console.log(`  ✓ activated the ${plan} license`);
		return 0;
	},
	async remove(ctx) {
		if (ctx.flags.dryRun) {
			console.log("  → would revert the license to community");
			return 0;
		}
		ctx.store.setLicense(null);
		console.log("  ✓ reverted the license to community");
		return 0;
	},
};
