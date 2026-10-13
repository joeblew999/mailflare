// Where a data subject's data lives. Hand-kept, and held to the real schema by a test: every
// table is classified here, and every column that names a user or a mailbox is accounted for.
import type { SubjectReport } from "./store/types";

export type SubjectScope = {
	table: string;
	/** Columns naming the user the row belongs to, or is about. Their rows are erased. */
	userColumns?: string[];
	/** Column naming the mailbox that owns the row. Rows in the subject's mailboxes are erased. */
	mailboxColumn?: string;
	/** Columns that merely mention a user. The schema nulls them; the row is someone else's. */
	referenceColumns?: string[];
};

export const SUBJECT_SCOPE: SubjectScope[] = [
	{ table: "api_keys", userColumns: ["user_id"] },
	{ table: "audit_logs", userColumns: ["actor_user_id", "target_user_id"], mailboxColumn: "mailbox_id" },
	{ table: "booking_events", userColumns: ["user_id"] },
	{ table: "calendar_events", userColumns: ["user_id"], mailboxColumn: "mailbox_id" },
	{ table: "contacts", userColumns: ["user_id"] },
	{ table: "domains", userColumns: ["user_id"] },
	{ table: "drive_items", userColumns: ["owner_id"] },
	{ table: "drive_shares", userColumns: ["user_id"] },
	{ table: "email_templates", userColumns: ["user_id"] },
	{ table: "folders", userColumns: ["user_id"], mailboxColumn: "mailbox_id" },
	{ table: "mailbox_access", userColumns: ["user_id"], mailboxColumn: "mailbox_id", referenceColumns: ["created_by_user_id"] },
	{ table: "mailbox_aliases", mailboxColumn: "mailbox_id" },
	{ table: "mailboxes", userColumns: ["user_id"] },
	{ table: "messages", userColumns: ["user_id"], mailboxColumn: "mailbox_id" },
	{ table: "outbound_jobs", userColumns: ["user_id"] },
	{ table: "password_reset_tokens", userColumns: ["user_id"] },
	{ table: "push_subscriptions", userColumns: ["user_id"] },
	{ table: "routing_rules", userColumns: ["user_id"], mailboxColumn: "mailbox_id" },
	{ table: "sessions", userColumns: ["user_id"] },
	{ table: "webhooks", userColumns: ["user_id"] },
	{ table: "login_challenges", userColumns: ["user_id"] },
	{ table: "mfa_recovery_codes", userColumns: ["user_id"] },
	{ table: "agent_conversations", userColumns: ["user_id"], mailboxColumn: "mailbox_id" },
	{ table: "agent_jobs", userColumns: ["reviewer_user_id"], mailboxColumn: "mailbox_id" },
	{ table: "agent_send_approvals", userColumns: ["user_id"], mailboxColumn: "mailbox_id" },
	{ table: "mailbox_agent_settings", mailboxColumn: "mailbox_id", referenceColumns: ["reviewer_user_id"] },
	{ table: "agent_draft_metadata", mailboxColumn: "mailbox_id" },
	{ table: "auto_reply_deliveries", mailboxColumn: "mailbox_id" },
	{ table: "mcp_key_mailboxes", mailboxColumn: "mailbox_id" },
	{ table: "spam_feedback", mailboxColumn: "mailbox_id", referenceColumns: ["actor_user_id"] },
	{ table: "spam_reputation", mailboxColumn: "mailbox_id" },
	{ table: "spam_token_stats", mailboxColumn: "mailbox_id" },
	{ table: "backups", referenceColumns: ["created_by_user_id"] },
	{ table: "jmap_mailbox_revisions", mailboxColumn: "mailbox_id" },
];

// Reachable only through a parent row. Each entry names the column pointing at the parent.
export type IndirectScope = { table: string; column: string; parent: string };

export const INDIRECT_SCOPE: IndirectScope[] = [
	{ table: "message_attachments", column: "message_id", parent: "messages" },
	{ table: "agent_chat_messages", column: "conversation_id", parent: "agent_conversations" },
	{ table: "webhook_deliveries", column: "webhook_id", parent: "webhooks" },
	{ table: "shared_attachment_links", column: "attachment_id", parent: "message_attachments" },
	{ table: "drive_upload_parts", column: "item_id", parent: "drive_items" },
];

// No user, owner or mailbox column exists on these at all, so their rows cannot be attributed.
export const SUBJECT_SCOPE_UNATTRIBUTABLE = ["ai_usage"];

/** Tables that describe the instance and hold nobody's data. */
export const INSTANCE_TABLES = ["app_settings", "backup_settings", "license_settings"];

// The object-store keys that hold a subject's bytes. Deleting the rows without deleting
// these would leave the mail itself behind.
export type ObjectKeyRef = { table: string; column: string };
export const SUBJECT_OBJECT_KEYS: ObjectKeyRef[] = [
	{ table: "messages", column: "raw_r2_key" },
	{ table: "message_attachments", column: "r2_key" },
	{ table: "drive_items", column: "r2_key" },
	{ table: "contacts", column: "avatar_key" },
	{ table: "mailboxes", column: "avatar_key" },
	{ table: "users", column: "avatar_key" },
];
/** Object keys that belong to the instance, not to a person. */
export const INSTANCE_OBJECT_KEYS: ObjectKeyRef[] = [
	{ table: "backups", column: "r2_key" },
	{ table: "app_settings", column: "icon_key" },
];

/** Rows that still exist for the subject — the number an erasure would have to reach 0. */
export const subjectTotal = (report: SubjectReport): number =>
	report.counts.reduce((sum, count) => sum + Math.max(0, count.rows), 0);

/** Tables that cannot be attributed to a subject at all — reported, never counted. */
export const subjectUnknown = (report: SubjectReport): string[] =>
	report.counts.filter((count) => count.rows < 0).map((count) => count.table);

/** The non-empty tables, biggest first, for the report. */
export const subjectLines = (report: SubjectReport): string[] =>
	report.counts
		.filter((count) => count.rows > 0)
		.sort((a, b) => b.rows - a.rows)
		.map((count) => `  ${String(count.rows).padStart(6)}  ${count.table}`);

/** True when `table` can be attributed to the subject at all - directly, or through a parent chain. */
export const isSubjectScoped = (table: string): boolean =>
	SUBJECT_SCOPE.some((scope) => scope.table === table) || INDIRECT_SCOPE.some((entry) => entry.table === table);

/** The parent the entry hangs off, or undefined when the table is linked directly. */
export const parentOf = (table: string): string | undefined =>
	INDIRECT_SCOPE.find((entry) => entry.table === table)?.parent;

/** How many parents stand between a table and a direct one. Deeper tables are erased first. */
export const depthOf = (table: string): number => {
	const parent = parentOf(table);
	return parent ? 1 + depthOf(parent) : 0;
};

/**
 * The WHERE clause that selects the subject's rows in `table`, or null when the table holds
 * none of theirs. Shared by the report and the erasure, so they cannot disagree.
 */
export function subjectPredicate(table: string, userId: string, mailboxIds: string[], quote: (value: string) => string): string | null {
	const scope = SUBJECT_SCOPE.find((entry) => entry.table === table);
	if (scope) {
		const parts = (scope.userColumns ?? []).map((column) => `${column}=${quote(userId)}`);
		if (scope.mailboxColumn && mailboxIds.length > 0) parts.push(`${scope.mailboxColumn} IN (${mailboxIds.map(quote).join(", ")})`);
		return parts.length > 0 ? parts.join(" OR ") : null;
	}
	const link = INDIRECT_SCOPE.find((entry) => entry.table === table);
	if (!link) return null;
	const inner = subjectPredicate(link.parent, userId, mailboxIds, quote);
	return inner ? `${link.column} IN (SELECT id FROM "${link.parent}" WHERE ${inner})` : null;
}
