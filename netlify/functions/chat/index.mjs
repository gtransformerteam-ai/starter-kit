// =============================================================================
// netlify/functions/chat/index.mjs: POST /api/chat
// =============================================================================
// The main backend. Every chat message (from the web page or the test runner)
// comes here. It is a Netlify Function: Netlify runs this file on its servers
// whenever someone calls /api/chat, so the API key never reaches the browser.
//
// Request : { "session_id": "<uuid>" (omit for a new chat), "message": "..." }
// Response: { session_id, turn, behavior, reply, flags, provider, model,
//             prompt_version, storage, latency_ms, usage }
//
// FLOW 1 in docs/HOW_IT_WORKS.md. The step numbers below match the doc:
//   1  Accept only POST with a JSON body
//   2  Validate the message (empty / too long)
//   3  Rate-limit the caller
//   4  Load the chat session, or create a new one
//   5  Stop if the chat is too long
//   6  Mask personal data, and flag injection / distress
//   7a Add extra context if the question needs it:
//        RAG (matching product reviews, FLOW 10) or live data from an external API (FLOW 11)
//   7  Build the conversation history the model will see (this is the "memory")
//   8  Call the model and check its answer format
//   9  Force a caring reply if distress was detected
//   10 Remove personal data from the reply
//   11 Save both messages to the session
//   12 Return the reply, and log (without message text)
// =============================================================================

import { loadSession, saveSession, newSession, isValidId, storageKind } from "../../lib/store.mjs";
import {
  validateMessage, redactPII, looksLikeInjection, showsDistress, parseModelOutput,
  SUPPORT_LINE, MAX_TURNS_PER_SESSION, HISTORY_TURNS_SENT,
} from "../../lib/checks.mjs";
import { callLLM, provider, modelName, env, PROMPT_VERSION } from "../../lib/llm.mjs";
import { retrieve, wantsReviews, formatReviews } from "../../lib/rag.mjs";
import { wantsNews, fetchTopHeadlines, formatHeadlines, NEWS_UNAVAILABLE } from "../../lib/external.mjs";

// -----------------------------------------------------------------------------
// Rate limiter used in step 3.
// Remembers the timestamps of recent requests per IP address and refuses
// anything over RATE_LIMIT_PER_MIN in the last 60 seconds.
// Limitation: it lives in this function instance's memory, so it is
// best-effort (Netlify may run several instances). Good enough for a demo;
// use a shared store (e.g. Netlify Blobs or Redis) for real traffic.
// -----------------------------------------------------------------------------
const hits = new Map(); // ip -> [timestamp, timestamp, ...]

function rateLimited(ip) {
  const limit = Number(env("RATE_LIMIT_PER_MIN") || 30);
  const now = Date.now();
  // Keep only requests from the last 60 seconds, then add this one.
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > limit;
}

// -----------------------------------------------------------------------------
// The handler. Netlify calls this with a standard web Request object and a
// `context` object (context.ip is the caller's IP address).
// -----------------------------------------------------------------------------
export default async (req, context) => {
  const started = Date.now(); // used for latency_ms in the response

  // ---- Step 1: accept only POST with a JSON body ---------------------------
  if (req.method !== "POST") return Response.json({ error: "Use POST" }, { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Body must be JSON: {"message": "..."}' }, { status: 400 });
  }

  // ---- Step 2: validate the message ----------------------------------------
  // Rejects empty messages and messages over MAX_MESSAGE_CHARS (see checks.mjs).
  const input = validateMessage(body?.message);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });

  // ---- Step 3: rate limit ----------------------------------------------------
  // 429 + retry-after tells well-behaved clients (like scripts/run-tests.mjs)
  // to wait and try again.
  if (rateLimited(context?.ip ?? "unknown")) {
    return Response.json(
      { error: "Too many messages, please slow down." },
      { status: 429, headers: { "retry-after": "10" } }
    );
  }

  // ---- Step 4: load the session, or create a new one -----------------------
  // The browser sends the session_id it got back from the first message.
  // We only accept proper UUIDs, so nobody can use odd keys in the store.
  let session = null;
  if (body.session_id != null) {
    if (!isValidId(body.session_id)) return Response.json({ error: "invalid session_id" }, { status: 400 });
    session = await loadSession(body.session_id);
  }
  // No id, or an id we've never seen (e.g. after a local restart): start a new chat.
  session ??= newSession(isValidId(body.session_id) ? body.session_id : crypto.randomUUID());

  // ---- Step 5: cap the conversation length (cost control) -------------------
  const userTurns = session.messages.filter((m) => m.role === "user").length;
  if (userTurns >= MAX_TURNS_PER_SESSION) {
    return Response.json({ error: "This conversation is full. Please start a new chat." }, { status: 400 });
  }

  // ---- Step 6: mask personal data, and raise flags ---------------------------
  // From here on we only use `redacted.text`: the model, the saved chat and
  // the logs never see the original email / phone / card / SSN.
  const redacted = redactPII(input.text);
  const flags = {
    pii_redacted: redacted.found,                     // e.g. ["email", "phone"]
    injection_suspected: looksLikeInjection(input.text), // flagged, NOT blocked
    distress: showsDistress(input.text),                // triggers step 9
    output_valid: true,                                  // updated in step 8
  };

  // ---- Step 7a: add extra context (RAG or external API) --------------------------
  // A simple "router" decides whether this question needs outside information:
  //   - asks for current headlines        → call the Hacker News API (external.mjs)
  //   - asks about the product / reviews  → retrieve matching reviews (rag.mjs)
  //     (also for short follow-ups like "and the price?" right after a review answer)
  //   - otherwise                         → no extra context
  // The extra context is put IN FRONT of the user's message for the model only.
  // It is not saved in the chat history; only which sources were used is saved.
  let extra = null;        // { type: "rag" | "api", source, items: [...] }, returned to the browser
  let contextText = "";    // the text block the model sees
  const lastBot = [...session.messages].reverse().find((m) => m.role === "assistant");

  if (wantsNews(redacted.text)) {
    try {
      const items = await fetchTopHeadlines(5);
      extra = { type: "api", source: "Hacker News API", items };
      contextText = formatHeadlines(items);
    } catch (err) {
      // The API is down or slow: keep chatting, and tell the model so it can say so.
      console.error(JSON.stringify({ event: "external_api_error", message: String(err.message).slice(0, 200) }));
      extra = { type: "api", source: "Hacker News API", items: [], error: "unavailable" };
      contextText = NEWS_UNAVAILABLE;
    }
  } else if (wantsReviews(redacted.text, lastBot?.context_type)) {
    const hits = retrieve(redacted.text); // top matching reviews, best first
    extra = { type: "rag", source: "Aurora X2 reviews", items: hits };
    contextText = hits.length
      ? formatReviews(hits)
      : "REFERENCE REVIEWS: no reviews matched this question. Say the reviews don't cover it; don't guess.";
  }

  // ---- Step 7: build the conversation history (the "memory") ----------------
  // The model itself remembers nothing between calls. We resend the last
  // HISTORY_TURNS_SENT exchanges every time, followed by the new message.
  // That is how "how about the orange?" is understood after the apple question.
  // Past bot replies are sent back in the same JSON shape we ask the model to
  // use, which helps it keep answering in that format.
  const past = session.messages.slice(-HISTORY_TURNS_SENT * 2).map((m) => ({
    role: m.role,
    content: m.role === "assistant" ? JSON.stringify({ behavior: m.behavior, reply: m.content }) : m.content,
  }));
  const userForModel = contextText ? `${contextText}\n\nUSER MESSAGE:\n${redacted.text}` : redacted.text;
  const history = [...past, { role: "user", content: userForModel }];

  // ---- Step 8: call the model and check its answer ---------------------------
  // callLLM (llm.mjs) picks Claude, OpenAI or the mock model.
  // parseModelOutput (checks.mjs) makes sure we got {"behavior", "reply"}.
  let behavior, reply, usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const llm = await callLLM(history);
    usage = llm.usage;
    const parsed = parseModelOutput(llm.raw);
    flags.output_valid = parsed.ok;
    ({ behavior, reply } = parsed);
  } catch (err) {
    // Network error, bad key, no credits, timeout... Log the reason for the
    // developer (visible in Netlify → Logs → Functions), show a generic message to the user.
    console.error(JSON.stringify({ event: "llm_error", message: String(err.message).slice(0, 300) }));
    return Response.json({ error: "The assistant is unavailable right now. Please try again." }, { status: 502 });
  }

  // ---- Step 9: distress always gets support resources ------------------------
  // A safety net that doesn't depend on the model getting it right.
  if (flags.distress) {
    behavior = "CARE";
    if (!reply.includes("988")) reply = `${reply} ${SUPPORT_LINE}`.trim();
  }

  // ---- Step 10: never echo personal data back --------------------------------
  reply = redactPII(reply).text;

  // ---- Step 11: save both messages to the session ----------------------------
  // The chat title is the first message (shown in the sidebar and downloads).
  session.messages.push({ role: "user", content: redacted.text, ts: new Date().toISOString() });
  session.messages.push({
    role: "assistant", content: reply, behavior, ts: new Date().toISOString(),
    // Remember which sources were used, so follow-ups can reuse RAG (step 7a)
    // and reopened chats can show the source tags.
    ...(extra && { context_type: extra.type, context_source: extra.source, context_ids: extra.items.map((x, i) => x.id ?? `H${i + 1}`) }),
  });
  if (!session.title) session.title = redacted.text.slice(0, 60);
  await saveSession(session);

  // ---- Step 12: respond, and log without message text ------------------------
  const response = {
    session_id: session.id,   // the browser keeps this and sends it with the next message
    turn: userTurns + 1,
    behavior,                 // ANSWER | DECLINE | CARE (used by the test runner)
    reply,                    // what the user sees
    flags,
    context: extra,         // which reviews / headlines were given to the model (null if none)
    provider: provider(),     // anthropic | openai | mock
    model: modelName(),
    prompt_version: PROMPT_VERSION,
    storage: await storageKind(), // netlify-blobs | memory
    latency_ms: Date.now() - started,
    usage,                    // tokens, for cost estimates
  };

  // QUIET_LOGS is set by the test script to keep its output readable.
  if (!env("QUIET_LOGS")) {
    console.log(JSON.stringify({ event: "chat", turn: response.turn, behavior, flags, context_type: extra?.type ?? null, latency_ms: response.latency_ms }));
  }
  return Response.json(response);
};

// Tells Netlify which URL this function answers on.
export const config = { path: "/api/chat" };
