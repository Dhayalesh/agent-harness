import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  duration,
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
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const threadEnd = useRef(null);

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

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "end" });
  }, [chat?.messages?.length, sending]);

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

  const removeChat = async () => {
    if (
      !chat ||
      !window.confirm(
        `Delete "${chat.title || chat.agentName}" and its messages?`,
      )
    ) {
      return;
    }
    try {
      await api.deleteChat(chat.id);
      setChats((current) => current.filter((item) => item.id !== chat.id));
      newChat();
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

  if (loading && agents.length === 0) return <Loading what="chat workspace" />;

  return (
    <section className="chat-page">
      <div className="chat-page-head">
        <div>
          <span className="eyebrow">Agent playground</span>
          <h1>Chat</h1>
        </div>
        <div className="chat-head-actions">
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
          <button type="button" disabled={!agentId} onClick={newChat}>
            New chat
          </button>
          {chat && (
            <button type="button" className="danger" onClick={removeChat}>
              Delete
            </button>
          )}
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="chat-layout">
        <aside className="chat-history" aria-label="Chat history">
          <div className="chat-history-head">
            <strong>Recent chats</strong>
            <span>{chats.length}</span>
          </div>
          {chats.length ? (
            <ul>
              {chats.map((item) => (
                <li key={item.id}>
                  <Link
                    className={
                      item.id === chat?.id
                        ? "chat-link chat-link-active"
                        : "chat-link"
                    }
                    to={"/chat/" + item.agentId + "?chat=" + item.id}
                  >
                    <strong>
                      {item.title || item.agentName || "Untitled chat"}
                    </strong>
                    <span>{when(item.updatedAt ?? item.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No chats for this agent yet.</p>
          )}
        </aside>

        <div className="chat-thread">
          {!selectedAgent ? (
            <AgentPicker agents={agents} onSelect={selectAgent} />
          ) : (
            <>
              <div className="thread-head">
                <div className="agent-avatar" aria-hidden="true">
                  {selectedAgent.name.slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <strong>{selectedAgent.name}</strong>
                  <span>
                    {selectedAgent.resolved?.modelProvider?.model ??
                      selectedAgent.model ??
                      "Configured model"}
                  </span>
                </div>
                <span
                  className={
                    selectedAgent.resolved?.ready === false
                      ? "readiness readiness-bad"
                      : "readiness"
                  }
                >
                  {selectedAgent.resolved?.ready === false
                    ? "Needs setup"
                    : "Ready"}
                </span>
              </div>

              <div className="message-list" aria-live="polite">
                {chat?.messages?.length ? (
                  chat.messages.map((message, index) => (
                    <Message
                      key={message.id ?? `${message.role}-${index}`}
                      message={message}
                    />
                  ))
                ) : (
                  <ChatWelcome
                    agent={selectedAgent}
                    onSuggestion={(value) => setDraft(value)}
                  />
                )}
                {sending && (
                  <article className="message message-assistant message-pending">
                    <div className="message-avatar" aria-hidden="true">
                      A
                    </div>
                    <div>
                      <strong>{selectedAgent.name}</strong>
                      <p>
                        AgentCore is running this turn
                        <span className="typing-dots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                      </p>
                    </div>
                  </article>
                )}
                <div ref={threadEnd} />
              </div>

              {!agentReady && (
                <div className="warn">
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
                <textarea
                  id="chat-message"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={3}
                  placeholder={
                    "Ask " + selectedAgent.name + " to do something…"
                  }
                  disabled={sending || !agentReady}
                />
                <div className="composer-foot">
                  <span>Enter to send · Shift + Enter for a new line</span>
                  <button
                    type="submit"
                    className="primary"
                    disabled={!draft.trim() || sending || !agentReady}
                  >
                    {sending ? "Running…" : "Send"}
                  </button>
                </div>
              </form>

              {lastRun && (
                <div className="run-strip">
                  <StatusPill status={lastRun.status} />
                  <span>{tokens(lastRun.usage)}</span>
                  <span>{duration(lastRun.durationMs)}</span>
                  <Link to={"/runs/" + lastRun.id}>Open run</Link>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function AgentPicker({ agents, onSelect }) {
  return (
    <div className="chat-empty">
      <span className="chat-empty-mark" aria-hidden="true">
        ✦
      </span>
      <h2>Choose an agent to begin</h2>
      <p className="muted">
        Chats keep prompts, answers, and run metadata together in MongoDB.
      </p>
      <div className="agent-pick-grid">
        {agents
          .filter((agent) => agent.enabled)
          .slice(0, 6)
          .map((agent) => (
            <button
              type="button"
              key={agent.id}
              onClick={() => onSelect(agent.id)}
            >
              <strong>{agent.name}</strong>
              <span>{agent.description || "Open a new chat"}</span>
            </button>
          ))}
      </div>
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
  return (
    <div className="chat-empty chat-welcome">
      <div className="agent-avatar agent-avatar-large" aria-hidden="true">
        {agent.name.slice(0, 1).toUpperCase()}
      </div>
      <h2>Chat with {agent.name}</h2>
      <p className="muted">
        {agent.description || "Start with a prompt below."}
      </p>
      <div className="suggestion-grid">
        {suggestions.map((suggestion) => (
          <button
            type="button"
            key={suggestion}
            onClick={() => onSuggestion(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ message }) {
  const role =
    message.role === "assistant" || message.role === "error"
      ? message.role
      : "user";
  const content = message.content ?? message.text ?? message.output ?? "";
  const isError = role === "error";
  return (
    <article className={"message message-" + role}>
      <div className="message-avatar" aria-hidden="true">
        {isError ? "!" : role === "assistant" ? "A" : "You"}
      </div>
      <div className="message-body">
        <header>
          <strong>
            {isError ? "Error" : role === "assistant" ? "Agent" : "You"}
          </strong>
          {message.createdAt && <span>{when(message.createdAt)}</span>}
        </header>
        <div className="message-content">{content}</div>
        {message.runId && (
          <Link className="message-run-link" to={"/runs/" + message.runId}>
            View run
          </Link>
        )}
      </div>
    </article>
  );
}
