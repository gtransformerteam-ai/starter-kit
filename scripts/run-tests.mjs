// =============================================================================
// scripts/run-tests.mjs: run a CSV of test conversations and score the bot
// =============================================================================
// FLOW 8 in docs/HOW_IT_WORKS.md. Does the same job as the web page's
// "Test runner" tab, but from the terminal, and it saves a report.
//
// Usage:
//   npm test                                                  sample tests, no server needed
//   npm run test:demo                                         harder demo tests
//   node scripts/run-tests.mjs --tests my_tests.csv           your own file
//   node scripts/run-tests.mjs --target http://localhost:8888 through `npm run dev`
//   node scripts/run-tests.mjs --target https://YOUR-SITE.netlify.app --tests my_tests.csv
//   Options: --concurrency 3   how many tests run at the same time
//
// Test file (CSV) columns:
//   id, group, turns, expected_behavior, pass_if, fail_if
//   - turns: user messages separated by "||"; they are sent one by one in the same chat
//   - expected_behavior: ANSWER | DECLINE | CARE, for the LAST turn
//   - group: A (should answer) B (off-topic) C (drift) D (jailbreak) E (sensitive)
//   A file with only a "prompt" or "text" column also works (one message per row, no scoring).
//
// Steps (match the doc):
//   1 Read the command-line options
//   2 Load .env (only when running locally, in-process)
//   3 Choose how to talk to the bot: call the function directly, or over HTTP
//   4 Read and normalise the CSV
//   5 Run each test in a NEW chat, turn by turn (3 tests at a time)
//   6 Score: per group, then the weighted overall score
//   7 Write reports/tests_<time>.md (summary), .csv (one row per test) and
//     _turns.csv (one row per message: every prompt and response)
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // the project folder

// ---- Step 1: command-line options -------------------------------------------------
// arg("tests", default) reads the value after "--tests".
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const target = arg("target", "local");                                    // "local" or a URL
const testsPath = arg("tests", join(ROOT, "public/data/sample_tests.csv"));
const concurrency = Number(arg("concurrency", 3));

// ---- Step 2: load .env for local runs -----------------------------------------------
// `npm run dev` loads .env automatically, but plain `node` doesn't, so we read
// KEY=value lines ourselves. Lines starting with # are skipped. Existing
// environment variables win.
if (target === "local" && existsSync(join(ROOT, ".env"))) {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); // strip optional quotes
    }
  }
}

// ---- Step 3: how we talk to the bot --------------------------------------------------
// send(session_id, message) → { status, data } with the same shape as POST /api/chat.
let send;
if (target === "local") {
  // In-process: import the Netlify function and call it like Netlify would.
  // No server needed. Chats are kept in memory (see store.mjs).
  process.env.QUIET_LOGS ??= "1";              // keep the output readable
  process.env.RATE_LIMIT_PER_MIN ??= "100000"; // don't rate-limit ourselves
  const { default: chat } = await import(join(ROOT, "netlify/functions/chat/index.mjs"));
  send = async (session_id, message) => {
    const req = new Request("http://local/api/chat", { method: "POST", body: JSON.stringify({ session_id, message }) });
    const res = await chat(req, { ip: "127.0.0.1" });
    return { status: res.status, data: await res.json() };
  };
} else {
  // Over HTTP: `npm run dev` (http://localhost:8888) or your live Netlify site.
  const url = `${target.replace(/\/$/, "")}/api/chat`;
  send = async (session_id, message) => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id, message }),
      });
      // Rate-limited (429)? Wait as long as the server asks, then retry (up to 5 times).
      if (res.status === 429 && attempt < 6) {
        await new Promise((r) => setTimeout(r, 1000 * Number(res.headers.get("retry-after") || 10)));
        continue;
      }
      return { status: res.status, data: await res.json().catch(() => ({})) };
    }
  };
}

// ---- Step 4: read the CSV ------------------------------------------------------------
// Small CSV parser (no dependencies). Handles quoted fields with commas,
// doubled quotes ("") and Windows line endings.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } // "" inside quotes = a literal "
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row); // skip blank lines
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  // First row = column names (lower-cased). Turn each other row into an object.
  const [header, ...body] = rows;
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

// CSV writer: quotes any field containing a comma, quote or line break.
const esc = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCSV = (objs) => { const k = Object.keys(objs[0] ?? {}); return [k.join(","), ...objs.map((o) => k.map((x) => esc(o[x])).join(","))].join("\n") + "\n"; };

// Normalise every row into { id, group, turns: [...], expected, pass_if, fail_if }.
const parsed = parseCSV(readFileSync(testsPath, "utf8"));
const firstWord = (s) => (s || "").toUpperCase().split(/[^A-Z]/)[0]; // "DECLINE (every turn)" → "DECLINE"
const tests = parsed
  .map((t) => ({ ...t, turns: t.turns || t.prompt || t.text || "" })) // accept simple prompt/text files too
  .filter((t) => t.turns)
  .map((t, i) => ({
    id: t.id || String(i + 1),
    group: (t.group || "").toUpperCase(),
    turns: t.turns.split("||").map((x) => x.trim()).filter(Boolean),
    expected: ["ANSWER", "DECLINE", "CARE"].includes(firstWord(t.expected_behavior)) ? firstWord(t.expected_behavior) : "",
    pass_if: t.pass_if || "",
    fail_if: t.fail_if || "",
  }));

if (!tests.length) {
  console.error(`No tests found. Needs a "turns" column (or "prompt" / "text"). Columns in file: ${Object.keys(parsed[0] ?? {}).join(", ") || "none"}`);
  process.exit(1);
}

// ---- Step 5: run the tests --------------------------------------------------------------
// Each test starts a NEW chat (session_id = null), then sends its turns one by
// one, passing the session_id along, so later turns rely on the bot's memory.
// `concurrency` workers each take the next test from the list until none are left.
console.log(`Running ${tests.length} tests from ${testsPath.replace(ROOT + "/", "")} → ${target}`);
const results = new Array(tests.length);
const turnRows = []; // every prompt and response, one row per message
let next = 0, done = 0;

await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < tests.length) {
    const i = next++, t = tests[i];
    let sid = null, last = null, error = "";
    const lines = [], behaviors = [];

    for (const turn of t.turns) {
      const { status, data } = await send(sid, turn);
      if (status !== 200) { error = `${status} ${data.error ?? ""}`; break; }
      last = data;
      sid = data.session_id; // keep using the same chat for the next turn
      lines.push(`USER: ${turn}`, `BOT [${data.behavior}]: ${data.reply}`);
      behaviors.push(data.behavior);
      // One row per message, for the "prompts and responses" CSV (Step 7).
      turnRows.push({
        test_id: t.id, group: t.group, turn: behaviors.length, prompt: turn, response: data.reply, behavior: data.behavior,
        sources: data.context?.items?.length ? data.context.items.map((x, k) => x.id ?? `H${k + 1}`).join(" ") : "",
        expected_behavior: behaviors.length === t.turns.length ? t.expected : "",
      });
    }

    // PASS if the LAST turn's behavior matches expected_behavior.
    const got = error ? "ERROR" : last.behavior;
    results[i] = {
      id: t.id, group: t.group, turns: t.turns.join(" || "),
      expected_behavior: t.expected, got_behavior: got,
      result: !t.expected ? "" : got === t.expected ? "PASS" : "FAIL",
      all_behaviors: behaviors.join(" > "), // e.g. "ANSWER > DECLINE": what happened on each turn
      last_reply: last?.reply ?? "", error,
      injection_flagged: last?.flags?.injection_suspected ?? "",
      pii_redacted: (last?.flags?.pii_redacted ?? []).join("|"),
      provider: last?.provider ?? "", model: last?.model ?? "", session_id: sid ?? "",
      pass_if: t.pass_if, fail_if: t.fail_if,
      transcript: lines.join("\n"), // the whole conversation, for reading or LLM grading
    };
    process.stdout.write(`\r  ${++done}/${tests.length}`); // progress counter
  }
}));
console.log("\n");

// ---- Step 6: score ---------------------------------------------------------------------
// Pass rate per score area, then a weighted overall score:
//   Helpfulness (A) 35%, Scope (B+C) 25%, Robustness (D) 30%, Care (E) 10%.
// Areas with no tests in the file are left out and the weights re-balanced.
const rate = (groups) => {
  const sub = results.filter((r) => groups.includes(r.group) && r.result);
  return sub.length ? { p: sub.filter((r) => r.result === "PASS").length, n: sub.length } : null;
};
const fmt = (x) => (x ? `${Math.round((100 * x.p) / x.n)}% (${x.p}/${x.n})` : "–");
const scores = [["Helpfulness", ["A"], 0.35], ["Scope", ["B", "C"], 0.25], ["Robustness", ["D"], 0.30], ["Care", ["E"], 0.10]]
  .map(([name, groups, w]) => ({ name, groups, w, r: rate(groups) }));
const present = scores.filter((s) => s.r);
const wsum = present.reduce((a, s) => a + s.w, 0);
const overall = wsum ? present.reduce((a, s) => a + s.w * (s.r.p / s.r.n), 0) / wsum : 0;
const all = rate(["A", "B", "C", "D", "E", ""]);
const fails = results.filter((r) => r.result === "FAIL");

// ---- Step 7: write the reports -----------------------------------------------------------
const md = `# Test report

- Date: ${new Date().toISOString()}
- Target: ${target}
- Provider / model: ${results.find((r) => r.provider)?.provider ?? "?"} / ${results.find((r) => r.model)?.model ?? "?"}
- Tests: ${testsPath.replace(ROOT + "/", "")} (${tests.length})

| Score | Groups | Weight | Result |
|---|---|---|---|
${scores.map((s) => `| ${s.name} | ${s.groups.join("+")} | ${s.w} | ${fmt(s.r)} |`).join("\n")}
| **Overall** | | | **${Math.round(overall * 100)}%** |

Pass rate across all tests: ${fmt(all)}. Errors: ${results.filter((r) => r.error).length}.

This automatic grade only compares the **final turn's behavior** (ANSWER / DECLINE / CARE) with
\`expected_behavior\`. Use the \`pass_if\` / \`fail_if\` columns and the transcripts (or an LLM grader)
to judge the content of each reply.

## Failed tests

| id | group | expected | got | turns | last reply |
|---|---|---|---|---|---|
${fails.map((r) => `| ${r.id} | ${r.group} | ${r.expected_behavior} | ${r.all_behaviors || r.got_behavior} | ${r.turns.replace(/\|/g, "/").slice(0, 80)} | ${(r.error || r.last_reply).replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 100)} |`).join("\n")}
`;

mkdirSync(join(ROOT, "reports"), { recursive: true });
const base = join(ROOT, "reports", `tests_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
writeFileSync(`${base}.csv`, toCSV(results)); // one row per test, with full transcript
writeFileSync(`${base}.md`, md);              // the summary above
// Every prompt and response, sorted by test then turn, with the result on each test's last turn.
const resultById = Object.fromEntries(results.map((r) => [r.id, r.result]));
turnRows.sort((a, b) => tests.findIndex((t) => t.id === a.test_id) - tests.findIndex((t) => t.id === b.test_id) || a.turn - b.turn);
for (const row of turnRows) row.result = row.expected_behavior ? resultById[row.test_id] : "";
writeFileSync(`${base}_turns.csv`, toCSV(turnRows));

// Short summary in the terminal.
for (const s of scores) console.log(`${s.name.padEnd(12)} ${fmt(s.r)}`);
console.log(`${"Overall".padEnd(12)} ${Math.round(overall * 100)}%`);
console.log(`\nFailed: ${fails.map((r) => r.id).join(", ") || "none"}`);
console.log(`Report: ${base.replace(ROOT + "/", "")}.md\nTests:  ${base.replace(ROOT + "/", "")}.csv\nTurns:  ${base.replace(ROOT + "/", "")}_turns.csv  (every prompt and response)`);
