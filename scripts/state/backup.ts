// A backup is the app's own export of its tables: one JSON object in the bucket, holding every
// row. Erasing a person from the database leaves them in every backup taken before, so this
// takes them out of a backup too - by the SAME scope the database erasure uses, so the two
// cannot disagree - and leaves a backup that still restores.
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";
import { INDIRECT_SCOPE, SUBJECT_SCOPE, depthOf, digestOf } from "./subject-scope";

export type BackupRow = Record<string, string | number | null>;
export type BackupDocument = { format: string; version: number; createdAt?: string; includedTables?: string[]; tables: Record<string, BackupRow[]> };

/** The document a backup object holds, or null when it is not one this system can read. */
export function parseBackup(content: string): BackupDocument | null {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return null;
	}
	const document = value as Partial<BackupDocument> | null;
	if (!document || document.format !== "mailflare-database-backup" || document.version !== 1 || !document.tables || typeof document.tables !== "object") return null;
	return Object.values(document.tables).every(Array.isArray) ? (document as BackupDocument) : null;
}

// Every reference between tables, from the app's own schema: what the database would do to a
// row when the row it points at is deleted.
type Reference = { table: string; column: string; parent: string; parentColumn: string; onDelete: string };
const REFERENCES: Reference[] = Object.values(schema).filter((value) => is(value, SQLiteTable)).flatMap((table) => {
	const config = getTableConfig(table as SQLiteTable);
	return config.foreignKeys.flatMap((key) => {
		const reference = key.reference();
		const parent = getTableConfig(reference.foreignTable as SQLiteTable).name;
		return reference.columns.map((column, index) => ({ table: config.name, column: column.name, parent, parentColumn: reference.foreignColumns[index].name, onDelete: key.onDelete ?? "no action" }));
	});
});

/** Whom to look for: by the digest of their address, or by ids already known from the database. */
export type Who = { digests?: Iterable<string>; userIds?: Iterable<string>; mailboxIds?: Iterable<string> };

/** The digests, of those given, that this backup holds an account for. */
export function holds(document: BackupDocument, digests: Iterable<string>): string[] {
	const wanted = new Set(digests);
	return [...new Set((document.tables.users ?? []).map((row) => digestOf(String(row.email ?? ""))).filter((digest) => wanted.has(digest)))];
}

export type Scrubbed = {
	/** Rows taken out. Zero means the backup never held them. */
	removed: number;
	/** Why this backup cannot be rewritten safely. It is to be deleted instead. */
	unsafe?: string;
};

/**
 * Take people out of a backup, in place: their rows by the erasure scope, then whatever the
 * database itself would have removed or blanked as a consequence, so that restoring the result
 * breaks no reference.
 */
export function scrub(document: BackupDocument, who: Who): Scrubbed {
	const tables = document.tables;
	const digests = new Set(who.digests ?? []);
	const users = new Set(who.userIds ?? []);
	for (const row of tables.users ?? []) if (digests.has(digestOf(String(row.email ?? "")))) users.add(String(row.id));
	const boxes = new Set(who.mailboxIds ?? []);
	for (const row of tables.mailboxes ?? []) if (users.has(String(row.user_id))) boxes.add(String(row.id));
	const named = (set: Set<string>, value: unknown) => value !== null && value !== undefined && set.has(String(value));

	// Deleting someone who owns a domain deletes every mailbox on it, other people's included.
	// The database erasure refuses that; a backup that shows it is not rewritten at all.
	const owned = (tables.domains ?? []).filter((row) => named(users, row.user_id)).map((row) => String(row.hostname));
	if (owned.length > 0) return { removed: 0, unsafe: `it holds them as the owner of ${owned.join(", ")}` };

	const dropped = new Map<string, BackupRow[]>();
	let removed = 0;
	const drop = (table: string, gone: (row: BackupRow) => boolean) => {
		const rows = tables[table];
		if (!rows) return 0;
		const kept = rows.filter((row) => !gone(row));
		const out = rows.filter(gone);
		if (out.length === 0) return 0;
		tables[table] = kept;
		dropped.set(table, [...(dropped.get(table) ?? []), ...out]);
		removed += out.length;
		return out.length;
	};
	const gone = (table: string, column: string) => new Set((dropped.get(table) ?? []).map((row) => String(row[column])));

	for (const scope of SUBJECT_SCOPE) {
		if (scope.table === "domains") continue;
		drop(scope.table, (row) => (scope.userColumns ?? []).some((column) => named(users, row[column])) || (!!scope.mailboxColumn && named(boxes, row[scope.mailboxColumn])));
	}
	for (const link of [...INDIRECT_SCOPE].sort((a, b) => depthOf(a.table) - depthOf(b.table))) {
		const parents = gone(link.parent, "id");
		drop(link.table, (row) => named(parents, row[link.column]));
	}
	drop("users", (row) => named(users, row.id));
	if (removed === 0) return { removed };

	// What the database does by itself when those rows go: cascade, or blank the reference.
	for (let changed = true; changed; ) {
		changed = false;
		for (const reference of REFERENCES) {
			const parents = gone(reference.parent, reference.parentColumn);
			if (parents.size === 0 || !tables[reference.table]) continue;
			const pointing = tables[reference.table].filter((row) => named(parents, row[reference.column]));
			if (pointing.length === 0) continue;
			if (reference.onDelete === "cascade") changed = drop(reference.table, (row) => pointing.includes(row)) > 0 || changed;
			else if (reference.onDelete === "set null") for (const row of pointing) row[reference.column] = null;
			else return { removed, unsafe: `${reference.table}.${reference.column} would be left pointing at a deleted row` };
		}
	}
	return { removed };
}

/** Every reference in a backup that points at a row which is not in it. Empty means it restores. */
export function dangling(document: BackupDocument): string[] {
	const found: string[] = [];
	for (const reference of REFERENCES) {
		const parents = document.tables[reference.parent];
		const rows = document.tables[reference.table];
		if (!parents || !rows) continue;
		const present = new Set(parents.map((row) => String(row[reference.parentColumn])));
		const broken = rows.filter((row) => row[reference.column] !== null && row[reference.column] !== undefined && !present.has(String(row[reference.column]))).length;
		if (broken > 0) found.push(`${reference.table}.${reference.column} → ${reference.parent}: ${broken}`);
	}
	return found;
}
