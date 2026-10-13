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

// Reachable only through a parent row, so a direct predicate cannot see them yet. The
// audit reports these as NOT COVERED rather than quietly implying a clean result.
export const SUBJECT_SCOPE_INDIRECT = [
	"message_attachments",   // -> message_id -> messages
	"shared_attachment_links",
	"webhook_deliveries",    // -> webhook_id -> webhooks
	"agent_chat_messages",   // -> conversation_id -> agent_conversations
	"ai_usage",
];

/** Rows that still exist for the subject — the number an erasure would have to reach 0. */
export const subjectTotal = (report: SubjectReport): number =>
	report.counts.reduce((sum, count) => sum + count.rows, 0);

/** The non-empty tables, biggest first, for the report. */
export const subjectLines = (report: SubjectReport): string[] =>
	report.counts
		.filter((count) => count.rows > 0)
		.sort((a, b) => b.rows - a.rows)
		.map((count) => `  ${String(count.rows).padStart(6)}  ${count.table}`);
