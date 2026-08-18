import { config } from "../config.js";

/**
 * Names a chat from its opening exchange, the way a chat client is expected to.
 *
 * Deliberately not a harness invocation. Going through the runtime would spin up a
 * full agent session — tools, permissions, session persistence, a stored run — to
 * produce six words, doubling the cost and latency of every first message. This
 * calls the agent's own model provider directly with a tiny request instead.
 *
 * The model is an optimisation, not a dependency: `fallbackTitle` already produces
 * a usable name from the prompt, so any failure, timeout, or missing credential
 * degrades to that rather than leaving the chat unnamed.
 */
export async function generateChatTitle({ provider, prompt, reply }) {
  const fallback = fallbackTitle(prompt);
  if (!config.chatTitles.enabled) return fallback;
  if (!usableProvider(provider)) return fallback;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.chatTitles.timeoutMs,
  );
  timer.unref?.();
  try {
    const generated = await requestTitle({
      provider,
      prompt,
      reply,
      signal: controller.signal,
    });
    return generated ?? fallback;
  } catch {
    // A title is never worth failing a turn over.
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_PROMPT =
  "You generate short titles for chat conversations. Reply with the title only: " +
  "3 to 6 words, no quotation marks, no trailing punctuation, no prefix such as " +
  "'Title:'. Use the language the conversation is in. Describe the subject, not " +
  "the fact that it is a conversation.";

async function requestTitle({ provider, prompt, reply, signal }) {
  const body = {
    model: provider.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Conversation to name.\n\nUser: ${clip(prompt, 2_000)}` +
          (reply ? `\n\nAssistant: ${clip(reply, 1_000)}` : ""),
      },
    ],
    stream: false,
    temperature: 0.2,
    // Mirrors the harness: OpenRouter fixes the field, others default to the
    // newer spelling unless the stored record says otherwise.
    [maxTokensField(provider)]: 24,
  };

  const response = await fetch(
    `${String(provider.baseURL).replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
        ...(provider.headers ?? {}),
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) return null;
  const payload = await response.json();
  return cleanTitle(payload?.choices?.[0]?.message?.content);
}

function maxTokensField(provider) {
  if (provider.provider === "openrouter") return "max_tokens";
  return provider.wire?.maxTokensField ?? "max_completion_tokens";
}

function usableProvider(provider) {
  return Boolean(
    provider &&
      typeof provider.baseURL === "string" &&
      provider.baseURL.trim() &&
      typeof provider.apiKey === "string" &&
      provider.apiKey.trim() &&
      typeof provider.model === "string" &&
      provider.model.trim(),
  );
}

/** Accepts only something that actually looks like a title. */
function cleanTitle(value) {
  if (typeof value !== "string") return null;
  const line = value
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return null;
  // Quotes are stripped on both sides of the prefix, because a model that ignores
  // the instructions returns either `"Title: x"` or `Title: "x"`.
  const stripped = line
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/^(?:title|chat title)\s*[:\-–]\s*/i, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/[.。!?！？]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  return stripped.slice(0, config.chatTitles.maxLength);
}

/**
 * The opening prompt, reduced to something readable in a sidebar.
 *
 * Fenced code, inline code, links, and image markup are dropped first: a message
 * that opens with a code block would otherwise be titled with its first line of
 * syntax.
 */
export function fallbackTitle(prompt) {
  const text = String(prompt ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_>~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "New chat";

  const words = text.split(" ").slice(0, 8);
  let title = words.join(" ");
  if (title.length > config.chatTitles.maxLength) {
    title = title.slice(0, config.chatTitles.maxLength).replace(/\s+\S*$/, "");
  }
  title = title.replace(/[,;:.!?\-]+$/, "").trim();
  if (!title) return "New chat";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * Whether a chat is still carrying a placeholder name.
 *
 * Matched against what this console generates rather than a stored flag, so a
 * chat the user has renamed is never silently retitled.
 */
export function hasDefaultTitle(chat) {
  const title = String(chat?.title ?? "").trim();
  if (!title) return true;
  if (title === "New chat") return true;
  return title === `${String(chat?.agentName ?? "").trim()} chat`;
}

function clip(value, maximum) {
  const text = String(value ?? "").trim();
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}
