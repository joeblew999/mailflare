#!/usr/bin/env node
// Toggle the self-hosted license plan (the gate `getLicenseEntitlements` reads).
// The whole plan state lives in the `license_settings` row, so this only touches data.
//
//   node scripts/license.mjs on   [--plan team|pro] [--local] [--db mailflare]
//   node scripts/license.mjs off
//   node scripts/license.mjs status
//
// Defaults to the remote D1 database. Pass --local for the local dev database.
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const ACTIONS = new Set(["on", "off", "status"]);

const { values, positionals } = parseArgs({
	options: {
		plan: { type: "string", default: "team" },
		db: { type: "string", default: "mailflare" },
		local: { type: "boolean", default: false },
		remote: { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
	allowPositionals: true,
});

function usage() {
	console.log(`Usage: node scripts/license.mjs <on|off|status> [options]

  on       Activate the license (defaults to --plan team)
  off      Revert to the community plan
  status   Print the current plan and gate state

Options:
  --plan <team|pro>   Plan to activate with "on" (default: team)
  --local             Use the local D1 database instead of remote
  --db <name>         D1 database name (default: mailflare)
  -h, --help          Show this help`);
}

if (values.help) {
	usage();
	process.exit(0);
}

const action = positionals[0] ?? "status";
if (!ACTIONS.has(action)) {
	console.error(`Unknown action: ${action}`);
	usage();
	process.exit(1);
}

const plan = (values.plan ?? "team").toLowerCase();
if (action === "on" && plan !== "team" && plan !== "pro") {
	console.error(`--plan must be "team" or "pro" (got "${values.plan}")`);
	process.exit(1);
}

const location = values.local ? "--local" : "--remote";

// Upsert the singleton license row. instance_id is generated in SQL so this also
// works against a fresh database; only plan/state matter on conflict.
const ON = (chosenPlan) => `
INSERT INTO license_settings (id, instance_id, plan, state, features, seat_limit, updated_at)
VALUES (
	'default',
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	'${chosenPlan}', 'active', '[]', 1, strftime('%s','now')
)
ON CONFLICT(id) DO UPDATE SET
	plan = excluded.plan, state = excluded.state, features = excluded.features, updated_at = excluded.updated_at;`;

// Back to the free plan: every gate in getLicenseEntitlements turns off.
const OFF = `
UPDATE license_settings
SET plan = 'community', state = 'inactive', features = '[]', updated_at = strftime('%s','now')
WHERE id = 'default';`;

// Read-only: exactly the columns the app derives its entitlements from.
const STATUS = `SELECT plan, state, seat_limit, features FROM license_settings WHERE id = 'default';`;

function runWrangler(sql) {
	const args = ["wrangler", "d1", "execute", values.db, location, "--json", "--command", sql];
	const result = spawnSync("npx", args, { encoding: "utf8" });
	if (result.error) {
		console.error(`Failed to run wrangler: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		process.stderr.write(result.stderr || result.stdout || "wrangler d1 execute failed\n");
		process.exit(result.status ?? 1);
	}
	try {
		const parsed = JSON.parse(result.stdout);
		const first = Array.isArray(parsed) ? parsed[0] : parsed;
		return first?.results ?? [];
	} catch {
		return [];
	}
}

// Mirrors getLicenseEntitlements (src/lib/licenses/service.ts) so the printed
// summary matches what the app actually enforces.
function entitlements(planValue, active) {
	const isTeam = active && planValue === "team";
	const isPro = active && planValue === "pro";
	return {
		branding: active,
		accounts: active,
		forwarding: active,
		sharing: isTeam,
		seatLimit: isPro ? "from license" : isTeam ? "unlimited" : "1",
	};
}

// Render the current row as plan + per-gate state.
function report(rows) {
	const row = rows[0];
	if (!row) {
		console.log("No license_settings row yet — open Settings → License in the app once, then retry.");
		return;
	}
	const active = row.state === "active" && (row.plan === "pro" || row.plan === "team");
	const gates = entitlements(row.plan, active);
	console.log(`plan=${row.plan}  state=${row.state}  active=${active}`);
	console.log(`  custom branding:   ${gates.branding ? "on" : "off"}`);
	console.log(`  manage accounts:   ${gates.accounts ? "on" : "off"}`);
	console.log(`  email forwarding:  ${gates.forwarding ? "on" : "off"}`);
	console.log(`  shared mailboxes:  ${gates.sharing ? "on" : "off"}`);
	console.log(`  account seats:     ${gates.seatLimit}`);
}

const sql = action === "on" ? ON(plan) : action === "off" ? OFF : STATUS;
if (action !== "status") {
	runWrangler(sql);
	console.log(action === "on" ? `Activated ${plan} license on ${values.db} (${location}).` : `Reverted to community on ${values.db} (${location}).`);
}
report(runWrangler(STATUS));
