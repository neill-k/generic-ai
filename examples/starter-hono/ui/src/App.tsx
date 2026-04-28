import {
  ActivityIcon,
  BotIcon,
  CheckIcon,
  ClipboardIcon,
  Code2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  FileTextIcon,
  LayoutTemplateIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldIcon,
  SquareIcon,
  WandSparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { GenericAIConsole, type ConsoleTab } from "@generic-ai/plugin-web-ui/client";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  WebPreview,
  WebPreviewBody,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from "@/components/ai-elements/web-preview";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type RunMode = "sync" | "stream";
type RunStatus = "ready" | "submitted" | "streaming" | "error";
type OutputView = "preview" | "code" | "events";
type ChatRole = "user" | "assistant";
type StudioTab = "playground" | ConsoleTab;

interface HealthPayload {
  adapter?: string;
  model?: string;
  exposure?: string;
  streaming?: boolean;
  transport?: string;
}

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}

interface RunEvent {
  id: string;
  level: "log" | "warn" | "error";
  message: string;
  timestamp: Date;
}

interface ParsedSseMessage {
  event: string;
  data: string;
}

interface OutputTextCarrier {
  outputText?: unknown;
}

interface ErrorMessageCarrier {
  message?: unknown;
}

const AUTH_STORAGE_KEY = "generic-ai.playground.auth-token";
const PROMPT_STORAGE_KEY = "generic-ai.playground.prompt";

const spaceshipPrompt = `Create a polished, retro-futuristic 3D spaceship web game contained entirely within a single HTML file using Three.js. The game should feature a "Synthwave/Retrowave" aesthetic with the following specifications:

1. Visual Style & Atmosphere
*Aesthetic:* Dark, immersive 3D environment with a glowing, volumetric neon look. Use a color palette of deep purples, hot pinks, and electric cyans.
*Post-Processing:* You must implement Three.js \`EffectComposer\` with \`UnrealBloomPass\` to make the neon elements glow intensely.
*Environment:*
A dense, moving starfield background with rich features. Go beyond simple plane shapes here and apply shaders to make the game visually appealing. For example, simulating retro astra, stars, and planets in the background.
Distance fog to fade distant objects smoothly into the darkness.
*Assets:* Use complex geometric primitives constructed programmatically (no external model imports).

2. Gameplay Mechanics
*Perspective:* Third-person view from behind the spaceship.
*Core Loop:* The player pilots the ship on the X and Y axis (2D plane) while enemies (neon blocks) spawn in the distance and fly toward the camera along the Z-axis.
*Combat:*
The player shoots laser bolts (glowing lines) to destroy enemies.
*Collision:* When a laser hits a block, the block should shatter into a very complex particle explosion effect.
*Game Over:* If a block hits the ship, the game ends.
*UI:* A minimal HUD displaying the current Score. A "Game Over" overlay with a "Restart" button.

3. Controls (Cross-Platform)
The game must detect the device type or input method:
*Desktop/Web:*
Use *Arrow Keys* or *WASD* for smooth movement (apply \`lerp\` or friction for a floaty, drift-like spaceship feel).
Use *Spacebar* to fire.
*Mobile/Touch:*
Render a semi-transparent *Virtual Joystick* on the bottom-left of the screen (using HTML/CSS or Canvas API) to map touch movement to ship coordinates.
Detect a *Tap* anywhere on the right side of the screen to fire lasers.

4. Technical Constraints
*Single File:* All HTML, CSS, and JavaScript (including the Three.js library and post-processing shaders imported via CDN) must be in one \`index.html\` file. Do not output any other text other than the html response.
*Performance:* Use object pooling for lasers and particles to ensure 60FPS performance.
*Responsiveness:* The canvas must resize dynamically to fit any screen size without stretching the aspect ratio.`;

const emptyPreview = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        align-items: center;
        background: #111;
        color: #d4d4d4;
        display: flex;
        font-family: system-ui, sans-serif;
        height: 100vh;
        justify-content: center;
        margin: 0;
      }
    </style>
  </head>
  <body>Preview will render here.</body>
</html>`;

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findOutputText(value: unknown, seen = new Set<unknown>()): string | undefined {
  if (typeof value === "string") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOutputText(item, seen);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  if (!isRecord(value) || seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  const { outputText } = value as OutputTextCarrier;
  if (typeof outputText === "string") {
    return outputText;
  }

  for (const nested of Object.values(value)) {
    const found = findOutputText(nested, seen);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function readErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const { message } = value as ErrorMessageCarrier;
  return typeof message === "string" ? message : undefined;
}

function findRunFailure(value: unknown, seen = new Set<unknown>()): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRunFailure(item, seen);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  if (!isRecord(value) || seen.has(value)) {
    return undefined;
  }

  seen.add(value);

  if (value["status"] === "failed" || value["status"] === "error") {
    const output = value["output"];
    if (isRecord(output)) {
      const payload = output["payload"];
      if (isRecord(payload)) {
        const payloadError = readErrorMessage(payload["error"]);
        if (payloadError !== undefined) {
          return payloadError;
        }
      }

      if (typeof output["summary"] === "string") {
        return output["summary"];
      }
    }

    return "Run failed.";
  }

  for (const nested of Object.values(value)) {
    const found = findRunFailure(nested, seen);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function stripMarkdownFence(output: string) {
  const trimmed = output.trim();
  const fenced = /^```(?:html)?\s*([\s\S]*?)```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parseSseMessage(block: string): ParsedSseMessage | undefined {
  let event = "message";
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  return { data: data.join("\n"), event };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function summarizePrompt(prompt: string) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 420 ? `${compact.slice(0, 420)}...` : compact;
}

const studioTabs: readonly {
  id: StudioTab;
  label: string;
  icon: typeof WorkflowIcon;
}[] = [
  { id: "playground", label: "Generate", icon: WandSparklesIcon },
  { id: "chat", label: "Chat", icon: BotIcon },
  { id: "config", label: "Config", icon: FileTextIcon },
  { id: "templates", label: "Templates", icon: LayoutTemplateIcon },
];

function initialStudioTab(): StudioTab {
  return window.location.pathname.startsWith("/console") ? "chat" : "playground";
}

function updateStudioPath(tab: StudioTab): void {
  const nextPath = tab === "playground" ? "/" : "/console";
  if (window.location.pathname === nextPath) {
    return;
  }

  window.history.replaceState(null, "", `${nextPath}${window.location.search}`);
}

export function App(): ReactElement {
  const [tab, setTab] = useState<StudioTab>(initialStudioTab);
  const consoleTab = tab === "playground" ? "chat" : tab;

  const selectTab = useCallback((nextTab: StudioTab) => {
    setTab(nextTab);
    updateStudioPath(nextTab);
  }, []);

  return (
    <TooltipProvider>
      <div className="grid min-h-screen grid-cols-[240px_minmax(0,1fr)] bg-background text-foreground max-lg:grid-cols-1">
        <aside className="min-w-0 border-r bg-card/40 p-4 max-lg:border-b max-lg:border-r-0">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-secondary">
              <WorkflowIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">Generic AI Studio</h1>
              <p className="truncate text-xs text-muted-foreground">
                {tab === "playground" ? "generate" : consoleTab}
              </p>
            </div>
          </div>
          <nav aria-label="Studio sections" className="grid gap-2">
            {studioTabs.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  aria-pressed={tab === item.id}
                  className="justify-start"
                  key={item.id}
                  onClick={() => selectTab(item.id)}
                  type="button"
                  variant={tab === item.id ? "default" : "ghost"}
                >
                  <Icon className="size-4" />
                  {item.label}
                </Button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0">
          {tab === "playground" ? (
            <StarterPlayground />
          ) : (
            <GenericAIConsole
              activeTab={consoleTab}
              apiBase="/console/api"
              shell="embedded"
              onTabChange={selectTab}
            />
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}

function StarterPlayground() {
  const [prompt, setPrompt] = useState(() => localStorage.getItem(PROMPT_STORAGE_KEY) ?? spaceshipPrompt);
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(AUTH_STORAGE_KEY) ?? "");
  const [mode, setMode] = useState<RunMode>("stream");
  const [status, setStatus] = useState<RunStatus>("ready");
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [outputHtml, setOutputHtml] = useState("");
  const [outputView, setOutputView] = useState<OutputView>("preview");
  const abortRef = useRef<AbortController | null>(null);

  const normalizedOutput = useMemo(() => stripMarkdownFence(outputHtml), [outputHtml]);
  const canRun = prompt.trim().length > 0 && status !== "submitted" && status !== "streaming";

  const addEvent = useCallback((level: RunEvent["level"], message: string) => {
    setEvents((current) => [
      ...current.slice(-79),
      {
        id: createId("event"),
        level,
        message,
        timestamp: new Date(),
      },
    ]);
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const response = await fetch("/starter/health", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Health check failed with HTTP ${response.status}.`);
      }
      setHealth((await response.json()) as HealthPayload);
      setHealthError(null);
    } catch (error) {
      setHealth(null);
      setHealthError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    localStorage.setItem(PROMPT_STORAGE_KEY, prompt);
  }, [prompt]);

  useEffect(() => {
    if (authToken.trim().length === 0) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      return;
    }

    localStorage.setItem(AUTH_STORAGE_KEY, authToken);
  }, [authToken]);

  const requestHeaders = useCallback((): HeadersInit => {
    const headers: { "content-type": string; authorization?: string } = {
      "content-type": "application/json",
    };
    const token = authToken.trim();
    if (token.length > 0) {
      headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }, [authToken]);

  const recordOutput = useCallback((payload: unknown, fallbackText: string) => {
    const output = findOutputText(payload) ?? fallbackText;
    const html = stripMarkdownFence(output);
    setOutputHtml(html);
    setOutputView("preview");
    setMessages((current) => [
      ...current,
      {
        content: `Generated \`${html.length.toLocaleString()}\` characters of HTML.`,
        id: createId("assistant"),
        role: "assistant",
      },
    ]);
  }, []);

  const runSync = useCallback(
    async (input: string, signal: AbortSignal) => {
      const response = await fetch("/starter/run", {
        body: JSON.stringify({ input }),
        headers: requestHeaders(),
        method: "POST",
        signal,
      });
      const responseText = await response.text();
      let payload: unknown = responseText;

      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = responseText;
      }

      if (!response.ok) {
        throw new Error(`Run failed with HTTP ${response.status}: ${responseText}`);
      }

      const failure = findRunFailure(payload);
      if (failure !== undefined) {
        throw new Error(failure);
      }

      recordOutput(payload, responseText);
    },
    [recordOutput, requestHeaders],
  );

  const runStream = useCallback(
    async (input: string, signal: AbortSignal) => {
      const response = await fetch("/starter/run/stream", {
        body: JSON.stringify({ input }),
        headers: requestHeaders(),
        method: "POST",
        signal,
      });

      if (!response.ok || response.body === null) {
        const responseText = await response.text();
        throw new Error(`Stream failed with HTTP ${response.status}: ${responseText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fallbackText = "";
      let finalPayload: unknown;
      let latestOutput: string | undefined;

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseMessage(block);

          if (parsed !== undefined) {
            fallbackText = parsed.data;
            addEvent("log", parsed.event);
            try {
              finalPayload = JSON.parse(parsed.data);
              const partial = findOutputText(finalPayload);
              if (partial !== undefined) {
                latestOutput = partial;
                setOutputHtml(stripMarkdownFence(partial));
              }
            } catch {
              finalPayload = parsed.data;
            }
          }

          boundary = buffer.indexOf("\n\n");
        }

        if (done) {
          break;
        }
      }

      const failure = findRunFailure(finalPayload);
      if (failure !== undefined) {
        throw new Error(failure);
      }

      recordOutput(latestOutput ?? finalPayload, latestOutput ?? fallbackText);
    },
    [addEvent, recordOutput, requestHeaders],
  );

  const runPrompt = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (trimmed.length === 0 || !canRun) {
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus(mode === "stream" ? "streaming" : "submitted");
      setEvents([]);
      setOutputHtml("");
      setMessages([
        {
          content: summarizePrompt(trimmed),
          id: createId("user"),
          role: "user",
        },
      ]);
      addEvent("log", `${mode === "stream" ? "Streaming" : "Sync"} run started`);

      try {
        if (mode === "stream") {
          await runStream(trimmed, controller.signal);
        } else {
          await runSync(trimmed, controller.signal);
        }
        setStatus("ready");
        addEvent("log", "Run completed");
      } catch (error) {
        if (controller.signal.aborted) {
          setStatus("ready");
          addEvent("warn", "Run stopped");
          return;
        }

        setStatus("error");
        addEvent("error", errorMessage(error));
        setMessages((current) => [
          ...current,
          {
            content: `Run failed: ${errorMessage(error)}`,
            id: createId("assistant-error"),
            role: "assistant",
          },
        ]);
      } finally {
        abortRef.current = null;
      }
    },
    [addEvent, canRun, mode, runStream, runSync],
  );

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      void runPrompt(message.text);
    },
    [runPrompt],
  );

  const stopRun = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const copyOutput = useCallback(async () => {
    if (normalizedOutput.length === 0) {
      return;
    }
    await navigator.clipboard.writeText(normalizedOutput);
    addEvent("log", "HTML copied");
  }, [addEvent, normalizedOutput]);

  const downloadOutput = useCallback(() => {
    if (normalizedOutput.length === 0) {
      return;
    }
    const url = URL.createObjectURL(new Blob([normalizedOutput], { type: "text/html" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "generic-ai-output.html";
    anchor.click();
    URL.revokeObjectURL(url);
    addEvent("log", "HTML downloaded");
  }, [addEvent, normalizedOutput]);

  const openOutput = useCallback(() => {
    if (normalizedOutput.length === 0) {
      return;
    }
    const url = URL.createObjectURL(new Blob([normalizedOutput], { type: "text/html" }));
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, [normalizedOutput]);

  const healthReady = health !== null && healthError === null;

  return (
      <section className="min-h-screen bg-background text-foreground">
        <header className="flex min-h-16 items-center justify-between border-b px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-secondary">
              <WandSparklesIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">Generic AI Playground</h1>
              <p className="truncate text-xs text-muted-foreground">
                {health?.model ?? "Model pending"} - {health?.adapter ?? "adapter pending"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "hidden items-center gap-2 rounded-md border px-2.5 py-1 text-xs sm:flex",
                healthReady ? "border-emerald-500/30 text-emerald-300" : "border-destructive/30 text-destructive",
              )}
            >
              {healthReady ? "Ready" : "Offline"}
            </span>
            <Button onClick={() => void refreshHealth()} size="icon" title="Refresh health" variant="ghost">
              <RefreshCwIcon className="size-4" />
            </Button>
          </div>
        </header>

        <div className="grid min-h-[calc(100vh-4rem)] grid-cols-[minmax(360px,0.92fr)_minmax(0,1.38fr)] max-lg:grid-cols-1">
          <aside className="flex min-h-0 flex-col border-r max-lg:border-b max-lg:border-r-0">
            <div className="grid gap-3 border-b p-4 sm:p-5">
              <div className="grid grid-cols-3 gap-2">
                <Button
                  className={cn(mode === "stream" && "bg-primary text-primary-foreground")}
                  onClick={() => setMode("stream")}
                  type="button"
                  variant={mode === "stream" ? "default" : "secondary"}
                >
                  <ActivityIcon className="size-4" />
                  Stream
                </Button>
                <Button
                  className={cn(mode === "sync" && "bg-primary text-primary-foreground")}
                  onClick={() => setMode("sync")}
                  type="button"
                  variant={mode === "sync" ? "default" : "secondary"}
                >
                  <CheckIcon className="size-4" />
                  Sync
                </Button>
                <Button
                  disabled={status !== "submitted" && status !== "streaming"}
                  onClick={stopRun}
                  type="button"
                  variant="secondary"
                >
                  <SquareIcon className="size-4" />
                  Stop
                </Button>
              </div>

              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                Auth token
                <input
                  className="h-10 rounded-md border bg-background px-3 text-sm text-foreground outline-none transition focus:border-ring"
                  onChange={(event) => setAuthToken(event.currentTarget.value)}
                  placeholder="Optional bearer token"
                  type="password"
                  value={authToken}
                />
              </label>

              <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <div className="rounded-md border p-2">
                  <div className="mb-1 flex items-center gap-1 text-foreground">
                    <ShieldIcon className="size-3.5" />
                    Exposure
                  </div>
                  <div className="truncate">{health?.exposure ?? "unknown"}</div>
                </div>
                <div className="rounded-md border p-2">
                  <div className="mb-1 flex items-center gap-1 text-foreground">
                    <ActivityIcon className="size-3.5" />
                    Stream
                  </div>
                  <div>{health?.streaming ? "enabled" : "unknown"}</div>
                </div>
                <div className="rounded-md border p-2">
                  <div className="mb-1 flex items-center gap-1 text-foreground">
                    <FileTextIcon className="size-3.5" />
                    Output
                  </div>
                  <div>{normalizedOutput.length.toLocaleString()}</div>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 p-4 sm:p-5">
              <PromptInput className="flex h-full flex-col" onSubmit={handleSubmit}>
                <PromptInputBody>
                  <PromptInputTextarea
                    className="min-h-[34rem] flex-1 resize-none text-sm leading-6 max-lg:min-h-[24rem]"
                    onChange={(event) => setPrompt(event.currentTarget.value)}
                    placeholder="Paste a workflow prompt..."
                    value={prompt}
                  />
                </PromptInputBody>
                <PromptInputFooter>
                  <PromptInputTools>
                    <PromptInputButton onClick={() => setPrompt(spaceshipPrompt)} tooltip="Load spaceship prompt">
                      <RefreshCwIcon className="size-4" />
                    </PromptInputButton>
                    <PromptInputButton
                      onClick={() => {
                        setPrompt("");
                        setOutputHtml("");
                        setMessages([]);
                        setEvents([]);
                      }}
                      tooltip="Clear"
                    >
                      <FileTextIcon className="size-4" />
                    </PromptInputButton>
                  </PromptInputTools>
                  <PromptInputSubmit
                    disabled={!canRun}
                    onStop={stopRun}
                    status={status}
                  >
                    {status === "submitted" || status === "streaming" ? (
                      <SquareIcon className="size-4" />
                    ) : (
                      <PlayIcon className="size-4" />
                    )}
                  </PromptInputSubmit>
                </PromptInputFooter>
              </PromptInput>
            </div>
          </aside>

          <section className="grid min-h-0 grid-rows-[minmax(14rem,0.45fr)_minmax(22rem,1fr)]">
            <div className="min-h-0 border-b">
              <Conversation className="h-full">
                <ConversationContent className="p-4 sm:p-5">
                  {messages.length === 0 ? (
                    <div className="max-w-[95%] text-sm text-muted-foreground">
                      {healthError ?? "Run a prompt to see the request and response trail."}
                    </div>
                  ) : (
                    messages.map((message) => (
                      <Message from={message.role} key={message.id}>
                        <MessageContent>
                          <MessageResponse>{message.content}</MessageResponse>
                        </MessageContent>
                      </Message>
                    ))
                  )}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            </div>

            <div className="flex min-h-0 flex-col">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3 sm:px-5">
                <div className="flex items-center gap-1">
                  <Button
                    onClick={() => setOutputView("preview")}
                    size="sm"
                    variant={outputView === "preview" ? "default" : "ghost"}
                  >
                    <EyeIcon className="size-4" />
                    Preview
                  </Button>
                  <Button
                    onClick={() => setOutputView("code")}
                    size="sm"
                    variant={outputView === "code" ? "default" : "ghost"}
                  >
                    <Code2Icon className="size-4" />
                    HTML
                  </Button>
                  <Button
                    onClick={() => setOutputView("events")}
                    size="sm"
                    variant={outputView === "events" ? "default" : "ghost"}
                  >
                    <ActivityIcon className="size-4" />
                    Events
                  </Button>
                </div>
                <div className="flex items-center gap-1">
                  <Button disabled={normalizedOutput.length === 0} onClick={() => void copyOutput()} size="icon" title="Copy HTML" variant="ghost">
                    <ClipboardIcon className="size-4" />
                  </Button>
                  <Button disabled={normalizedOutput.length === 0} onClick={downloadOutput} size="icon" title="Download HTML" variant="ghost">
                    <DownloadIcon className="size-4" />
                  </Button>
                  <Button disabled={normalizedOutput.length === 0} onClick={openOutput} size="icon" title="Open output" variant="ghost">
                    <ExternalLinkIcon className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-hidden">
                {outputView === "preview" ? (
                  <WebPreview className="rounded-none border-0" defaultUrl="generated-output">
                    <WebPreviewNavigation>
                      <WebPreviewNavigationButton disabled tooltip="Back">
                        <span className="size-2 rounded-full bg-red-400" />
                      </WebPreviewNavigationButton>
                      <WebPreviewNavigationButton disabled tooltip="Forward">
                        <span className="size-2 rounded-full bg-yellow-400" />
                      </WebPreviewNavigationButton>
                      <WebPreviewNavigationButton disabled tooltip="Reload">
                        <span className="size-2 rounded-full bg-emerald-400" />
                      </WebPreviewNavigationButton>
                      <WebPreviewUrl readOnly value="generated-output" />
                    </WebPreviewNavigation>
                    <WebPreviewBody
                      sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups allow-modals"
                      srcDoc={normalizedOutput || emptyPreview}
                    />
                  </WebPreview>
                ) : null}

                {outputView === "code" ? (
                  <div className="h-full overflow-auto p-4">
                    <pre className="min-h-full overflow-auto rounded-md border bg-secondary/40 p-4 font-mono text-xs leading-5 text-foreground">
                      <code>{normalizedOutput || "<!-- No output yet. -->"}</code>
                    </pre>
                  </div>
                ) : null}

                {outputView === "events" ? (
                  <div className="h-full overflow-auto p-4 font-mono text-xs">
                    {events.length === 0 ? (
                      <div className="text-muted-foreground">No events yet.</div>
                    ) : (
                      events.map((event, index) => (
                        <div className="grid grid-cols-[6rem_4rem_minmax(0,1fr)] gap-3 py-1" key={event.id}>
                          <span className="text-muted-foreground">
                            {event.timestamp.toLocaleTimeString()}
                          </span>
                          <span
                            className={cn(
                              event.level === "error" && "text-destructive",
                              event.level === "warn" && "text-yellow-300",
                              event.level === "log" && "text-emerald-300",
                            )}
                          >
                            {event.level}
                          </span>
                          <span className="truncate">{event.message}</span>
                          {index < events.length - 1 ? <Separator className="col-span-3" /> : null}
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </section>
  );
}
