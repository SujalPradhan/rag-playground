import { embed } from "./aipipe.js";

export const EMBED_MODEL = "text-embedding-3-small";
const CACHE_PREFIX = "emb:";

export function chunkText(text, source, size, overlap) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let heading = "";
  let para = [];
  const flush = () => {
    const body = para.join("\n").trim();
    if (body) blocks.push({ heading, body });
    para = [];
  };
  for (const line of lines) {
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) {
      flush();
      heading = h[1].trim();
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();

  const pieces = [];
  for (const b of blocks) {
    if (b.body.length <= size) {
      pieces.push(b);
      continue;
    }
    const sentences = b.body.match(/[^.!?\n]+[.!?]*\s*/g) || [b.body];
    let cur = "";
    for (const s of sentences) {
      if (cur && (cur + s).length > size) {
        pieces.push({ heading: b.heading, body: cur.trim() });
        cur = "";
      }
      cur += s;
    }
    if (cur.trim()) pieces.push({ heading: b.heading, body: cur.trim() });
  }

  const chunks = [];
  let cur = null;
  for (const p of pieces) {
    const add = cur && cur.last !== p.heading && p.heading ? `\n\n${p.heading}\n${p.body}` : `\n${p.body}`;
    if (cur && cur.body.length + add.length <= size) {
      cur.body += add;
      cur.last = p.heading;
    } else {
      if (cur) chunks.push(cur);
      cur = { heading: p.heading, last: p.heading, body: p.body };
    }
  }
  if (cur) chunks.push(cur);

  return chunks.map((c, i) => {
    let body = c.body;
    if (overlap > 0 && i > 0 && chunks[i - 1].last === c.heading) {
      const prev = chunks[i - 1].body;
      const tail = prev.slice(Math.max(0, prev.length - overlap));
      const cut = tail.indexOf(" ");
      body = "…" + (cut >= 0 ? tail.slice(cut + 1) : tail) + "\n" + body;
    }
    const text = c.heading ? `${c.heading}\n${body}` : body;
    return { id: `${source}#${i + 1}`, source, n: i + 1, heading: c.heading, text };
  });
}

function hash(str) {
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + str.length.toString(36);
}

function encode(vec) {
  const bytes = new Uint8Array(new Float32Array(vec).buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function cacheGet(key) {
  try {
    const v = localStorage.getItem(CACHE_PREFIX + key);
    return v ? decode(v) : null;
  } catch {
    return null;
  }
}

function cacheSet(key, vec) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, encode(vec));
  } catch {}
}

export function clearEmbeddingCache() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
  } catch {}
}

export async function embedTexts(token, texts, onProgress) {
  const out = new Array(texts.length);
  const missing = [];
  texts.forEach((t, i) => {
    const v = cacheGet(hash(EMBED_MODEL + "|" + t));
    if (v) out[i] = v;
    else missing.push(i);
  });
  const BATCH = 64;
  for (let s = 0; s < missing.length; s += BATCH) {
    const idx = missing.slice(s, s + BATCH);
    const vecs = await embed(token, EMBED_MODEL, idx.map((i) => texts[i]));
    idx.forEach((i, j) => {
      out[i] = new Float32Array(vecs[j]);
      cacheSet(hash(EMBED_MODEL + "|" + texts[i]), vecs[j]);
    });
    onProgress?.(Math.min(s + BATCH, missing.length), missing.length);
  }
  return { vectors: out, fresh: missing.length };
}

export function cosine(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function search(index, qvec, k) {
  return index
    .map((c) => ({ ...c, score: cosine(qvec, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function buildUserMessage(question, hits) {
  if (!hits) return question;
  const context = hits.map((h, i) => `[${i + 1}] (source: ${h.source})\n${h.text}`).join("\n\n");
  return `Context:\n${context}\n\nQuestion: ${question}`;
}
