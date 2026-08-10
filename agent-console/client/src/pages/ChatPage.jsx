import {
  Button,
  Chip,
  Link as HeroLink,
  Input,
  Select,
  SelectItem,
  Tooltip,
} from "@heroui/react";
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
  AgentAvatar,
  ErrorNote,
  Loading,
  StatusPill,
  clock,
  duration,
  relative,
  tokens,
  useConfirm,
  when,
} from "../components/Bits.jsx";
import { Icon } from "../components/Icon.jsx";

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
  const [resettingSession, setResettingSession] = useState(false);
  const [error, setError] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [live, setLive] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const threadEnd = useRef(null);
  const composer = useRef(null);
  const inFlight = useRef(null);

  // Leaving the page stops the run rather than leaving it to finish unwatched:
  // the server aborts its AgentCore call when this connection closes.
  useEffect(
    () => () => {
      inFlight.current?.abort();
    },
    [],
  );

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
    if (!victim) return;
    const confirmed = await confirm({
      title: "Delete chat",
      body: `Delete "${victim.title || victim.agentName}" and its messages?`,
      confirmLabel: "Delete chat",
    });
    if (!confirmed) return;
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

  const resetSession = async () => {
    if (!chat || sending || resettingSession) return;
    const confirmed = await confirm({
      title: "Reset agent context",
      body: "Start a fresh agent session? Existing messages stay visible, but they will not be included in the new context.",
      confirmLabel: "Reset context",
    });
    if (!confirmed) return;
    setResettingSession(true);
    setError(null);
    try {
      const result = await api.resetChatSession(chat.id);
      setChat(result.chat);
      setLastRun(null);
      setChats((current) => [
        result.chat,
        ...current.filter((item) => item.id !== result.chat.id),
      ]);
    } catch (caught) {
      setError(caught);
    } finally {
      setResettingSession(false);
    }
  };

  const send = async (event) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !agentId || sending) return;

    const streaming = selectedAgent?.stream === true;
    setSending(true);
    setError(null);
    setDraft("");
    setLive(streaming ? EMPTY_LIVE : null);

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
        session: { ...(current?.session ?? {}), status: "running" },
        messages: [...(current?.messages ?? []), optimistic],
      }));

      const controller = new AbortController();
      inFlight.current = controller;
      const result = streaming
        ? await api.streamChatMessage(currentChat.id, content, {
            signal: controller.signal,
            onEvent: (event) =>
              setLive((current) => applyLiveEvent(current, event)),
          })
        : await api.sendChatMessage(currentChat.id, content);
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
      // An abort is this component going away, not a failure to report.
      if (caught?.name !== "AbortError") setError(caught);
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
      inFlight.current = null;
      setSending(false);
      setLive(null);
    }
  };

  const applySuggestion = (value) => {
    setDraft(value);
    composer.current?.focus();
  };

  if (loading && agents.length === 0) return <Loading what="chat workspace" />;

  return (
    <section className="flex min-h-[480px] min-w-0 flex-1 flex-col">
      <h1 className="sr-only">Chat</h1>

      {/*
        The row is `minmax(0,1fr)` rather than the implicit `auto`: a grid item
        keeps `min-height: auto`, so an auto row would size itself to the whole
        transcript and overflow the card instead of letting the thread scroll.
      */}
      <div className="relative grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] overflow-hidden rounded-large border border-divider bg-content1 shadow-sm lg:grid-cols-[276px_minmax(0,1fr)]">
        <aside
          className={`absolute inset-y-0 left-0 z-20 flex min-h-0 w-[276px] min-w-0 flex-col border-r border-divider bg-content2/60 transition-transform duration-200 lg:static lg:translate-x-0 ${
            sidebarOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
          }`}
          aria-label="Chat history"
        >
          <div className="flex flex-col gap-2.5 border-b border-divider p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.11em] text-primary">
                Agent playground
              </span>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                className="lg:hidden"
                aria-label="Close chat history"
                onPress={() => setSidebarOpen(false)}
              >
                <Icon name="close" className="h-4 w-4" />
              </Button>
            </div>

            <Select
              aria-label="Choose an agent"
              size="sm"
              variant="bordered"
              placeholder="Choose an agent"
              classNames={{ trigger: "bg-content1" }}
              selectedKeys={agentId ? [agentId] : []}
              disabledKeys={agents
                .filter((agent) => !agent.enabled)
                .map((agent) => agent.id)}
              onSelectionChange={(keys) => selectAgent([...keys][0] ?? "")}
            >
              {agents.map((agent) => (
                <SelectItem key={agent.id} textValue={agent.name}>
                  {agent.name}
                  {!agent.enabled ? " (disabled)" : ""}
                </SelectItem>
              ))}
            </Select>

            <Button
              size="sm"
              color="primary"
              radius="md"
              className="h-9"
              isDisabled={!agentId}
              onPress={newChat}
              startContent={<Icon name="plus" className="h-4 w-4" />}
            >
              New chat
            </Button>
          </div>

          <div className="p-3 pb-2">
            <Input
              type="search"
              size="sm"
              variant="bordered"
              aria-label="Search chats"
              placeholder="Search chats"
              value={search}
              onValueChange={setSearch}
              startContent={
                <Icon name="search" className="h-4 w-4 text-default-400" />
              }
              classNames={{ inputWrapper: "h-9 bg-content1" }}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {visibleChats.length ? (
              groupChats(visibleChats).map((group) => (
                <div className="mt-2 first:mt-0" key={group.label}>
                  <span className="block px-2 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.1em] text-default-400">
                    {group.label}
                  </span>
                  <ul className="flex flex-col gap-0.5">
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
              <p className="px-3 py-4 text-tiny text-default-500">
                {search.trim()
                  ? "No chats match that search."
                  : "No chats yet. Start one below."}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-divider px-4 py-2.5 text-tiny text-default-500">
            <span>
              {chats.length} {chats.length === 1 ? "chat" : "chats"}
            </span>
            <HeroLink href="/runs" size="sm">
              Runs
            </HeroLink>
          </div>
        </aside>

        {sidebarOpen && (
          <button
            type="button"
            className="absolute inset-0 z-10 bg-black/35 backdrop-blur-sm lg:hidden"
            aria-label="Close chat history"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <div className="relative flex min-h-0 min-w-0 flex-col bg-content1">
          <header className="flex min-h-[60px] items-center gap-3 border-b border-divider px-3.5 py-2.5">
            <Button
              isIconOnly
              size="sm"
              variant="light"
              className="lg:hidden"
              aria-label="Open chat history"
              aria-expanded={sidebarOpen}
              onPress={() => setSidebarOpen(true)}
            >
              <Icon name="menu" className="h-5 w-5" />
            </Button>

            {selectedAgent ? (
              <>
                <AgentAvatar circle name={selectedAgent.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-small font-semibold">
                    {chat?.title || selectedAgent.name}
                  </strong>
                  <span className="block truncate text-tiny text-default-500">
                    {selectedAgent.resolved?.modelProvider?.model ??
                      selectedAgent.model ??
                      "Configured model"}
                    {chat?.messageCount
                      ? ` · ${chat.messageCount} messages`
                      : ""}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Chip
                    size="sm"
                    variant="flat"
                    color={agentReady ? "success" : "warning"}
                    classNames={{
                      base: "hidden h-6 rounded-full sm:flex",
                      content: "px-1 text-tiny font-semibold",
                    }}
                    startContent={
                      <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-current" />
                    }
                  >
                    {agentReady ? "Ready" : "Needs setup"}
                  </Chip>
                  {chat && (
                    <Tooltip
                      content={sessionDescription(chat.session)}
                      size="sm"
                    >
                      <Chip
                        size="sm"
                        variant="flat"
                        color={sessionPresentation(chat.session).color}
                        classNames={{
                          base: "hidden h-6 rounded-full md:flex",
                          content: "px-1 text-tiny font-semibold",
                        }}
                        startContent={
                          <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-current" />
                        }
                      >
                        {sessionPresentation(chat.session).label}
                      </Chip>
                    </Tooltip>
                  )}
                  <Tooltip content="Agent configuration" size="sm">
                    <Button
                      as={Link}
                      to={`/agents/${selectedAgent.id}`}
                      isIconOnly
                      size="sm"
                      variant="light"
                      aria-label="Open agent configuration"
                    >
                      <Icon name="settings" className="h-4 w-4" />
                    </Button>
                  </Tooltip>
                  {chat && (
                    <Tooltip content="Reset agent context" size="sm">
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        aria-label="Reset agent context"
                        isLoading={resettingSession}
                        isDisabled={sending || resettingSession}
                        onPress={resetSession}
                      >
                        {!resettingSession && (
                          <Icon name="refresh" className="h-4 w-4" />
                        )}
                      </Button>
                    </Tooltip>
                  )}
                  {chat && (
                    <Tooltip content="Delete chat" size="sm" color="danger">
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        color="danger"
                        aria-label="Delete this chat"
                        onPress={() => removeChat(chat)}
                      >
                        <Icon name="trash" className="h-4 w-4" />
                      </Button>
                    </Tooltip>
                  )}
                </div>
              </>
            ) : (
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-small font-semibold">
                  No agent selected
                </strong>
                <span className="block truncate text-tiny text-default-500">
                  Pick an agent to open a conversation
                </span>
              </div>
            )}
          </header>

          {!selectedAgent ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <AgentPicker agents={agents} onSelect={selectAgent} />
            </div>
          ) : (
            <>
              <div
                className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
                onScroll={trackScroll}
                aria-live="polite"
              >
                <div className="mx-auto flex w-full max-w-[780px] flex-1 flex-col gap-6 px-4 pb-3 pt-6 sm:px-7">
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
                  {sending &&
                    (live ? (
                      <LiveMessage live={live} agentName={selectedAgent.name} />
                    ) : (
                      <PendingMessage agentName={selectedAgent.name} />
                    ))}
                  <div ref={threadEnd} />
                </div>
              </div>

              <div className="relative mx-auto w-full max-w-[780px] px-4 pb-4 pt-1.5 sm:px-7">
                {!atBottom && (
                  <Button
                    isIconOnly
                    size="sm"
                    radius="full"
                    variant="flat"
                    className="absolute -top-10 left-1/2 z-10 -translate-x-1/2 border border-divider bg-content1 shadow-md"
                    aria-label="Scroll to latest message"
                    onPress={() =>
                      threadEnd.current?.scrollIntoView({
                        block: "end",
                        behavior: "smooth",
                      })
                    }
                  >
                    <Icon name="down" className="h-4 w-4" />
                  </Button>
                )}

                <ErrorNote error={error} />

                {!agentReady && (
                  <div className="mb-2.5 rounded-medium border border-warning-200 bg-warning-50 px-3 py-2.5 text-tiny text-warning-700 dark:border-warning-500/25 dark:bg-warning-500/10 dark:text-warning-400">
                    <strong className="block font-semibold">
                      This agent needs configuration before it can run.
                    </strong>
                    <ul className="my-1 list-disc space-y-0.5 pl-4">
                      {(selectedAgent.resolved?.issues ?? []).map(
                        (issue, index) => (
                          <li key={issue.code ?? index}>
                            {issue.message ?? String(issue)}
                          </li>
                        ),
                      )}
                    </ul>
                    <HeroLink
                      href={`/agents/${selectedAgent.id}`}
                      size="sm"
                      color="warning"
                    >
                      Review agent configuration
                    </HeroLink>
                  </div>
                )}

                <form
                  className="rounded-[16px] border border-divider bg-content1 py-2 pl-3.5 pr-2 shadow-sm transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20"
                  onSubmit={send}
                >
                  <label className="sr-only" htmlFor="chat-message">
                    Message {selectedAgent.name}
                  </label>
                  <div className="flex items-end gap-2">
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
                      placeholder={`Ask ${selectedAgent.name} to do something…`}
                      disabled={sending || resettingSession || !agentReady}
                      className="max-h-[208px] min-h-[28px] w-full resize-none border-0 bg-transparent py-1 text-small leading-relaxed text-foreground outline-none placeholder:text-default-400 disabled:opacity-60"
                    />
                    <Button
                      type="submit"
                      isIconOnly
                      radius="full"
                      color="primary"
                      size="sm"
                      className="h-9 w-9 shrink-0"
                      aria-label={sending ? "Running" : "Send message"}
                      isLoading={sending}
                      isDisabled={
                        !draft.trim() ||
                        sending ||
                        resettingSession ||
                        !agentReady
                      }
                    >
                      {!sending && <Icon name="send" className="h-4 w-4" />}
                    </Button>
                  </div>
                  <div className="flex min-h-6 items-center justify-between gap-3 px-0.5 pb-0.5 pt-1.5">
                    <span className="hidden text-tiny text-default-400 sm:block">
                      Enter to send · Shift + Enter for a new line
                    </span>
                    {lastRun && (
                      <div className="ml-auto flex items-center gap-2.5 text-tiny text-default-500">
                        <StatusPill status={lastRun.status} />
                        <span>{tokens(lastRun.usage)}</span>
                        <span>{duration(lastRun.durationMs)}</span>
                        <HeroLink href={`/runs/${lastRun.id}`} size="sm">
                          Open run
                        </HeroLink>
                      </div>
                    )}
                  </div>
                </form>
              </div>
            </>
          )}
        </div>
      </div>

      {confirmDialog}
    </section>
  );
}

function ChatListItem({ item, active, onRemove }) {
  const title = item.title || item.agentName || "Untitled chat";
  return (
    <li
      className={`group relative rounded-medium ${
        active
          ? "bg-primary/10 ring-1 ring-inset ring-primary/25"
          : "hover:bg-default-100"
      }`}
    >
      <HeroLink
        href={`/chat/${item.agentId}?chat=${item.id}`}
        className="block rounded-medium py-2 pl-2.5 pr-9 text-foreground"
      >
        <span className="block truncate text-small font-medium">{title}</span>
        <span className="mt-0.5 block truncate text-tiny text-default-500">
          {item.agentName ? item.agentName + " · " : ""}
          {relative(item.updatedAt ?? item.createdAt)}
        </span>
      </HeroLink>
      <Button
        isIconOnly
        size="sm"
        variant="light"
        color="danger"
        className="absolute right-1 top-1/2 h-7 w-7 min-w-7 -translate-y-1/2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
        aria-label={`Delete ${title}`}
        onPress={() => onRemove(item)}
      >
        <Icon name="trash" className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

function AgentPicker({ agents, onSelect }) {
  const runnable = agents.filter((agent) => agent.enabled);
  return (
    <div className="m-auto flex max-w-[640px] flex-col items-center px-4 pb-9 pt-7 text-center">
      <span className="mb-3.5 grid h-12 w-12 place-items-center rounded-large bg-gradient-to-br from-primary to-secondary text-white shadow-md">
        <Icon name="spark" className="h-5 w-5" />
      </span>
      <h2 className="text-xl font-semibold tracking-tight">
        Choose an agent to begin
      </h2>
      <p className="mb-4 mt-1.5 max-w-[48ch] text-small text-default-500">
        Chats keep prompts, answers, and run metadata together in MongoDB.
      </p>
      {runnable.length > 0 && (
        <div className="grid w-full grid-cols-1 gap-2.5 text-left sm:grid-cols-2">
          {runnable.slice(0, 6).map((agent) => (
            <button
              type="button"
              key={agent.id}
              onClick={() => onSelect(agent.id)}
              className="flex items-center gap-3 rounded-large border border-divider bg-content1 px-3.5 py-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm"
            >
              <AgentAvatar circle name={agent.name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small font-medium">
                  {agent.name}
                </span>
                <span className="block truncate text-tiny text-default-500">
                  {agent.description || "Open a new chat"}
                </span>
              </span>
              <Icon name="arrow" className="h-4 w-4 text-default-400" />
            </button>
          ))}
        </div>
      )}
      {agents.length === 0 && (
        <Button as={Link} to="/agents/new" color="primary" radius="md">
          Create your first agent
        </Button>
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
    <div className="m-auto flex max-w-[640px] flex-col items-center px-2 pb-9 pt-7 text-center">
      <AgentAvatar circle name={agent.name} size="lg" className="mb-3.5" />
      <h2 className="text-xl font-semibold tracking-tight">
        Chat with {agent.name}
      </h2>
      <p className="mt-1.5 max-w-[48ch] text-small text-default-500">
        {agent.description || "Start with a prompt below."}
      </p>
      {facts.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
          {facts.map((fact) => (
            <Chip
              key={fact}
              size="sm"
              variant="flat"
              classNames={{ base: "h-6 rounded-full", content: "text-tiny" }}
            >
              {fact}
            </Chip>
          ))}
        </div>
      )}
      <div className="mt-5 grid w-full grid-cols-1 gap-2.5 text-left sm:grid-cols-3">
        {suggestions.map((suggestion) => (
          <button
            type="button"
            key={suggestion}
            onClick={() => onSuggestion(suggestion)}
            className="flex items-start gap-2.5 rounded-large border border-divider bg-content1 px-3.5 py-3 text-left text-small leading-snug transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm"
          >
            <span className="min-w-0 flex-1">{suggestion}</span>
            <Icon name="arrow" className="mt-0.5 h-4 w-4 text-default-400" />
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
    <article
      className={`group grid items-start gap-3 ${
        role === "user" ? "grid-cols-1" : "grid-cols-[30px_minmax(0,1fr)]"
      }`}
    >
      {role !== "user" &&
        (isError ? (
          <span
            aria-hidden="true"
            className="grid h-[30px] w-[30px] place-items-center rounded-full bg-danger text-tiny font-bold text-white"
          >
            !
          </span>
        ) : (
          <AgentAvatar
            circle
            name={agentName}
            size="xs"
            className="h-[30px] w-[30px]"
          />
        ))}

      <div
        className={`min-w-0 ${role === "user" ? "justify-self-end max-w-[min(86%,580px)]" : ""}`}
      >
        <header
          className={`mb-1.5 flex items-baseline gap-2 ${
            role === "user" ? "justify-end" : ""
          }`}
        >
          <strong className="text-small font-semibold">{author}</strong>
          {message.createdAt && (
            <span
              className="text-tiny text-default-400"
              title={when(message.createdAt)}
            >
              {clock(message.createdAt)}
            </span>
          )}
        </header>

        <div
          className={`text-small ${
            role === "user"
              ? "rounded-[14px] rounded-tr-[4px] border border-primary-200 bg-primary-50 px-4 py-2.5 dark:border-primary-500/25 dark:bg-primary-500/10"
              : isError
                ? "rounded-[14px] rounded-tl-[4px] border border-danger-200 bg-danger-50 px-4 py-2.5 text-danger dark:border-danger-500/25 dark:bg-danger-500/10"
                : ""
          }`}
        >
          {segments(content).map((segment, index) =>
            segment.kind === "code" ? (
              <CodeBlock key={index} value={segment.value} />
            ) : (
              <p key={index} className="message-text [&+&]:mt-3">
                {segment.value}
              </p>
            ),
          )}
        </div>

        <footer
          className={`mt-2 flex items-center gap-3.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${
            role === "user" ? "justify-end" : ""
          }`}
        >
          <CopyButton value={content} label="Copy message" />
          {message.runId && (
            <HeroLink href={`/runs/${message.runId}`} size="sm">
              View run
            </HeroLink>
          )}
        </footer>
      </div>
    </article>
  );
}

const EMPTY_LIVE = {
  status: "Starting the run",
  reasoning: "",
  text: "",
  tools: [],
  warnings: [],
};

/**
 * The in-flight turn, as the events describe it so far.
 *
 * A pure reducer rather than a pile of setState calls: one event can touch two
 * fields, and every branch has to leave the other fields alone. Unknown types
 * fall through untouched, so a runtime that emits something newer than this
 * console still renders everything it does understand.
 */
function applyLiveEvent(live, event) {
  const current = live ?? EMPTY_LIVE;
  switch (event?.type) {
    case "run.preparing":
      return { ...current, status: event.message };
    case "session.started":
      return { ...current, status: "Thinking" };
    case "turn.started":
      return { ...current, status: `Turn ${event.turn}` };
    case "assistant.reasoning.delta":
      return {
        ...current,
        status: "Thinking",
        reasoning: current.reasoning + (event.delta ?? ""),
      };
    case "assistant.text.delta":
      return {
        ...current,
        status: "Writing the answer",
        text: current.text + (event.delta ?? ""),
      };
    case "tool.input.delta":
      return {
        ...current,
        tools: upsertTool(current.tools, toolKey(event), (tool) => ({
          ...tool,
          name: event.toolName || tool.name,
          input: tool.input + (event.delta ?? ""),
        })),
      };
    case "tool.requested":
    case "tool.started":
      return {
        ...current,
        status: `Running ${event.call?.name ?? "a tool"}`,
        tools: upsertTool(current.tools, event.call?.id, (tool) => ({
          ...tool,
          name: event.call?.name ?? tool.name,
          input: tool.input || formatToolInput(event.call?.input),
          state: event.type === "tool.started" ? "running" : tool.state,
        })),
      };
    case "tool.progress":
      return {
        ...current,
        tools: upsertTool(current.tools, event.toolCallId, (tool) => ({
          ...tool,
          output: [...tool.output, event.message].slice(-40),
        })),
      };
    case "tool.completed":
      return {
        ...current,
        tools: upsertTool(current.tools, event.result?.toolCallId, (tool) => ({
          ...tool,
          state: event.result?.isError ? "error" : "done",
        })),
      };
    case "warning":
      return {
        ...current,
        warnings: [...current.warnings, event.message].slice(-5),
      };
    default:
      return current;
  }
}

/** Deltas arrive before an id on some gateways, so the slot number is the fallback. */
function toolKey(event) {
  return event.toolCallId || `index-${event.index}`;
}

function upsertTool(tools, key, update) {
  if (!key) return tools;
  const existing = tools.find((tool) => tool.key === key);
  if (existing) {
    return tools.map((tool) => (tool.key === key ? update(tool) : tool));
  }
  return [
    ...tools,
    update({ key, name: "", input: "", output: [], state: "pending" }),
  ];
}

function formatToolInput(input) {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

function LiveMessage({ live, agentName }) {
  const busy = !live.text;
  return (
    <article className="grid grid-cols-[30px_minmax(0,1fr)] items-start gap-3">
      <AgentAvatar
        circle
        name={agentName}
        size="xs"
        className="h-[30px] w-[30px] animate-pulse"
      />
      <div className="min-w-0">
        <header className="mb-1.5">
          <strong className="text-small font-semibold">{agentName}</strong>
        </header>

        {live.reasoning && (
          <details className="mb-2.5 rounded-medium border border-divider bg-content2 px-3 py-2">
            <summary className="flex cursor-pointer items-center gap-1.5 text-tiny font-semibold text-default-500 [&::-webkit-details-marker]:hidden">
              <Icon name="spark" className="h-3.5 w-3.5" />
              Thinking
            </summary>
            <p className="message-text mt-2 max-h-[260px] overflow-y-auto text-tiny text-default-500">
              {live.reasoning}
            </p>
          </details>
        )}

        {live.tools.map((tool) => (
          <ToolCard key={tool.key} tool={tool} />
        ))}

        {live.warnings.map((warning, index) => (
          <p
            className="mb-2 rounded-medium border border-warning-200 bg-warning-50 px-2.5 py-1.5 text-tiny text-warning-700 dark:border-warning-500/25 dark:bg-warning-500/10 dark:text-warning-400"
            key={`${warning}-${index}`}
          >
            {warning}
          </p>
        ))}

        {live.text ? (
          <p className="message-text text-small">
            {live.text}
            <span
              aria-hidden="true"
              className="ml-0.5 inline-block h-[1.05em] w-[7px] animate-caret-blink rounded-[1px] bg-primary align-text-bottom"
            />
          </p>
        ) : (
          <p className="text-small text-default-500">
            {live.status}
            <TypingDots />
          </p>
        )}
        {!busy && <span className="sr-only">{live.status}</span>}
      </div>
    </article>
  );
}

function ToolCard({ tool }) {
  const tone = {
    pending: "text-primary animate-pulse",
    running: "text-primary animate-pulse",
    done: "text-success",
    error: "text-danger",
  }[tool.state];

  return (
    <div
      className={`mb-2 overflow-hidden rounded-medium border bg-content2 ${
        tool.state === "error"
          ? "border-danger-200 dark:border-danger-500/25"
          : "border-divider"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-tiny text-default-500">
        <span className={tone}>
          <Icon
            name={tool.state === "done" ? "check" : "tool"}
            className="h-4 w-4"
          />
        </span>
        <code className="font-semibold text-foreground">
          {tool.name || "tool"}
        </code>
        {tool.input && (
          <span className="min-w-0 truncate font-mono text-[11px]">
            {tool.input}
          </span>
        )}
      </div>
      {tool.output.length > 0 && (
        <pre className="message-text max-h-[180px] overflow-auto border-t border-divider px-3 py-2 text-[11px] text-default-500">
          {tool.output.join("\n")}
        </pre>
      )}
    </div>
  );
}

function PendingMessage({ agentName }) {
  return (
    <article className="grid grid-cols-[30px_minmax(0,1fr)] items-start gap-3">
      <AgentAvatar
        circle
        name={agentName}
        size="xs"
        className="h-[30px] w-[30px] animate-pulse"
      />
      <div className="min-w-0">
        <header className="mb-1.5">
          <strong className="text-small font-semibold">{agentName}</strong>
        </header>
        <p className="text-small text-default-500">
          AgentCore is running this turn
          <TypingDots />
        </p>
      </div>
    </article>
  );
}

function TypingDots() {
  return (
    <span
      className="ml-1.5 inline-flex gap-[3px] align-middle"
      aria-hidden="true"
    >
      <i className="h-1 w-1 animate-typing-hop rounded-full bg-default-400" />
      <i className="h-1 w-1 animate-typing-hop rounded-full bg-default-400 [animation-delay:0.15s]" />
      <i className="h-1 w-1 animate-typing-hop rounded-full bg-default-400 [animation-delay:0.3s]" />
    </span>
  );
}

function CodeBlock({ value }) {
  const { language, code } = splitFence(value);
  return (
    <div className="my-3 overflow-hidden rounded-medium border border-divider bg-content2 first:mt-0 last:mb-0">
      <div className="flex items-center justify-between gap-2.5 border-b border-divider bg-content3/40 py-1.5 pl-3 pr-2 text-[10px] font-bold uppercase tracking-[0.08em] text-default-500">
        <span>{language || "code"}</span>
        <CopyButton value={code} label="Copy code" />
      </div>
      <pre className="code-scroll max-h-[420px]">{code}</pre>
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
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 text-tiny normal-case tracking-normal text-default-500 transition-colors hover:text-primary"
    >
      <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" />
      {copied ? "Copied" : label}
    </button>
  );
}

function countLabel(count, noun) {
  if (!count) return null;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function sessionPresentation(session) {
  if (session?.status === "running")
    return { label: "Session running", color: "primary" };
  if (session?.status === "error")
    return { label: "Session issue", color: "danger" };
  if (session?.origin === "client_history")
    return { label: "Context restored", color: "secondary" };
  if (session?.status === "active")
    return {
      label: session?.storage === "s3" ? "S3 session active" : "Session active",
      color: "success",
    };
  return { label: "New session", color: "default" };
}

function sessionDescription(session) {
  const state = sessionPresentation(session).label;
  const messages = session?.historyMessageCount ?? 0;
  const generation = session?.generation ?? 1;
  const storage =
    session?.storage === "s3"
      ? "S3 durable"
      : `${session?.storage ?? "local"} storage`;
  return `${state} · ${storage} · context ${generation} · ${messages} runtime messages`;
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
