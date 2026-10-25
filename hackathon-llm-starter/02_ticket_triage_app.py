"""
Step 2 — an end-to-end application: a customer-support ticket triager.

Input : a raw customer message
Output: structured JSON -> category, urgency, one-line summary, suggested reply

It runs two ways:

  A) Command line
       python 02_ticket_triage_app.py "I was charged twice this month, please fix ASAP"

  B) As a web API (your own "remote API" that in turn calls the LLM)
       uvicorn 02_ticket_triage_app:app --reload
       # then, in another terminal:
       curl -X POST http://127.0.0.1:8000/triage \
            -H "Content-Type: application/json" \
            -d '{"message": "The app crashes every time I upload a photo"}'
       # or open http://127.0.0.1:8000/docs for a clickable test page

  Flow for (B):
    browser / frontend --> YOUR FastAPI server (/triage) --> LLM provider API --> JSON back
"""
import json
import sys

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from llm import chat

SYSTEM_PROMPT = """You triage customer-support tickets.
Return ONLY valid JSON (no markdown, no code fences) with exactly these keys:
  "category":        one of "billing", "bug", "account", "feature_request", "other"
  "urgency":         one of "low", "medium", "high"
  "summary":         one short sentence
  "suggested_reply": a polite 1-3 sentence reply to the customer
"""


def triage(message: str) -> dict:
    """The core application logic: prompt -> LLM -> parse JSON."""
    raw = chat(f"Ticket:\n{message}", system=SYSTEM_PROMPT)

    # Models occasionally wrap JSON in ``` fences; strip them defensively.
    cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        raise ValueError(f"Model did not return valid JSON:\n{raw}")


# ----------------------------- Web API --------------------------------------
app = FastAPI(title="Ticket Triage API")


class TicketIn(BaseModel):
    message: str


@app.post("/triage")
def triage_endpoint(ticket: TicketIn):
    try:
        return triage(ticket.message)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/")
def health():
    return {"status": "ok", "try": "POST /triage  or open /docs"}


# ----------------------------- CLI ------------------------------------------
if __name__ == "__main__":
    msg = " ".join(sys.argv[1:]) or "Hi, I was charged twice for my subscription this month. Please refund one!"
    print(f"Ticket: {msg}\n")
    print(json.dumps(triage(msg), indent=2))
