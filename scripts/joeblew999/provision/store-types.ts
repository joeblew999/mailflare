// The one seam between provisioning logic and the outside world. Every read and
// write the logic needs is declared here: the app's key-authenticated HTTP API, and
// the raw D1 statements the app exposes no key-authenticated route for. The logic
// modules depend only on this interface, so tests drive an in-memory fake instead of
// a live Worker - and swapping how we reach the app never touches the logic.
import type { ApiResult } from "../lib";
import type { ApiAccount, ApiDomain, ApiMailbox } from "./types";

// --- keys, access grants and routing rules have no key-authenticated app route,
// --- so they are written with SQL. These are their stored shapes.

/** A domain-scope routing rule as stored (the D1 row, snake_case). */
export type RoutingRuleRow = {
	id: string;
	match_value: string | null;
	forward_to: string | null;
	keep_copy: number;
	mailbox_id: string | null;
	reject_reason: string | null;
	priority: number;
	enabled: number;
};

/** Values for a routing rule; ids and timestamps are the store's job. */
export type RoutingRuleValues = {
	userId: string;
	domainId: string;
	name: string;
	enabled: number;
	pattern: string;
	matchField: string;
	matchOperator: string;
	matchValue: string;
	action: string;
	forwardTo: string | null;
	keepCopy: number;
	mailboxId: string | null;
	rejectReason: string | null;
	priority: number;
};

/** The mutable half of a routing rule, for reconciling an existing row. */
export type RoutingRulePatch = Pick<
	RoutingRuleValues,
	"matchValue" | "forwardTo" | "keepCopy" | "mailboxId" | "rejectReason" | "priority" | "enabled"
>;

/** The single license_settings row the app's entitlement gate reads. */
export type LicenseRow = { plan: string; state: string };

export type PushTestInput = { from: string; to: string; subject: string; text: string; html: string };

export type Store = {
	readonly base: string;
	readonly admin: { id: string; email: string };

	// the domain's current MX records, from the Cloudflare API (null if unknown)
	currentMx(hostname: string): Promise<Array<{ priority?: number; content?: string }> | null>;

	// domains (HTTP)
	listDomains(): Promise<ApiDomain[]>;
	onboardDomain(body: unknown): Promise<ApiResult>;
	removeDomain(domainId: string): Promise<ApiResult>;

	// mailboxes (HTTP + one SQL read for the owner)
	listMailboxes(): Promise<ApiMailbox[]>;
	createMailbox(body: unknown): Promise<ApiResult>;
	deleteMailbox(mailboxId: string): Promise<ApiResult>;
	mailboxOwnerId(mailboxId: string): string | null;

	// accounts (HTTP)
	listAccounts(): Promise<ApiAccount[]>;
	createAccount(body: unknown): Promise<ApiResult>;
	updateAccount(accountId: string, body: unknown): Promise<ApiResult>;

	// users and mailbox sharing (SQL)
	userIdByEmail(email: string): string | null;
	accessPermission(mailboxId: string, userId: string): string | null;
	grantAccess(mailboxId: string, userId: string, permission: string): void;
	revokeAccess(mailboxId: string, userId: string): void;

	// domain routing rules (SQL)
	routingRule(domainId: string, pattern: string, action: string): RoutingRuleRow | null;
	insertRoutingRule(values: RoutingRuleValues): void;
	updateRoutingRule(ruleId: string, patch: RoutingRulePatch): void;
	deleteRoutingRule(domainId: string, pattern: string, action: string): void;

	// fresh instance lifecycle: only the reset capability uses these
	/** Bring the target database up to the current schema. */
	applyMigrations(): void;
	schemaPresent(): boolean;
	/** Delete every row from every base table (d1_migrations and internal tables stay). */
	wipeData(): void;
	insertAdmin(user: { id: string; email: string; name: string; passwordHash: string }): void;

	// license (SQL): the plan the entitlement gate reads
	licenseRow(): LicenseRow | null;
	/** Activate a plan, or revert to community when null. */
	setLicense(plan: string | null): void;

	// web push verification (network + SQL + wrangler)
	workerSecrets(): string[] | null;
	pushSubscriptionCount(): number;
	clearPushSubscriptions(): void;
	firstAdminEmail(): string | null;
	sendViaCloudflare(input: PushTestInput): Promise<{ messageId?: string }>;
	messageStatusBySubject(subject: string): Promise<{ status: string } | null>;
	/** Injectable so tests and dry runs do not really wait. */
	wait(ms: number): Promise<void>;

	// MCP keys (SQL)
	mcpKey(userId: string, name: string): { id: string } | null;
	createMcpKey(input: { name: string; scopes: string[]; mailboxIds: string[] }): { fullKey: string };
	deleteMcpKey(userId: string, name: string): void;

	/** Delete the temporary admin key, if one was ever minted. */
	dispose(): void;
};
