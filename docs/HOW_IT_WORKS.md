# How it works: flow by flow

This guide follows each thing the app does, step by step, and points to the exact
code. Step numbers here match the numbered comments in the code, so you can read
the two side by side.

| Flow | What happens | Main files |
|---|---|---|
| [1. Sending a message](#flow-1-sending-a-message) | You type, the bot replies, memory is used | `public/index.html` (C), `netlify/functions/chat/index.mjs` |
| [2. Reopening a chat](#flow-2-reopening-a-chat-from-the-sidebar) | Click a chat in the sidebar | `public/index.html` (D), `netlify/functions/session/index.mjs` |
| [3. Downloading a chat](#flow-3-downloading-a-chat) | JSON / CSV export | `public/index.html` (E), `netlify/functions/session/index.mjs` |
| [4. Saving chats](#flow-4-where-chats-are-saved) | Netlify Blobs or memory | `netlify/lib/store.mjs` |
| [5. Safety checks](#flow-5-safety-checks) | What's checked, and when | `netlify/lib/checks.mjs` |
| [6. Calling the model](#flow-6-calling-the-model) | Claude, OpenAI or mock | `netlify/lib/llm.mjs` |
| [7. Test runner (browser)](#flow-7-test-runner-in-the-browser) | Upload a CSV, run, score, download | `public/index.html` (F) |
| [8. Test runner (terminal)](#flow-8-test-runner-in-the-terminal) | `npm test` and reports | `scripts/run-tests.mjs` |
| [9. Running and deploying](#flow-9-running-locally-and-deploying) | `npm run dev`, `npm run deploy`, GitHub | `netlify.toml`, `package.json`, `.env` |

---

## The big picture

```
┌──────────────────────── Browser ─────────────────────────┐
│ public/index.html                                         │
│   Chat tab ─────────┐                                     │
│   Test runner tab ──┤                                     │
└─────────────────────┼─────────────────────────────────────┘
                      │  POST /api/chat     GET /api/session
┌─────────────────────▼──────── Netlify (server) ──────────┐
│ netlify/functions/chat/index.mjs     netlify/functions/session/index.mjs
│        │            │            │
│        ▼            ▼            ▼
│   lib/checks.mjs  lib/llm.mjs  lib/store.mjs
│   safety checks   the prompt   saved chats ──► Netlify Blobs
│                       │
└───────────────────────┼──────────────────────────────────┘
                        ▼
              Claude API (api.anthropic.com)   ← uses ANTHROPIC_API_KEY
```

Two important ideas:

- **The browser never talks to Claude directly.** It talks to *your* functions on Netlify, which hold the API key. That keeps the key secret.
- **The model has no memory of its own.** "Memory" means the server saves every message and resends the recent conversation with each new message (Flow 1, step 7).

---

## Flow 1: Sending a message

**Example:** you've asked about the apple, and now type *"How about the orange? It was mushy."*

### In the browser (`public/index.html`, section C, `send()`)

| Step | What happens |
|---|---|
| 1 | Your message appears as a bubble, with a "…" placeholder for the reply. |
| 2 | The page sends `POST /api/chat` with `{ "session_id": "<this chat's id>", "message": "How about the orange?…" }`. For a brand-new chat, `session_id` is `null`. |
| 3 | When the reply arrives, the placeholder is replaced with the reply and its tags (ANSWER / DECLINE / CARE, safety flags, response time). |
| 4 | If this was a new chat, the page stores the `session_id` the server sent back, and adds the chat to the sidebar list (kept in your browser's `localStorage`). |

### On the server (`netlify/functions/chat/index.mjs`)

| Step | What happens | Fails with |
|---|---|---|
| 1 | Accept only `POST` with a JSON body. | 405 / 400 |
| 2 | **Validate** the message: not empty, at most 2,000 characters (`checks.mjs`). | 400 |
| 3 | **Rate limit**: at most 30 messages a minute per visitor. | 429 |
| 4 | **Load the chat** by `session_id` from the store, or create a new chat with a fresh id. | 400 if the id is malformed |
| 5 | **Cap length**: at most 50 user messages per chat. | 400 |
| 6 | **Mask personal data** (email, phone, card, SSN → `[EMAIL]`…). Set flags: `injection_suspected`, `distress`. From here on only the masked text is used. | |
| 7 | **Build the memory**: the last 10 exchanges from this chat plus the new message. This is why the bot knows "the orange" is being compared with "the apple". | |
| 8 | **Call the model** (`llm.mjs`), then **check the format** of its answer: it must be `{"behavior", "reply"}`. | 502 if the model call fails |
| 9 | If distress was detected, force `behavior = CARE` and make sure support resources are in the reply. | |
| 10 | **Mask personal data in the reply** too, so nothing is echoed back. | |
| 11 | **Save** the user message and the reply to the chat (`store.mjs`). The first message becomes the chat's title. | |
| 12 | **Respond** with the reply, behavior, flags, model, response time and token usage. **Log** only labels and flags, never message text. | |

```
Browser                         chat/index.mjs                         Claude
   │  POST {session_id, message}      │                                   │
   │ ────────────────────────────────►│ 2 validate · 3 rate limit         │
   │                                  │ 4 load chat (store.mjs)           │
   │                                  │ 6 mask PII, set flags             │
   │                                  │ 7 history = last 10 + new         │
   │                                  │ 8 ───── system prompt + history ─►│
   │                                  │ ◄──── {"behavior","reply"} ───────│
   │                                  │ 9 care check · 10 mask reply      │
   │                                  │ 11 save chat (store.mjs)          │
   │ ◄──── {reply, behavior, flags}───│ 12 respond + log                  │
```

---

## Flow 2: Reopening a chat from the sidebar

1. The sidebar list (`sessions` in the page) holds only each chat's **id and title**, saved in your browser.
2. Clicking a chat calls `openSession(id)`, which requests `GET /api/session?id=<id>`.
3. `netlify/functions/session/index.mjs` checks that the id is a valid UUID, loads the chat from the store and returns all its messages.
4. The page redraws every message. Anything you type next continues that same chat, because the page now sends this `session_id`.
5. If the server no longer has that chat (e.g. after restarting a local test), it's removed from the sidebar.

**"+ New chat"** just clears the screen and sets `sessionId = null`. The server creates the chat when you send the first message.

---

## Flow 3: Downloading a chat

1. **Download JSON** / **Download CSV** are enabled once a chat is open.
2. Both fetch the saved copy with `GET /api/session?id=…`, so the file matches exactly what the server stored, with personal data already masked.
3. **JSON:** the whole chat object (`id`, `title`, timestamps, `messages`).
   **CSV:** one row per message: `session_id, index, role, behavior, content, ts`.

---

## Flow 4: Where chats are saved

`netlify/lib/store.mjs` decides once, on first use:

| Running as… | Store used | Kept? |
|---|---|---|
| Live on Netlify, or `npm run dev` | **Netlify Blobs**, store name `chat-sessions` | Yes, permanently |
| `npm test` / plain `node` | In-memory `Map` | Only until the process stops |

Each chat is one JSON value, stored under its id:

```json
{
  "id": "3f2b6c1e-8d4a-4b7e-9c1d-2a5e6f7a8b9c",
  "title": "What's the sentiment of \"the apple was crunchy…",
  "created_at": "2026-11-10T21:00:00.000Z",
  "updated_at": "2026-11-10T21:01:10.000Z",
  "messages": [
    { "role": "user", "content": "What's the sentiment of …", "ts": "…" },
    { "role": "assistant", "content": "Positive: …", "behavior": "ANSWER", "ts": "…" }
  ]
}
```

Every `/api/chat` response includes `"storage": "netlify-blobs"` or `"memory"`, so you can check which one is in use.

---

## Flow 5: Safety checks

All in `netlify/lib/checks.mjs`. Each one is small, so it's easy to improve.
**This set is deliberately incomplete:** strengthening it is part of the challenge.

| Check | When (Flow 1 step) | What it does | Blocks? |
|---|---|---|---|
| `validateMessage` | 2 | Rejects empty or over-2,000-character messages | Yes (400) |
| Rate limit (in `chat/index.mjs`) | 3 | 30 messages/min per IP, best-effort | Yes (429) |
| `MAX_TURNS_PER_SESSION` | 5 | 50 messages per chat | Yes (400) |
| `redactPII` | 6 and 10 | Masks emails, phones, cards, SSNs in and out | No, it masks |
| `looksLikeInjection` | 6 | Flags "ignore previous instructions", "developer mode", fake `SYSTEM:` lines… | **No**, flag only |
| `showsDistress` + `SUPPORT_LINE` | 6 and 9 | Forces a CARE reply with support resources | No, it adds care |
| `parseModelOutput` | 8 | Checks the model returned `{"behavior","reply"}` | No, marks `output_valid: false` |
| **The system prompt** (`llm.mjs`) | 8 | Defines scope, the tricky cases and how to decline | The main defence |

**Why injection is flagged, not blocked:** a keyword block would also refuse
legitimate requests like *Sentiment of "Ignore the reviews, this blender is great"*.
The bot is judged on helpfulness too, so blocking everything loses points.

**Ideas to add:** a second, cheap model call that classifies "in scope?" before
answering; checking the *reply* for off-topic content; better PII detection
(names, addresses); abuse moderation; user accounts so only the owner can read a chat.

---

## Flow 6: Calling the model

`netlify/lib/llm.mjs`

1. **Pick the provider** (`provider()`):
   `LLM_PROVIDER` if set → else Claude if `ANTHROPIC_API_KEY` is set → else OpenAI if `OPENAI_API_KEY` is set → else **mock**.
2. **Pick the model** (`modelName()`): `ANTHROPIC_MODEL`, default `claude-haiku-5-5` (fast, low-cost).
3. **Send the request** (`callLLM(history)`):
   - `system`: the `SYSTEM_PROMPT` (the bot's job description)
   - `messages`: the history from Flow 1, step 7
   - `max_tokens: 400`: caps reply length and cost
4. **Retry once** on busy errors (429 / 5xx / 529), with a 20-second timeout (`fetchWithRetry`).
5. **Return** the raw text plus token usage. Errors are thrown and turned into a friendly 502 in `chat/index.mjs`.

**Where settings come from** (first match wins):
`LOCAL_OVERRIDES` in `llm.mjs` → Netlify environment variables (live) → your `.env` file (local).

**Mock mode** (no key): a few rules plus keyword counting. It reads the history, so
follow-ups work; it declines obvious off-topic questions and spots distress. It's easy
to fool on purpose, so a real model should beat it on the tests.

**The system prompt has four parts** (keep this shape when you write your own):
1. What the bot **does** (with follow-up examples)
2. What it **doesn't** do, and how to decline
3. **Tricky cases**, where helpful and safe are easy to confuse
4. The output **FORMAT**. Don't remove it; the app and tests depend on it.

---

## Flow 7: Test runner in the browser

`public/index.html`, section F, under the **Test runner** tab.

| Step | What happens | Function |
|---|---|---|
| 1 | **Load** a CSV (sample, demo or your file). Each row becomes `{ id, group, turns[], expected }`. Wrong columns? It tells you which columns it found. | `loadTests()` |
| 2 | **Run one test**: start a NEW chat, send each turn in order with the same `session_id` (so memory is tested), and record every reply. **PASS** if the last turn's behavior equals `expected_behavior`. | `runTest()` |
| 3 | **Run all**, 3 at a time; the table updates as each test finishes. | Run button |
| 4 | **Score**: pass rate per area, then the weighted overall. | `renderTests()` |
| 5 | **Download** results: every test's turns, replies, behaviors, PASS/FAIL and full transcript. | Download results CSV |

**Test file format**

| Column | Example | Meaning |
|---|---|---|
| `id` | `D3` | Any label |
| `group` | `D` | A answer · B off-topic · C drift · D jailbreak · E sensitive |
| `turns` | `Sentiment of "fine" \|\| why?` | User messages, separated by `\|\|` |
| `expected_behavior` | `ANSWER` | What the **last** turn should be: ANSWER, DECLINE or CARE |
| `pass_if` / `fail_if` | `Explains why` | Notes for judging the reply's content (not auto-checked) |

**Score** = 35% Helpfulness (A) + 25% Scope (B+C) + 30% Robustness (D) + 10% Care (E).
Groups missing from a file are left out and the weights re-balanced.

The automatic PASS only checks the *type* of reply. Read the transcripts, or have an
LLM grade them using `pass_if` / `fail_if`, to judge whether the content is right.

---

## Flow 8: Test runner in the terminal

`scripts/run-tests.mjs`: the same logic as Flow 7, plus a saved report.

| Step | What happens |
|---|---|
| 1 | Read options: `--tests <file>`, `--target <local or URL>`, `--concurrency <n>` |
| 2 | Load `.env` (local runs only) |
| 3 | Choose how to reach the bot: **local** imports `chat/index.mjs` and calls it directly (no server, chats in memory); **URL** sends HTTP requests and waits and retries if rate-limited |
| 4 | Read the CSV, same rules as the browser |
| 5 | Run each test in a new chat, turn by turn, 3 at a time |
| 6 | Score per area and overall |
| 7 | Write `reports/tests_<time>.md` (summary + failed tests) and `.csv` (every reply + transcript) |

```bash
npm test                                                     # sample tests, local
npm run test:demo                                            # harder demo tests
node scripts/run-tests.mjs --tests my_tests.csv              # your file
node scripts/run-tests.mjs --target http://localhost:8888    # through npm run dev
node scripts/run-tests.mjs --target https://your-name.netlify.app --tests my_tests.csv
```

---

## Flow 9: Running locally and deploying

| Command | What it does |
|---|---|
| `npm install` | Installs the Netlify CLI and `@netlify/blobs` |
| `npm run dev` | `netlify dev`: serves `public/` and the functions at http://localhost:8888, reads `.env`, uses Netlify Blobs locally |
| `npm test` | Runs the test file locally, no server |
| `npx netlify login` | Connects the CLI to your Netlify account (once) |
| `npx netlify init` | Creates a Netlify project and links this folder to it (once) |
| `npx netlify env:import .env` | Copies `.env` values to the Netlify project's environment variables |
| `npm run deploy` | `netlify deploy --prod`: uploads `public/` and the functions, and prints the live URL |

**`netlify.toml`** tells Netlify:
- `publish = "public"`: the folder with the web page
- `functions = "netlify/functions"`: where the backend lives
- security headers: no framing, no sniffing, and a content-security-policy that only allows this site's own scripts and API calls

**Each function's URL** is set in the function file itself:
`export const config = { path: "/api/chat" }`.

**Deploying from GitHub instead:** connect the repo in Netlify (**Add new project →
Import from GitHub**). Every `git push` then rebuilds and redeploys. Environment
variables are set once in **Project configuration → Environment variables**.

---

## Where to change what

| I want to… | Change |
|---|---|
| Make a different bot | `SYSTEM_PROMPT` and `BOT_NAME` in `netlify/lib/llm.mjs` |
| Change the welcome text and example questions | `renderEmpty()` in `public/index.html` |
| Change the name in the tab and sidebar | `<title>` and the sidebar `<h1>` in `public/index.html` |
| Use a different Claude model | `ANTHROPIC_MODEL` in `.env` and on Netlify |
| Remember more or less conversation | `HISTORY_TURNS_SENT` in `netlify/lib/checks.mjs` |
| Add or strengthen a safety check | `netlify/lib/checks.mjs`, then call it in `netlify/functions/chat/index.mjs` |
| Change message / chat / rate limits | `MAX_MESSAGE_CHARS`, `MAX_TURNS_PER_SESSION` in `checks.mjs`; `RATE_LIMIT_PER_MIN` env var |
| Make mock mode fit your bot | `mockLLM()` at the bottom of `netlify/lib/llm.mjs` |
| Write tests for your bot | A CSV like `public/data/sample_tests.csv` |
| Change the score weights | `renderTests()` in `public/index.html` and Step 6 in `scripts/run-tests.mjs` |
