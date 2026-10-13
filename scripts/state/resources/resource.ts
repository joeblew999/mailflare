// The whole contract, in one place.
import { apiError, type ApiResult } from "../wrangler";
import type { Context } from "../context";

/** What an action has to tell the operator - a secret shown once, say. Failure is a throw. */
export type Note = string | void;

export type Item = {
	/** Terraform-style address: what it is, and which one. */
	address: string;
	/** What the document asks for, for the plan. */
	wants?: string;
	/** Cannot work. Reported, never attempted. */
	problem?: string;
	/** Why destroy leaves it in place. */
	keep?: string;
	/** On the server, in a section the document writes, and not in it: to be removed. */
	undeclared?: boolean;
	/** On the server and nobody's to manage: said, never acted on. */
	unmanaged?: string;
	/** Reads the world. `null` means absent. */
	actual(): Promise<unknown>;
	/** Is the world already what the document wants? Defaults to "it exists". */
	satisfied?(actual: unknown): boolean;
	/** Absent for an item that is only ever removed or reported. */
	create?(): Promise<Note>;
	/** Only when the thing exists but is wrong. */
	update?(actual: unknown): Promise<Note>;
	remove(present: unknown): Promise<Note>;
	/** What destroy would remove, when that is not simply what `actual` reads. `null` means nothing. */
	removable?(): Promise<unknown>;
};

export type Resource = {
	section: string;
	/** Runs before the rest and stops the document when it fails. */
	prerequisite?: boolean;
	declared(ctx: Context): boolean;
	items(ctx: Context): Promise<Item[]>;
};

export type ChangeAction = "create" | "update" | "remove" | "unchanged" | "keep" | "problem" | "unmanaged";
export type Change = { address: string; action: ChangeAction; detail?: string };

/** Anything that is not already as wanted is work to do. */
export const hasWork = (changes: Change[]): boolean => changes.some((change) => change.action !== "unchanged" && change.action !== "keep" && change.action !== "unmanaged");

/** The response of a call that must succeed. */
export function expectOk(result: ApiResult): ApiResult {
	if (result.status !== 200 && result.status !== 201) throw new Error(apiError(result));
	return result;
}
