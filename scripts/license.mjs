#!/usr/bin/env node
// Toggle the self-hosted license plan (the gate `getLicenseEntitlements` reads).
// The whole plan state lives in the `license_settings` row, so this only touches data.
//
//   node scripts/license.mjs on   [--plan team|pro] [--local] [--db mailflare]
//   node scripts/license.mjs off
//   node scripts/license.mjs status
//
// Defaults to the remote D1 database. Pass --local for the local dev database.
// GUI: the plan, seats and activation state are shown at <instance>/admin/licenses.
import { parseArgs } from "node:util";
import { d1 as libD1, entitlementsFor, licenceSql } from "./lib.mjs";

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

// License SQL lives in scripts/lib.mjs (licenceSql) so every script shares one copy.

function runWrangler(sql) {
	try {
		return libD1(sql, { db: values.db, local: values.local });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

// Render the current row as plan + per-gate state.
function report(rows) {
	const row = rows[0];
	if (!row) {
		console.log("No license_settings row yet — open Settings → License in the app once, then retry.");
		return;
	}
	const active = row.state === "active" && (row.plan === "pro" || row.plan === "team");
	const gates = entitlementsFor(row.plan, active);
	console.log(`plan=${row.plan}  state=${row.state}  active=${active}`);
	console.log(`  custom branding:   ${gates.branding ? "on" : "off"}`);
	console.log(`  manage accounts:   ${gates.accounts ? "on" : "off"}`);
	console.log(`  email forwarding:  ${gates.forwarding ? "on" : "off"}`);
	console.log(`  shared mailboxes:  ${gates.sharing ? "on" : "off"}`);
	console.log(`  account seats:     ${gates.seatLimit}`);
}

const sql = action === "on" ? licenceSql.on(plan) : action === "off" ? licenceSql.off : licenceSql.status;
if (action !== "status") {
	runWrangler(sql);
	console.log(action === "on" ? `Activated ${plan} license on ${values.db} (${location}).` : `Reverted to community on ${values.db} (${location}).`);
}
report(runWrangler(licenceSql.status));
