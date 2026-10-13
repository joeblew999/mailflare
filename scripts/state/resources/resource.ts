// One capability of the system. Everything the reconciler can do - reset the
// instance, onboard a domain, mailboxes, accounts, routing rules, MCP keys, the
// license, web push - is a Resource, so there is one list of them (registry.ts) and
// one loop that applies them (driver.ts).
import type { Context } from "../context";
import type { Role } from "../spec";
import type { Change } from "../plan";

// Threaded through a run: mailboxes create the ids that routing rules and MCP keys
// refer to by role, so later resources read what earlier ones produced.
export type RunState = { mailboxIdsByRole: Map<string, string> };

export type Resource = {
	/** The document section this resource owns. */
	section: string;
	/** Domain-scoped resources need a resolved domain before they can do anything. */
	needsDomain: boolean;
	/** Stop the run if this resource fails, instead of letting the rest fail against
	 *  a world that was never set up. True for the prerequisites (fresh, domain). */
	abortOnFailure?: boolean;
	/** Whether this run asks for it (absent sections are skipped silently). */
	declared(ctx: Context, roles: Role[]): boolean;
	/** Classify every declared item WITHOUT writing: create, update or unchanged. */
	plan(ctx: Context, roles: Role[], state: RunState): Promise<Change[]>;
	/** Create or reconcile. Returns failures. */
	apply(ctx: Context, roles: Role[], state: RunState): Promise<number>;
	/** Undo, for --cleanup. Returns failures. */
	remove(ctx: Context, roles: Role[], state: RunState): Promise<number>;
};
