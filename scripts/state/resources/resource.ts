// The whole contract, in one place.
import type { Context } from "../context";
import type { Role } from "../spec";

/** Threaded through a run: mailboxes create the ids that routing rules and MCP keys name. */
export type RunState = { mailboxIdsByRole: Map<string, string> };

export type Item = {
	/** Terraform-style address: what it is, and which one. */
	address: string;
	/** Reads the world. `null` means absent. */
	actual(): Promise<unknown>;
	/** Is what exists already what we want? Defaults to "it exists". */
	satisfied?(actual: unknown): boolean;
	create(): Promise<number>;
	/** Only when the thing exists but is wrong. */
	update?(actual: unknown): Promise<number>;
	remove(): Promise<number>;
	/** Why, for the plan. */
	wants?: string;
	/** Cannot work. Reported, never attempted. */
	problem?: string;
};

export type Resource = {
	section: string;
	needsDomain: boolean;
	/** Runs before the rest and aborts the run when it fails. */
	prerequisite?: boolean;
	declared(ctx: Context, roles: Role[]): boolean;
	items(ctx: Context, roles: Role[], state: RunState): Promise<Item[]>;
};

export type ChangeAction = "create" | "update" | "unchanged" | "problem";
export type Change = { address: string; action: ChangeAction; detail?: string };

/** Anything not `unchanged` is work to do. */
export const hasWork = (changes: Change[]): boolean => changes.some((change) => change.action !== "unchanged");
