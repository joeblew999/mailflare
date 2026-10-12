/* eslint-disable @typescript-eslint/no-explicit-any -- external HTTP JSON is validated by the app's zod schemas at runtime. */
import type { ApiResult } from "../joeblew999-lib";

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
	domain: any | null;
	d1: (sql: string) => any[];
	api: (path: string, options?: { method?: string; body?: unknown }) => Promise<ApiResult>;
};
