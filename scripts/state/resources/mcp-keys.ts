import type { Context, McpKeyEntry } from "../types";
import type { Resource } from "./resource";

// MCP tool scopes (mirrors MCP_SCOPES in src/lib/mcp/auth.ts).
export const MCP_SCOPES = ["mcp:read", "mcp:draft", "mcp:organize", "mcp:request-send", "mcp:calendar-read", "mcp:calendar-write"];

// Mint an MCP key (`mcpKeys: [{ name, mailboxes?, scopes? }]`) and print the
// ready-to-paste client config. The key is shown once.
export function ensureMcpKey(ctx: Context, entry: McpKeyEntry, mailboxIdsByRole: Map<string, string>): number {
	const name = String(entry.name ?? "agent").trim();
	const scopes = Array.isArray(entry.scopes) && entry.scopes.length > 0 ? entry.scopes.map(String) : MCP_SCOPES;
	const bad = scopes.filter((scope) => !MCP_SCOPES.includes(scope));
	if (bad.length > 0) {
		console.log(`  ✗ mcp key "${name}": unknown scope(s) ${bad.join(", ")}`);
		return 1;
	}
	const mailboxIds = resolveMailboxes(name, entry, mailboxIdsByRole);
	if (ctx.store.mcpKey(ctx.store.admin.id, name)) {
		console.log(`  · mcp key "${name}" — already exists`);
		return 0;
	}
	if (ctx.flags.dryRun) {
		console.log(`  → would create mcp key "${name}" (${scopes.length} scope(s), ${mailboxIds.length} mailbox(es))`);
		return 0;
	}
	const { fullKey } = ctx.store.createMcpKey({ name, scopes, mailboxIds });
	console.log(`  ✓ created mcp key "${name}"  ⚠ key (shown once): ${fullKey}`);
	console.log(`     client JSON: {"mcpServers":{"mailflare":{"type":"http","url":"${ctx.store.base}/mcp","headers":{"Authorization":"Bearer ${fullKey}"}}}}`);
	return 0;
}

export function removeMcpKey(ctx: Context, entry: McpKeyEntry): number {
	const name = String(entry.name ?? "agent").trim();
	if (ctx.flags.dryRun) {
		console.log(`  → would remove mcp key "${name}"`);
		return 0;
	}
	ctx.store.deleteMcpKey(ctx.store.admin.id, name);
	console.log(`  ✓ removed mcp key "${name}"`);
	return 0;
}

// Resolve the mailbox ids a key entry names, warning about roles that are absent.
function resolveMailboxes(name: string, entry: McpKeyEntry, mailboxIdsByRole: Map<string, string>): string[] {
	const ids: string[] = [];
	for (const role of entry.mailboxes ?? []) {
		const id = mailboxIdsByRole.get(String(role).toLowerCase());
		if (!id) {
			console.log(`  ⚠ mcp key "${name}": mailbox "${role}" not found, skipping it`);
			continue;
		}
		ids.push(id);
	}
	return ids;
}

async function statusMcpKeys(ctx: Context): Promise<number> {
	let missing = 0;
	for (const entry of ctx.project?.mcpKeys ?? []) {
		const name = String(entry.name ?? "agent").trim();
		const exists = ctx.store.mcpKey(ctx.store.admin.id, name) !== null;
		if (!exists) missing += 1;
		console.log(`  ${exists ? "✓" : "✗"} mcp key "${name}" — ${exists ? "present" : "missing"}`);
	}
	return missing;
}

export const mcpKeysResource: Resource = {
	section: "mcpKeys",
	needsDomain: true,
	declared: (ctx) => (ctx.project?.mcpKeys?.length ?? 0) > 0,
	status: (ctx) => statusMcpKeys(ctx),
	async apply(ctx, _roles, state) {
		let failures = 0;
		for (const entry of ctx.project?.mcpKeys ?? []) failures += ensureMcpKey(ctx, entry, state.mailboxIdsByRole);
		return failures;
	},
	async remove(ctx) {
		let failures = 0;
		for (const entry of ctx.project?.mcpKeys ?? []) failures += removeMcpKey(ctx, entry);
		return failures;
	},
};
