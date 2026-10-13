// Cloudflare names the data center that answered a request by its airport code (`cf-placement:
// remote-FRA`). This says which country each one is in, so "it answered from FRA" can be held
// to the country a server declares. The list is github.com/Netrvin/cloudflare-colo-list (MIT,
// regenerated daily), cut down to code → country. `state colos` pulls it again.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const COLOS_FILE = "scripts/state/colos.json";
const SOURCE = "https://github.com/Netrvin/cloudflare-colo-list";
const PUBLISHED = "https://raw.githubusercontent.com/Netrvin/cloudflare-colo-list/main/DC-Colos.json";

/** Airport code → the country it is in, as Cloudflare's list writes one (`FRA` → `DE`). */
export type Colos = Record<string, string>;

/** `remote-FRA` (it ran elsewhere than the request arrived) or `local-FRA`: the data center. */
export const coloOf = (placement: string | null | undefined): string | null => /^(?:local|remote)-([A-Z]{3})$/.exec(placement ?? "")?.[1] ?? null;

export const loadColos = (path = COLOS_FILE): Colos => (JSON.parse(readFileSync(path, "utf8")) as { colos: Colos }).colos;

/** The country a data center is in, as documents write one, or null when the list has not heard of it. */
export const countryOfColo = (colo: string, colos: Colos = loadColos()): string | null => colos[colo]?.toLowerCase() ?? null;

/** Where a request to a server was answered from: the data center Cloudflare names, and its country. */
export async function answeredFrom(origin: string): Promise<{ colo: string | null; country: string | null }> {
	const colo = coloOf(await fetch(`${origin.replace(/\/+$/, "")}/login`, { redirect: "manual", signal: AbortSignal.timeout(15_000) }).then((response) => response.headers.get("cf-placement"), () => null));
	return { colo, country: colo ? countryOfColo(colo) : null };
}

/** Does Cloudflare have a data center in this country at all? Without one, nothing can run there. */
export const hasColo = (country: string, colos: Colos = loadColos()): boolean => Object.values(colos).includes(country.toUpperCase());

/** The published list, cut down to code → country. Anything that is not that shape is refused. */
export function parseColoList(published: unknown): Colos {
	if (!published || typeof published !== "object" || Array.isArray(published)) throw new Error("the data-center list is not an object of codes");
	const colos: Colos = {};
	for (const [code, entry] of Object.entries(published).sort(([a], [b]) => a.localeCompare(b))) {
		const country = (entry as { cca2?: unknown } | null)?.cca2;
		if (!/^[A-Z]{3}$/.test(code) || typeof country !== "string" || !/^[A-Z]{2}$/.test(country)) throw new Error(`the data-center list has an entry that is not a code and a country: ${code.slice(0, 20)}`);
		colos[code] = country;
	}
	// A list that lost most of its entries is a broken download, not Cloudflare closing data centers.
	if (Object.keys(colos).length < 200) throw new Error(`the data-center list holds only ${Object.keys(colos).length} entries`);
	return colos;
}

/** Pull the list again, and say what changed. */
export async function refreshColos(print: (line: string) => void = console.log, path = COLOS_FILE): Promise<number> {
	const response = await fetch(PUBLISHED);
	if (!response.ok) throw new Error(`could not pull the data-center list: ${PUBLISHED} answered ${response.status}`);
	const colos = parseColoList(await response.json());
	const before = existsSync(path) ? loadColos(path) : {};
	for (const [code, country] of Object.entries(colos)) {
		if (!(code in before)) print(`  + ${code} ${country}`);
		else if (before[code] !== country) print(`  ~ ${code} ${before[code]} → ${country}`);
	}
	for (const [code, country] of Object.entries(before)) if (!(code in colos)) print(`  - ${code} ${country}`);
	writeFileSync(path, `${JSON.stringify({ source: SOURCE, fetched: new Date().toISOString().slice(0, 10), colos }, null, 2)}\n`);
	print(`${Object.keys(colos).length} data centers in ${new Set(Object.values(colos)).size} countries → ${path}`);
	return 0;
}
