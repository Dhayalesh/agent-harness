import {
  Button,
  Chip,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
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
  ActivityIndicator,
  ContextMeter,
  ErrorNote,
  Loading,
  StatusPill,
  clock,
  duration,
  relative,
  useConfirm,
  usePrompt,
  when,
} from "../components/Bits.jsx";
import { Icon } from "../components/Icon.jsx";
import { MarkdownDocument } from "../components/MarkdownDocument.jsx";
import { ArtifactPreview } from "../components/artifacts/ArtifactPreview.jsx";
import {
  artifactExtension,
  artifactIcon,
  artifactKind,
  artifactLabel,
  artifactModes,
} from "../components/artifacts/artifact-utils.js";

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
  /**
   * Whether the next turn should compact before it runs.
   *
   * Armed rather than executed on press: compaction happens in front of a model
   * request, so doing it the moment the button is pressed would mean spending a
   * turn — and putting a message in the transcript — for housekeeping the user did
   * not ask to say out loud. The flag rides along with the next real message and is
   * cleared once it has been spent.
   */
  const [compactQueued, setCompactQueued] = useState(false);
  const [error, setError] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [live, setLive] = useState(null);
  const [documentPane, setDocumentPane] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadAccept, setUploadAccept] = useState("");
  const [confirm, confirmDialog] = useConfirm();
  const [promptText, promptDialog] = usePrompt();
  const threadEnd = useRef(null);
  const composer = useRef(null);
  const inFlight = useRef(null);
  const documentAutoOpened = useRef(false);
  const filePicker = useRef(null);
  // Depth rather than a boolean: dragging over a child fires leave on the parent,
  // which would otherwise clear the highlight while the pointer is still inside.
  const dragDepth = useRef(0);

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

  /**
   * What the context meter shows, newest measurement first.
   *
   * The live run is preferred while one is streaming, because it falls the instant a
   * compaction lands. The stored session measurement is what a reopened chat starts
   * from. Failing both, the resolved model's own window is enough to show an empty
   * meter — which is the honest reading for a conversation that has not run a turn
   * yet, and is also what keeps the affordance discoverable before the first
   * message rather than appearing out of nowhere after it.
   */
  const contextUsage = useMemo(() => {
    if (live?.context) return live.context;
    if (chat?.session?.context) return chat.session.context;
    const capabilities = selectedAgent?.resolved?.modelProvider?.capabilities;
    if (!capabilities?.contextWindow) return null;
    const reserved = capabilities.maxOutputTokens ?? 0;
    const budget = Math.max(1, capabilities.contextWindow - reserved);
    return {
      usedTokens: 0,
      budgetTokens: budget,
      contextWindow: capabilities.contextWindow,
      reservedOutputTokens: reserved,
      usedPercent: 0,
      compacted: false,
      compactions: 0,
    };
  }, [live?.context, chat?.session?.context, selectedAgent]);

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

  // The server owns the accepted-type list, so the picker offers exactly what the
  // upload route will take. Fetched once; a failure just leaves the filter open.
  useEffect(() => {
    let cancelled = false;
    void api
      .catalogue()
      .then((result) => {
        if (!cancelled) {
          setUploadAccept((result.uploads?.accept ?? []).join(","));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const liveDocument = useMemo(() => artifactDraftFromLive(live), [live]);

  useEffect(() => {
    if (!liveDocument) return;
    if (!documentAutoOpened.current) {
      documentAutoOpened.current = true;
      setDocumentPane(liveDocument);
      return;
    }
    setDocumentPane((current) =>
      current?.kind === "live" && current.key === liveDocument.key
        ? liveDocument
        : current,
    );
  }, [liveDocument]);

  const trackScroll = (event) => {
    const node = event.currentTarget;
    setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 96);
  };

  const selectAgent = (nextId) => {
    setDraft("");
    // Pending uploads belong to the chat they were uploaded against.
    setAttachments([]);
    setDocumentPane(null);
    navigate(nextId ? "/chat/" + nextId : "/chat");
  };

  const newChat = () => {
    if (!agentId) return;
    setChat(null);
    setLastRun(null);
    setDraft("");
    setAttachments([]);
    setDocumentPane(null);
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

  /**
   * Keeps the summary list and the open chat in step after a metadata edit.
   *
   * Only the three fields a rename or a pin can change are copied across: the
   * PATCH response is a full chat, and merging it wholesale would push a stored
   * transcript into the sidebar summaries.
   */
  const applyChatPatch = (updated) => {
    const patch = {
      title: updated.title,
      pinned: updated.pinned,
      updatedAt: updated.updatedAt,
    };
    setChats((current) =>
      current.map((item) =>
        item.id === updated.id ? { ...item, ...patch } : item,
      ),
    );
    setChat((current) =>
      current?.id === updated.id ? { ...current, ...patch } : current,
    );
  };

  const renameChat = async (target) => {
    const victim = target ?? chat;
    if (!victim) return;
    const current = victim.title ?? "";
    const title = await promptText({
      title: "Rename chat",
      label: "Chat name",
      placeholder: "Chat name",
      defaultValue: current,
      confirmLabel: "Rename",
    });
    if (title === null || title === current) return;
    try {
      applyChatPatch((await api.renameChat(victim.id, title)).chat);
    } catch (caught) {
      setError(caught);
    }
  };

  const togglePin = async (target) => {
    const victim = target ?? chat;
    if (!victim) return;
    try {
      applyChatPatch(
        (await api.setChatPinned(victim.id, !victim.pinned)).chat,
      );
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
      // A fresh session has nothing to compact.
      setCompactQueued(false);
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
    const sent = attachments;
    if ((!content && !sent.length) || !agentId || sending || uploading) return;

    const streaming = selectedAgent?.stream === true;
    setSending(true);
    setError(null);
    setDraft("");
    setAttachments([]);
    setLive(streaming ? EMPTY_LIVE : null);
    documentAutoOpened.current = false;

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
        ...(sent.length ? { attachments: sent } : {}),
      };
      setChat((current) => ({
        ...current,
        session: { ...(current?.session ?? {}), status: "running" },
        messages: [...(current?.messages ?? []), optimistic],
      }));

      const controller = new AbortController();
      inFlight.current = controller;
      const attachmentIds = sent.map((item) => item.id);
      // Read once and cleared on the way out, so a failed turn does not silently
      // drop a compaction the user asked for.
      const compactContext = compactQueued;
      const result = streaming
        ? await api.streamChatMessage(currentChat.id, content, {
            signal: controller.signal,
            attachmentIds,
            compactContext,
            onEvent: (event) =>
              setLive((current) => applyLiveEvent(current, event)),
          })
        : await api.sendChatMessage(currentChat.id, content, {
            attachmentIds,
            compactContext,
          });
      setCompactQueued(false);
      setChat(result.chat);
      setLastRun(result.run ?? null);
      const completedArtifact = latestArtifact(result.chat);
      if (completedArtifact) {
        setDocumentPane({ kind: "saved", artifact: completedArtifact });
        documentAutoOpened.current = true;
      }
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

  /**
   * Uploads on selection rather than on send.
   *
   * The file is validated, extracted, and sized server-side before the user has
   * written anything, so an unreadable upload is reported while they can still do
   * something about it. It also means the chat has to exist, so one is created here
   * if this is the first thing to happen in a new conversation.
   */
  const addFiles = async (fileList) => {
    const files = [...(fileList ?? [])];
    if (!files.length || !agentId || uploading) return;
    setUploading(true);
    setError(null);
    try {
      let currentChat = chat;
      if (!currentChat) {
        const created = await api.createChat({ agentId });
        currentChat = created.chat;
        setChat(currentChat);
        setChats((current) => [currentChat, ...current]);
        navigate("/chat/" + agentId + "?chat=" + currentChat.id, {
          replace: true,
        });
      }
      const result = await api.uploadChatAttachments(currentChat.id, files);
      setAttachments((current) => [...current, ...(result.attachments ?? [])]);
      // A partial success is not an error, but the user still needs to know which
      // files did not make it and why.
      if (result.rejected?.length) {
        setError(
          new Error(
            result.rejected
              .map((entry) => `${entry.filename}: ${entry.reason}`)
              .join("\n"),
          ),
        );
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setUploading(false);
      composer.current?.focus();
    }
  };

  const removeAttachment = (id) => {
    setAttachments((current) => current.filter((item) => item.id !== id));
  };

  const onDragEnter = (event) => {
    if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const onDrop = (event) => {
    if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void addFiles(event.dataTransfer?.files);
  };

  const applySuggestion = (value) => {
    setDraft(value);
    composer.current?.focus();
  };

  if (loading && agents.length === 0) return <Loading what="chat workspace" />;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-content1">
      <h1 className="sr-only">Chat</h1>

      {/*
        The row is `minmax(0,1fr)` rather than the implicit `auto`: a grid item
        keeps `min-height: auto`, so an auto row would size itself to the whole
        transcript and overflow the card instead of letting the thread scroll.
      */}
      <div
        className={`relative grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] overflow-hidden bg-content1 lg:grid-cols-[264px_minmax(0,1fr)] ${
          documentPane
            ? "xl:grid-cols-[264px_minmax(400px,1fr)_minmax(380px,42vw)]"
            : ""
        }`}
      >
        <aside
          className={`absolute inset-y-0 left-0 z-20 flex min-h-0 w-[264px] min-w-0 flex-col border-r border-divider bg-[#f7f6f2] transition-transform duration-200 dark:bg-[#1f1e1b] lg:static lg:translate-x-0 ${
            sidebarOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
          }`}
          aria-label="Chat history"
        >
          <div className="flex flex-col gap-3 border-b border-divider p-3">
            <div className="flex min-h-10 items-center justify-between gap-2">
              <Link
                to="/"
                className="flex min-w-0 items-center gap-2.5 rounded-medium outline-none transition-opacity hover:opacity-75"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-medium bg-[#d97757] text-white shadow-[inset_0_0_0_1px_rgba(75,35,23,0.12)] dark:bg-[#c86f50]">
                  <Icon name="spark" className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-small font-semibold">
                    Agent Console
                  </strong>
                  <span className="block truncate text-[10px] text-default-500">
                    Chat workspace
                  </span>
                </span>
              </Link>
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

            <Button
              size="sm"
              radius="md"
              className="h-9 bg-[#302e2b] font-medium text-white shadow-[0_1px_2px_rgba(27,25,22,0.16)] hover:bg-[#242220] dark:bg-[#ece8df] dark:text-[#242220] dark:hover:bg-white"
              isDisabled={!agentId}
              onPress={newChat}
              startContent={<Icon name="plus" className="h-4 w-4" />}
            >
              New chat
            </Button>

            <span className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-default-500">
              Active agent
            </span>
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
          </div>

          <div className="px-3 pb-2 pt-3">
            <Input
              type="search"
              size="sm"
              variant="flat"
              aria-label="Search chats"
              placeholder="Search chats"
              value={search}
              onValueChange={setSearch}
              startContent={
                <Icon name="search" className="h-4 w-4 text-default-400" />
              }
              classNames={{
                inputWrapper:
                  "h-9 border border-transparent bg-content2 shadow-none data-[focus=true]:border-divider data-[focus=true]:bg-content1",
              }}
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
                        onRename={renameChat}
                        onPin={togglePin}
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

          <div className="grid grid-cols-2 gap-1 border-t border-divider p-2">
            <Button
              as={Link}
              to="/"
              size="sm"
              variant="light"
              className="justify-start text-default-600"
              startContent={<Icon name="dashboard" className="h-4 w-4" />}
            >
              Workspace
            </Button>
            <Button
              as={Link}
              to="/runs"
              size="sm"
              variant="light"
              className="justify-start text-default-600"
              startContent={<Icon name="runs" className="h-4 w-4" />}
            >
              Runs
            </Button>
            <span className="col-span-2 px-2 pb-1 text-[10px] text-default-400">
              {chats.length} {chats.length === 1 ? "chat" : "chats"}
            </span>
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

        <div
          className="relative flex min-h-0 min-w-0 flex-col bg-content1"
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          // Without preventDefault on dragover the browser refuses the drop and
          // navigates to the file instead.
          onDragOver={(event) => {
            if ([...(event.dataTransfer?.types ?? [])].includes("Files")) {
              event.preventDefault();
            }
          }}
          onDrop={onDrop}
        >
          {dragging && selectedAgent && (
            <div
              className="pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-large border-2 border-dashed border-secondary/60 bg-background/80 backdrop-blur-sm"
              role="status"
            >
              <span className="flex flex-col items-center gap-2 text-small font-medium text-secondary">
                <Icon name="paperclip" className="h-6 w-6" />
                Drop files to attach
              </span>
            </div>
          )}
          <header className="flex min-h-[64px] items-center gap-3 border-b border-divider bg-content1/95 px-4 py-2.5 backdrop-blur sm:px-5">
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
                    <Tooltip content="Rename chat" size="sm">
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        aria-label="Rename this chat"
                        onPress={() => renameChat(chat)}
                      >
                        <Icon name="edit" className="h-4 w-4" />
                      </Button>
                    </Tooltip>
                  )}
                  {chat && (
                    <Tooltip
                      content={chat.pinned ? "Unpin chat" : "Pin chat"}
                      size="sm"
                    >
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        aria-label={
                          chat.pinned ? "Unpin this chat" : "Pin this chat"
                        }
                        aria-pressed={Boolean(chat.pinned)}
                        className={chat.pinned ? "text-secondary" : undefined}
                        onPress={() => togglePin(chat)}
                      >
                        <Icon
                          name={chat.pinned ? "unpin" : "pin"}
                          className="h-4 w-4"
                        />
                      </Button>
                    </Tooltip>
                  )}
                  {chat && (
                    <Tooltip content="Reset agent context" size="sm">
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        aria-label="Reset agent context"
                        isDisabled={sending || resettingSession}
                        onPress={resetSession}
                      >
                        {resettingSession ? (
                          <ActivityIndicator size="sm" />
                        ) : (
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
                <div className="mx-auto flex w-full max-w-[840px] flex-1 flex-col gap-8 px-4 pb-5 pt-8 sm:px-8 lg:px-10">
                  {chat?.messages?.length ? (
                    chat.messages.map((message, index) => (
                      <Message
                        key={message.id ?? `${message.role}-${index}`}
                        message={message}
                        agentName={selectedAgent.name}
                        onOpenDocument={(artifact) =>
                          setDocumentPane({ kind: "saved", artifact })
                        }
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

              <div className="relative mx-auto w-full max-w-[840px] px-4 pb-5 pt-2 sm:px-8 lg:px-10">
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
                  className="rounded-[20px] border border-divider bg-content1 py-2.5 pl-4 pr-2.5 shadow-[0_8px_28px_rgba(36,32,27,0.08),0_1px_3px_rgba(36,32,27,0.06)] transition-all focus-within:border-secondary/50 focus-within:shadow-[0_10px_32px_rgba(36,32,27,0.11),0_0_0_3px_rgba(182,95,66,0.08)] dark:shadow-[0_10px_28px_rgba(0,0,0,0.24)]"
                  onSubmit={send}
                >
                  <label className="sr-only" htmlFor="chat-message">
                    Message {selectedAgent.name}
                  </label>
                  {(attachments.length > 0 || uploading) && (
                    <AttachmentTray
                      attachments={attachments}
                      uploading={uploading}
                      onRemove={removeAttachment}
                    />
                  )}
                  <div className="flex items-end gap-2">
                    <input
                      ref={filePicker}
                      type="file"
                      multiple
                      accept={uploadAccept}
                      className="hidden"
                      onChange={(event) => {
                        void addFiles(event.target.files);
                        // Cleared so choosing the same file twice still fires.
                        event.target.value = "";
                      }}
                    />
                    <Tooltip content="Attach files" size="sm">
                      <Button
                        isIconOnly
                        radius="md"
                        size="sm"
                        variant="light"
                        className="h-9 w-9 shrink-0 text-default-500"
                        aria-label="Attach files"
                        isDisabled={sending || resettingSession || !agentReady}
                        onPress={() => filePicker.current?.click()}
                      >
                        <Icon name="paperclip" className="h-4 w-4" />
                      </Button>
                    </Tooltip>
                    <textarea
                      id="chat-message"
                      ref={composer}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onPaste={(event) => {
                        // Screenshot straight from the clipboard, the way every
                        // other chat client behaves.
                        const pasted = [...(event.clipboardData?.files ?? [])];
                        if (!pasted.length) return;
                        event.preventDefault();
                        void addFiles(pasted);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                      rows={1}
                      placeholder={`Ask ${selectedAgent.name} to do something…`}
                      disabled={sending || resettingSession || !agentReady}
                      className="max-h-[208px] min-h-[30px] w-full resize-none border-0 bg-transparent py-1 text-[15px] leading-6 text-foreground outline-none placeholder:text-default-400 disabled:opacity-60"
                    />
                    <Button
                      type="submit"
                      isIconOnly
                      radius="md"
                      size="sm"
                      className="h-9 w-9 shrink-0 bg-[#302e2b] text-white shadow-[0_1px_2px_rgba(30,28,25,0.16)] hover:bg-[#242220] dark:bg-[#ece8df] dark:text-[#242220] dark:hover:bg-white"
                      aria-label={sending ? "Running" : "Send message"}
                      isDisabled={
                        // Files alone are a valid message.
                        (!draft.trim() && attachments.length === 0) ||
                        uploading ||
                        sending ||
                        resettingSession ||
                        !agentReady
                      }
                    >
                      {sending ? (
                        <ActivityIndicator
                          size="sm"
                          className="text-white dark:text-black"
                        />
                      ) : (
                        <Icon name="send" className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <div className="flex min-h-6 items-center justify-between gap-3 px-0.5 pb-0.5 pt-1.5">
                    {compactQueued ? (
                      <span className="flex items-center gap-1.5 text-tiny text-secondary">
                        <Icon name="compact" className="h-3.5 w-3.5" />
                        Context will be compacted on your next message
                        <button
                          type="button"
                          className="underline underline-offset-2 hover:no-underline"
                          onClick={() => setCompactQueued(false)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <span className="hidden text-tiny text-default-400 sm:block">
                        Enter to send · Shift + Enter for a new line
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-2.5 text-tiny text-default-500">
                      {lastRun && (
                        <>
                          <StatusPill status={lastRun.status} />
                          <span>{duration(lastRun.durationMs)}</span>
                          <HeroLink href={`/runs/${lastRun.id}`} size="sm">
                            Open run
                          </HeroLink>
                        </>
                      )}
                      <ContextMeter
                        context={contextUsage}
                        queued={compactQueued}
                        disabled={sending || uploading}
                        onCompact={() => setCompactQueued(true)}
                      />
                    </div>
                  </div>
                </form>
              </div>
            </>
          )}
        </div>

        {documentPane && (
          <DocumentWorkspace
            document={documentPane}
            onClose={() => setDocumentPane(null)}
          />
        )}
      </div>

      {confirmDialog}
      {promptDialog}
    </section>
  );
}

/** Pending uploads above the composer, each removable before the message is sent. */
function AttachmentTray({ attachments, uploading, onRemove }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-1.5 px-0.5">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          <AttachmentChip attachment={attachment} onRemove={onRemove} />
        </li>
      ))}
      {uploading && (
        <li className="flex h-8 items-center gap-2 rounded-medium border border-divider bg-content2 px-2.5 text-tiny text-default-500">
          <ActivityIndicator size="sm" />
          Reading files…
        </li>
      )}
    </ul>
  );
}

/**
 * One attachment, as a chip.
 *
 * Reports the extracted character count rather than the file size for text, because
 * that is what the upload actually costs in context — a 4 MB workbook and a 4 MB
 * screenshot are nothing alike once one of them has been reduced to a grid.
 */
function AttachmentChip({ attachment, onRemove }) {
  const detail = [
    attachment.label,
    attachment.handling === "image"
      ? fileSize(attachment.size)
      : attachment.textChars
        ? `${attachment.textChars.toLocaleString()} chars`
        : fileSize(attachment.size),
    ...(attachment.notes ?? []),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      className={`group/chip flex h-8 max-w-[240px] items-center gap-1.5 rounded-medium border border-divider bg-content2 pl-2 text-tiny ${
        onRemove ? "pr-1" : "pr-2.5"
      }`}
    >
      <Icon
        name={attachment.handling === "image" ? "image" : "file"}
        className="h-3.5 w-3.5 shrink-0 text-default-500"
      />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-medium text-foreground">
          {attachment.url ? (
            <HeroLink
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              className="text-tiny text-foreground"
            >
              {attachment.filename}
            </HeroLink>
          ) : (
            attachment.filename
          )}
        </span>
        {detail && (
          <span className="block truncate text-[10px] text-default-500">
            {detail}
          </span>
        )}
      </span>
      {onRemove && (
        <Button
          isIconOnly
          size="sm"
          variant="light"
          className="h-6 w-6 min-w-6 shrink-0 text-default-500"
          aria-label={`Remove ${attachment.filename}`}
          onPress={() => onRemove(attachment.id)}
        >
          <Icon name="close" className="h-3 w-3" />
        </Button>
      )}
    </span>
  );
}

function fileSize(bytes) {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function ChatListItem({ item, active, onRename, onPin, onRemove }) {
  const title = item.title || item.agentName || "Untitled chat";
  return (
    <li
      className={`group relative rounded-medium ${
        active
          ? "bg-content1 shadow-[0_1px_3px_rgba(32,29,25,0.07)] ring-1 ring-inset ring-divider"
          : "hover:bg-content1/70"
      }`}
    >
      <HeroLink
        href={`/chat/${item.agentId}?chat=${item.id}`}
        className="block rounded-medium py-2 pl-2.5 pr-9 text-foreground"
      >
        <span className="flex items-center gap-1.5">
          {item.pinned && (
            <Icon name="pin" className="h-3 w-3 shrink-0 text-secondary" />
          )}
          <span className="min-w-0 flex-1 truncate text-small font-medium">
            {title}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-tiny text-default-500">
          {item.agentName ? item.agentName + " · " : ""}
          {relative(item.updatedAt ?? item.createdAt)}
        </span>
      </HeroLink>
      <Dropdown placement="bottom-end">
        <DropdownTrigger>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            // Stays visible while its own menu is open, or the trigger vanishes
            // from under the pointer the moment the menu takes focus.
            className="absolute right-1 top-1/2 h-7 w-7 min-w-7 -translate-y-1/2 opacity-0 transition-opacity aria-expanded:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
            aria-label={`Actions for ${title}`}
          >
            <Icon name="dots" className="h-3.5 w-3.5" />
          </Button>
        </DropdownTrigger>
        <DropdownMenu
          aria-label={`Actions for ${title}`}
          onAction={(key) => {
            if (key === "rename") onRename(item);
            if (key === "pin") onPin(item);
            if (key === "delete") onRemove(item);
          }}
        >
          <DropdownItem
            key="rename"
            startContent={<Icon name="edit" className="h-4 w-4" />}
          >
            Rename
          </DropdownItem>
          <DropdownItem
            key="pin"
            startContent={
              <Icon name={item.pinned ? "unpin" : "pin"} className="h-4 w-4" />
            }
          >
            {item.pinned ? "Unpin" : "Pin"}
          </DropdownItem>
          <DropdownItem
            key="delete"
            color="danger"
            className="text-danger"
            startContent={<Icon name="trash" className="h-4 w-4" />}
          >
            Delete
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>
    </li>
  );
}

function AgentPicker({ agents, onSelect }) {
  const runnable = agents.filter((agent) => agent.enabled);
  return (
    <div className="m-auto flex max-w-[640px] flex-col items-center px-4 pb-9 pt-7 text-center">
      <span className="mb-4 grid h-12 w-12 place-items-center rounded-large border border-[#c96343] bg-[#d97757] text-white shadow-[0_4px_14px_rgba(139,68,43,0.18)] dark:bg-[#c86f50]">
        <Icon name="spark" className="h-5 w-5" />
      </span>
      <h2 className="text-xl font-medium tracking-[-0.02em]">
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
              className="flex items-center gap-3 rounded-large border border-divider bg-content1 px-3.5 py-3 text-left transition-all hover:border-[#c9c5bc] hover:bg-content2/50 hover:shadow-[0_2px_8px_rgba(36,32,27,0.05)] dark:hover:border-content4"
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
        <Button
          as={Link}
          to="/agents/new"
          radius="md"
          className="bg-[#302e2b] text-white hover:bg-[#242220] dark:bg-[#ece8df] dark:text-[#242220]"
        >
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
      <h2 className="text-xl font-medium tracking-[-0.02em]">
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
            className="flex items-start gap-2.5 rounded-large border border-divider bg-content1 px-3.5 py-3 text-left text-small leading-snug transition-all hover:border-[#c9c5bc] hover:bg-content2/50 hover:shadow-[0_2px_8px_rgba(36,32,27,0.05)] dark:hover:border-content4"
          >
            <span className="min-w-0 flex-1">{suggestion}</span>
            <Icon name="arrow" className="mt-0.5 h-4 w-4 text-default-400" />
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ message, agentName, onOpenDocument }) {
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
        className={`min-w-0 ${role === "user" ? "justify-self-end max-w-[min(88%,620px)]" : ""}`}
      >
        <header
          className={`mb-1.5 flex items-baseline gap-2 ${
            role === "user" ? "justify-end" : ""
          }`}
        >
          <strong className="text-[13px] font-semibold">{author}</strong>
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
              ? "rounded-[16px] rounded-tr-[5px] border border-divider bg-content2 px-4 py-2.5 shadow-[0_1px_2px_rgba(35,32,28,0.025)]"
              : isError
                ? "rounded-[14px] rounded-tl-[4px] border border-danger-200 bg-danger-50 px-4 py-2.5 text-danger dark:border-danger-500/25 dark:bg-danger-500/10"
                : ""
          }`}
        >
          {role !== "user" && message.reasoning && (
            <ThinkingBlock reasoning={message.reasoning} />
          )}
          {role !== "user" && message.toolCalls?.length > 0 && (
            <ToolHistory toolCalls={message.toolCalls} />
          )}
          {message.attachments?.length > 0 && (
            <ul
              className={`flex flex-wrap gap-1.5 ${content ? "mb-2" : ""} ${
                role === "user" ? "justify-end" : ""
              }`}
            >
              {message.attachments.map((attachment) => (
                <li key={attachment.id}>
                  <AttachmentChip attachment={attachment} />
                </li>
              ))}
            </ul>
          )}
          {/* A files-only turn has no text, and an empty paragraph would just add space. */}
          {content
            ? segments(content).map((segment, index) =>
                segment.kind === "code" ? (
                  <CodeBlock key={index} value={segment.value} />
                ) : (
                  <MarkdownDocument
                    key={index}
                    content={segment.value}
                    className="markdown-chat [&+&]:mt-3"
                  />
                ),
              )
            : null}
          {(message.artifacts ?? []).map((artifact) => (
            <DocumentCard
              key={artifact.id}
              artifact={artifact}
              onOpen={() => onOpenDocument(artifact)}
            />
          ))}
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
  messageReasoning: "",
  text: "",
  messageText: "",
  tools: [],
  artifacts: [],
  warnings: [],
  /** The last `context.usage` this run reported. Null until the first turn measures. */
  context: null,
  compactions: 0,
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
        messageReasoning: current.messageReasoning + (event.delta ?? ""),
      };
    case "assistant.text.delta":
      return {
        ...current,
        status: "Writing the answer",
        text: current.text + (event.delta ?? ""),
        messageText: current.messageText + (event.delta ?? ""),
      };
    case "assistant.message.completed": {
      const messageText = (event.message?.content ?? [])
        .filter((block) => block?.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      return {
        ...current,
        text: appendCompletedValue(
          current.text,
          current.messageText,
          messageText,
        ),
        reasoning: appendCompletedValue(
          current.reasoning,
          current.messageReasoning,
          event.message?.reasoning ?? "",
        ),
        messageText: "",
        messageReasoning: "",
      };
    }
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
          output:
            typeof event.result?.content === "string"
              ? [event.result.content]
              : tool.output,
        })),
      };
    case "artifact.created":
      return {
        ...current,
        status: "Document ready",
        artifacts: [
          ...current.artifacts.filter(
            (artifact) => artifact.id !== event.artifact?.id,
          ),
          event.artifact,
        ].filter(Boolean),
      };
    case "warning":
      return {
        ...current,
        warnings: [...current.warnings, event.message].slice(-5),
      };
    // The meter follows the newest measurement, so it falls as soon as a
    // compaction lands rather than at the end of the run.
    case "context.usage": {
      // The peak is kept as a high water mark rather than replaced, so a run that
      // compacted can show both what filled the context and what freeing it gave
      // back. Without it the meter drops and nothing explains why.
      const candidate = event.peakTokens ?? event.usedTokens ?? 0;
      const peaked = candidate > (current.context?.peakTokens ?? 0);
      return {
        ...current,
        context: {
          usedTokens: event.usedTokens ?? 0,
          budgetTokens: event.budgetTokens ?? 0,
          contextWindow: event.contextWindow,
          reservedOutputTokens: event.reservedOutputTokens,
          usedPercent: event.usedPercent ?? 0,
          compacted: event.compacted === true,
          compactions: current.compactions,
          peakTokens: peaked ? candidate : current.context?.peakTokens,
          peakPercent: peaked
            ? (event.peakPercent ?? event.usedPercent ?? 0)
            : current.context?.peakPercent,
        },
      };
    }
    case "context.compaction.started":
      return { ...current, status: "Compacting the context" };
    case "context.compaction.completed":
      return { ...current, compactions: current.compactions + 1 };
    default:
      return current;
  }
}

function appendCompletedValue(all, streamed, completed) {
  if (!completed || completed === streamed) return all;
  if (!streamed) return all ? `${all}\n\n${completed}` : completed;
  return completed.startsWith(streamed)
    ? all + completed.slice(streamed.length)
    : all;
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

const ARTIFACT_TOOL_KINDS = {
  create_markdown_artifact: "markdown",
  create_html_artifact: "html",
  create_document_artifact: "docx",
  create_spreadsheet_artifact: "xlsx",
  create_csv_artifact: "csv",
  create_json_artifact: "json",
  create_code_artifact: "code",
};

function artifactDraftFromLive(live) {
  const tool = [...(live?.tools ?? [])]
    .reverse()
    .find((candidate) => ARTIFACT_TOOL_KINDS[candidate.name]);
  if (!tool) return null;
  const parsed = parseJsonObject(tool.input);
  // One tool writes both JSON flavours, so its `format` argument picks the kind.
  // Until the arguments finish streaming it reads as plain JSON, which renders
  // the same either way.
  const kind =
    tool.name === "create_json_artifact" && parsed?.format === "ndjson"
      ? "ndjson"
      : ARTIFACT_TOOL_KINDS[tool.name];
  const language =
    kind === "code"
      ? (parsed?.language ??
        partialJsonStringField(tool.input, "language") ??
        undefined)
      : undefined;
  const artifact = [...(live?.artifacts ?? [])]
    .reverse()
    .find((candidate) => artifactKind(candidate) === kind);
  return {
    kind: "live",
    key: tool.key,
    artifactKind: kind,
    language,
    title:
      artifact?.metadata?.title ??
      parsed?.title ??
      partialJsonStringField(tool.input, "title") ??
      `Writing ${artifactLabel({ kind })}`,
    filename:
      artifact?.metadata?.filename ??
      parsed?.filename ??
      partialJsonStringField(tool.input, "filename") ??
      `document${artifactExtension(kind, language)}`,
    content:
      parsed?.content ?? partialJsonStringField(tool.input, "content") ?? "",
    draft: parsed ?? {
      content: partialJsonStringField(tool.input, "content") ?? "",
    },
    status: tool.state,
  };
}

function parseJsonObject(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Reads a JSON string even while the model is still streaming its closing quote. */
function partialJsonStringField(value, field) {
  if (typeof value !== "string") return null;
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(value);
  if (!match) return null;
  let output = "";
  for (
    let index = match.index + match[0].length;
    index < value.length;
    index += 1
  ) {
    const character = value[index];
    if (character === '"') break;
    if (character !== "\\") {
      output += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) break;
    index += 1;
    const simple = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      '"': '"',
      "\\": "\\",
      "/": "/",
    }[escaped];
    if (simple !== undefined) {
      output += simple;
      continue;
    }
    if (escaped === "u") {
      const digits = value.slice(index + 1, index + 5);
      if (/^[0-9a-fA-F]{4}$/.test(digits)) {
        output += String.fromCharCode(Number.parseInt(digits, 16));
        index += 4;
      }
    }
  }
  return output;
}

function latestArtifact(chat) {
  const response = [...(chat?.messages ?? [])]
    .reverse()
    .find((message) => ["assistant", "error"].includes(message.role));
  return [...(response?.artifacts ?? [])].reverse()[0] ?? null;
}

function LiveMessage({ live, agentName }) {
  const busy = !live.text && live.artifacts.length === 0;
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

        {live.reasoning && <ThinkingBlock reasoning={live.reasoning} live />}

        {live.tools.length > 0 && <ToolHistory toolCalls={live.tools} live />}

        {live.artifacts.map((artifact) => (
          <LiveDocumentCard key={artifact.id} artifact={artifact} />
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
          <MarkdownDocument
            content={live.text}
            className="markdown-chat markdown-chat-live"
          />
        ) : busy ? (
          <p className="text-small text-default-500">
            {live.status}
            <TypingDots />
          </p>
        ) : null}
        {!busy && <span className="sr-only">{live.status}</span>}
      </div>
    </article>
  );
}

function DocumentCard({ artifact, onOpen }) {
  const label = artifactLabel(artifact);
  return (
    <div className="mt-3 flex max-w-[560px] items-center gap-3 rounded-large border border-divider bg-content1 p-3 shadow-[0_2px_10px_rgba(34,31,27,0.05)] transition-colors hover:border-[#c9b4a7] dark:hover:border-[#6f4c3e]">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onOpen}
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-medium border border-[#dfcbbf] bg-[#f3e6dc] text-[#925138] dark:border-[#634438] dark:bg-[#442f27] dark:text-[#e49a7d]">
          <Icon name={artifactIcon(artifact)} className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-small font-semibold">
            {artifact.title || artifact.filename}
          </strong>
          <span className="mt-0.5 block truncate text-tiny text-default-500">
            {label} · {formatBytes(artifact.size)} · Preview file
          </span>
        </span>
      </button>
      <Button
        as="a"
        href={artifact.downloadUrl}
        download={artifact.filename}
        isIconOnly
        size="sm"
        variant="light"
        aria-label={`Download ${artifact.filename}`}
      >
        <Icon name="download" className="h-4 w-4" />
      </Button>
    </div>
  );
}

function DocumentWorkspace({ document, onClose }) {
  const [mode, setMode] = useState("preview");
  const [bytes, setBytes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const artifact = document.kind === "saved" ? document.artifact : null;
  const url = artifact?.url;

  useEffect(() => {
    if (document.kind === "live") {
      setBytes(null);
      setLoading(false);
      setError(null);
      return;
    }
    if (!url) return;
    let cancelled = false;
    setBytes(null);
    setLoading(true);
    setError(null);
    void api
      .getArtifactBytes(url)
      .then((value) => {
        if (!cancelled) setBytes(value);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [document, url]);

  const kind =
    document.kind === "live" ? document.artifactKind : artifactKind(artifact);
  const modes = artifactModes(kind, document.kind === "live");

  useEffect(() => {
    setMode("preview");
  }, [document.key, artifact?.id, kind]);

  const title =
    document.kind === "live"
      ? document.title || document.filename
      : artifact?.title || artifact?.filename;
  const filename =
    document.kind === "live" ? document.filename : artifact?.filename;

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-divider bg-content1 shadow-[-16px_0_40px_rgba(28,25,22,0.12)] sm:w-[min(680px,82vw)] xl:static xl:z-auto xl:w-auto xl:shadow-none">
      <header className="flex min-h-[64px] items-center gap-3 border-b border-divider px-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-medium border border-[#dfcbbf] bg-[#f3e6dc] text-[#925138] dark:border-[#634438] dark:bg-[#442f27] dark:text-[#e49a7d]">
          <Icon name={artifactIcon({ kind })} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-small font-semibold">
            {title || artifactLabel({ kind })}
          </strong>
          <span className="block truncate text-[11px] text-default-500">
            {filename || "document"} {" / "}
            {document.kind === "live" ? "Writing live" : "Saved"}
          </span>
        </span>
        <div className="flex items-center rounded-medium border border-divider bg-content2 p-0.5">
          {modes.map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant="light"
              radius="sm"
              className={`h-7 min-w-0 px-2.5 text-[11px] ${
                mode === value ? "bg-content1 shadow-sm" : "text-default-500"
              }`}
              aria-pressed={mode === value}
              onPress={() => setMode(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        {artifact?.downloadUrl && (
          <Button
            as="a"
            href={artifact.downloadUrl}
            download={artifact.filename}
            isIconOnly
            size="sm"
            variant="light"
            aria-label={`Download ${artifact.filename}`}
          >
            <Icon name="download" className="h-4 w-4" />
          </Button>
        )}
        <Button
          isIconOnly
          size="sm"
          variant="light"
          aria-label="Close document workspace"
          onPress={onClose}
        >
          <Icon name="close" className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fbfaf7] p-5 dark:bg-[#1c1b19] sm:p-7">
        {loading ? (
          <DocumentWritingState label="Loading document" />
        ) : error ? (
          <ErrorNote error={error} />
        ) : (
          <ArtifactPreview
            kind={kind}
            mode={mode}
            bytes={bytes}
            draft={document.kind === "live" ? document.draft : null}
          />
        )}
      </div>
    </aside>
  );
}

function DocumentWritingState({ label }) {
  return (
    <div
      className="grid min-h-64 place-items-center text-center text-small text-default-500"
      role="status"
    >
      <span className="flex flex-col items-center gap-3">
        <ActivityIndicator />
        {label}...
      </span>
    </div>
  );
}

function LiveDocumentCard({ artifact }) {
  const filename = artifact?.metadata?.filename ?? "document";
  return (
    <div className="mb-2 flex max-w-[560px] items-center gap-3 rounded-large border border-[#dfcbbf] bg-[#fbf3ed] p-3 dark:border-[#634438] dark:bg-[#33251f]">
      <span className="grid h-10 w-10 place-items-center rounded-medium bg-[#f0ddd0] text-[#925138] dark:bg-[#4b3329] dark:text-[#e49a7d]">
        <Icon name={artifactIcon(artifact)} className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-small font-semibold">
          {artifact?.metadata?.title ?? filename}
        </strong>
        <span className="block truncate text-tiny text-default-500">
          {filename} · Saving to this chat
        </span>
      </span>
      <Icon name="check" className="h-4 w-4 text-success" />
    </div>
  );
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ThinkingBlock({ reasoning, live = false }) {
  return (
    <details
      className="group/thinking mb-3 overflow-hidden rounded-medium border border-divider bg-content2/55"
      defaultOpen={live}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-tiny [&::-webkit-details-marker]:hidden">
        <Icon name="spark" className="h-4 w-4 text-secondary" />
        <span className="font-semibold text-foreground">Thinking</span>
        <span className="text-default-400">
          {live ? "Working through the request" : "View reasoning"}
        </span>
        {live && <ActivityIndicator size="sm" className="ml-0.5" />}
        <Icon
          name="chevron"
          className="ml-auto h-3.5 w-3.5 text-default-400 transition-transform group-open/thinking:rotate-180"
        />
      </summary>
      <div className="border-t border-divider px-3 py-3">
        <p className="message-text max-h-[320px] whitespace-pre-wrap overflow-y-auto text-[12px] leading-5 text-default-500">
          {reasoning}
        </p>
      </div>
    </details>
  );
}

function ToolHistory({ toolCalls, live = false }) {
  const calls = (toolCalls ?? []).map((tool) => ({
    ...tool,
    key: tool.key ?? tool.id,
    state: tool.state ?? tool.status,
    output: Array.isArray(tool.output)
      ? tool.output
      : tool.output
        ? [tool.output]
        : [],
  }));
  const active = calls.some((tool) =>
    ["pending", "running"].includes(tool.state),
  );
  return (
    <details
      className="group/tools mb-3 overflow-hidden rounded-medium border border-divider bg-content2/55"
      defaultOpen={live}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-tiny [&::-webkit-details-marker]:hidden">
        <Icon name="tool" className="h-4 w-4 text-secondary" />
        <span className="font-semibold text-foreground">Tools</span>
        <span className="text-default-400">
          {calls.length} {calls.length === 1 ? "call" : "calls"}
        </span>
        {active && (
          <ActivityIndicator size="sm" className="ml-0.5 text-secondary" />
        )}
        <Icon
          name="chevron"
          className="ml-auto h-3.5 w-3.5 text-default-400 transition-transform group-open/tools:rotate-180"
        />
      </summary>
      <div className="divide-y divide-divider border-t border-divider">
        {calls.map((tool) => (
          <ToolCard key={tool.key} tool={tool} />
        ))}
      </div>
    </details>
  );
}

function ToolCard({ tool }) {
  const output = Array.isArray(tool.output)
    ? tool.output
    : tool.output
      ? [tool.output]
      : [];
  const tone = {
    pending: "text-default-400",
    running: "text-secondary",
    done: "text-success",
    error: "text-danger",
  }[tool.state];
  const stateLabel = {
    pending: "Pending",
    running: "Running",
    done: "Complete",
    error: "Failed",
  }[tool.state];

  return (
    <details className="group/tool bg-content1/35">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 text-tiny [&::-webkit-details-marker]:hidden">
        <span className={tone}>
          {tool.state === "running" ? (
            <ActivityIndicator size="sm" />
          ) : (
            <Icon
              name={tool.state === "done" ? "check" : "tool"}
              className="h-4 w-4"
            />
          )}
        </span>
        <code className="min-w-0 truncate font-semibold text-foreground">
          {tool.name || "tool"}
        </code>
        <span className={`ml-auto shrink-0 text-[11px] ${tone}`}>
          {stateLabel || "Complete"}
        </span>
        <Icon
          name="chevron"
          className="h-3.5 w-3.5 text-default-400 transition-transform group-open/tool:rotate-180"
        />
      </summary>
      <div className="space-y-3 border-t border-divider bg-content2/35 px-3 py-3">
        {tool.input && <ToolDetail label="Input" value={tool.input} />}
        {output.length > 0 && (
          <ToolDetail label="Output" value={output.join("\n")} />
        )}
        {!tool.input && output.length === 0 && (
          <p className="text-[11px] text-default-400">
            Waiting for tool details...
          </p>
        )}
      </div>
    </details>
  );
}

function ToolDetail({ label, value }) {
  return (
    <section>
      <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-default-400">
        {label}
      </h4>
      <pre className="message-text max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-medium border border-divider bg-content1 px-3 py-2 font-mono text-[11px] leading-5 text-default-600">
        {value}
      </pre>
    </section>
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
      className="inline-flex items-center gap-1.5 text-tiny normal-case tracking-normal text-default-500 transition-colors hover:text-secondary"
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

/**
 * Buckets chat summaries the way every mainstream chat sidebar does.
 *
 * Pinned chats leave the date buckets entirely and lead the list, because the
 * point of pinning one is that it stops drifting down as newer chats arrive.
 */
function groupChats(chats) {
  const pinned = chats.filter((item) => item.pinned);
  const buckets = new Map(GROUP_ORDER.map((label) => [label, []]));
  for (const item of chats) {
    if (item.pinned) continue;
    buckets.get(bucketOf(item.updatedAt ?? item.createdAt)).push(item);
  }
  return [
    ...(pinned.length ? [{ label: "Pinned", items: pinned, pinned: true }] : []),
    ...GROUP_ORDER.filter((label) => buckets.get(label).length > 0).map(
      (label) => ({ label, items: buckets.get(label) }),
    ),
  ];
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
