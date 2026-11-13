# RAG Playground

A small, browser-only Retrieval-Augmented Generation playground for teaching. It ships with a made-up Biology 101 course pack (syllabus, grading policy, a lecture chapter, a student FAQ) and lets you upload your own PDF, Markdown or text files.

Everything runs in the browser. Calls go straight to [AI Pipe](https://aipipe.org) with each student's own token, so there is no server and no shared key.

## Using it

1. Paste your AI Pipe token in the top right. No token? Click **Get a token**, sign in with Google at aipipe.org, and you come back with it filled in.
2. Ask a question, or click a suggestion.
3. Open **Under the hood** to see the retrieved chunks, their similarity scores and the exact prompt sent.
4. Edit the system prompt (or pick a preset), change top-k, chunk size, overlap, model or temperature, and ask again.
5. Untick **RAG on** to ask the same question with no retrieval.

The token is kept only in that browser's localStorage. Embeddings are cached there too, so re-indexing is free after the first time.

## Demo script

- "What's the late submission penalty?" → correct, cites grading-policy.md.
- Same question with RAG off → generic "I don't have access" answer.
- "Who won the 2011 Cricket World Cup?" with Strict tutor → "I don't know based on the course documents." Switch to **No rules** → it answers from memory.
- "When are the TA's lab help desk hours?" at chunk size 600 → misses. Drop chunk size to 300 → found. Shows why chunking matters.
- Quiz maker preset + "photosynthesis" → three MCQs from the chapter.

## How it works

- `js/rag.js`: splits documents by heading and paragraph into chunks, embeds them with `text-embedding-3-small`, ranks by cosine similarity, builds the prompt.
- `js/aipipe.js`: AI Pipe calls (`/openai/v1/embeddings`, `/openai/v1/chat/completions` with streaming, `/usage`).
- `js/app.js`: the UI.
- `docs/`: the sample course pack. Add a file and list it in `docs/index.json` to include it by default.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Publish on GitHub Pages

```bash
git remote add origin https://github.com/<you>/rag-playground.git
git push -u origin main
```

Then in the repository: Settings → Pages → Source: Deploy from a branch → `main` / root. The site appears at `https://<you>.github.io/rag-playground/`.
