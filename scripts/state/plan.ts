// The plan, in Terraform's shape: one line per resource, an action, and a reason.
//
//   + mailbox.office@acme.de      create
//   ~ routing.*                   update   drifted
//   · mailbox.support@acme.de     unchanged
//
// Resources classify their own changes; this only renders them, so the diff cannot disagree
// with what apply would do - both come from the same walk over the same resources.
export type ChangeAction = "create" | "update" | "delete" | "unchanged";

export type Change = {
	/** Terraform-style address: what it is, and which one. */
	address: string;
	action: ChangeAction;
	/** Why, or from what to what. */
	detail?: string;
};

const SYMBOL: Record<ChangeAction, string> = { create: "+", update: "~", delete: "-", unchanged: "·" };

/** Anything not `unchanged` is work to do. */
export const hasWork = (changes: Change[]): boolean => changes.some((change) => change.action !== "unchanged");

export function formatPlan(changes: Change[], heading = "Plan"): string {
	const count = (action: ChangeAction) => changes.filter((change) => change.action === action).length;
	const width = Math.max(0, ...changes.map((change) => change.address.length));
	const lines = changes.map((change) => {
		const symbol = SYMBOL[change.action];
		const detail = change.action === "unchanged" ? "" : `  ${change.detail ?? change.action}`;
		return `  ${symbol} ${change.address.padEnd(width)}${detail}`.trimEnd();
	});
	if (changes.length === 0) return "No changes — nothing declared.";
	return `${heading}: ${count("create")} to create, ${count("update")} to update, ${count("delete")} to destroy\n\n${lines.join("\n")}`;
}
