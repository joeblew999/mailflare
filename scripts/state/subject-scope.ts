// Where a data subject's data lives, derived from `pragma_table_info` over the real
// database rather than from the schema file - the database is what the erasure would
// actually run against. Every table below carries a user or mailbox link.
//
// This is DATA, not SQL: store/live.ts turns it into the predicate. A table may link
// both ways (messages name a user AND a mailbox), which is why each entry lists both
// and the store ORs them.
import type { SubjectReport } from "./store/types";

export type SubjectScope = {
	table: string;
	/** Columns that name a user directly. */
	userColumns?: string[];
	/** Column naming the mailbox that owns the row. */
	mailboxColumn?: string;
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
	{ table: "mailbox_access", userColumns: ["user_id", "created_by_user_id"], mailboxColumn: "mailbox_id" },
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
	{ table: "mailbox_agent_settings", userColumns: ["reviewer_user_id"], mailboxColumn: "mailbox_id" },
	{ table: "agent_draft_metadata", mailboxColumn: "mailbox_id" },
	{ table: "auto_reply_deliveries", mailboxColumn: "mailbox_id" },
	{ table: "mcp_key_mailboxes", mailboxColumn: "mailbox_id" },
	{ table: "spam_feedback", userColumns: ["actor_user_id"], mailboxColumn: "mailbox_id" },
	{ table: "spam_reputation", mailboxColumn: "mailbox_id" },
	{ table: "spam_token_stats", mailboxColumn: "mailbox_id" },
	{ table: "backups", userColumns: ["created_by_user_id"] },
	{ table: "jmap_mailbox_revisions", mailboxColumn: "mailbox_id" },
];

// Reachable only through a parent row. Each entry names the column pointing at the parent,
// and the parent is itself resolved (a direct table, or another indirect one) - so
// shared_attachment_links -> message_attachments -> messages resolves in two hops.
export type IndirectScope = { table: string; column: string; parent: string };

export const INDIRECT_SCOPE: IndirectScope[] = [
	{ table: "message_attachments", column: "message_id", parent: "messages" },
	{ table: "agent_chat_messages", column: "conversation_id", parent: "agent_conversations" },
	{ table: "webhook_deliveries", column: "webhook_id", parent: "webhooks" },
	{ table: "shared_attachment_links", column: "attachment_id", parent: "message_attachments" },
];

// No user, owner or mailbox column exists on these at all, so there is no way to
// attribute a row to a subject. Listed so a clean report is never mistaken for a
// complete one.
export const SUBJECT_SCOPE_UNATTRIBUTABLE = ["ai_usage"];

// The object-store keys that hold a subject's bytes. Deleting the rows without deleting
// these would leave the mail itself behind.
export type ObjectKeyRef = { table: string; column: string; where: string };
export const SUBJECT_OBJECT_KEYS: ObjectKeyRef[] = [
	{ table: "messages", column: "raw_r2_key", where: "mailbox_id" },
	{ table: "message_attachments", column: "r2_key", where: "message_id" },
	{ table: "drive_items", column: "r2_key", where: "owner_id" },
	{ table: "users", column: "avatar_key", where: "id" },
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

/**
 * True when `table` can be attributed to the subject at all - directly, or through a
 * parent chain. Used by the audit to decide whether a table is in scope.
 */
export const isSubjectScoped = (table: string): boolean =>
	SUBJECT_SCOPE.some((scope) => scope.table === table) || INDIRECT_SCOPE.some((entry) => entry.table === table);

/** The parent the entry hangs off, or undefined when the table is linked directly. */
export const parentOf = (table: string): string | undefined =>
	INDIRECT_SCOPE.find((entry) => entry.table === table)?.parent;
