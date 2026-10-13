import type { LicenseEntry } from "../spec";
import type { Resource } from "./resource";

// The plan the license resource should write: null means "revert to community".
export function wantedPlan(entry: LicenseEntry | undefined): string | null {
	const raw = typeof entry === "string" ? entry : entry?.plan;
	const plan = (raw ?? "").trim().toLowerCase();
	if (!plan || plan === "community" || plan === "off") return null;
	return plan;
}

// The self-hosted license plan is one row, so this is pure data - no domain needed.
export const licenseResource: Resource = {
	section: "license",
	needsDomain: false,
	// An empty licence section asks for nothing. Reading it as "revert to community" would
	// silently downgrade a live licence.
	declared: (ctx) => Boolean(wantedPlan(ctx.spec?.license)),
	async items(ctx) {
		const wanted = wantedPlan(ctx.spec?.license) as string;
		const row = ctx.store.licenseRow();
		const active = row?.state === "active" ? row.plan : "community";
		const set = async () => {
			ctx.store.setLicense(wanted);
			console.log(`  ✓ licence set to ${wanted}`);
			return 0;
		};
		return [{
			address: "license",
			wants: `${active} → ${wanted}`,
			actual: async () => (row ? row.plan : null),
			satisfied: () => active === wanted,
			create: set,
			update: set,
			remove: async () => {
				ctx.store.setLicense(null);
				console.log("  ✓ reverted the licence to community");
				return 0;
			},
		}];
	},
};
