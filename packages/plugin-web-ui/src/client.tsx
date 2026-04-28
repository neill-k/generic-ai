import {
  BotIcon,
  FileJsonIcon,
  GitBranchIcon,
  LayoutTemplateIcon,
  RefreshCcwIcon,
  SendIcon,
  WorkflowIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./components/ai-elements/conversation.js";
import { Message, MessageContent, MessageResponse } from "./components/ai-elements/message.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { cn } from "./lib/utils.js";
import type {
  WebUiChatThread,
  WebUiChatThreadDetail,
  WebUiConfigSnapshot,
  WebUiHealth,
  WebUiTemplateDefinition,
  WebUiTemplateSummary,
} from "./types.js";

export interface GenericAIConsoleProps {
  readonly apiBase?: string;
  readonly sessionToken?: string;
  readonly activeTab?: ConsoleTab;
  readonly defaultTab?: ConsoleTab;
  readonly shell?: "full" | "embedded";
  readonly onTabChange?: (tab: ConsoleTab) => void;
}

export type ConsoleTab = "chat" | "config" | "templates";

interface TemplatesPayload {
  readonly templates: readonly WebUiTemplateSummary[];
}

interface ThreadsPayload {
  readonly threads: readonly WebUiChatThread[];
}

const tabs: readonly { id: ConsoleTab; label: string; icon: typeof BotIcon }[] = [
  { id: "chat", label: "Chat", icon: BotIcon },
  { id: "config", label: "Config", icon: FileJsonIcon },
  { id: "templates", label: "Templates", icon: LayoutTemplateIcon },
];

export function GenericAIConsole(props: GenericAIConsoleProps): ReactElement {
  const {
    activeTab,
    apiBase: apiBaseInput = "/console/api",
    defaultTab = "chat",
    onTabChange,
    sessionToken: sessionTokenInput,
    shell = "full",
  } = props;
  const apiBase = normalizeApiBase(apiBaseInput);
  const [uncontrolledTab, setUncontrolledTab] = useState<ConsoleTab>(defaultTab);
  const [health, setHealth] = useState<WebUiHealth | undefined>();
  const [config, setConfig] = useState<WebUiConfigSnapshot | undefined>();
  const [templates, setTemplates] = useState<readonly WebUiTemplateSummary[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<WebUiTemplateDefinition | undefined>();
  const [threads, setThreads] = useState<readonly WebUiChatThread[]>([]);
  const [thread, setThread] = useState<WebUiChatThreadDetail | undefined>();
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [sessionToken, setSessionToken] = useState<string | undefined>(sessionTokenInput);
  const [isSubmittingMessage, setIsSubmittingMessage] = useState(false);
  const openThreadId = thread?.thread.id;
  const tab = activeTab ?? uncontrolledTab;
  const setTab = useCallback(
    (nextTab: ConsoleTab) => {
      onTabChange?.(nextTab);
      if (activeTab === undefined) {
        setUncontrolledTab(nextTab);
      }
    },
    [activeTab, onTabChange],
  );

  const headers = useMemo(() => {
    const values: Record<string, string> = { "content-type": "application/json" };
    if (sessionToken !== undefined) {
      values["x-generic-ai-web-ui-token"] = sessionToken;
    }
    return values;
  }, [sessionToken]);

  const refresh = useCallback(async (): Promise<void> => {
    setError(undefined);
    try {
      const [nextHealth, nextConfig, nextTemplates, nextThreads] = await Promise.all([
        fetchJson<WebUiHealth>(`${apiBase}/health`),
        fetchJson<WebUiConfigSnapshot>(`${apiBase}/config`),
        fetchJson<TemplatesPayload>(`${apiBase}/templates`),
        fetchJson<ThreadsPayload>(`${apiBase}/chat/threads`),
      ]);
      setHealth(nextHealth);
      setConfig(nextConfig);
      setTemplates(nextTemplates.templates);
      setThreads(nextThreads.threads);
      if (openThreadId !== undefined) {
        setThread(
          await fetchJson<WebUiChatThreadDetail>(`${apiBase}/chat/threads/${openThreadId}`),
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [apiBase, openThreadId]);

  useEffect(() => {
    if (sessionTokenInput !== undefined) {
      setSessionToken(sessionTokenInput);
      return;
    }

    void fetchJson<{ readonly sessionToken: string }>(`${apiBase}/session`)
      .then((payload) => setSessionToken(payload.sessionToken))
      .catch(() => undefined);
  }, [apiBase, sessionTokenInput]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openTemplate(id: string): Promise<void> {
    setSelectedTemplate(await fetchJson<WebUiTemplateDefinition>(`${apiBase}/templates/${id}`));
  }

  async function applyTemplate(id: string, dryRun: boolean): Promise<void> {
    setError(undefined);
    const response = await fetchJson<unknown>(`${apiBase}/templates/${id}/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        dryRun,
        expectedRevision: config?.revision,
        idempotencyKey: `web-ui-${id}-${Date.now()}`,
      }),
    });
    await refresh();
    if (!isOkResult(response)) {
      setError(JSON.stringify(response, null, 2));
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    const content = prompt.trim();
    if (content.length === 0) {
      return;
    }
    if (sessionToken === undefined) {
      setError("Console session is still initializing. Try again in a moment.");
      return;
    }

    setPrompt("");
    setIsSubmittingMessage(true);
    try {
      const threadId = thread?.thread.id ?? `thread-${Date.now()}`;
      const detail = await fetchJson<WebUiChatThreadDetail>(
        `${apiBase}/chat/threads/${threadId}/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            content,
            selectedAgentId: config?.config?.framework.primaryAgent,
            selectedHarnessId: config?.config?.framework.primaryHarness,
          }),
        },
      );
      setThread(detail);
      await refresh();
    } catch (caught) {
      setPrompt(content);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsSubmittingMessage(false);
    }
  }

  return (
    <div
      className={cn(
        "gai-console bg-background text-foreground",
        shell === "full" ? "min-h-screen" : "min-h-full",
      )}
    >
      <div
        className={cn(
          shell === "full"
            ? "grid min-h-screen grid-cols-[240px_minmax(0,1fr)] max-lg:grid-cols-1"
            : "min-h-full",
        )}
      >
        {shell === "full" ? (
          <aside className="min-w-0 border-r bg-card/40 p-4 max-lg:border-b max-lg:border-r-0">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-secondary">
                <WorkflowIcon className="size-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold">Generic AI Console</h1>
                <p className="truncate text-xs text-muted-foreground">
                  {health?.config.primaryAgent ?? "Loading"}
                </p>
              </div>
            </div>
            <nav aria-label="Console sections" className="grid gap-2">
              {tabs.map((item) => {
                const Icon = item.icon;
                return (
                  <Button
                    aria-pressed={tab === item.id}
                    className="justify-start"
                    key={item.id}
                    onClick={() => setTab(item.id)}
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
        ) : null}

        <main className="grid min-w-0 content-start gap-5 p-5">
          {error === undefined ? null : (
            <Card className="border-destructive/40 bg-destructive/10">
              <CardContent className="text-sm text-destructive">{error}</CardContent>
            </Card>
          )}

          <section aria-label="Status" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Workspace" value={health?.workspaceRoot ?? "Loading"} />
            <Metric label="Primary Agent" value={health?.config.primaryAgent ?? "None"} />
            <Metric label="Primary Harness" value={health?.config.primaryHarness ?? "None"} />
            <Metric
              label="Config Revision"
              value={health?.config.revision?.slice(0, 12) ?? "Unknown"}
            />
          </section>

          {tab === "chat" ? (
            <ChatPanel
              threads={threads}
              thread={thread}
              prompt={prompt}
              submitting={isSubmittingMessage}
              onPromptChange={setPrompt}
              onSubmit={submitMessage}
              onOpenThread={async (threadId) => {
                setThread(
                  await fetchJson<WebUiChatThreadDetail>(`${apiBase}/chat/threads/${threadId}`),
                );
              }}
            />
          ) : null}
          {tab === "config" ? <ConfigPanel config={config} /> : null}
          {tab === "templates" ? (
            <TemplatesPanel
              templates={templates}
              selectedTemplate={selectedTemplate}
              onOpenTemplate={(id) => void openTemplate(id)}
              onApplyTemplate={(id, dryRun) => void applyTemplate(id, dryRun)}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}

function Metric(props: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="text-xs font-semibold uppercase tracking-normal">
          {props.label}
        </CardDescription>
        <CardTitle className="break-words font-mono text-sm font-medium leading-5">
          {props.value}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

function ChatPanel(props: {
  readonly threads: readonly WebUiChatThread[];
  readonly thread: WebUiChatThreadDetail | undefined;
  readonly prompt: string;
  readonly submitting: boolean;
  readonly onPromptChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onOpenThread: (threadId: string) => void;
}): ReactElement {
  return (
    <section className="grid gap-3">
      <div className="flex items-center gap-2">
        <BotIcon className="size-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Chat</h2>
        {props.thread === undefined ? null : (
          <Badge variant={props.thread.thread.status === "failed" ? "warning" : "secondary"}>
            {props.thread.thread.status}
          </Badge>
        )}
      </div>
      <div className="grid gap-3 xl:grid-cols-[320px_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardDescription className="text-xs font-semibold uppercase tracking-normal">
              Threads
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 pt-0">
            {props.threads.length === 0 ? (
              <p className="text-sm text-muted-foreground">No threads yet.</p>
            ) : (
              props.threads.map((thread) => (
                <Button
                  className="justify-start overflow-hidden"
                  key={thread.id}
                  type="button"
                  variant={props.thread?.thread.id === thread.id ? "secondary" : "ghost"}
                  onClick={() => props.onOpenThread(thread.id)}
                >
                  <span className="truncate">{thread.title}</span>
                </Button>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="min-h-[28rem]">
          <CardContent className="flex h-full min-h-[28rem] flex-col gap-3">
            <Conversation className="min-h-0">
              <ConversationContent className="min-h-[18rem] px-0">
                {(props.thread?.messages ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">Ask the selected agent.</p>
                ) : (
                  props.thread?.messages.map((message) => (
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
            <form className="flex gap-2 max-sm:flex-col" onSubmit={props.onSubmit}>
              <input
                aria-label="Ask the selected agent"
                className="min-h-9 min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={props.prompt}
                onChange={(event) => props.onPromptChange(event.currentTarget.value)}
                placeholder="Ask the selected agent"
              />
              <Button disabled={props.submitting || props.prompt.trim().length === 0} type="submit">
                <SendIcon className="size-4" />
                {props.submitting ? "Sending" : "Send"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function ConfigPanel(props: { readonly config: WebUiConfigSnapshot | undefined }): ReactElement {
  return (
    <section className="grid gap-3">
      <div className="flex items-center gap-2">
        <FileJsonIcon className="size-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Config</h2>
      </div>
      <Card>
        <CardContent>
          <pre className="max-h-[40rem] overflow-auto rounded-md border bg-secondary/40 p-4 font-mono text-xs leading-5">
            {JSON.stringify(props.config ?? {}, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </section>
  );
}

function TemplatesPanel(props: {
  readonly templates: readonly WebUiTemplateSummary[];
  readonly selectedTemplate: WebUiTemplateDefinition | undefined;
  readonly onOpenTemplate: (id: string) => void;
  readonly onApplyTemplate: (id: string, dryRun: boolean) => void;
}): ReactElement {
  return (
    <section className="grid gap-3">
      <div className="flex items-center gap-2">
        <LayoutTemplateIcon className="size-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Templates</h2>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {props.templates.map((template) => (
          <Card key={template.id}>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <Badge variant={template.status === "runnable" ? "success" : "warning"}>
                  {template.status}
                </Badge>
                <GitBranchIcon className="size-4 text-muted-foreground" />
              </div>
              <CardTitle>{template.label}</CardTitle>
              <CardDescription>{template.summary}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => props.onOpenTemplate(template.id)}
              >
                Open
              </Button>
              {template.status === "runnable" ? (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => props.onApplyTemplate(template.id, true)}
                  >
                    <RefreshCcwIcon className="size-4" />
                    Dry Run
                  </Button>
                  <Button type="button" onClick={() => props.onApplyTemplate(template.id, false)}>
                    Apply
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
      {props.selectedTemplate === undefined ? null : (
        <Card>
          <CardContent>
            <pre
              className={cn(
                "max-h-[32rem] overflow-auto rounded-md border bg-secondary/40 p-4",
                "font-mono text-xs leading-5",
              )}
            >
              {JSON.stringify(props.selectedTemplate, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

async function fetchJson<TValue>(url: string, init?: RequestInit): Promise<TValue> {
  const response = await fetch(url, init);
  const text = await response.text();
  const value = text.trim().length === 0 ? undefined : JSON.parse(text);
  if (!response.ok) {
    throw new Error(JSON.stringify(value ?? { status: response.status }, null, 2));
  }
  return value as TValue;
}

function normalizeApiBase(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isOkResult(value: unknown): boolean {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}
