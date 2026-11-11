// =============================================================================
// netlify/lib/checks.mjs: the starter safety checks
// =============================================================================
// FLOW 5 in docs/HOW_IT_WORKS.md.
//
// This is deliberately NOT a complete set. Teams are judged on how safe AND
// how helpful their bot is, so improving these checks is part of the challenge.
// Each check is a small, separate function so it is easy to read, test and extend.
//
// Where each check is used (step numbers from chat/index.mjs):
//   validateMessage    → step 2   reject empty / too-long messages
//   MAX_TURNS_...      → step 5   cap chat length
//   redactPII          → steps 6 and 10   mask personal data in and out
//   looksLikeInjection → step 6   flag jailbreak attempts (does not block)
//   showsDistress      → steps 6 and 9    force a caring reply
//   parseModelOutput   → step 8   check the model answered in the right format
// =============================================================================

// ---- Limits -------------------------------------------------------------------
export const MAX_MESSAGE_CHARS = 2000;   // longest message we accept (cost + abuse control)
export const MAX_TURNS_PER_SESSION = 50; // most user messages in one chat
export const HISTORY_TURNS_SENT = 10;    // how many past exchanges the model sees (the "memory window")

// ---- Check 1: input validation ---------------------------------------------------
// Returns { ok: true, text } with surrounding spaces trimmed, or { ok: false, error }.
export function validateMessage(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "message is required" };
  if (text.length > MAX_MESSAGE_CHARS) return { ok: false, error: `message is too long (max ${MAX_MESSAGE_CHARS} characters)` };
  return { ok: true, text: text.trim() };
}

// ---- Check 2: personal data (PII) masking -----------------------------------------
// Replaces emails, card numbers, SSNs and phone numbers with placeholders like
// [EMAIL] before the text reaches the model, the saved chat or the logs.
// Simple patterns on purpose: they miss names and addresses. Improve me!
// Order matters: cards and SSNs are matched before phone numbers.
const PII = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["card", /\b(?:\d[ -]?){13,16}\b/g],                               // 13–16 digits, spaces/dashes allowed
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],                                  // 123-45-6789
  ["phone", /(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g], // US-style numbers
];

// Returns { text: "masked text", found: ["email", "phone", ...] }.
export function redactPII(text) {
  const found = new Set();
  let out = text;
  for (const [type, re] of PII) {
    out = out.replace(re, () => {
      found.add(type);
      return `[${type.toUpperCase()}]`;
    });
  }
  return { text: out, found: [...found] };
}

// ---- Check 3: prompt-injection signal -------------------------------------------
// Spots common jailbreak phrasing. We only FLAG it (flags.injection_suspected),
// we don't block, because blocking on keywords also blocks legitimate text such
// as "Ignore the reviews, this blender is great". The real defence is the
// system prompt in llm.mjs; this flag helps you spot attacks in tests and logs.
const INJECTION = [
  /ignore (all |any )?(the )?(previous|prior|above|earlier|your) (instructions|prompts?|rules)/i,
  /disregard (all |any )?(the )?(previous|prior|above|your) (instructions|rules|prompt)/i,
  /(reveal|show|print|repeat) (me )?(your|the) (system )?(prompt|instructions|rules)/i,
  /(developer|dan|admin|god|jailbreak) mode/i,
  /pretend (you are|you're|to be) (a |an )?(general|different|unrestricted)/i,
  /^\s*(system|admin|developer)\s*:/im, // fake "SYSTEM:" messages
];
export const looksLikeInjection = (text) => INJECTION.some((re) => re.test(text));

// ---- Check 4: distress ------------------------------------------------------------
// If someone mentions self-harm or hopelessness, the reply always includes
// support resources (step 9), whatever the model said.
const DISTRESS = [
  /\b(kill|hurt|harm) (myself|me)\b/i,
  /\b(suicid|end it all|end my life|want to die|don'?t want to (live|be here))/i,
  /\b(no point in (anything|living|life)|see the point in anything)\b/i,
];
export const showsDistress = (text) => DISTRESS.some((re) => re.test(text));
export const SUPPORT_LINE =
  "If you're going through a hard time, you don't have to handle it alone. In the US you can call or text 988 (Suicide & Crisis Lifeline); elsewhere, findahelpline.com lists free local services.";

// ---- Check 5: model output format -------------------------------------------------
// The system prompt asks the model to reply with {"behavior": "...", "reply": "..."}.
// This parses that safely. If the model ignored the format, we still show its
// text (so the chat doesn't break) but mark ok: false → flags.output_valid = false.
export const BEHAVIORS = ["ANSWER", "DECLINE", "CARE"];

export function parseModelOutput(raw) {
  try {
    // Some models wrap JSON in ```json fences. Strip them before parsing.
    const cleaned = String(raw).trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    const obj = JSON.parse(cleaned);
    const behavior = String(obj.behavior ?? "").toUpperCase();
    const reply = String(obj.reply ?? "").trim();
    if (!BEHAVIORS.includes(behavior) || !reply) throw new Error("bad fields");
    return { ok: true, behavior, reply: reply.slice(0, 1500) };
  } catch {
    const text = String(raw ?? "").trim();
    return { ok: false, behavior: "ANSWER", reply: text.slice(0, 1500) || "Sorry, something went wrong. Please try again." };
  }
}
