"""
llm.py — one tiny wrapper so every example works with OpenAI OR Claude.

Pick a provider with the LLM_PROVIDER env var (in your .env file):
    LLM_PROVIDER=openai      -> uses OPENAI_API_KEY
    LLM_PROVIDER=anthropic   -> uses ANTHROPIC_API_KEY
    LLM_PROVIDER=mock        -> no key, no network; canned answers (for offline testing)

Two functions are all you need:
    chat(user_message, system=None)  -> str
    embed(list_of_texts)             -> list of vectors   (OpenAI only; RAG falls back otherwise)
"""
import os
import json

from dotenv import load_dotenv

load_dotenv()  # reads .env in the current folder

PROVIDER = os.getenv("LLM_PROVIDER", "openai").lower()

# Defaults are cheap/fast models. Override in .env if you want something bigger.
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.4-mini")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-haiku-5-5")
OPENAI_EMBED_MODEL = os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small")


def chat(user_message: str, system: str | None = None, max_tokens: int = 1024) -> str:
    """Send one message to the LLM and return its text reply."""
    if PROVIDER == "openai":
        from openai import OpenAI

        client = OpenAI()  # reads OPENAI_API_KEY from the environment
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": user_message})
        resp = client.chat.completions.create(model=OPENAI_MODEL, messages=messages)
        return resp.choices[0].message.content

    if PROVIDER == "anthropic":
        import anthropic

        client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from the environment
        resp = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=max_tokens,
            system=system or "You are a helpful assistant.",
            messages=[{"role": "user", "content": user_message}],
        )
        return "".join(block.text for block in resp.content if block.type == "text")

    if PROVIDER == "mock":
        return _mock_reply(user_message, system)

    raise ValueError(f"Unknown LLM_PROVIDER '{PROVIDER}'. Use openai, anthropic or mock.")


def embed(texts: list[str]) -> list[list[float]]:
    """Turn texts into embedding vectors. Only OpenAI offers this here."""
    if PROVIDER != "openai":
        raise NotImplementedError("Embeddings need LLM_PROVIDER=openai")
    from openai import OpenAI

    client = OpenAI()
    resp = client.embeddings.create(model=OPENAI_EMBED_MODEL, input=texts)
    return [item.embedding for item in resp.data]


# ---------------------------------------------------------------------------
# Mock mode: lets you run every example with zero keys (useful on bad Wi-Fi).
# ---------------------------------------------------------------------------
def _mock_reply(user_message: str, system: str | None) -> str:
    if system and "JSON" in system:
        return json.dumps(
            {
                "category": "billing",
                "urgency": "high",
                "summary": "Customer was charged twice and wants a refund.",
                "suggested_reply": "Sorry about the double charge! We've started a refund; "
                "you'll see it in 3-5 business days.",
            }
        )
    if user_message.startswith("Context:"):
        top_passage = user_message.split("\n")[1]
        return f"[mock] Based on the top retrieved passage: {top_passage}"
    return f"[mock reply] I received {len(user_message)} characters. Set LLM_PROVIDER to use a real model."
