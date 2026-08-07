import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api } from "../api.js";
import {
  ErrorNote,
  Loading,
  StatusPill,
  clock,
  duration,
  relative,
  tokens,
  when,
} from "../components/Bits.jsx";

export function ChatPage() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const chatId = searchParams.get("chat");

  const [agents, setAgents] = useState([]);
  const [chats, setChats] = useState([]);
  const [chat, setChat] = useState(null);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const threadEnd = useRef(null);
  const composer = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentResult, chatResult] = await Promise.all([
        api.listAgents(),
        api.listChats(agentId ? { agentId } : {}),
      ]);
      setAgents(agentResult.agents ?? []);
      setChats(chatResult.chats ?? []);
      if (chatId) {
        const detail = await api.getChat(chatId);
        setChat(detail.chat);
      } else {
        setChat(null);
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, [agentId, chatId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === agentId),
    [agentId, agents],
  );
  const agentReady =
    selectedAgent?.enabled !== false &&
    selectedAgent?.resolved?.ready !== false;

  const visibleChats = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return chats;
    return chats.filter((item) =>
      `${item.title ?? ""} ${item.agentName ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [chats, search]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [chat?.messages?.length, sending]);

  // The composer grows with the draft instead of showing a fixed scrollbox.
  useLayoutEffect(() => {
    const node = composer.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 208)}px`;
  }, [draft, agentId]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [agentId, chatId]);

  const trackScroll = (event) => {
    const node = event.currentTarget;
    setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 96);
  };

  const selectAgent = (nextId) => {
    setDraft("");
    navigate(nextId ? "/chat/" + nextId : "/chat");
  };

  const newChat = () => {
    if (!agentId) return;
    setChat(null);
    setLastRun(null);
    setDraft("");
    navigate("/chat/" + agentId);
  };

  const removeChat = async (target) => {
    const victim = target ?? chat;
    if (
      !victim ||
      !window.confirm(
        `Delete "${victim.title || victim.agentName}" and its messages?`,
      )
    ) {
      return;
    }
    try {
      await api.deleteChat(victim.id);
      setChats((current) => current.filter((item) => item.id !== victim.id));
      if (victim.id === chat?.id || victim.id === chatId) {
        setChat(null);
        setLastRun(null);
        setDraft("");
        navigate(victim.agentId ? "/chat/" + victim.agentId : "/chat", {
          replace: true,
        });
      }
    } catch (caught) {
      setError(caught);
    }
  };

  const send = async (event) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !agentId || sending) return;

    setSending(true);
    setError(null);
    setDraft("");

    let currentChat = chat;
    try {
      if (!currentChat) {
        const created = await api.createChat({ agentId });
        currentChat = created.chat;
        setChat(currentChat);
        setChats((current) => [currentChat, ...current]);
      }

      const optimistic = {
        id: "pending-" + Date.now(),
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      setChat((current) => ({
        ...current,
        messages: [...(current?.messages ?? []), optimistic],
      }));

      const result = await api.sendChatMessage(currentChat.id, content);
      setChat(result.chat);
      setLastRun(result.run ?? null);
      setChats((current) => [
        result.chat,
        ...current.filter((item) => item.id !== result.chat.id),
      ]);
      if (chatId !== result.chat.id) {
        navigate("/chat/" + agentId + "?chat=" + result.chat.id, {
          replace: true,
        });
      }
    } catch (caught) {
      setError(caught);
      if (currentChat?.id) {
        if (chatId !== currentChat.id) {
          navigate("/chat/" + agentId + "?chat=" + currentChat.id, {
            replace: true,
          });
        }
        void api
          .getChat(currentChat.id)
          .then((result) => setChat(result.chat))
          .catch(() => undefined);
      }
    } finally {
      setSending(false);
    }
  };

  const applySuggestion = (value) => {
    setDraft(value);
    composer.current?.focus();
  };

  if (loading && agents.length === 0) return <Loading what="chat workspace" />;

  return (
    <section className="chat-page">
      <h1 className="sr-only">Chat</h1>

      <div className="chat-layout">
        <aside
          className={sidebarOpen ? "chat-sidebar chat-sidebar-open" : "chat-sidebar"}
          aria-label="Chat history"
        >
          <div className="chat-sidebar-head">
            <div className="chat-sidebar-title">
              <span className="eyebrow">Agent playground</span>
              <button
                type="button"
                className="icon-button chat-sidebar-close"
                aria-label="Close chat history"
                onClick={() => setSidebarOpen(false)}
              >
                <ChatIcon name="close" />
              </button>
            </div>
            <select
              aria-label="Choose an agent"
              value={agentId ?? ""}
              onChange={(event) => selectAgent(event.target.value)}
            >
              <option value="">Choose an agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id} disabled={!agent.enabled}>
                  {agent.name}
                  {!agent.enabled ? " (disabled)" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="primary new-chat-button"
              disabled={!agentId}
              onClick={newChat}
            >
              <ChatIcon name="plus" />
              New chat
            </button>
          </div>

          <div className="chat-search">
            <ChatIcon name="search" />
            <input
              type="search"
              value={search}
              aria-label="Search chats"
              placeholder="Search chats"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <div className="chat-list-scroll">
            {visibleChats.length ? (
              groupChats(visibleChats).map((group) => (
                <div className="chat-group" key={group.label}>
                  <span className="chat-group-label">{group.label}</span>
                  <ul className="chat-list">
                    {group.items.map((item) => (
                      <ChatListItem
                        key={item.id}
                        item={item}
                        active={item.id === chat?.id}
                        onRemove={removeChat}
                      />
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <p className="chat-list-empty muted">
                {search.trim()
                  ? "No chats match that search."
                  : "No chats yet. Start one below."}
              </p>
            )}
          </div>

          <div className="chat-sidebar-foot">
            <span>
              {chats.length} {chats.length === 1 ? "chat" : "chats"}
            </span>
            <Link to="/runs">Runs</Link>
          </div>
        </aside>

        {sidebarOpen && (
          <button
            type="button"
            className="chat-scrim"
            aria-label="Close chat history"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <div className="chat-thread">
          <header className="thread-head">
            <button
              type="button"
              className="icon-button thread-menu"
              aria-label="Open chat history"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(true)}
            >
              <ChatIcon name="menu" />
            </button>

            {selectedAgent ? (
              <>
                <span className="agent-avatar" aria-hidden="true">
                  {initial(selectedAgent.name)}
                </span>
                <div className="thread-identity">
                  <strong>{chat?.title || selectedAgent.name}</strong>
                  <span>
                    {selectedAgent.resolved?.modelProvider?.model ??
                      selectedAgent.model ??
                      "Configured model"}
                    {chat?.messageCount ? ` · ${chat.messageCount} messages` : ""}
                  </span>
                </div>
                <div className="thread-actions">
                  <span
                    className={
                      agentReady
                        ? "readiness"
                        : "readiness readiness-bad"
                    }
                  >
                    <i aria-hidden="true" />
                    {agentReady ? "Ready" : "Needs setup"}
                  </span>
                  <Link
                    className="icon-button"
                    to={"/agents/" + selectedAgent.id}
                    aria-label="Open agent configuration"
                    title="Agent configuration"
                  >
                    <ChatIcon name="settings" />
                  </Link>
                  {chat && (
                    <button
                      type="button"
                      className="icon-button icon-button-danger"
                      aria-label="Delete this chat"
                      title="Delete chat"
                      onClick={() => removeChat(chat)}
                    >
                      <ChatIcon name="trash" />
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="thread-identity">
                <strong>No agent selected</strong>
                <span>Pick an agent to open a conversation</span>
              </div>
            )}
          </header>

          {!selectedAgent ? (
            <div className="chat-scroll">
              <AgentPicker agents={agents} onSelect={selectAgent} />
            </div>
          ) : (
            <>
              <div
                className="chat-scroll"
                onScroll={trackScroll}
                aria-live="polite"
              >
                <div className="message-list">
                  {chat?.messages?.length ? (
                    chat.messages.map((message, index) => (
                      <Message
                        key={message.id ?? `${message.role}-${index}`}
                        message={message}
                        agentName={selectedAgent.name}
                      />
                    ))
                  ) : (
                    <ChatWelcome
                      agent={selectedAgent}
                      onSuggestion={applySuggestion}
                    />
                  )}
                  {sending && <PendingMessage agentName={selectedAgent.name} />}
                  <div ref={threadEnd} />
                </div>
              </div>

              <div className="composer-dock">
                {!atBottom && (
                  <button
                    type="button"
                    className="scroll-bottom"
                    aria-label="Scroll to latest message"
                    onClick={() =>
                      threadEnd.current?.scrollIntoView({
                        block: "end",
                        behavior: "smooth",
                      })
                    }
                  >
                    <ChatIcon name="down" />
                  </button>
                )}

                <ErrorNote error={error} />

                {!agentReady && (
                  <div className="warn thread-warn">
                    <strong>
                      This agent needs configuration before it can run.
                    </strong>
                    <ul>
                      {(selectedAgent.resolved?.issues ?? []).map(
                        (issue, index) => (
                          <li key={issue.code ?? index}>
                            {issue.message ?? String(issue)}
                          </li>
                        ),
                      )}
                    </ul>
                    <Link to={"/agents/" + selectedAgent.id}>
                      Review agent configuration
                    </Link>
                  </div>
                )}

                <form className="chat-composer" onSubmit={send}>
                  <label className="sr-only" htmlFor="chat-message">
                    Message {selectedAgent.name}
                  </label>
                  <div className="composer-row">
                    <textarea
                      id="chat-message"
                      ref={composer}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                      rows={1}
                      placeholder={
                        "Ask " + selectedAgent.name + " to do something…"
                      }
                      disabled={sending || !agentReady}
                    />
                    <button
                      type="submit"
                      className="send-button"
                      aria-label={sending ? "Running" : "Send message"}
                      disabled={!draft.trim() || sending || !agentReady}
                    >
                      {sending ? (
                        <span className="spinner" aria-hidden="true" />
                      ) : (
                        <ChatIcon name="send" />
                      )}
                    </button>
                  </div>
                  <div className="composer-foot">
                    <span>Enter to send · Shift + Enter for a new line</span>
                    {lastRun && (
                      <div className="run-strip">
                        <StatusPill status={lastRun.status} />
                        <span>{tokens(lastRun.usage)}</span>
                        <span>{duration(lastRun.durationMs)}</span>
                        <Link to={"/runs/" + lastRun.id}>Open run</Link>
                      </div>
                    )}
                  </div>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ChatListItem({ item, active, onRemove }) {
  const title = item.title || item.agentName || "Untitled chat";
  return (
    <li className={active ? "chat-item chat-item-active" : "chat-item"}>
      <Link
        className="chat-link"
        to={"/chat/" + item.agentId + "?chat=" + item.id}
      >
        <strong>{title}</strong>
        <span>
          {item.agentName ? item.agentName + " · " : ""}
          {relative(item.updatedAt ?? item.createdAt)}
        </span>
      </Link>
      <button
        type="button"
        className="icon-button chat-item-remove"
        aria-label={`Delete ${title}`}
        title="Delete chat"
        onClick={() => onRemove(item)}
      >
        <ChatIcon name="trash" />
      </button>
    </li>
  );
}

function AgentPicker({ agents, onSelect }) {
  const runnable = agents.filter((agent) => agent.enabled);
  return (
    <div className="chat-empty">
      <span className="chat-empty-mark" aria-hidden="true">
        <ChatIcon name="spark" />
      </span>
      <h2>Choose an agent to begin</h2>
      <p className="muted">
        Chats keep prompts, answers, and run metadata together in MongoDB.
      </p>
      {runnable.length > 0 && (
        <div className="agent-pick-grid">
          {runnable.slice(0, 6).map((agent) => (
            <button
              type="button"
              key={agent.id}
              onClick={() => onSelect(agent.id)}
            >
              <span className="agent-avatar" aria-hidden="true">
                {initial(agent.name)}
              </span>
              <span className="pick-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Open a new chat"}</span>
              </span>
              <ChatIcon name="arrow" />
            </button>
          ))}
        </div>
      )}
      {agents.length === 0 && (
        <Link to="/agents/new" className="button-link primary">
          Create your first agent
        </Link>
      )}
    </div>
  );
}

function ChatWelcome({ agent, onSuggestion }) {
  const suggestions = [
    "Introduce yourself and describe what you can help with.",
    "Review the tools and integrations available to you.",
    "Create a short plan for my next task.",
  ];
  const facts = [
    agent.resolved?.modelProvider?.model,
    countLabel(agent.tools?.length, "tool"),
    countLabel(agent.resolved?.mcpServers?.length, "MCP server"),
    countLabel(agent.resolved?.skills?.length, "skill"),
  ].filter(Boolean);

  return (
    <div className="chat-empty chat-welcome">
      <span className="agent-avatar agent-avatar-large" aria-hidden="true">
        {initial(agent.name)}
      </span>
      <h2>Chat with {agent.name}</h2>
      <p className="muted">
        {agent.description || "Start with a prompt below."}
      </p>
      {facts.length > 0 && (
        <div className="welcome-facts">
          {facts.map((fact) => (
            <span className="chip" key={fact}>
              {fact}
            </span>
          ))}
        </div>
      )}
      <div className="suggestion-grid">
        {suggestions.map((suggestion) => (
          <button
            type="button"
            key={suggestion}
            onClick={() => onSuggestion(suggestion)}
          >
            <span>{suggestion}</span>
            <ChatIcon name="arrow" />
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ message, agentName }) {
  const role =
    message.role === "assistant" || message.role === "error"
      ? message.role
      : "user";
  const content = message.content ?? message.text ?? message.output ?? "";
  const isError = role === "error";
  const author = isError ? "Error" : role === "assistant" ? agentName : "You";

  return (
    <article className={"message message-" + role}>
      {role !== "user" && (
        <span className="message-avatar" aria-hidden="true">
          {isError ? "!" : initial(agentName)}
        </span>
      )}
      <div className="message-body">
        <header>
          <strong>{author}</strong>
          {message.createdAt && (
            <span title={when(message.createdAt)}>
              {clock(message.createdAt)}
            </span>
          )}
        </header>
        <div className="message-content">
          {segments(content).map((segment, index) =>
            segment.kind === "code" ? (
              <CodeBlock key={index} value={segment.value} />
            ) : (
              <p key={index}>{segment.value}</p>
            ),
          )}
        </div>
        <footer className="message-actions">
          <CopyButton value={content} label="Copy message" />
          {message.runId && (
            <Link className="message-run-link" to={"/runs/" + message.runId}>
              View run
            </Link>
          )}
        </footer>
      </div>
    </article>
  );
}

function PendingMessage({ agentName }) {
  return (
    <article className="message message-assistant message-pending">
      <span className="message-avatar" aria-hidden="true">
        {initial(agentName)}
      </span>
      <div className="message-body">
        <header>
          <strong>{agentName}</strong>
        </header>
        <p className="pending-copy">
          AgentCore is running this turn
          <span className="typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </p>
      </div>
    </article>
  );
}

function CodeBlock({ value }) {
  const { language, code } = splitFence(value);
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{language || "code"}</span>
        <CopyButton value={code} label="Copy code" />
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the text stays selectable either way.
    }
  };

  return (
    <button type="button" className="text-button copy-button" onClick={copy}>
      <ChatIcon name={copied ? "check" : "copy"} />
      {copied ? "Copied" : label}
    </button>
  );
}

function initial(name) {
  return (name ?? "?").trim().slice(0, 1).toUpperCase() || "?";
}

function countLabel(count, noun) {
  if (!count) return null;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Splits stored text into plain and fenced-code segments. The agent answers in
 * Markdown often enough that unfenced code is the difference between a readable
 * transcript and a wall of text.
 */
function segments(content) {
  return String(content)
    .split("```")
    .map((value, index) => ({ kind: index % 2 ? "code" : "text", value }))
    .filter((segment) => segment.value.trim().length > 0)
    .map((segment) =>
      segment.kind === "text"
        ? { ...segment, value: segment.value.replace(/^\n+|\n+$/g, "") }
        : segment,
    );
}

function splitFence(value) {
  const newline = value.indexOf("\n");
  const first = newline === -1 ? "" : value.slice(0, newline).trim();
  const tagged = /^[\w+#.-]{1,20}$/.test(first);
  return {
    language: tagged ? first : "",
    code: (tagged ? value.slice(newline + 1) : value).replace(/\n+$/, ""),
  };
}

const GROUP_ORDER = [
  "Today",
  "Yesterday",
  "Previous 7 days",
  "Previous 30 days",
  "Older",
];

/** Buckets chat summaries the way every mainstream chat sidebar does. */
function groupChats(chats) {
  const buckets = new Map(GROUP_ORDER.map((label) => [label, []]));
  for (const item of chats) {
    buckets.get(bucketOf(item.updatedAt ?? item.createdAt)).push(item);
  }
  return GROUP_ORDER.filter((label) => buckets.get(label).length > 0).map(
    (label) => ({ label, items: buckets.get(label) }),
  );
}

function bucketOf(iso) {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) return "Older";
  const then = new Date(date).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  const days = Math.round((today - then) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return "Older";
}

function ChatIcon({ name }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.4-3.4" />
      </>
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    send: <path d="M12 19V5M6 11l6-6 6 6" />,
    down: <path d="M12 5v14M6 13l6 6 6-6" />,
    arrow: <path d="M5 12h13M13 6l6 6-6 6" />,
    check: <path d="m5 12.5 4.5 4.5L19 7" />,
    copy: (
      <>
        <rect x="9" y="9" width="11" height="11" rx="2.5" />
        <path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H16" />
      </>
    ),
    trash: (
      <>
        <path d="M4 7h16M10 11v6M14 11v6" />
        <path d="M6 7h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2Z" />
        <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" />
        <path d="m18 16 .8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8Z" />
      </>
    ),
  };

  return (
    <svg
      className="chat-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
