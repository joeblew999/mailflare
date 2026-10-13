import { freshResource } from "./fresh";
import { mailboxesResource } from "./mailboxes";
import { accountsResource } from "./accounts";
import { routingResource } from "./routing";
import { mcpKeysResource } from "./mcp-keys";
import { licenseResource } from "./license";
import { pushResource } from "./push";
import type { Resource } from "./resource";
import type { Context, Role } from "./types";

// Every capability the system has, in apply order. The order matters:
//   - fresh wipes the instance, so it must precede everything;
//   - license must precede what it GATES: shared inboxes and account management are
//     both 403 without an active Pro/Team plan, which only shows on a fresh server;
//   - accounts precede mailboxes: a mailbox's `access` grants name users, and on a
//     fresh server the only users that can exist are the ones `accounts` creates;
//   - mailboxes precede routing rules and MCP keys, which name mailbox ids by role
//     (RunState.mailboxIdsByRole).
// Cleanup runs this same order, which deletes mailboxes before the rules naming them.
export const RESOURCES: Resource[] = [
	freshResource,
	licenseResource,
	accountsResource,
	mailboxesResource,
	routingResource,
	mcpKeysResource,
	pushResource,
];

/** The resources this run actually asks for (absent manifest sections are skipped). */
export const wantedResources = (ctx: Context, roles: Role[]): Resource[] =>
	RESOURCES.filter((resource) => resource.wanted(ctx, roles));
