"""
Step 1 — your first LLM call.

Run:  python 01_hello_llm.py
      python 01_hello_llm.py "Explain RAG in one sentence"

What happens under the hood:
  your script --HTTPS + API key--> provider's API (OpenAI / Anthropic) --> LLM runs --> text comes back
"""
import sys

from llm import chat, PROVIDER

question = " ".join(sys.argv[1:]) or "Give me three fun hackathon project ideas using an LLM, one line each."

print(f"Provider: {PROVIDER}")
print(f"You: {question}\n")

answer = chat(
    question,
    system="You are a concise, friendly assistant for hackathon participants.",
)
print(f"LLM: {answer}")
