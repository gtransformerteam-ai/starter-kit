// =============================================================================
// netlify/functions/session/index.mjs: GET /api/session?id=<uuid>
// =============================================================================
// Returns one saved chat. Used by the web page to:
//   - reopen a chat when you click it in the sidebar   (FLOW 2 in docs/HOW_IT_WORKS.md)
//   - download a chat as JSON or CSV                   (FLOW 3)
//
// Response: { id, title, created_at, updated_at,
//             messages: [ { role: "user"|"assistant", content, behavior?, ts } ] }
//
// Privacy note: anyone who knows a chat's id can read it. Ids are random
// UUIDs and are never listed, which is fine for a hackathon. A real product
// would add user accounts and check that the chat belongs to the caller.
// =============================================================================

import { loadSession, isValidId } from "../../lib/store.mjs";

export default async (req) => {
  // Step 1: read-only endpoint, GET only.
  if (req.method !== "GET") return Response.json({ error: "Use GET" }, { status: 405 });

  // Step 2: take the id from the URL and check it's a real UUID.
  const id = new URL(req.url).searchParams.get("id");
  if (!isValidId(id)) return Response.json({ error: "invalid id" }, { status: 400 });

  // Step 3: load it from the store (Netlify Blobs, or memory when testing locally).
  const session = await loadSession(id);
  if (!session) return Response.json({ error: "session not found" }, { status: 404 });

  // Step 4: send the whole chat back.
  return Response.json(session);
};

// Tells Netlify which URL this function answers on.
export const config = { path: "/api/session" };
