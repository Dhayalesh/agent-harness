# Browser-Use & SAP Desktop Agent — Build Plan

Status: draft, not started. Two tools for two different kinds of target, grown
out of the same conversation on `feat-comp-use`: a generic browser-automation
tool for anything reachable by URL, and a local companion agent for SAP's
native desktop GUI, which a browser can't reach at all.

## 1. The scenario(s) this serves

Two, related but distinct:

- **General**: an agent needs to operate a system that only exposes a normal
  human-facing web UI — no API, no MCP server built for it, and building one
  isn't worth it for a one-off. Every internal tool, vendor portal, or admin
  dashboard without an API is currently a dead end for any agent on this
  harness (see §2 for why `web_fetch`/`web_search` don't cover this).
- **Specific**: a person, inside the agent-console chat UI, asks something like

  > @logon find the latest sales order used or created

  or

  > @logon check the MARA table

  and the agent should drive **the person's own SAP session** to answer —
  entering a transaction code, reading a table or list screen — with a live
  view of what's happening visible in a side panel in the browser, so the
  person can watch and trust what the agent is doing rather than waiting blind.

## 2. Two targets, two tools — which one applies

| Target | Reachable how | Tool |
| --- | --- | --- |
| An ordinary website, or an internal tool with a web UI and no API | A URL, in any browser | **`browser_use`** (§3) |
| SAP GUI for HTML / Fiori Launchpad | A URL, in any browser | **`browser_use`** — SAP-over-the-web is just another browser target |
| Native SAP GUI ("SAP Logon Pad") | A standalone Windows application, not a web page | **SAP Desktop Agent** (§4) — a browser tool cannot see or touch it |

The dividing line is simply: is the target a web page at all? If yes,
`browser_use` covers it — including browser-based SAP, if a given customer's
landscape has that exposed. If it's the native desktop client, nothing
cloud-hosted can reach it, and that's what §4 exists for.

## 3. Tool A — `browser_use`, the generic fallback tool

### 3.1 The need

`web_fetch` does one stateless HTTP GET — no JavaScript execution, no
persisted session/cookies, no clicking, typing, or scrolling. `web_search`
tells you a page exists, not what's inside an interactive system. Neither can
log into anything, click through a multi-step flow, fill a form, or read
something that's only rendered client-side. Anything that requires *acting
inside* a system — and doesn't already have a purpose-built MCP integration
the way `sap-documentation-agent`'s `ADT-AP` server does for ABAP development —
is currently unreachable by any agent on this harness. `browser_use` is the
universal fallback: one tool that lets an agent operate any browser-reachable
system the way a person would, without a bespoke integration per system.

### 3.2 Build our own, not a vendor's computer-use model

OpenAI's `computer-use-preview` and Anthropic's native computer-use are each
tied to a specific vendor's specially-trained model on that vendor's own API
protocol. This harness talks to models through generic OpenRouter/OpenAI-
compatible function calling (`src/models/openrouter-provider.ts`,
`openai-compatible-provider.ts`) — not either vendor's native protocol — so
neither drops in directly. Building `browser_use` as an ordinary function-
calling tool (same shape as `bash`/`web_fetch` in `src/tools/`) means *any*
tool-capable model can use it regardless of provider; only the model's skill
at using it varies, not whether it's available at all.

One genuine advantage of building it ourselves: Playwright can act on the DOM
directly — by CSS selector or visible text — not only by screenshot pixel
coordinates the way OpenAI's and Anthropic's screenshot-driven loops do.
Selector-based actions are more robust (survive a layout shift that would
break a coordinate click) and worth using wherever the DOM is accessible,
falling back to coordinates only where it isn't (canvas content, some
JS-heavy widgets).

### 3.3 Architecture

- Lives in `agent-harness-clone/src/tools/`, alongside `bash`, `web_fetch`.
- Backed by a real Playwright browser instance, launched per-invocation inside
  the same sandboxed, ephemeral workspace model `runtime-host.ts` already gives
  `bash` — an isolated browser context, no shared cookies or state with
  anything else, torn down when the invocation ends.
- Action set: `navigate(url)`, `click(selector | x,y)`, `type(text)`,
  `press_key`, `scroll`, `screenshot`, `read_text` / `read_dom`, `wait_for`.
  Small and explicit, mirroring the vocabulary both OpenAI's and Anthropic's
  computer-use tools converged on, plus the selector-based actions from §3.2.
- Returns to the model the same way any tool result does — a screenshot and/or
  extracted text as the `tool.completed` result content.

### 3.4 Safety

- Goes through the same permission gate `bash` already does
  (`permissionMode`/`permissionRules`) — nothing about the permission system
  needs to change to support it.
- A configurable domain allowlist per agent, the same restriction `web_fetch`
  already applies (no non-public hosts, no embedded credentials in URLs).
- For a sensitive action (an unexpected domain, a login form, anything
  state-changing), raise the harness's existing `permission.requested` event
  rather than inventing a new gate — this is the same mechanism OpenAI's
  `pending_safety_checks` exists to provide, already present in this codebase.

### 3.5 Live view

Every action's resulting screenshot rides along as a `tool.progress` event —
already a real event type (`agent-harness-clone/src/core/events.ts`,
`{ type: 'tool.progress', toolCallId, message, data? }`) that already streams
to the browser over the existing SSE path. A side panel in `agent-console`
renders the latest frame as an `<img>` while the tool call is in flight. This
is the *same* panel and the *same* event shape §4's SAP Desktop Agent uses —
one live-view component serves both tools, not two separate builds (§5).

### 3.6 Phased build

**Phase 0** — a standalone Playwright script, no harness integration: navigate
to a real target, click/type/read something back, confirm the action loop and
selector strategy work before wiring anything up.

**Phase 1** — add `browser_use` as a real tool in `agent-harness-clone`, gated
by the permission system, proven against a real agent turn end to end.

**Phase 2** — the live-view side panel in `agent-console`, built once and
shared with §4.

## 4. Tool B — SAP Desktop Agent, for the native GUI case

### 4.1 Why the native GUI needs a different architecture

The native SAP GUI ("SAP Logon Pad") is a standalone Windows application —
no DOM, no URL, nothing `browser_use` can see. A cloud-hosted browser (or
cloud-hosted anything) cannot reach an application running on a customer's own
machine. Something has to run **on** that machine: a local companion agent,
not a cloud browser.

### 4.2 SAP GUI Scripting, not pixel automation

Two ways to drive a native Windows GUI program:

1. **Pixel/window automation** — screenshots and coordinate clicks, the same
   technique generic OS-level computer-use (and OpenAI's `environment:
   windows` mode) uses. Works on anything, but brittle: a resolution or theme
   change, or an unexpected dialog, breaks it.
2. **SAP GUI Scripting API** — a COM interface SAP ships with SAP GUI for
   Windows, addressing the actual object model directly:
   `session.findById("wnd[0]/tbar[0]/okcd").text = "SE16N"`, reading a grid's
   cells by row/column. This is what commercial SAP RPA packages (UiPath,
   Automation Anywhere) build on — far more reliable, and it's what "read the
   MARA table" or "list sales orders" actually needs: structured field/grid
   access, not a picture of a screen.

**Use SAP GUI Scripting.** Pixel automation is a fallback only for whatever
Scripting can't reach, if anything.

### 4.3 Credential/session model

- **(a) Attach to the person's own already-logged-in SAP GUI session.** The
  agent only acts while a real person is present and already authenticated
  however this landscape normally requires (password, SSO, MFA). No SAP
  credential is ever stored, transmitted, or touched by the cloud side.
  Matches §1's scenario exactly.
- **(b) The local agent logs in itself with a stored service account.**
  Needed only for unattended/background automation with nobody present —
  bigger credential-custody problem, bigger blast radius, not what §1 asks for.

**Recommendation: (a) for v1.**

### 4.4 Architecture — four components

```
Person (browser, agent-console)
        |
        v
 agent-console chat  --(prompt: "@logon check MARA")-->  agent-harness-clone
                                                                |
                                                     tool call: sap_gui_action
                                                                |
                                                                v
                                                     Cloud relay service (NEW)
                                                                |
                                                   outbound WebSocket, TLS
                                                                |
                                                                v
                                            Local companion agent (installed .exe)
                                                                |
                                                  SAP GUI Scripting API (COM)
                                                                |
                                                                v
                                              Person's own SAP GUI session
```

1. **Local companion agent** (the installed executable) — runs on a Windows
   machine with SAP GUI installed, on the customer's network. Attaches via the
   Scripting API, executes commanded actions (`enter_tcode`, `set_field`,
   `read_grid`, `execute`), and periodically captures a screenshot of the SAP
   GUI window for the live view. Opens an **outbound-only** WebSocket to the
   cloud relay — outbound so no customer firewall/NAT change is needed, the
   same pattern remote-support tools (TeamViewer, AnyDesk) and RPA
   orchestrators use. Authenticates with a per-installation device token
   issued at install time, not a shared secret baked into the binary.

2. **Cloud relay service** — genuinely new infrastructure; the first new
   backend component since this project started (everything else so far has
   been additive to `agent-console`/`agent-harness-clone`). Holds one
   persistent connection per installed local agent, routes a tool call's
   commands down to the right customer's agent, and routes results/screenshots
   back up.

3. **The tool itself**, `sap_gui_action` in `agent-harness-clone` — an
   ordinary tool from the model's point of view. What differs is only where
   it executes: instead of the local sandboxed workspace, its execution hops
   through the relay to the customer's local agent and waits for the result.
   The `tool.requested` → `tool.completed` event shape is unchanged, so
   nothing about the harness's event model, permission system, or the
   Observability tracing already built needs to change to support this.

4. **Live view panel** — the same panel and the same `tool.progress` reuse
   as §3.5, not a second build.

### 4.5 The "@logon" invocation

A natural fit for the **Skills** system that already exists in this project,
not a new invocation mechanism. A skill named `logon` carries the SAP-specific
knowledge — navigation patterns, common tcodes, how to interpret a grid
result — as its `SKILL.md`, using the generic `sap_gui_action` tool
underneath. The same pattern applies to `browser_use`: a skill can wrap it for
any other specific target (a vendor portal, an internal dashboard) the same
way, without either tool needing to know about that target itself.

### 4.6 The one non-engineering blocker

SAP GUI Scripting is **disabled by default** in most enterprise landscapes —
many Basis/security teams turn it off deliberately, because unattended
programmatic control of a live SAP session is exactly the capability class
their own security posture exists to prevent. Enabling it needs, on the
customer's side, a server-side profile parameter
(`sapgui/user_scripting = TRUE`) plus a client-side SAP GUI options change.

**Whether this feature works for a given customer is a conversation with
their SAP Basis/security team, not a guarantee that ships with the product.**
Flag this to whoever owns customer onboarding before treating it as universal.

### 4.7 Phased build

**Phase 0** — a local script (Python + `pywin32`, or PowerShell) on one dev
machine: attach to an already-open SAP GUI session, set the OK-code to
`SE16N`, type `MARA`, execute, dump the grid to the console. No relay, no
cloud, no installer — this answers the single riskiest question (does
Scripting give clean, reliable access to the target screens on this SAP
version) before anything else is built on top of an assumption.

**Phase 1** — turn the script into a small always-running local agent that
opens a WebSocket to a bare-bones relay; add `sap_gui_action` to
`agent-harness-clone`; prove one real agent turn end to end.

**Phase 2** — live view, sharing §3's panel.

**Phase 3** — real distribution: signed installer, per-customer device
provisioning and token issuance, an update mechanism, and security hardening —
server-side allowlisting of which `sap_gui_action` commands are permitted
(read-only tcodes only, to start — nothing that writes or changes data), and
least-privilege scoping of what the local agent process can do on the host
beyond driving SAP GUI Scripting.

## 5. What the two tools share

- **The live-view panel** (§3.5/§4.4-4) is one component in `agent-console`,
  built once. Both tools stream frames through the identical `tool.progress`
  event shape, so the panel doesn't know or care whether it's watching a cloud
  Playwright browser or a customer's native SAP session.
- **Skills** (§4.5) are the layer that turns either generic tool into a named,
  domain-specific shortcut like `@logon` — the tools themselves stay generic;
  the domain knowledge lives in the skill, not the tool.
- **Nothing about the event model, permission system, or Observability
  tracing needs to change for either** — both fit the existing
  `tool.requested`/`tool.completed`/`tool.progress` shape this harness already
  has, which is also exactly what makes both of them show up correctly in the
  trace waterfall/flow views already built.

## 6. Recommendation and sequencing

Build `browser_use` (§3) first. It's entirely cloud-side — no customer
install, no relay service, no device fleet — and it validates the whole
pattern (tool → permission gate → live-view panel → skill wrapper) cheaply
against real, low-stakes targets. Once that pattern is proven, the SAP Desktop
Agent (§4) is the same pattern applied to a harder transport (a local
installed agent instead of a cloud sandbox), not a design done from scratch.
Start §3's Phase 0 first; start §4's Phase 0 in parallel only once there's a
real SAP GUI Scripting-enabled environment to test against, since that
question is independent of everything else in this document.
