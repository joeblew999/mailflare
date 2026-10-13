// The fleet's front door. A person belongs to ONE server - the one that holds their domain -
// and is sent there by who they are, never by where they happen to be. This Worker holds no
// data and proxies nothing: it knows which server each domain lives on, and redirects.
//
// FLEET is generated from the project folders by `npm run state -- router apply`:
//   { "domains": { "acme.de": "eu1" }, "servers": { "eu1": { "url": "https://…", "jurisdiction": "eu", "country": "de" } }, "countries": { "de": "eu1" } }

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** The server a domain lives on, or null. */
function homeOf(fleet, domain) {
	const name = fleet.domains[String(domain ?? "").trim().toLowerCase()];
	const server = name ? fleet.servers[name] : null;
	return server?.url ? { domain: String(domain).trim().toLowerCase(), server: name, url: server.url, jurisdiction: server.jurisdiction ?? null } : null;
}

const cookieHome = (request) => /(?:^|;\s*)home=([^;]+)/.exec(request.headers.get("Cookie") ?? "")?.[1] ?? null;

// The address is split in the browser and only its domain is sent here, so this Worker never
// sees whose mailbox it is. The home server gets the whole address, on its own origin.
const PAGE = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title>
<style>
	body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f6f7;color:#111}
	form{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 1px 4px #0002;width:min(22rem,90vw)}
	input,button{font:inherit;width:100%;box-sizing:border-box;padding:.6rem .7rem;border-radius:8px;border:1px solid #bbb;margin-top:.6rem}
	button{background:#111;color:#fff;border-color:#111;cursor:pointer}
	p{margin:.8rem 0 0;font-size:.875rem;color:#b00020;min-height:1.3em}
</style>
<form id="f">
	<label for="e">Your email address</label>
	<input id="e" type="email" autocomplete="username" required autofocus>
	<button>Continue</button>
	<p id="m" role="alert"></p>
</form>
<script>
	document.getElementById("f").addEventListener("submit", async (event) => {
		event.preventDefault();
		const email = document.getElementById("e").value.trim().toLowerCase();
		const answer = await fetch("/.well-known/mailflare-home?domain=" + encodeURIComponent(email.split("@")[1] ?? ""));
		if (!answer.ok) return void (document.getElementById("m").textContent = "We do not host mail for that address.");
		const home = await answer.json();
		document.cookie = "home=" + encodeURIComponent(home.server) + "; Path=/; Max-Age=31536000; Secure; SameSite=Lax";
		location.href = home.url + "/login?email=" + encodeURIComponent(email);
	});
</script>`;

const router = {
	async fetch(request, env) {
		const fleet = JSON.parse(env.FLEET || '{"domains":{},"servers":{},"countries":{}}');
		const url = new URL(request.url);

		// What this router believes, without the origins' details: enough to tell drift.
		if (url.pathname === "/.well-known/mailflare-fleet") return json({ version: env.FLEET_VERSION ?? null, domains: Object.keys(fleet.domains).length, servers: Object.keys(fleet.servers).length });

		if (url.pathname === "/.well-known/mailflare-home") {
			const domain = url.searchParams.get("domain") ?? (url.searchParams.get("email") ?? "").split("@")[1];
			if (domain) {
				const home = homeOf(fleet, domain);
				return home ? json(home) : json({ error: "no server hosts that domain" }, 404);
			}
			// No domain yet - someone new. Where a country is at home is a SUGGESTION for them: the
			// country asked about, else the one the request came from. It never routes anyone who has a domain.
			const country = (url.searchParams.get("country") ?? request.cf?.country ?? "").toLowerCase();
			const server = fleet.servers[(fleet.countries ?? {})[country]];
			return server?.url ? json({ country, server: fleet.countries[country], url: server.url, jurisdiction: server.jurisdiction ?? null, suggested: true }) : json({ error: "no server is home to that country", country }, 404);
		}

		if (url.pathname === "/forget") return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": "home=; Path=/; Max-Age=0; Secure; SameSite=Lax" } });

		// Someone who has been here before goes straight home, with the path they asked for.
		const known = fleet.servers[decodeURIComponent(cookieHome(request) ?? "")];
		if (known?.url) return Response.redirect(`${known.url}${url.pathname === "/" ? "" : url.pathname}${url.search}`, 302);

		if (url.pathname === "/" || url.pathname === "/login") return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
		return json({ error: "not found" }, 404);
	},
};

export default router;
