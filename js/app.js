import { getProfile, saveToken, logout, loginUrl, chat, getUsage } from "./aipipe.js";
import { chunkText, embedTexts, search, buildUserMessage } from "./rag.js";

const PRESETS = [
  {
    id: "strict",
    label: "Strict tutor",
    text: `You are the course assistant for BIO 101 at Riverside Community College.
Answer the student's question using ONLY the numbered context passages provided.
- Cite the passages you used like [1] or [2].
- If the context does not contain the answer, reply: "I don't know based on the course documents." Do not guess.
- Keep answers short and clear: 2 to 5 sentences, or a short list.`,
  },
  {
    id: "friendly",
    label: "Friendly explainer",
    text: `You are a warm, encouraging tutor explaining things to a first-year student.
Use the numbered context passages as your source of truth and cite them like [1].
Explain in simple words, use one everyday analogy, and end with a one-line summary.
If the context does not cover the question, say so kindly and suggest who to ask (the instructor or TA).`,
  },
  {
    id: "quiz",
    label: "Quiz maker",
    text: `You are a teacher's assistant who writes practice questions.
From the numbered context passages only, write 3 multiple-choice questions about the student's topic.
For each: the question, options A to D, the correct answer, and a one-line explanation citing the passage like [1].
If the context does not cover the topic, say that no quiz can be made from the course documents.`,
  },
  {
    id: "open",
    label: "No rules",
    text: `You are a helpful assistant.`,
  },
];

const SUGGESTIONS = [
  "What's the late submission penalty?",
  "Explain the light-dependent reactions",
  "When are the TA's lab help desk hours?",
  "How many books can I borrow from the library?",
  "Where does the oxygen in photosynthesis come from?",
  "Who won the 2011 Cricket World Cup?",
];

const SETTINGS_KEY = "rag-playground:settings";
const $ = (id) => document.getElementById(id);

const state = {
  profile: getProfile(),
  docs: [],
  sampleDocs: [],
  index: null,
  indexKey: "",
  turns: [],
  activeTurn: -1,
  busy: false,
  usage: null,
};

const el = {
  auth: $("auth"),
  presets: $("presets"),
  systemPrompt: $("systemPrompt"),
  resetPrompt: $("resetPrompt"),
  ragToggle: $("ragToggle"),
  topk: $("topk"),
  chunkSize: $("chunkSize"),
  overlap: $("overlap"),
  model: $("model"),
  temperature: $("temperature"),
  docList: $("docList"),
  upload: $("upload"),
  resetDocs: $("resetDocs"),
  indexStatus: $("indexStatus"),
  messages: $("messages"),
  welcome: $("welcome"),
  suggestions: $("suggestions"),
  composer: $("composer"),
  question: $("question"),
  send: $("send"),
  hood: $("hood"),
  hoodHint: $("hoodHint"),
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, nums) =>
      nums
        .split(",")
        .map((n) => `<span class="cite" data-cite="${n.trim()}" role="button" tabindex="0">${n.trim()}</span>`)
        .join("")
    );
}

function renderMarkdown(src) {
  const lines = escapeHtml(src).split("\n");
  let html = "";
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) html += `<p>${inline(para.join("<br>"))}</p>`;
    para = [];
  };
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (ul || ol) {
      flushPara();
      const type = ul ? "ul" : "ol";
      if (list !== type) {
        closeList();
        html += `<${type}>`;
        list = type;
      }
      html += `<li>${inline((ul || ol)[1])}</li>`;
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else if (h) {
      flushPara();
      closeList();
      html += `<p><b>${inline(h[1])}</b></p>`;
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return html;
}

function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {}
  el.systemPrompt.value = s.systemPrompt ?? PRESETS[0].text;
  if (s.topk) el.topk.value = s.topk;
  if (s.chunkSize) el.chunkSize.value = s.chunkSize;
  if (s.overlap !== undefined) el.overlap.value = s.overlap;
  if (s.model && [...el.model.options].some((o) => o.value === s.model)) el.model.value = s.model;
  if (s.temperature !== undefined) el.temperature.value = s.temperature;
  if (s.rag !== undefined) el.ragToggle.checked = s.rag;
}

function saveSettings() {
  const s = {
    systemPrompt: el.systemPrompt.value,
    topk: el.topk.value,
    chunkSize: el.chunkSize.value,
    overlap: el.overlap.value,
    model: el.model.value,
    temperature: el.temperature.value,
    rag: el.ragToggle.checked,
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

function syncOutputs() {
  $("topkOut").value = el.topk.value;
  $("sizeOut").value = el.chunkSize.value;
  $("overlapOut").value = el.overlap.value;
  $("tempOut").value = el.temperature.value;
  el.ragToggle.nextElementSibling.textContent = el.ragToggle.checked ? "RAG on" : "RAG off";
  const current = el.systemPrompt.value.trim();
  for (const b of el.presets.children) {
    const p = PRESETS.find((x) => x.id === b.dataset.id);
    b.setAttribute("aria-pressed", String(p.text.trim() === current));
  }
}

function renderPresets() {
  el.presets.innerHTML = "";
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = p.label;
    b.dataset.id = p.id;
    b.addEventListener("click", () => {
      el.systemPrompt.value = p.text;
      saveSettings();
      syncOutputs();
    });
    el.presets.append(b);
  }
}

function renderSuggestions() {
  el.suggestions.innerHTML = "";
  for (const q of SUGGESTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = q;
    b.addEventListener("click", () => ask(q));
    el.suggestions.append(b);
  }
}

function renderAuth() {
  el.auth.innerHTML = "";
  const token = state.profile.token;
  if (token) {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = state.profile.email ? state.profile.email : "Token saved";
    const usage = document.createElement("span");
    usage.className = "usage";
    if (state.usage && typeof state.usage.cost === "number") {
      usage.textContent = `$${state.usage.cost.toFixed(4)} of $${Number(state.usage.limit).toFixed(2)} used (last ${state.usage.days} days)`;
    }
    const out = document.createElement("button");
    out.className = "ghost";
    out.type = "button";
    out.textContent = "Change token";
    out.addEventListener("click", () => {
      logout();
      state.profile = {};
      state.usage = null;
      renderAuth();
      el.auth.querySelector("input")?.focus();
    });
    el.auth.append(who, usage, out);
  } else {
    const form = document.createElement("form");
    form.className = "token-form";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Paste your AI Pipe token";
    input.setAttribute("aria-label", "AI Pipe token");
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "primary";
    save.textContent = "Use token";
    const get = document.createElement("a");
    get.href = loginUrl();
    get.textContent = "Get a token";
    get.title = "Sign in at aipipe.org with Google; you come back here with a token filled in";
    form.append(input, save, get);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = input.value.trim();
      if (!t) return input.focus();
      state.profile = saveToken(t);
      renderAuth();
      refreshUsage();
    });
    el.auth.append(form);
  }
}

async function refreshUsage() {
  if (!state.profile.token) return;
  try {
    state.usage = await getUsage(state.profile.token);
    if (state.usage.email && !state.profile.email) state.profile.email = state.usage.email;
  } catch (e) {
    if (e.status === 401) {
      state.usage = null;
    }
  }
  renderAuth();
}

function renderDocs() {
  el.docList.innerHTML = "";
  if (!state.docs.length) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="meta">No documents. Upload one or reset to the sample pack.</span>`;
    el.docList.append(li);
  }
  state.docs.forEach((d, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = d.name;
    name.title = d.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${Math.max(1, Math.round(d.text.length / 1000))}k chars${d.sample ? " · sample" : ""}`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "×";
    rm.title = `Remove ${d.name}`;
    rm.setAttribute("aria-label", `Remove ${d.name}`);
    rm.addEventListener("click", () => {
      state.docs.splice(i, 1);
      renderDocs();
      updateIndexStatus();
    });
    const right = document.createElement("span");
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "6px";
    right.append(meta, rm);
    li.append(name, right);
    el.docList.append(li);
  });
}

function currentKey() {
  return JSON.stringify([state.docs.map((d) => [d.name, d.text.length]), el.chunkSize.value, el.overlap.value]);
}

function makeChunks() {
  const size = Number(el.chunkSize.value);
  const overlap = Math.min(Number(el.overlap.value), Math.floor(size / 2));
  return state.docs.flatMap((d) => chunkText(d.text, d.name, size, overlap));
}

function updateIndexStatus(msg, isError) {
  el.indexStatus.classList.toggle("error", !!isError);
  if (msg) {
    el.indexStatus.textContent = msg;
    return;
  }
  const chunks = makeChunks();
  const ready = state.index && state.indexKey === currentKey();
  el.indexStatus.textContent = ready
    ? `Indexed: ${state.index.length} chunks from ${state.docs.length} document${state.docs.length === 1 ? "" : "s"}.`
    : `${chunks.length} chunks ready to embed. They are indexed on your first question.`;
}

async function ensureIndex() {
  const key = currentKey();
  if (state.index && state.indexKey === key) return state.index;
  const chunks = makeChunks();
  if (!chunks.length) {
    state.index = [];
    state.indexKey = key;
    return state.index;
  }
  updateIndexStatus(`Embedding ${chunks.length} chunks…`);
  const { vectors, fresh } = await embedTexts(state.profile.token, chunks.map((c) => c.text), (done, total) =>
    updateIndexStatus(`Embedding new chunks… ${done}/${total}`)
  );
  state.index = chunks.map((c, i) => ({ ...c, vector: vectors[i] }));
  state.indexKey = key;
  updateIndexStatus(
    `Indexed: ${chunks.length} chunks from ${state.docs.length} document${state.docs.length === 1 ? "" : "s"}` +
      (fresh ? ` (${fresh} newly embedded).` : " (from cache).")
  );
  return state.index;
}

async function loadSamples() {
  const names = await fetch("docs/index.json").then((r) => r.json());
  const docs = await Promise.all(
    names.map(async (name) => ({ name, text: await fetch(`docs/${name}`).then((r) => r.text()), sample: true }))
  );
  state.sampleDocs = docs;
  state.docs = docs.map((d) => ({ ...d }));
  renderDocs();
  updateIndexStatus();
}

let pdfjsPromise;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      s.onerror = () => {
        pdfjsPromise = null;
        reject(new Error("Could not load the PDF reader."));
      };
      document.head.append(s);
    });
  }
  return pdfjsPromise;
}

async function readPdf(file) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let text = "";
    let lastY;
    for (const item of content.items) {
      const y = item.transform?.[5];
      if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2) text += "\n";
      text += item.str;
      if (item.hasEOL) text += "\n";
      lastY = y;
    }
    pages.push(`# Page ${p}\n${text.replace(/\n{3,}/g, "\n\n").trim()}`);
  }
  return pages.join("\n\n");
}

async function handleUpload(files) {
  for (const file of files) {
    updateIndexStatus(`Reading ${file.name}…`);
    try {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const text = isPdf ? await readPdf(file) : await file.text();
      if (!text.trim() || text.replace(/# Page \d+/g, "").trim().length < 20) {
        updateIndexStatus(`${file.name} has no readable text (scanned PDFs are not supported).`, true);
        continue;
      }
      const existing = state.docs.findIndex((d) => d.name === file.name);
      const doc = { name: file.name, text, sample: false };
      if (existing >= 0) state.docs[existing] = doc;
      else state.docs.push(doc);
      renderDocs();
      updateIndexStatus();
    } catch (e) {
      updateIndexStatus(`Could not read ${file.name}: ${e.message}`, true);
    }
  }
}

function addMessage(role, html) {
  el.welcome.hidden = true;
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = html;
  wrap.append(bubble);
  el.messages.append(wrap);
  el.messages.scrollTop = el.messages.scrollHeight;
  return { wrap, bubble };
}

function setActiveTurn(i) {
  state.activeTurn = i;
  document.querySelectorAll(".msg.bot").forEach((m) => m.classList.toggle("active", Number(m.dataset.turn) === i));
  renderHood();
}

function renderHood() {
  const t = state.turns[state.activeTurn];
  el.hood.innerHTML = "";
  if (!t) {
    el.hoodHint.textContent = "Ask a question to see what the model received";
    return;
  }
  el.hoodHint.textContent = `Question ${state.activeTurn + 1} of ${state.turns.length}`;

  const retrieved = document.createElement("div");
  retrieved.className = "hood-section";
  retrieved.innerHTML = `<h3>1 · Retrieved chunks</h3>`;
  if (!t.rag) {
    retrieved.innerHTML += `<p class="empty-note">RAG was off. Nothing was retrieved, so the model answered from its own memory only.</p>`;
  } else if (!t.hits.length) {
    retrieved.innerHTML += `<p class="empty-note">No documents loaded, so there was nothing to retrieve.</p>`;
  } else {
    t.hits.forEach((h, i) => {
      const pct = Math.max(0, Math.min(100, h.score * 100));
      const div = document.createElement("div");
      div.className = "hit";
      div.id = `hit-${state.activeTurn}-${i + 1}`;
      div.innerHTML = `<div class="hit-head"><span class="hit-src">[${i + 1}] ${escapeHtml(h.source)} · chunk ${h.n}</span><span class="score">${h.score.toFixed(3)}</span></div><div class="bar"><span style="width:${pct}%"></span></div><div class="hit-text"></div>`;
      div.querySelector(".hit-text").textContent = h.text;
      retrieved.append(div);
    });
  }
  el.hood.append(retrieved);

  const prompt = document.createElement("div");
  prompt.className = "hood-section";
  prompt.innerHTML = `<h3>2 · Exact prompt sent to the model</h3>`;
  const details = document.createElement("details");
  details.className = "prompt";
  details.open = true;
  details.innerHTML = `<summary>${t.messages.length} messages · ${escapeHtml(t.model)}</summary>`;
  for (const m of t.messages) {
    const role = document.createElement("div");
    role.className = `role ${m.role}`;
    role.textContent = m.role === "system" ? "System prompt" : "User message (context + question)";
    const pre = document.createElement("pre");
    pre.textContent = m.content;
    details.append(role, pre);
  }
  prompt.append(details);
  el.hood.append(prompt);

  const stats = document.createElement("div");
  stats.className = "hood-section";
  const u = t.usage;
  stats.innerHTML = `<h3>3 · Stats</h3><p class="stats">${t.ms ? `${(t.ms / 1000).toFixed(1)} s` : "…"}${
    u ? ` · ${u.prompt_tokens} prompt tokens · ${u.completion_tokens} answer tokens` : ""
  }${t.rag ? ` · top-k ${t.topk} · chunk size ${t.chunkSize}` : ""} · temperature ${t.temperature ?? "default"}</p>`;
  el.hood.append(stats);
}

function flashHit(n) {
  const node = document.getElementById(`hit-${state.activeTurn}-${n}`);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.add("flash");
  setTimeout(() => node.classList.remove("flash"), 1400);
}

async function ask(question) {
  question = question.trim();
  if (!question || state.busy) return;
  if (!state.profile.token) {
    addMessage("bot", `<p>Paste your AI Pipe token at the top right first. No token yet? Click “Get a token”: it's free with a Google sign-in.</p>`).bubble.classList.add("error-box");
    el.auth.querySelector("input")?.focus();
    return;
  }
  state.busy = true;
  el.send.disabled = true;
  el.question.value = "";

  const rag = el.ragToggle.checked;
  const model = el.model.value;
  const temperature = Number(el.temperature.value);
  const topk = Number(el.topk.value);
  const systemPrompt = el.systemPrompt.value.trim() || "You are a helpful assistant.";

  addMessage("user", escapeHtml(question).replace(/\n/g, "<br>"));
  const { wrap, bubble } = addMessage("bot", `<span class="typing">${rag ? "Searching the documents…" : "Thinking…"}</span>`);
  const turnIndex = state.turns.length;
  wrap.dataset.turn = turnIndex;

  const started = performance.now();
  try {
    let hits = null;
    if (rag) {
      const index = await ensureIndex();
      if (index.length) {
        const [qvec] = (await embedTexts(state.profile.token, [question])).vectors;
        hits = search(index, qvec, topk);
      } else {
        hits = [];
      }
    }
    const userContent = rag
      ? hits.length
        ? buildUserMessage(question, hits)
        : `Context:\n(no documents are loaded)\n\nQuestion: ${question}`
      : question;
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];
    const turn = { question, rag, hits: hits || [], messages, model, temperature, topk, chunkSize: el.chunkSize.value };
    state.turns.push(turn);
    setActiveTurn(turnIndex);

    let text = "";
    bubble.innerHTML = `<span class="typing"></span>`;
    const result = await chat(state.profile.token, { model, messages, temperature }, (delta) => {
      text += delta;
      bubble.innerHTML = renderMarkdown(text) + `<span class="typing"></span>`;
      el.messages.scrollTop = el.messages.scrollHeight;
    });
    turn.usage = result.usage;
    turn.ms = performance.now() - started;
    bubble.innerHTML = renderMarkdown(result.text || text || "(empty answer)");

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.innerHTML = `<span class="tag ${rag ? "on" : "off"}">${rag ? `RAG on · ${turn.hits.length} chunks` : "RAG off"}</span><span>${escapeHtml(model)}</span>`;
    const inspect = document.createElement("button");
    inspect.type = "button";
    inspect.className = "link";
    inspect.textContent = "Show under the hood";
    inspect.addEventListener("click", () => setActiveTurn(turnIndex));
    meta.append(inspect);
    wrap.append(meta);
    if (state.activeTurn === turnIndex) renderHood();
    refreshUsage();
  } catch (e) {
    bubble.classList.add("error-box");
    bubble.textContent = e.message || String(e);
    if (e.status === 401) {
      logout();
      state.profile = {};
      renderAuth();
    }
    if (rag && !state.index) updateIndexStatus();
  } finally {
    state.busy = false;
    el.send.disabled = false;
    el.messages.scrollTop = el.messages.scrollHeight;
  }
}

function bind() {
  el.systemPrompt.addEventListener("input", () => {
    saveSettings();
    syncOutputs();
  });
  el.resetPrompt.addEventListener("click", () => {
    el.systemPrompt.value = PRESETS[0].text;
    saveSettings();
    syncOutputs();
  });
  for (const input of [el.topk, el.chunkSize, el.overlap, el.temperature, el.ragToggle, el.model]) {
    input.addEventListener("input", () => {
      saveSettings();
      syncOutputs();
      if (input === el.chunkSize || input === el.overlap) updateIndexStatus();
    });
  }
  el.upload.addEventListener("change", async () => {
    await handleUpload([...el.upload.files]);
    el.upload.value = "";
  });
  el.resetDocs.addEventListener("click", () => {
    state.docs = state.sampleDocs.map((d) => ({ ...d }));
    renderDocs();
    updateIndexStatus();
  });
  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    ask(el.question.value);
  });
  el.question.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(el.question.value);
    }
  });
  el.messages.addEventListener("click", (e) => {
    const cite = e.target.closest(".cite");
    const msg = e.target.closest(".msg.bot");
    if (msg && msg.dataset.turn !== undefined && Number(msg.dataset.turn) !== state.activeTurn && state.turns[msg.dataset.turn]) {
      setActiveTurn(Number(msg.dataset.turn));
    }
    if (cite) flashHit(cite.dataset.cite);
  });
  el.messages.addEventListener("keydown", (e) => {
    const cite = e.target.closest(".cite");
    if (cite && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      flashHit(cite.dataset.cite);
    }
  });
}

async function init() {
  loadSettings();
  renderPresets();
  renderSuggestions();
  syncOutputs();
  renderAuth();
  bind();
  try {
    await loadSamples();
  } catch {
    updateIndexStatus("Could not load the sample documents. Open this page through a web server, not as a file.", true);
  }
  refreshUsage();
}

init();
