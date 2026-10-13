// The fleet's front door: one small Worker that knows which server each domain lives on, and
// sends a person there by who they are - never by where they happen to be. It is generated
// from the project folders, so it cannot disagree with them for longer than one apply.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { message, readWranglerConfig, sleep, workersDevUrl, wrangler } from "./wrangler";
import type { Project } from "./document";
import { servedBy } from "./spec";
import type { Flags } from "./flags";

/** `countries` is where someone NEW from a country would be at home: a suggestion, never a route. */
export type FleetMap = { domains: Record<string, string>; servers: Record<string, { url: string; jurisdiction?: string; country?: string }>; countries: Record<string, string> };

/** Every domain's home, from the documents. A server with no origin yet cannot be routed to. */
export function fleetMap(projects: Project[]): FleetMap {
	const map: FleetMap = { domains: {}, servers: {}, countries: {} };
	for (const { server, entries } of projects) {
		if (!server?.url || server.local) continue;
		map.servers[server.name] = { url: server.url.replace(/\/+$/, ""), ...(server.jurisdiction ? { jurisdiction: server.jurisdiction } : {}), ...(server.country ? { country: server.country.toLowerCase() } : {}) };
		// The first server to claim a country keeps it; a document on the wrong one is refused at load.
		for (const country of servedBy(server)) map.countries[country] ??= server.name;
		for (const entry of entries) if (entry.spec.domain) map.domains[entry.spec.domain.trim().toLowerCase()] = server.name;
	}
	return map;
}

export const fleetVersion = (map: FleetMap): string => createHash("sha256").update(JSON.stringify(map)).digest("hex").slice(0, 12);

/** What the deployed router says it holds, or null when there is none. */
async function deployedVersion(url: string): Promise<string | null> {
	const response = await fetch(`${url}/.well-known/mailflare-fleet`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
	if (!response?.ok) return null;
	return ((await response.json().catch(() => null)) as { version?: string } | null)?.version ?? null;
}

export async function router(projects: Project[], flags: Flags, named?: string, print: (text: string) => void = console.log): Promise<number> {
	// A fleet of local servers has no front door: there is nowhere deployed to send anyone.
	if (!projects.some((project) => project.server && !project.server.local)) return 0;
	try {
		const template = readWranglerConfig();
		const name = named ?? `${template.name}-router`;
		const config = `wrangler.${name}.json`;
		const url = await workersDevUrl(name);
		if (!url) throw new Error("the router's address needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (environment or keychain)");
		const map = fleetMap(projects);
		const version = fleetVersion(map);
		const deployed = await deployedVersion(url);
		const summary = `${Object.keys(map.domains).length} domain(s) on ${Object.keys(map.servers).length} server(s)`;
		const write = () => writeFileSync(config, `${JSON.stringify({ name, main: "scripts/state/router/worker.js", compatibility_date: template.compatibility_date, workers_dev: true, vars: { FLEET: JSON.stringify(map), FLEET_VERSION: version } }, null, "\t")}\n`);

		print(`\n──────── router (${url})`);
		if (flags.cleanup) {
			if (!deployed) return print("  · nothing to remove"), 0;
			if (flags.status) return print("Destroy plan for the router: 1 to remove\n\n  - router"), 1;
			write();
			const removed = await wrangler(["delete"], { config });
			if (removed.status !== 0) throw new Error((removed.stderr || removed.stdout).trim());
			return print("  - router"), 0;
		}

		const lines = Object.entries(map.domains).sort().map(([domain, server]) => `      ${domain} → ${server}${map.servers[server].jurisdiction ? ` (${map.servers[server].jurisdiction})` : ""}`);
		if (deployed === version) return print(`Plan for the router: 0 to create, 0 to update\n\n  · router  ${summary}\n${lines.join("\n")}`), 0;
		const symbol = deployed ? "~" : "+";
		if (flags.status) return print(`Plan for the router: ${deployed ? "0 to create, 1 to update" : "1 to create, 0 to update"}\n\n  ${symbol} router  ${summary}\n${lines.join("\n")}`), 1;

		write();
		const result = await wrangler(["deploy"], { config });
		if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
		// A deploy takes a moment to be what answers.
		for (let attempt = 0; attempt < 30 && (await deployedVersion(url)) !== version; attempt += 1) await sleep(2000);
		if ((await deployedVersion(url)) !== version) throw new Error("deployed, but it is not answering with the new fleet yet");
		print(`  ${symbol} router  ${summary}\n${lines.join("\n")}`);
		return 0;
	} catch (error) {
		print(`  ✗ router  ${message(error)}`);
		return 1;
	}
}
