// One capability of the system. Everything the provisioner can do - mailboxes,
// accounts, routing rules, MCP keys, the license, web push - is a Resource, so
// there is one place that lists them and one loop that applies them.
import type { Context, Role } from "./types";

// Threaded through a run: mailboxes create the ids that routing rules and MCP keys
// refer to by role, so later resources read what earlier ones produced.
export type RunState = { mailboxIdsByRole: Map<string, string> };

export type Resource = {
	/** Manifest section this resource owns. */
	section: string;
	/** Domain-scoped resources require a resolved domain before they can run. */
	needsDomain: boolean;
	/** Whether this run asks for it (absent sections are skipped silently). */
	wanted(ctx: Context, roles: Role[]): boolean;
	/** Report drift without writing. Returns missing-item failures. */
	status(ctx: Context, roles: Role[], state: RunState): Promise<number>;
	/** Create or reconcile. Returns failures. */
	apply(ctx: Context, roles: Role[], state: RunState): Promise<number>;
	/** Undo, for --cleanup. Returns failures. */
	remove(ctx: Context, roles: Role[], state: RunState): Promise<number>;
};
