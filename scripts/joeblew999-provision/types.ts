/* eslint-disable @typescript-eslint/no-explicit-any -- manifest entries are user-authored JSON. */
import type { InferSelectModel } from "drizzle-orm";
import type { accountListItemFromUser } from "@/app/api/accounts/utils";
import type { listUserDomains } from "@/lib/domains/service";
import type { domains as domainsTable, mailboxes as mailboxesTable } from "@/db/schema";
import type { ApiResult } from "../joeblew999-lib";

// Response shapes taken from the app's own builders, so field access is checked
// against what the endpoint actually returns (no guessing).
//   GET /api/v1/domains   → listUserDomains() rows (+ sendingEnabled)
//   GET /api/v1/accounts  → accountListItemFromUser()
//   GET /api/v1/mailboxes → the inline select in api/v1/mailboxes/utils.ts (no named
//                           export exists, so the columns below mirror that select)
export type ApiDomain = Awaited<ReturnType<typeof listUserDomains>>[number] & {
	/** Added by GET /api/v1/domains on top of the stored row. */
	sendingEnabled?: boolean;
};
export type ApiAccount = ReturnType<typeof accountListItemFromUser>;
export type ApiMailbox = Pick<
	InferSelectModel<typeof mailboxesTable>,
	"id" | "userId" | "domainId" | "localPart" | "displayName" | "type" | "disabled" | "createdAt"
> & { hostname: InferSelectModel<typeof domainsTable>["hostname"] };

export type Flags = {
	dryRun: boolean;
	status: boolean;
	cleanup: boolean;
	onboard: boolean;
	confirmMx: boolean;
	replaceMx: boolean;
	share: boolean;
	disableAccounts: boolean;
	removeDomain: boolean;
	url?: string;
	db: string;
	local: boolean;
};

export type AccessGrant = { email?: string; permission?: string };
export type Role = { role: string; displayName: string; share: boolean; access: AccessGrant[] };
export type AccountEntry = { username?: string; name?: string; role?: string; password?: string; passwordEnv?: string };
export type RoutingEntry = {
	name?: string;
	pattern?: string;
	action?: string;
	forwardTo?: string;
	keepCopy?: boolean;
	rejectReason?: string;
	priority?: number;
	matchValue?: string;
	mailboxId?: string;
	/** Destination mailbox by role (for keepCopy / store). */
	mailbox?: string;
};
export type McpKeyEntry = { name?: string; mailboxes?: string[]; scopes?: string[] };

export type ProjectManifest = {
	domain?: string;
	onboard?: Record<string, any>;
	mailboxes?: any[];
	accounts?: AccountEntry[];
	routing?: RoutingEntry[];
	mcpKeys?: McpKeyEntry[];
};

// Everything a resource helper needs. Built once per run so no module reaches into
// process state; `api`/`d1` close over the resolved base URL and database.
export type Context = {
	base: string;
	key: string;
	admin: { id: string; email: string };
	flags: Flags;
	project: ProjectManifest | null;
	domainName: string;
	domain: ApiDomain | null;
	d1: (sql: string) => any[];
	api: (path: string, options?: { method?: string; body?: unknown }) => Promise<ApiResult>;
};
