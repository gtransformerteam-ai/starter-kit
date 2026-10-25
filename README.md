# Hackathon LLM Starter Kit

Three small, working Python examples:

| File | What it shows |
|---|---|
| `01_hello_llm.py` | Your first call to an LLM API (OpenAI or Claude) |
| `02_ticket_triage_app.py` | An end-to-end app: support-ticket triager returning structured JSON, usable from the CLI **or** as your own web API (FastAPI) |
| `03_simple_rag.py` | Retrieval-Augmented Generation: answer questions from your own documents in `docs/` |

All LLM calls go through one tiny file, `llm.py`, so switching providers is one line in `.env`.

```
your code ──HTTPS + API key──▶ provider API (OpenAI / Anthropic) ──▶ LLM ──▶ text back
```

---

## 0. Prerequisites

- Python 3.10+ (`python --version`)
- A terminal and a code editor

## 1. Get an API key (pick ONE provider)

### Option A — OpenAI (GPT models)
1. Go to **https://platform.openai.com** and sign up / log in.
2. Open **API keys** (https://platform.openai.com/api-keys) → **Create new secret key**.
3. Copy the key (starts with `sk-`). You will **not** be able to see it again.
4. Billing: add a payment method or credits under **Settings → Billing** (API usage is billed separately from a ChatGPT subscription).

### Option B — Anthropic (Claude models)
1. Go to **https://console.anthropic.com** and sign up / log in.
2. Open **Settings → API keys** → **Create Key**, give it a name.
3. Copy the key (starts with `sk-ant-`). You will **not** see it again.
4. Billing: add credits under **Plans & Billing** (API usage is separate from a Claude.ai subscription).

### No key yet?
Set `LLM_PROVIDER=mock` and every example runs offline with canned answers, so you can start coding immediately.

> 🔒 **Treat your key like a password.** Never paste it in code, Slack/Discord, or commit it to GitHub. It lives only in `.env`, which is already in `.gitignore`.

## 2. Install

```bash
git clone <this-repo> && cd hackathon-llm-starter
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 3. Configure

```bash
cp .env.example .env               # Windows: copy .env.example .env
```

Edit `.env`:

```
LLM_PROVIDER=openai                # or anthropic, or mock
OPENAI_API_KEY=sk-...              # only the one you're using is needed
```

## 4. Run the examples

### Example 1 — Hello LLM
```bash
python 01_hello_llm.py
python 01_hello_llm.py "Explain embeddings to a 10 year old"
```

### Example 2 — End-to-end app: Ticket Triage

**As a CLI:**
```bash
python 02_ticket_triage_app.py "I was charged twice this month, please fix ASAP"
```
Output:
```json
{
  "category": "billing",
  "urgency": "high",
  "summary": "Customer was charged twice and wants a refund.",
  "suggested_reply": "Sorry about the double charge! ..."
}
```

**As your own web API** (frontend → your server → LLM):
```bash
uvicorn 02_ticket_triage_app:app --reload
```
Then open **http://127.0.0.1:8000/docs** for an interactive test page, or:
```bash
curl -X POST http://127.0.0.1:8000/triage \
     -H "Content-Type: application/json" \
     -d '{"message": "The app crashes every time I upload a photo"}'
```
Any frontend (React, plain HTML `fetch`, mobile app) can now call `POST /triage`.

**Make it yours:** change `SYSTEM_PROMPT` and the JSON keys, e.g. a résumé reviewer, recipe generator, meeting-notes summarizer, or code explainer.

### Example 3 — Simple RAG
```bash
python 03_simple_rag.py "When are submissions due?"
python 03_simple_rag.py            # interactive mode
```

How it works:
1. **Load** files from `docs/`
2. **Chunk** them into paragraphs
3. **Embed** each chunk as a vector (OpenAI embeddings, or TF-IDF if you're on Claude/mock — no extra key)
4. **Retrieve** the top 3 chunks most similar to the question
5. **Generate** an answer with the LLM using only those chunks, citing sources

**Make it yours:** delete the sample docs, drop in your own `.md`/`.txt` files (lecture notes, product docs, policies), rerun.

---

## Troubleshooting

| Error | Fix |
|---|---|
| `401` / `AuthenticationError` | Key missing or wrong. Check `.env` is in the folder you run from and there are no spaces/quotes around the key. |
| `429` / `RateLimitError` | Out of credits or too many requests. Check billing; wait a few seconds and retry. |
| `model not found` / `404` | Model name changed. Set `OPENAI_MODEL` or `ANTHROPIC_MODEL` in `.env` to a current one from the provider's models page. |
| `Model did not return valid JSON` | Retry, or make the system prompt stricter. |
| `Embeddings need LLM_PROVIDER=openai` | Set `RAG_RETRIEVER=tfidf` in `.env`. |
| `ModuleNotFoundError` | Activate your venv and `pip install -r requirements.txt`. |

## Model docs
- OpenAI models: https://platform.openai.com/docs/models
- Claude models: https://docs.claude.com/en/docs/about-claude/models
