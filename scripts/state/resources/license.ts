import type { LicenseEntry, Plan } from "../spec";
import type { Resource } from "./resource";

export const planOf = (entry: LicenseEntry | undefined): Plan | undefined => (typeof entry === "string" ? entry : entry?.plan);

// The self-hosted licence plan is one row, so this is pure data - no domain needed.
export const licenseResource: Resource = {
	section: "license",
	declared: (ctx) => planOf(ctx.spec.license) !== undefined,
	async items(ctx) {
		const wanted = planOf(ctx.spec.license)!;
		const row = await ctx.store.licenseRow();
		const active = row?.state === "active" ? row.plan : "community";
		const set = async () => {
			await ctx.store.setLicense(wanted === "community" ? null : wanted);
			return wanted;
		};
		return [{
			address: "license",
			wants: `${active} → ${wanted}`,
			// There is always a plan: no row at all is the community one.
			actual: async () => active,
			satisfied: () => active === wanted,
			create: set,
			update: set,
			// Destroy takes back the plan the document gave. A document asking for community gave none.
			removable: async () => (wanted !== "community" && active !== "community" ? active : null),
			remove: async () => {
				await ctx.store.setLicense(null);
				return "reverted to community";
			},
		}];
	},
};
