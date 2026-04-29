import {
  ActivityIcon,
  AlertCircleIcon,
  ArrowRightIcon,
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
  RocketIcon,
  RefreshCwIcon,
  ShieldIcon,
  SquareIcon,
  SparklesIcon,
  WandSparklesIcon,
  WrenchIcon,
  WorkflowIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { GenericAIConsole, type ConsoleTab } from "@generic-ai/plugin-web-ui/client";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
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
type ChatState = "error";
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
  state?: ChatState;
}

interface RunEvent {
  id: string;
  kind: "message" | "output" | "run" | "system" | "tool";
  level: "log" | "warn" | "error";
  title: string;
  detail?: string;
  source?: string;
  timestamp: Date;
}

type RunEventInput = Omit<RunEvent, "id" | "timestamp">;

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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function createPreviewPlaceholder(title: string, detail: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      :root {
        color-scheme: dark;
      }

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

      main {
        max-width: 32rem;
        padding: 2rem;
        text-align: center;
      }

      h1 {
        color: white;
        font-size: 1rem;
        font-weight: 650;
        margin: 0 0 0.5rem;
      }

      p {
        color: #a3a3a3;
        font-size: 0.875rem;
        line-height: 1.5;
        margin: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(detail)}</p>
    </main>
  </body>
</html>`;
}

const emptyPreview = createPreviewPlaceholder(
  "Preview will render here.",
  "Run a prompt and the page will appear here.",
);

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

function parseSseData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function eventPayloadData(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  const data = payload["data"];
  return isRecord(data) ? data : payload;
}

function eventSourceName(eventName: string, payload: unknown): string {
  return readStringField(payload, "name") ?? eventName;
}

function eventPayloadType(eventName: string, payload: unknown): string {
  const data = eventPayloadData(payload);
  return readStringField(data, "type") ?? eventName;
}

function eventDetail(payload: unknown, ...keys: readonly string[]): string | undefined {
  const data = eventPayloadData(payload);
  for (const key of keys) {
    const value = readStringField(data, key);
    if (value !== undefined && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function createRunEventInput(
  input: Omit<RunEventInput, "detail">,
  detail?: string,
): RunEventInput {
  return detail === undefined ? input : { ...input, detail };
}

function describeStreamEvent(eventName: string, payload: unknown): RunEventInput | undefined {
  const source = eventSourceName(eventName, payload);
  const type = eventPayloadType(eventName, payload);

  switch (eventName) {
    case "run.created":
      return createRunEventInput(
        {
          kind: "run",
          level: "log",
          source,
          title: "Run created",
        },
        eventDetail(payload, "presetId"),
      );

    case "run.started":
      return { kind: "run", level: "log", source, title: "Run started" };

    case "run.completed":
      return { kind: "run", level: "log", source, title: "Run completed" };

    case "run.failed":
      return createRunEventInput(
        {
          kind: "run",
          level: "error",
          source,
          title: "Run failed",
        },
        eventDetail(payload, "error", "message"),
      );

    case "run.envelope":
      return { kind: "output", level: "log", source, title: "Preview ready" };

    case "runtime.text.delta":
      return undefined;
  }

  if (eventName === "tool") {
    return createRunEventInput(
      {
        kind: "tool",
        level: "log",
        source,
        title: "Tool call",
      },
      eventDetail(payload, "toolName", "name"),
    );
  }

  if (type === "message_update") {
    return undefined;
  }

  if (type === "tool_execution_start" || eventName === "tool.call.started") {
    return createRunEventInput(
      {
        kind: "tool",
        level: "log",
        source,
        title: "Tool started",
      },
      eventDetail(payload, "toolName", "name"),
    );
  }

  if (type === "tool_execution_update") {
    return createRunEventInput(
      {
        kind: "tool",
        level: "log",
        source,
        title: "Tool updated",
      },
      eventDetail(payload, "toolName", "name"),
    );
  }

  if (type === "tool_execution_end" || eventName === "tool.call.completed") {
    const failed = readBooleanField(eventPayloadData(payload), "isError");
    return createRunEventInput(
      {
        kind: "tool",
        level: failed ? "error" : "log",
        source,
        title: failed ? "Tool failed" : "Tool completed",
      },
      eventDetail(payload, "toolName", "name"),
    );
  }

  if (eventName === "tool.call.failed") {
    return createRunEventInput(
      {
        kind: "tool",
        level: "error",
        source,
        title: "Tool failed",
      },
      eventDetail(payload, "toolName", "name", "error"),
    );
  }

  if (type === "message_start") {
    const role = eventDetail(payload, "role");
    return createRunEventInput(
      {
        kind: "message",
        level: "log",
        source,
        title: role === "user" ? "User message sent" : "Assistant started",
      },
      role === "assistant" ? role : undefined,
    );
  }

  if (type === "message_end") {
    const role = eventDetail(payload, "role");
    return createRunEventInput(
      {
        kind: "message",
        level: "log",
        source,
        title: role === "user" ? "User message sent" : "Assistant finished",
      },
      role === "assistant" ? role : undefined,
    );
  }

  if (type === "agent_start") {
    return { kind: "run", level: "log", source, title: "Agent started" };
  }

  if (type === "turn_start") {
    return { kind: "run", level: "log", source, title: "Turn started" };
  }

  if (type === "turn_end") {
    return { kind: "run", level: "log", source, title: "Turn finished" };
  }

  if (type === "agent_end") {
    return { kind: "run", level: "log", source, title: "Agent finished" };
  }

  if (type === "auto_retry_start") {
    return createRunEventInput(
      {
        kind: "system",
        level: "warn",
        source,
        title: "Retry started",
      },
      eventDetail(payload, "errorMessage"),
    );
  }

  if (type === "auto_retry_end") {
    return { kind: "system", level: "log", source, title: "Retry finished" };
  }

  if (type === "compaction_start") {
    return createRunEventInput(
      {
        kind: "system",
        level: "log",
        source,
        title: "Context compacting",
      },
      eventDetail(payload, "reason"),
    );
  }

  if (type === "compaction_end") {
    return createRunEventInput(
      {
        kind: "system",
        level: "log",
        source,
        title: "Context ready",
      },
      eventDetail(payload, "reason"),
    );
  }

  if (type === "queue_update") {
    return { kind: "system", level: "log", source, title: "Queue updated" };
  }

  return {
    kind: "system",
    level: "log",
    source,
    title: source,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function summarizePrompt(prompt: string) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 280 ? `${compact.slice(0, 280)}...` : compact;
}

function isActiveStatus(status: RunStatus) {
  return status === "submitted" || status === "streaming";
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function ProcessingIndicator({
  mode,
  startedAt,
}: {
  mode: RunMode;
  startedAt: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) {
      return undefined;
    }

    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  const elapsed = startedAt === null ? "0s" : formatElapsed(now - startedAt);

  return (
    <div
      aria-live="polite"
      className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground"
      role="status"
    >
      <ActivityIcon aria-hidden="true" className="size-3.5 animate-pulse" />
      <span>{mode === "stream" ? "Streaming" : "Working"}</span>
      {elapsed !== "0s" ? (
        <span className="tabular-nums text-muted-foreground/70">{elapsed}</span>
      ) : null}
    </div>
  );
}

function activityIconFor(event: RunEvent) {
  if (event.level === "error") {
    return AlertCircleIcon;
  }

  switch (event.kind) {
    case "message":
      return BotIcon;
    case "output":
      return EyeIcon;
    case "tool":
      return WrenchIcon;
    case "run":
      return ActivityIcon;
    case "system":
      return WorkflowIcon;
  }
}

function ActivityRail({
  events,
  running,
}: {
  events: readonly RunEvent[];
  running: boolean;
}) {
  const visibleEvents = events.slice(-10);

  return (
    <aside className="flex min-h-0 flex-col bg-card/20" aria-label="Run activity">
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <ActivityIcon
            aria-hidden="true"
            className={cn("size-4", running && "animate-pulse text-sky-300")}
          />
          <span>Activity</span>
        </div>
        {running ? (
          <span className="rounded-md border border-sky-400/30 px-2 py-0.5 text-xs text-sky-200">
            Live
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {visibleEvents.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">Idle</div>
        ) : (
          <ol className="grid gap-2">
            {visibleEvents.map((event) => {
              const Icon = activityIconFor(event);
              return (
                <li
                  className={cn(
                    "grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2 rounded-md border bg-background/60 p-2.5",
                    event.level === "error" && "border-destructive/30 bg-destructive/10",
                    event.level === "warn" && "border-yellow-500/30 bg-yellow-500/10",
                  )}
                  key={event.id}
                >
                  <div
                    className={cn(
                      "mt-0.5 flex size-6 items-center justify-center rounded-md border bg-secondary text-muted-foreground",
                      event.kind === "tool" && "text-sky-300",
                      event.kind === "output" && "text-emerald-300",
                      event.level === "error" && "text-destructive",
                      event.level === "warn" && "text-yellow-300",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">{event.title}</span>
                      <span className="shrink-0 text-[0.68rem] tabular-nums text-muted-foreground">
                        {event.timestamp.toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </div>
                    {event.detail !== undefined ? (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {event.detail}
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
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

function resolveTab(pathname: string): StudioTab {
  return pathname.startsWith("/console") ? "chat" : "playground";
}

function updateStudioPath(tab: StudioTab): string {
  const nextPath = tab === "playground" ? "/studio" : "/console";
  if (window.location.pathname !== nextPath) {
    window.history.replaceState(null, "", `${nextPath}${window.location.search}`);
  }

  return nextPath;
}

function navigate(pathname: string): void {
  if (window.location.pathname === pathname) {
    return;
  }

  window.history.pushState(null, "", pathname);
}

export function App(): ReactElement {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [tab, setTab] = useState<StudioTab>(() => resolveTab(window.location.pathname));
  const consoleTab = tab === "playground" ? "chat" : tab;
  const showLanding = pathname === "/";

  useEffect(() => {
    const onPopState = () => {
      setPathname(window.location.pathname);
      setTab(resolveTab(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectTab = useCallback((nextTab: StudioTab) => {
    setTab(nextTab);
    setPathname(updateStudioPath(nextTab));
  }, []);

  const openStudio = useCallback(() => {
    navigate("/studio");
    setPathname("/studio");
    setTab("playground");
  }, []);

  const openConsole = useCallback(() => {
    navigate("/console");
    setPathname("/console");
    setTab("chat");
  }, []);

  if (showLanding) {
    return <LandingPage onOpenConsole={openConsole} onOpenStudio={openStudio} />;
  }

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

function LandingPage({
  onOpenConsole,
  onOpenStudio,
}: {
  onOpenConsole: () => void;
  onOpenStudio: () => void;
}): ReactElement {
  const pillars = [
    {
      description:
        "Harness DSL compiles into Generic Agent IR, giving a typed contract between design-time and runtime execution.",
      icon: WandSparklesIcon,
      title: "Agents as code",
    },
    {
      description:
        "Orchestration stays in the kernel while business capabilities are delivered through replaceable plugins.",
      icon: WorkflowIcon,
      title: "Minimal kernel",
    },
    {
      description:
        "Start from preset-starter-hono and get local-first config, tools, MCP wiring, memory, and transport in one stack.",
      icon: RocketIcon,
      title: "Starter preset",
    },
    {
      description:
        "Run sync and async missions with the same session model, including child-agent delegation and durable messaging.",
      icon: BotIcon,
      title: "Composable runtime",
    },
    {
      description:
        "MissionSpec and BenchmarkSpec produce trace-backed evidence so teams can compare architectures with confidence.",
      icon: ActivityIcon,
      title: "Evidence harness",
    },
    {
      description:
        "Develop with unrestricted local tools, then move to Docker sandbox policies for tighter operational controls.",
      icon: ShieldIcon,
      title: "Safety progression",
    },
  ] as const;

  const packages = [
    "@generic-ai/core",
    "@generic-ai/sdk",
    "@generic-ai/preset-starter-hono",
    "@generic-ai/plugin-mcp",
    "@generic-ai/plugin-tools-terminal-sandbox",
    "@generic-ai/plugin-web-ui",
  ] as const;

  const personas = [
    "Platform engineers embedding multi-agent systems in production apps.",
    "AI infra teams that need swappable capabilities without kernel rewrites.",
    "Applied AI teams running reproducible benchmark experiments.",
  ] as const;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 py-14 sm:px-8 lg:py-20">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 rounded-md border bg-card/60 px-3 py-2 text-sm">
            <WorkflowIcon className="size-4 text-primary" />
            <span className="font-medium">gencorp.dev</span>
          </div>
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <CheckIcon className="size-3.5 text-emerald-400" />
            Node 24 + npm 11 + typed contracts
          </div>
        </header>

        <div className="grid gap-8 lg:grid-cols-[1.08fr_0.92fr]">
          <div className="space-y-5">
            <p className="inline-flex items-center gap-2 rounded-full border bg-card/40 px-3 py-1 text-xs text-muted-foreground">
              <SparklesIcon className="size-3.5" />
              Plugin-first agents-as-code framework
            </p>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              Build multi-agent systems with a stable contract, not glue code.
            </h1>
            <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
              Generic AI compiles Harness DSL to Generic Agent IR, runs sync and async missions, and
              ships trace-backed evidence through a modular runtime built on <code>pi</code>.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={onOpenStudio} size="lg" type="button">
                Start in Studio
                <ArrowRightIcon className="size-4" />
              </Button>
              <Button onClick={onOpenConsole} size="lg" type="button" variant="outline">
                Open Console
              </Button>
              <Button
                asChild
                size="lg"
                type="button"
                variant="ghost"
              >
                <a href="https://gencorp.dev" rel="noreferrer" target="_blank">
                  Visit gencorp.dev
                  <ExternalLinkIcon className="size-4" />
                </a>
              </Button>
            </div>
          </div>

          <div className="rounded-xl border bg-card/40 p-5">
            <p className="mb-4 text-xs uppercase tracking-wide text-muted-foreground">
              Framework spine
            </p>
            <div className="space-y-3 text-sm">
              <div className="rounded-md border bg-background/70 p-3">
                Harness DSL
                <ArrowRightIcon className="mx-2 inline size-3.5 text-muted-foreground" />
                Generic Agent IR
              </div>
              <div className="rounded-md border bg-background/70 p-3">
                Core runtime
                <ArrowRightIcon className="mx-2 inline size-3.5 text-muted-foreground" />
                Plugin stack
              </div>
              <div className="rounded-md border bg-background/70 p-3">
                Sessions + traces
                <ArrowRightIcon className="mx-2 inline size-3.5 text-muted-foreground" />
                Benchmark reports
              </div>
            </div>
          </div>
        </div>

        <section className="space-y-5">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Why teams choose Generic AI</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {pillars.map((pillar) => (
              <article className="rounded-lg border bg-card/40 p-4" key={pillar.title}>
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <pillar.icon className="size-4 text-primary" />
                  {pillar.title}
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{pillar.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="rounded-xl border bg-card/40 p-5">
            <h3 className="mb-3 text-lg font-semibold">Package ecosystem</h3>
            <div className="grid gap-2 text-sm">
              {packages.map((name) => (
                <div className="rounded-md border bg-background/70 px-3 py-2" key={name}>
                  <code>{name}</code>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-xl border bg-card/40 p-5">
            <h3 className="mb-3 text-lg font-semibold">Built for</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              {personas.map((persona) => (
                <li className="flex items-start gap-2" key={persona}>
                  <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                  <span>{persona}</span>
                </li>
              ))}
            </ul>
          </article>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
          <article className="rounded-xl border bg-card/40 p-5">
            <h3 className="mb-3 text-lg font-semibold">Production trust signals</h3>
            <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
              <div className="rounded-md border bg-background/70 p-3">
                Typecheck, lint, test, and build required in baseline CI.
              </div>
              <div className="rounded-md border bg-background/70 p-3">
                Contracts, planning pack, and package boundaries are documented.
              </div>
              <div className="rounded-md border bg-background/70 p-3">
                Changesets + npm provenance support predictable releases.
              </div>
              <div className="rounded-md border bg-background/70 p-3">
                Sandbox terminal plugin provides a safer execution path.
              </div>
            </div>
          </article>

          <article className="rounded-xl border bg-card/40 p-5">
            <h3 className="mb-2 text-lg font-semibold">Get started</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              Run the starter stack, then extend through plugins and presets.
            </p>
            <Button className="w-full" onClick={onOpenStudio} type="button">
              Launch Starter Studio
            </Button>
            <Button className="mt-2 w-full" onClick={onOpenConsole} type="button" variant="outline">
              Inspect Console APIs
            </Button>
          </article>
        </section>
      </section>
    </main>
  );
}

function StarterPlayground() {
  const [prompt, setPrompt] = useState(
    () => localStorage.getItem(PROMPT_STORAGE_KEY) ?? spaceshipPrompt,
  );
  const [authToken, setAuthToken] = useState(() => sessionStorage.getItem(AUTH_STORAGE_KEY) ?? "");
  const [mode, setMode] = useState<RunMode>("stream");
  const [status, setStatus] = useState<RunStatus>("ready");
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [outputHtml, setOutputHtml] = useState("");
  const [outputView, setOutputView] = useState<OutputView>("preview");
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const normalizedOutput = useMemo(() => stripMarkdownFence(outputHtml), [outputHtml]);
  const canRun = prompt.trim().length > 0 && status !== "submitted" && status !== "streaming";

  const addEvent = useCallback((event: RunEventInput) => {
    setEvents((current) => [
      ...current.slice(-79),
      {
        ...event,
        id: createId("event"),
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
      sessionStorage.removeItem(AUTH_STORAGE_KEY);
      return;
    }

    sessionStorage.setItem(AUTH_STORAGE_KEY, authToken);
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

    if (html.length === 0) {
      setMessages((current) => [
        ...current,
        {
          content: "No preview returned.",
          id: createId("assistant-empty"),
          role: "assistant",
          state: "error",
        },
      ]);
    }
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
            const payload = parseSseData(parsed.data);
            const activity = describeStreamEvent(parsed.event, payload);
            if (activity !== undefined) {
              addEvent(activity);
            }

            if (typeof payload === "string") {
              finalPayload = payload;
            } else {
              finalPayload = payload;
              const partial = findOutputText(finalPayload);
              if (partial !== undefined) {
                latestOutput = partial;
                const html = stripMarkdownFence(partial);
                setOutputHtml(html);
                setOutputView("preview");
              }
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
      const userMessageId = createId("user");

      setStatus(mode === "stream" ? "streaming" : "submitted");
      setRunStartedAt(Date.now());
      setEvents([]);
      setOutputHtml("");
      setOutputView("preview");
      setMessages((current) => [
        ...current,
        {
          content: summarizePrompt(trimmed),
          id: userMessageId,
          role: "user",
        },
      ]);
      addEvent({
        kind: "run",
        level: "log",
        title: `${mode === "stream" ? "Streaming" : "Sync"} request sent`,
      });

      try {
        if (mode === "stream") {
          await runStream(trimmed, controller.signal);
        } else {
          await runSync(trimmed, controller.signal);
        }
        setStatus("ready");
        if (mode === "sync") {
          addEvent({ kind: "run", level: "log", title: "Run completed" });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          setStatus("ready");
          addEvent({ kind: "run", level: "warn", title: "Run stopped" });
          return;
        }

        setStatus("error");
        addEvent({
          detail: errorMessage(error),
          kind: "run",
          level: "error",
          title: "Run failed",
        });
        setMessages((current) => [
          ...current,
          {
            content: `Run failed: ${errorMessage(error)}`,
            id: createId("assistant-error"),
            role: "assistant",
            state: "error",
          },
        ]);
      } finally {
        setRunStartedAt(null);
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
    addEvent({ kind: "output", level: "log", title: "HTML copied" });
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
    addEvent({ kind: "output", level: "log", title: "HTML downloaded" });
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
  const running = isActiveStatus(status);
  const appStatusText =
    status === "error"
      ? "Needs attention"
      : status === "streaming"
        ? "Streaming"
        : status === "submitted"
          ? "Working"
          : healthReady
            ? "Ready"
            : "Offline";
  const appStatusClass =
    status === "error"
      ? "border-destructive/30 text-destructive"
      : running
        ? "border-sky-400/30 text-sky-200"
        : healthReady
          ? "border-emerald-500/30 text-emerald-300"
          : "border-destructive/30 text-destructive";
  const previewState = normalizedOutput.length > 0 ? "ready" : running ? "working" : "empty";
  const previewDocument =
    normalizedOutput ||
    (running
      ? createPreviewPlaceholder(
          "Working...",
          "Preview appears here.",
        )
      : emptyPreview);

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
              appStatusClass,
            )}
          >
            {running ? <ActivityIcon aria-hidden="true" className="size-3.5 animate-pulse" /> : null}
            {appStatusText}
          </span>
          <Button
            onClick={() => void refreshHealth()}
            size="icon"
            title="Refresh health"
            variant="ghost"
          >
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
                  Preview
                </div>
                <div>{previewState}</div>
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
                  <PromptInputButton
                    onClick={() => setPrompt(spaceshipPrompt)}
                    tooltip="Load spaceship prompt"
                  >
                    <RefreshCwIcon className="size-4" />
                  </PromptInputButton>
                  <PromptInputButton
                    onClick={() => {
                      setPrompt("");
                      setOutputHtml("");
                      setRunStartedAt(null);
                      setMessages([]);
                      setEvents([]);
                    }}
                    tooltip="Clear"
                  >
                    <FileTextIcon className="size-4" />
                  </PromptInputButton>
                </PromptInputTools>
                <PromptInputSubmit
                  disabled={!running && prompt.trim().length === 0}
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
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(16rem,0.58fr)] border-b max-xl:grid-cols-1">
            <div className="min-h-0 border-r max-xl:border-b max-xl:border-r-0">
              <Conversation aria-label="Run message history" aria-live="polite" className="h-full">
                <ConversationContent className="p-4 sm:p-5">
                  {messages.length === 0 ? (
                    <div className="max-w-[95%] text-sm text-muted-foreground">
                      {healthError ?? "Run a prompt to start."}
                    </div>
                  ) : (
                    messages.map((message) => (
                      <Message from={message.role} key={message.id}>
                        <MessageContent
                          className={cn(
                            message.state === "error" &&
                              "group-[.is-assistant]:rounded-lg group-[.is-assistant]:border group-[.is-assistant]:border-destructive/30 group-[.is-assistant]:bg-destructive/10 group-[.is-assistant]:p-3",
                          )}
                        >
                          {message.role === "assistant" ? (
                            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                              <AlertCircleIcon aria-hidden="true" className="size-3.5" />
                              <span>Generic AI</span>
                            </div>
                          ) : null}
                          <MessageResponse>{message.content}</MessageResponse>
                        </MessageContent>
                      </Message>
                    ))
                  )}
                  {running ? <ProcessingIndicator mode={mode} startedAt={runStartedAt} /> : null}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            </div>
            <ActivityRail events={events} running={running} />
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
                <Button
                  disabled={normalizedOutput.length === 0}
                  onClick={() => void copyOutput()}
                  size="icon"
                  title="Copy HTML"
                  variant="ghost"
                >
                  <ClipboardIcon className="size-4" />
                </Button>
                <Button
                  disabled={normalizedOutput.length === 0}
                  onClick={downloadOutput}
                  size="icon"
                  title="Download HTML"
                  variant="ghost"
                >
                  <DownloadIcon className="size-4" />
                </Button>
                <Button
                  disabled={normalizedOutput.length === 0}
                  onClick={openOutput}
                  size="icon"
                  title="Open preview"
                  variant="ghost"
                >
                  <ExternalLinkIcon className="size-4" />
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {outputView === "preview" ? (
                <WebPreview className="rounded-none border-0" defaultUrl="generated-preview">
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
                    <WebPreviewUrl readOnly value="generated-preview" />
                  </WebPreviewNavigation>
                  <WebPreviewBody
                    sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups allow-modals"
                    srcDoc={previewDocument}
                  />
                </WebPreview>
              ) : null}

              {outputView === "code" ? (
                <div className="h-full overflow-auto p-4">
                  <pre className="min-h-full overflow-auto rounded-md border bg-secondary/40 p-4 font-mono text-xs leading-5 text-foreground">
                    <code>{normalizedOutput || "<!-- No preview HTML yet. -->"}</code>
                  </pre>
                </div>
              ) : null}

              {outputView === "events" ? (
                <div className="h-full overflow-auto p-4 font-mono text-xs">
                  {events.length === 0 ? (
                    <div className="text-muted-foreground">No events yet.</div>
                  ) : (
                    events.map((event, index) => (
                      <div
                        className="grid grid-cols-[6rem_4rem_5rem_minmax(0,1fr)] gap-3 py-1"
                        key={event.id}
                      >
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
                        <span className="truncate text-muted-foreground">{event.kind}</span>
                        <span className="truncate">
                          {event.detail === undefined
                            ? event.title
                            : `${event.title}: ${event.detail}`}
                        </span>
                        {index < events.length - 1 ? <Separator className="col-span-4" /> : null}
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
