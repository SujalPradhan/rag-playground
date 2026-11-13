const BASE = "https://aipipe.org";
const STORE_KEY = "aipipe";

export function getProfile() {
  let profile = {};
  try {
    profile = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {}
  const params = new URLSearchParams(location.search);
  let changed = false;
  for (const [key, value] of [...params.entries()]) {
    if (key.startsWith("aipipe_")) {
      profile[key.slice(7)] = value;
      params.delete(key);
      changed = true;
    }
  }
  if (changed) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(profile));
    } catch {}
    const qs = params.toString();
    history.replaceState({}, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }
  return profile;
}

export function saveToken(token) {
  const profile = { token: token.trim() };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(profile));
  } catch {}
  return profile;
}

export function logout() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {}
}

export function loginUrl() {
  const here = location.origin + location.pathname;
  return `${BASE}/login?redirect=${encodeURIComponent(here)}`;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function errorFrom(res) {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json.message || json.error?.message || json.error || text;
    } catch {
      detail = text;
    }
  } catch {}
  if (typeof detail !== "string") detail = JSON.stringify(detail);
  if (res.status === 401) return new ApiError("Your AI Pipe token is invalid or expired. Paste a fresh one from aipipe.org.", 401);
  if (res.status === 429 || /limit|budget|quota/i.test(detail))
    return new ApiError(`AI Pipe usage limit reached. ${detail}`.trim(), res.status);
  return new ApiError(`AI Pipe error ${res.status}: ${detail.slice(0, 300)}`, res.status);
}

async function post(path, token, body, signal) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError("Could not reach aipipe.org. Check your internet connection.", 0);
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

export async function embed(token, model, inputs) {
  const res = await post("/openai/v1/embeddings", token, { model, input: inputs });
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function chat(token, { model, messages, temperature }, onDelta, signal) {
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (temperature !== undefined) body.temperature = temperature;
  let res;
  try {
    res = await post("/openai/v1/chat/completions", token, body, signal);
  } catch (e) {
    if (body.temperature === undefined || !/temperature/i.test(e.message)) throw e;
    delete body.temperature;
    res = await post("/openai/v1/chat/completions", token, body, signal);
  }
  const type = res.headers.get("content-type") || "";
  if (!type.includes("text/event-stream")) {
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || "";
    onDelta(text);
    return { text, usage: json.usage };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onDelta(delta);
        }
        if (json.usage) usage = json.usage;
      } catch {}
    }
  }
  return { text, usage };
}

export async function getUsage(token) {
  const res = await fetch(`${BASE}/usage`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}
