// =============================================================================
// netlify/lib/store.mjs: where chats are saved
// =============================================================================
// FLOW 4 in docs/HOW_IT_WORKS.md.
//
// On Netlify (and under `npm run dev`, which runs `netlify dev`) chats are
// saved in Netlify Blobs: a key-value store that comes with every Netlify
// project. There's no database to create; it just works once deployed.
//
// Anywhere else (e.g. `npm test`, which runs the function directly with
// plain Node) Netlify Blobs isn't available, so chats are kept in an
// in-memory Map instead. That works the same way, but everything is
// forgotten when the process stops.
//
// One chat ("session") is stored as one JSON value under its id:
// {
//   id: "<uuid>",
//   title: "first message, max 60 chars",
//   created_at: "...", updated_at: "...",
//   messages: [ { role: "user" | "assistant", content: "...", behavior?: "ANSWER", ts: "..." } ]
// }
// =============================================================================

const memory = new Map(); // fallback store: id -> session
let blobs;                // undefined = not checked yet, null = not available, otherwise the Blobs store

// Decide once which store to use, and remember the answer.
async function blobStore() {
  if (blobs !== undefined) return blobs;
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("chat-sessions"); // all chats live in one store called "chat-sessions"
    await store.get("__probe__");            // throws if we're not running inside Netlify
    blobs = store;
  } catch {
    blobs = null;                             // fall back to memory
  }
  return blobs;
}

// "netlify-blobs" or "memory". Returned in every /api/chat response so you can check.
export async function storageKind() {
  return (await blobStore()) ? "netlify-blobs" : "memory";
}

// Get a chat by id. Returns null if it doesn't exist.
export async function loadSession(id) {
  const store = await blobStore();
  if (store) return (await store.get(id, { type: "json" })) ?? null;
  return memory.get(id) ?? null;
}

// Save (create or overwrite) a chat.
export async function saveSession(session) {
  session.updated_at = new Date().toISOString();
  const store = await blobStore();
  if (store) await store.setJSON(session.id, session);
  else memory.set(session.id, structuredClone(session)); // copy, so later edits don't leak in
}

// An empty chat with the given id.
export function newSession(id) {
  const now = new Date().toISOString();
  return { id, created_at: now, updated_at: now, title: "", messages: [] };
}

// Only accept real UUIDs as ids (e.g. "3f2b6c1e-8d4a-4b7e-9c1d-2a5e6f7a8b9c").
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidId = (id) => typeof id === "string" && UUID.test(id);
