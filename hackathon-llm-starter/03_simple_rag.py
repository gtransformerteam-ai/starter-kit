"""
Step 3 — a simple RAG (Retrieval-Augmented Generation) example.

Idea: the LLM doesn't know YOUR documents. So we
  1. LOAD    your documents (the .md / .txt files in ./docs)
  2. CHUNK   them into small passages
  3. INDEX   each chunk as a vector (embedding)
  4. RETRIEVE the chunks most similar to the user's question
  5. GENERATE an answer with the LLM, giving it ONLY those chunks as context

Run:
  python 03_simple_rag.py "When are submissions due?"
  python 03_simple_rag.py            # interactive mode, type questions, 'quit' to exit

Retrieval backend:
  - LLM_PROVIDER=openai  -> OpenAI embeddings (semantic search)
  - anything else        -> TF-IDF keyword vectors (scikit-learn, no API needed)
  Force one with RAG_RETRIEVER=openai or RAG_RETRIEVER=tfidf in .env

Swap in your own data: drop .md or .txt files into ./docs and rerun.
"""
import os
import sys
from pathlib import Path

import numpy as np

from llm import PROVIDER, chat, embed

DOCS_DIR = Path(__file__).parent / "docs"
TOP_K = 3
RETRIEVER = os.getenv("RAG_RETRIEVER", "openai" if PROVIDER == "openai" else "tfidf")


# 1. LOAD + 2. CHUNK ---------------------------------------------------------
def load_chunks(docs_dir: Path) -> list[dict]:
    """Split every doc into paragraphs; each paragraph is one chunk."""
    chunks = []
    for path in sorted(docs_dir.glob("*")):
        if path.suffix not in {".md", ".txt"}:
            continue
        for para in path.read_text(encoding="utf-8").split("\n\n"):
            para = para.strip()
            if para and not para.startswith("#"):  # skip empty lines and headings
                chunks.append({"source": path.name, "text": para})
    return chunks


# 3. INDEX + 4. RETRIEVE -----------------------------------------------------
class Retriever:
    def __init__(self, chunks: list[dict]):
        self.chunks = chunks
        texts = [c["text"] for c in chunks]
        if RETRIEVER == "openai":
            self.matrix = _normalize(np.array(embed(texts)))
        else:
            from sklearn.feature_extraction.text import TfidfVectorizer

            self.vectorizer = TfidfVectorizer(stop_words="english")
            self.matrix = _normalize(self.vectorizer.fit_transform(texts).toarray())

    def _vector(self, query: str) -> np.ndarray:
        if RETRIEVER == "openai":
            return _normalize(np.array(embed([query])))[0]
        return _normalize(self.vectorizer.transform([query]).toarray())[0]

    def search(self, query: str, k: int = TOP_K) -> list[dict]:
        scores = self.matrix @ self._vector(query)  # cosine similarity
        best = np.argsort(scores)[::-1][:k]
        return [{**self.chunks[i], "score": float(scores[i])} for i in best]


def _normalize(m: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    return m / np.where(norms == 0, 1, norms)


# 5. GENERATE ----------------------------------------------------------------
SYSTEM_PROMPT = """Answer the question using ONLY the context passages provided.
If the answer is not in the context, say "I don't know based on the provided documents."
Cite the source file name in brackets, e.g. [logistics.md]."""


def answer(question: str, retriever: Retriever) -> tuple[str, list[dict]]:
    hits = retriever.search(question)
    context = "\n\n".join(f"[{h['source']}] {h['text']}" for h in hits)
    prompt = f"Context:\n{context}\n\nQuestion: {question}"
    return chat(prompt, system=SYSTEM_PROMPT), hits


def ask(question: str, retriever: Retriever):
    reply, hits = answer(question, retriever)
    print("\nRetrieved passages:")
    for h in hits:
        print(f"  ({h['score']:.2f}) [{h['source']}] {h['text'][:80]}...")
    print(f"\nAnswer: {reply}\n")


if __name__ == "__main__":
    chunks = load_chunks(DOCS_DIR)
    print(f"Indexed {len(chunks)} chunks from {DOCS_DIR.name}/ using {RETRIEVER} retrieval.")
    retriever = Retriever(chunks)

    if len(sys.argv) > 1:
        ask(" ".join(sys.argv[1:]), retriever)
    else:
        while (q := input("Ask a question (or 'quit'): ").strip()).lower() not in {"quit", "exit", ""}:
            ask(q, retriever)
