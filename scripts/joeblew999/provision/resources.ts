import { mailboxesResource } from "./mailboxes";
import { accountsResource } from "./accounts";
import { routingResource } from "./routing";
import { mcpKeysResource } from "./mcp-keys";
import { licenseResource } from "./license";
import { pushResource } from "./push";
import type { Resource } from "./resource";
import type { Context, Role } from "./types";

// Every capability the system has, in apply order. Mailboxes come first because
// routing rules and MCP keys refer to mailbox ids by role (RunState.mailboxIdsByRole);
// cleanup runs this same order, which deletes mailboxes before the rules naming them.
export const RESOURCES: Resource[] = [
	mailboxesResource,
	accountsResource,
	routingResource,
	mcpKeysResource,
	licenseResource,
	pushResource,
];

/** The resources this run actually asks for (absent manifest sections are skipped). */
export const wantedResources = (ctx: Context, roles: Role[]): Resource[] =>
	RESOURCES.filter((resource) => resource.wanted(ctx, roles));
