import type { Context } from "../context";
import type { McpKeyEntry } from "../spec";
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
	const { fullKey } = ctx.store.createMcpKey({ name, scopes, mailboxIds });
	console.log(`  ✓ created mcp key "${name}"  ⚠ key (shown once): ${fullKey}`);
	console.log(`     client JSON: {"mcpServers":{"mailflare":{"type":"http","url":"${ctx.store.base}/mcp","headers":{"Authorization":"Bearer ${fullKey}"}}}}`);
	return 0;
}

export function removeMcpKey(ctx: Context, entry: McpKeyEntry): number {
	const name = String(entry.name ?? "agent").trim();
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

export const mcpKeysResource: Resource = {
	section: "mcpKeys",
	needsDomain: true,
	declared: (ctx) => (ctx.spec?.mcpKeys?.length ?? 0) > 0,
	async items(ctx, _roles, state) {
		return (ctx.spec?.mcpKeys ?? []).map((entry) => {
			const name = String(entry.name ?? "agent").trim();
			return {
				address: `mcpKey.${name}`,
				actual: async () => ctx.store.mcpKey(ctx.store.admin.id, name),
				create: async () => ensureMcpKey(ctx, entry, state.mailboxIdsByRole),
				remove: async () => removeMcpKey(ctx, entry),
			};
		});
	},
};
