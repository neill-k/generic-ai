import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionContext,
  type ToolDefinition,
} from "@generic-ai/sdk";

export const name = "@generic-ai/plugin-interaction" as const;
export const kind = "interaction" as const;

export const interactionQuestionKinds = ["text", "single_choice", "multi_choice"] as const;
export type InteractionQuestionKind = (typeof interactionQuestionKinds)[number];

export const interactionTaskStatuses = ["pending", "in_progress", "completed"] as const;
export type InteractionTaskStatus = (typeof interactionTaskStatuses)[number];

export type InteractionCancellationCode = "cancelled" | "timeout" | "aborted";

export interface InteractionChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface InteractionQuestionInput {
  readonly id?: string;
  readonly title?: string;
  readonly question: string;
  readonly kind: InteractionQuestionKind;
  readonly choices?: readonly InteractionChoice[];
  readonly placeholder?: string;
  readonly timeoutMs?: number;
}

export interface InteractionQuestion {
  readonly id: string;
  readonly title?: string;
  readonly question: string;
  readonly kind: InteractionQuestionKind;
  readonly choices: readonly InteractionChoice[];
  readonly placeholder?: string;
  readonly timeoutMs?: number;
  readonly createdAt: string;
  readonly timeoutAt?: string;
}

export interface InteractionResponseInput {
  readonly text?: string;
  readonly choiceId?: string;
  readonly choiceIds?: readonly string[];
}

export interface InteractionResponse {
  readonly questionId: string;
  readonly kind: InteractionQuestionKind;
  readonly text?: string;
  readonly choiceIds?: readonly string[];
  readonly choiceLabels?: readonly string[];
  readonly submittedAt: string;
}

export interface InteractionTask {
  readonly id: string;
  readonly description: string;
  readonly status: InteractionTaskStatus;
}

export interface InteractionTaskListInput {
  readonly listId?: string;
  readonly title?: string;
  readonly tasks: readonly InteractionTask[];
}

export interface InteractionTaskList {
  readonly listId: string;
  readonly title?: string;
  readonly tasks: readonly InteractionTask[];
  readonly updatedAt: string;
}

export interface InteractionQuestionRequestedEvent {
  readonly type: "question.requested";
  readonly occurredAt: string;
  readonly question: InteractionQuestion;
}

export interface InteractionQuestionAnsweredEvent {
  readonly type: "question.answered";
  readonly occurredAt: string;
  readonly question: InteractionQuestion;
  readonly response: InteractionResponse;
}

export interface InteractionQuestionCancelledEvent {
  readonly type: "question.cancelled";
  readonly occurredAt: string;
  readonly question: InteractionQuestion;
  readonly code: InteractionCancellationCode;
  readonly reason: string;
}

export interface InteractionTaskListUpdatedEvent {
  readonly type: "task_list.updated";
  readonly occurredAt: string;
  readonly taskList: InteractionTaskList;
}

export type InteractionEvent =
  | InteractionQuestionRequestedEvent
  | InteractionQuestionAnsweredEvent
  | InteractionQuestionCancelledEvent
  | InteractionTaskListUpdatedEvent;

export type InteractionTransportEvent = InteractionEvent & {
  readonly eventId: string;
  readonly sequence: number;
};

export interface InteractionTransport {
  publish(event: InteractionEvent): void;
}

export interface InteractionPluginOptions {
  readonly idFactory?: () => string;
  readonly now?: () => string | number | Date;
  readonly transports?: readonly InteractionTransport[];
  readonly onTransportError?: (error: unknown, event: InteractionEvent) => void;
}

export interface InteractionRequestOptions {
  readonly signal?: AbortSignal;
}

export interface InteractionPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly piTools: readonly [
    ToolDefinition<typeof askUserSchema, InteractionResponse>,
    ToolDefinition<typeof taskWriteSchema, InteractionTaskList>,
  ];
  attachTransport(transport: InteractionTransport): () => void;
  askUser(
    input: InteractionQuestionInput,
    options?: InteractionRequestOptions,
  ): Promise<InteractionResponse>;
  answerQuestion(questionId: string, response: InteractionResponseInput): InteractionResponse;
  cancelQuestion(questionId: string, reason?: string): boolean;
  getPendingQuestion(questionId: string): InteractionQuestion | undefined;
  listPendingQuestions(): readonly InteractionQuestion[];
  taskWrite(input: InteractionTaskListInput): InteractionTaskList;
  getTaskList(listId?: string): InteractionTaskList | undefined;
  listTaskLists(): readonly InteractionTaskList[];
}

export interface HonoInteractionTransportOptions {
  readonly interaction: Pick<
    InteractionPlugin,
    "answerQuestion" | "cancelQuestion" | "listPendingQuestions" | "listTaskLists"
  >;
  readonly routePrefix?: string;
  readonly historyLimit?: number;
  readonly createEventId?: () => string;
  readonly now?: () => string | number | Date;
}

export interface HonoInteractionTransport extends InteractionTransport {
  readonly routePrefix: string;
  readonly app: Hono;
  readonly fetch: Hono["fetch"];
  snapshot(fromSequence?: number): readonly InteractionTransportEvent[];
  close(): void;
}

export class InteractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InteractionError";
  }
}

export class InteractionValidationError extends InteractionError {
  constructor(message: string) {
    super(message);
    this.name = "InteractionValidationError";
  }
}

export class InteractionQuestionNotFoundError extends InteractionError {
  constructor(questionId: string) {
    super(`Question "${questionId}" is not pending.`);
    this.name = "InteractionQuestionNotFoundError";
  }
}

export class InteractionQuestionCancelledError extends InteractionError {
  constructor(
    public readonly questionId: string,
    public readonly code: InteractionCancellationCode,
    message: string,
  ) {
    super(message);
    this.name = "InteractionQuestionCancelledError";
  }
}

export class InteractionQuestionTimeoutError extends InteractionQuestionCancelledError {
  constructor(questionId: string, message = "Question timed out while waiting for a user response.") {
    super(questionId, "timeout", message);
    this.name = "InteractionQuestionTimeoutError";
  }
}

type PendingQuestionRecord = {
  readonly question: InteractionQuestion;
  readonly resolve: (response: InteractionResponse) => void;
  readonly reject: (error: unknown) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  abortSignal: AbortSignal | undefined;
  abortHandler: (() => void) | undefined;
};

const interactionChoiceSchema = Type.Object({
  id: Type.String({ description: "Stable choice identifier returned back to the agent." }),
  label: Type.String({ description: "User-facing label for the choice." }),
  description: Type.Optional(Type.String({ description: "Optional supporting detail for the choice." })),
});

const askUserSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "Optional short heading shown above the question." })),
  question: Type.String({ description: "The exact question to ask the user." }),
  kind: Type.Union(
    interactionQuestionKinds.map((value) => Type.Literal(value)) as unknown as [
      TSchema,
      TSchema,
      ...TSchema[],
    ],
    {
      description: 'Response mode. Use "text", "single_choice", or "multi_choice".',
    },
  ),
  choices: Type.Optional(
    Type.Array(interactionChoiceSchema, {
      description: "Choices shown to the user for choice-based questions.",
      minItems: 1,
    }),
  ),
  placeholder: Type.Optional(
    Type.String({ description: "Optional placeholder for free-text questions." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Optional timeout in milliseconds.", minimum: 1 }),
  ),
});

const interactionTaskSchema = Type.Object({
  id: Type.String({ description: "Stable task identifier." }),
  description: Type.String({ description: "Short task description visible to the user." }),
  status: Type.Union(
    interactionTaskStatuses.map((value) => Type.Literal(value)) as unknown as [TSchema, TSchema, ...TSchema[]],
    {
      description: 'Task status. Use "pending", "in_progress", or "completed".',
    },
  ),
});

const taskWriteSchema = Type.Object({
  listId: Type.Optional(
    Type.String({ description: 'Optional task-list identifier. Defaults to "default".' }),
  ),
  title: Type.Optional(Type.String({ description: "Optional heading for the visible task list." })),
  tasks: Type.Array(interactionTaskSchema, {
    description: "Complete visible task-list snapshot to publish.",
  }),
});

type AskUserInput = Static<typeof askUserSchema>;
type TaskWriteInput = Static<typeof taskWriteSchema>;

function normalizeTimestamp(value: InteractionPluginOptions["now"]): string {
  const current = value?.() ?? Date.now();
  const date = current instanceof Date ? current : new Date(current);

  if (Number.isNaN(date.getTime())) {
    throw new TypeError("InteractionPluginOptions.now() must return a valid date-like value.");
  }

  return date.toISOString();
}

function isInteractionQuestionKind(value: string): value is InteractionQuestionKind {
  return interactionQuestionKinds.includes(value as InteractionQuestionKind);
}

function isInteractionTaskStatus(value: string): value is InteractionTaskStatus {
  return interactionTaskStatuses.includes(value as InteractionTaskStatus);
}

function parseReplaySequence(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function assertUnreachable(value: never, label: string): never {
  throw new InteractionValidationError(`${label} "${String(value)}" is not supported.`);
}

function assertNonEmpty(value: string | undefined, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new InteractionValidationError(`${label} must be a non-empty string.`);
}

function freezeChoices(
  input: readonly InteractionChoice[] | undefined,
  questionKind: InteractionQuestionKind,
): readonly InteractionChoice[] {
  if (questionKind === "text") {
    if (input && input.length > 0) {
      throw new InteractionValidationError(
        'Text questions must not define "choices"; use "single_choice" or "multi_choice".',
      );
    }

    return Object.freeze([] as InteractionChoice[]);
  }

  if (input === undefined || input.length === 0) {
    throw new InteractionValidationError(
      `${questionKind} questions require at least one choice.`,
    );
  }

  const seen = new Set<string>();
  const normalized: InteractionChoice[] = [];

  for (const [index, choice] of input.entries()) {
    const id = assertNonEmpty(choice.id, `choices[${index}].id`);
    if (seen.has(id)) {
      throw new InteractionValidationError(`Duplicate choice id "${id}" is not allowed.`);
    }

    seen.add(id);
    normalized.push(
      Object.freeze({
        id,
        label: assertNonEmpty(choice.label, `choices[${index}].label`),
        ...(choice.description?.trim()
          ? { description: choice.description.trim() }
          : {}),
      }),
    );
  }

  return Object.freeze(normalized);
}

function normalizeQuestion(
  input: InteractionQuestionInput,
  now: InteractionPluginOptions["now"],
  idFactory: () => string,
): InteractionQuestion {
  if (!isInteractionQuestionKind(input.kind)) {
    throw new InteractionValidationError(`question.kind "${input.kind}" is not supported.`);
  }

  const id = input.id === undefined ? idFactory() : assertNonEmpty(input.id, "question.id");
  const createdAt = normalizeTimestamp(now);
  const timeoutMs =
    input.timeoutMs === undefined
      ? undefined
      : Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
        ? input.timeoutMs
        : (() => {
            throw new InteractionValidationError("timeoutMs must be a positive number.");
          })();
  const timeoutAt =
    timeoutMs === undefined
      ? undefined
      : new Date(new Date(createdAt).getTime() + timeoutMs).toISOString();
  const question: InteractionQuestion = {
    id,
    question: assertNonEmpty(input.question, "question"),
    kind: input.kind,
    choices: freezeChoices(input.choices, input.kind),
    createdAt,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(input.placeholder?.trim() ? { placeholder: input.placeholder.trim() } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(timeoutAt === undefined ? {} : { timeoutAt }),
  };

  return Object.freeze(question);
}

function findChoiceLabel(question: InteractionQuestion, choiceId: string): string {
  return question.choices.find((choice) => choice.id === choiceId)?.label ?? choiceId;
}

function normalizeChoiceIds(
  question: InteractionQuestion,
  response: InteractionResponseInput,
  expectedLength: 1 | "many",
): readonly string[] {
  const rawChoiceIds =
    response.choiceIds !== undefined
      ? [...response.choiceIds]
      : response.choiceId !== undefined
        ? [response.choiceId]
        : [];

  if (expectedLength === 1 && rawChoiceIds.length !== 1) {
    throw new InteractionValidationError(
      "single_choice questions require exactly one choice id in the response.",
    );
  }

  if (expectedLength === "many" && rawChoiceIds.length === 0) {
    throw new InteractionValidationError(
      "multi_choice questions require one or more choice ids in the response.",
    );
  }

  const allowedChoices = new Set(question.choices.map((choice) => choice.id));
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const [index, choiceId] of rawChoiceIds.entries()) {
    const normalizedChoiceId = assertNonEmpty(choiceId, `response.choiceIds[${index}]`);
    if (!allowedChoices.has(normalizedChoiceId)) {
      throw new InteractionValidationError(
        `Choice id "${normalizedChoiceId}" is not valid for question "${question.id}".`,
      );
    }

    if (seen.has(normalizedChoiceId)) {
      throw new InteractionValidationError(
        `Choice id "${normalizedChoiceId}" was provided more than once.`,
      );
    }

    seen.add(normalizedChoiceId);
    normalized.push(normalizedChoiceId);
  }

  return Object.freeze(normalized);
}

function normalizeResponse(
  question: InteractionQuestion,
  response: InteractionResponseInput,
  now: InteractionPluginOptions["now"],
): InteractionResponse {
  const submittedAt = normalizeTimestamp(now);

  switch (question.kind) {
    case "text":
      return Object.freeze({
        questionId: question.id,
        kind: question.kind,
        text: assertNonEmpty(response.text, "response.text"),
        submittedAt,
      });
    case "single_choice": {
      const choiceIds = normalizeChoiceIds(question, response, 1);
      return Object.freeze({
        questionId: question.id,
        kind: question.kind,
        choiceIds,
        choiceLabels: Object.freeze(choiceIds.map((choiceId) => findChoiceLabel(question, choiceId))),
        submittedAt,
      });
    }
    case "multi_choice": {
      const choiceIds = normalizeChoiceIds(question, response, "many");
      return Object.freeze({
        questionId: question.id,
        kind: question.kind,
        choiceIds,
        choiceLabels: Object.freeze(choiceIds.map((choiceId) => findChoiceLabel(question, choiceId))),
        submittedAt,
      });
    }
    default:
      return assertUnreachable(question.kind, "question.kind");
  }
}

function freezeTasks(tasks: readonly InteractionTask[]): readonly InteractionTask[] {
  const seen = new Set<string>();
  const normalized: InteractionTask[] = [];

  for (const [index, task] of tasks.entries()) {
    const id = assertNonEmpty(task.id, `tasks[${index}].id`);
    if (seen.has(id)) {
      throw new InteractionValidationError(`Duplicate task id "${id}" is not allowed.`);
    }

    seen.add(id);
    if (!isInteractionTaskStatus(task.status)) {
      throw new InteractionValidationError(
        `tasks[${index}].status "${task.status}" is not supported.`,
      );
    }
    normalized.push(
      Object.freeze({
        id,
        description: assertNonEmpty(task.description, `tasks[${index}].description`),
        status: task.status,
      }),
    );
  }

  return Object.freeze(normalized);
}

function normalizeTaskList(
  input: InteractionTaskListInput,
  now: InteractionPluginOptions["now"],
): InteractionTaskList {
  const listId =
    input.listId === undefined ? "default" : assertNonEmpty(input.listId, "listId");

  return Object.freeze({
    listId,
    tasks: freezeTasks(input.tasks),
    updatedAt: normalizeTimestamp(now),
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
  });
}

function summarizeQuestionResponse(response: InteractionResponse): string {
  if (response.text !== undefined) {
    return `User answered: ${response.text}`;
  }

  return `User selected: ${(response.choiceLabels ?? response.choiceIds ?? []).join(", ")}`;
}

function summarizeTaskList(taskList: InteractionTaskList): string {
  const counts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
  };

  for (const task of taskList.tasks) {
    counts[task.status] += 1;
  }

  return `Updated task list "${taskList.listId}" with ${taskList.tasks.length} task(s): ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed.`;
}

function dispatchTransportEvent(
  transports: Iterable<InteractionTransport>,
  event: InteractionEvent,
  onTransportError: InteractionPluginOptions["onTransportError"],
): void {
  for (const transport of transports) {
    try {
      transport.publish(event);
    } catch (error) {
      onTransportError?.(error, event);
    }
  }
}

function replayTransportState(
  transport: InteractionTransport,
  pendingQuestions: readonly InteractionQuestion[],
  taskLists: readonly InteractionTaskList[],
  onTransportError: InteractionPluginOptions["onTransportError"],
): void {
  for (const taskList of taskLists) {
    dispatchTransportEvent(
      [transport],
      {
        type: "task_list.updated",
        occurredAt: taskList.updatedAt,
        taskList,
      },
      onTransportError,
    );
  }

  for (const question of pendingQuestions) {
    dispatchTransportEvent(
      [transport],
      {
        type: "question.requested",
        occurredAt: question.createdAt,
        question,
      },
      onTransportError,
    );
  }
}

export function createAskUserToolDefinition(
  interaction: Pick<InteractionPlugin, "askUser">,
): ToolDefinition<typeof askUserSchema, InteractionResponse> {
  return defineTool({
    name: "ask_user",
    label: "ask_user",
    description:
      "Pause execution and ask the user a structured question. Supports free-text, single-choice, and multi-choice responses.",
    promptSnippet: "Ask the user a blocking clarifying question when you need a decision or missing input.",
    promptGuidelines: [
      "Use ask_user only when you are blocked on missing user input or an actual decision.",
      "For choice questions, provide short stable choice ids and clear labels.",
      "If a question times out or the user cancels it, treat that as a blocking failure and decide how to recover.",
    ],
    parameters: askUserSchema,
    async execute(
      _toolCallId: string,
      params: AskUserInput,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<InteractionResponse> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<InteractionResponse>> {
      const response = await interaction.askUser(
        params as InteractionQuestionInput,
        signal === undefined ? {} : { signal },
      );

      return {
        content: [{ type: "text", text: summarizeQuestionResponse(response) }],
        details: response,
      };
    },
  });
}

export function createTaskWriteToolDefinition(
  interaction: Pick<InteractionPlugin, "taskWrite">,
): ToolDefinition<typeof taskWriteSchema, InteractionTaskList> {
  return defineTool({
    name: "task_write",
    label: "task_write",
    description:
      "Create or replace a visible task list that the user can monitor while the agent works.",
    promptSnippet: "Publish the current task list so the user can see progress.",
    promptGuidelines: [
      "Send the full task list snapshot each time instead of partial prose-only updates.",
      "Keep task descriptions short and update statuses as work moves from pending to completed.",
    ],
    parameters: taskWriteSchema,
    async execute(
      _toolCallId: string,
      params: TaskWriteInput,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<InteractionTaskList> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<InteractionTaskList>> {
      const taskList = interaction.taskWrite(params as InteractionTaskListInput);

      return {
        content: [{ type: "text", text: summarizeTaskList(taskList) }],
        details: taskList,
      };
    },
  });
}

export function createInteractionPlugin(
  options: InteractionPluginOptions = {},
): InteractionPlugin {
  const idFactory = options.idFactory ?? randomUUID;
  const transports = new Set<InteractionTransport>(options.transports ?? []);
  const pendingQuestions = new Map<string, PendingQuestionRecord>();
  const taskLists = new Map<string, InteractionTaskList>();

  function clearPendingQuestion(record: PendingQuestionRecord): void {
    if (record.timeoutHandle !== undefined) {
      clearTimeout(record.timeoutHandle);
      record.timeoutHandle = undefined;
    }

    if (record.abortSignal !== undefined && record.abortHandler !== undefined) {
      record.abortSignal.removeEventListener("abort", record.abortHandler);
      record.abortHandler = undefined;
      record.abortSignal = undefined;
    }
  }

  function notify(event: InteractionEvent): void {
    dispatchTransportEvent(transports, event, options.onTransportError);
  }

  function closePendingQuestion(
    questionId: string,
    cancellationCode: InteractionCancellationCode,
    reason: string,
  ): boolean {
    const record = pendingQuestions.get(questionId);
    if (record === undefined) {
      return false;
    }

    pendingQuestions.delete(questionId);
    clearPendingQuestion(record);

    const error =
      cancellationCode === "timeout"
        ? new InteractionQuestionTimeoutError(questionId, reason)
        : new InteractionQuestionCancelledError(questionId, cancellationCode, reason);
    record.reject(error);
    notify({
      type: "question.cancelled",
      occurredAt: normalizeTimestamp(options.now),
      question: record.question,
      code: cancellationCode,
      reason,
    });

    return true;
  }

  const interaction: InteractionPlugin = {
    name,
    kind,
    piTools: undefined as never,
    attachTransport(transport: InteractionTransport): () => void {
      transports.add(transport);
      replayTransportState(
        transport,
        interaction.listPendingQuestions(),
        interaction.listTaskLists(),
        options.onTransportError,
      );
      return () => transports.delete(transport);
    },
    async askUser(
      input: InteractionQuestionInput,
      requestOptions: InteractionRequestOptions = {},
    ): Promise<InteractionResponse> {
      const question = normalizeQuestion(input, options.now, idFactory);
      if (requestOptions.signal?.aborted === true) {
        throw new InteractionQuestionCancelledError(
          question.id,
          "aborted",
          "Question was aborted before the user responded.",
        );
      }

      if (pendingQuestions.has(question.id)) {
        throw new InteractionValidationError(`Question id "${question.id}" is already pending.`);
      }

      let resolveResponse!: (response: InteractionResponse) => void;
      let rejectResponse!: (error: unknown) => void;
      const responsePromise = new Promise<InteractionResponse>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });

      const record: PendingQuestionRecord = {
        question,
        resolve: resolveResponse,
        reject: rejectResponse,
        timeoutHandle: undefined,
        abortSignal: undefined,
        abortHandler: undefined,
      };

      if (question.timeoutMs !== undefined) {
        record.timeoutHandle = setTimeout(() => {
          closePendingQuestion(
            question.id,
            "timeout",
            "Question timed out while waiting for a user response.",
          );
        }, question.timeoutMs);
      }

      if (requestOptions.signal !== undefined) {
        record.abortSignal = requestOptions.signal;
        record.abortHandler = () => {
          closePendingQuestion(
            question.id,
            "aborted",
            "Question was aborted before the user responded.",
          );
        };
        requestOptions.signal.addEventListener("abort", record.abortHandler, { once: true });
      }

      pendingQuestions.set(question.id, record);
      notify({
        type: "question.requested",
        occurredAt: question.createdAt,
        question,
      });

      return responsePromise;
    },
    answerQuestion(questionId: string, response: InteractionResponseInput): InteractionResponse {
      const record = pendingQuestions.get(questionId);
      if (record === undefined) {
        throw new InteractionQuestionNotFoundError(questionId);
      }

      const normalizedResponse = normalizeResponse(record.question, response, options.now);
      pendingQuestions.delete(questionId);
      clearPendingQuestion(record);
      record.resolve(normalizedResponse);
      notify({
        type: "question.answered",
        occurredAt: normalizedResponse.submittedAt,
        question: record.question,
        response: normalizedResponse,
      });
      return normalizedResponse;
    },
    cancelQuestion(questionId: string, reason = "Question was cancelled by the user."): boolean {
      return closePendingQuestion(questionId, "cancelled", reason);
    },
    getPendingQuestion(questionId: string): InteractionQuestion | undefined {
      return pendingQuestions.get(questionId)?.question;
    },
    listPendingQuestions(): readonly InteractionQuestion[] {
      return Object.freeze(
        [...pendingQuestions.values()]
          .map((record) => record.question)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      );
    },
    taskWrite(input: InteractionTaskListInput): InteractionTaskList {
      const taskList = normalizeTaskList(input, options.now);
      taskLists.set(taskList.listId, taskList);
      notify({
        type: "task_list.updated",
        occurredAt: taskList.updatedAt,
        taskList,
      });
      return taskList;
    },
    getTaskList(listId = "default"): InteractionTaskList | undefined {
      return taskLists.get(listId);
    },
    listTaskLists(): readonly InteractionTaskList[] {
      return Object.freeze(
        [...taskLists.values()].sort((left, right) => left.listId.localeCompare(right.listId)),
      );
    },
  };

  const askUserTool = createAskUserToolDefinition(interaction);
  const taskWriteTool = createTaskWriteToolDefinition(interaction);

  return Object.freeze({
    ...interaction,
    piTools: Object.freeze([askUserTool, taskWriteTool]) as InteractionPlugin["piTools"],
  });
}

function normalizeRoutePrefix(routePrefix: string | undefined): string {
  if (routePrefix === undefined) {
    return "";
  }

  const trimmed = routePrefix.trim();
  if (trimmed.length === 0 || trimmed === "/") {
    return "";
  }

  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

class InvalidJsonBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonBodyError";
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  const rawBody = await request.text();

  if (rawBody.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new InvalidJsonBodyError("Request body is not valid JSON.");
  }
}

function normalizeResponsePayload(body: unknown): InteractionResponseInput {
  if (!isPlainObject(body)) {
    throw new InteractionValidationError("Answer payload must be a JSON object.");
  }

  const rawText = body["text"];
  const rawChoiceId = body["choiceId"];
  const rawChoiceIds = body["choiceIds"];
  const hasText = Object.hasOwn(body, "text");
  const hasChoiceId = Object.hasOwn(body, "choiceId");
  const hasChoiceIds = Object.hasOwn(body, "choiceIds");

  if (hasText && typeof rawText !== "string") {
    throw new InteractionValidationError('Answer payload field "text" must be a string.');
  }

  if (hasChoiceId && typeof rawChoiceId !== "string") {
    throw new InteractionValidationError('Answer payload field "choiceId" must be a string.');
  }

  if (
    hasChoiceIds &&
    (!Array.isArray(rawChoiceIds) ||
      !rawChoiceIds.every((value): value is string => typeof value === "string"))
  ) {
    throw new InteractionValidationError(
      'Answer payload field "choiceIds" must be an array of strings.',
    );
  }

  if (hasChoiceId && hasChoiceIds) {
    throw new InteractionValidationError(
      'Answer payload must include either "choiceId" or "choiceIds", but not both.',
    );
  }

  return {
    ...(typeof rawText === "string" ? { text: rawText } : {}),
    ...(typeof rawChoiceId === "string" ? { choiceId: rawChoiceId } : {}),
    ...(Array.isArray(rawChoiceIds) ? { choiceIds: rawChoiceIds } : {}),
  };
}

function normalizeCancelReason(body: unknown): string | undefined {
  if (!isPlainObject(body)) {
    return undefined;
  }

  const rawReason = body["reason"];
  return typeof rawReason === "string" && rawReason.trim().length > 0
    ? rawReason.trim()
    : undefined;
}

function serializeInteractionEvent(event: InteractionTransportEvent): string {
  const payload = JSON.stringify(event, undefined, 2);
  const lines = [`id: ${event.sequence}`, `event: ${event.type}`];

  for (const line of payload.split(/\r?\n/)) {
    lines.push(`data: ${line}`);
  }

  lines.push("", "");
  return lines.join("\n");
}

export function createHonoInteractionTransport(
  options: HonoInteractionTransportOptions,
): HonoInteractionTransport {
  const routePrefix = normalizeRoutePrefix(options.routePrefix ?? "/interaction");
  const app = new Hono();
  const listeners = new Map<number, (event: InteractionTransportEvent) => void>();
  const activeStreams = new Set<(closeController: boolean) => void>();
  const history: InteractionTransportEvent[] = [];
  const historyLimit = options.historyLimit ?? 100;
  const createEventId = options.createEventId ?? randomUUID;
  let nextSequence = 1;
  let nextListenerId = 1;
  let closed = false;

  function record(event: InteractionEvent): InteractionTransportEvent {
    const nextEvent: InteractionTransportEvent = Object.freeze({
      ...event,
      eventId: createEventId(),
      sequence: nextSequence++,
    });

    history.push(nextEvent);
    if (historyLimit >= 0 && history.length > historyLimit) {
      history.splice(0, history.length - historyLimit);
    }

    return nextEvent;
  }

  function emit(event: InteractionEvent): void {
    if (closed) {
      return;
    }

    const recorded = record(event);
    for (const listener of [...listeners.values()]) {
      listener(recorded);
    }
  }

  function snapshot(fromSequence?: number): readonly InteractionTransportEvent[] {
    return Object.freeze(
      fromSequence === undefined
        ? [...history]
        : history.filter((event) => event.sequence >= fromSequence),
    );
  }

  function subscribe(listener: (event: InteractionTransportEvent) => void): () => void {
    const listenerId = nextListenerId++;
    listeners.set(listenerId, listener);

    return () => {
      listeners.delete(listenerId);
    };
  }

  app.get(`${routePrefix}/health`, (context) =>
    context.json({
      plugin: name,
      adapter: "hono",
      pendingQuestions: options.interaction.listPendingQuestions().length,
      taskLists: options.interaction.listTaskLists().length,
      historySize: history.length,
    }),
  );

  app.get(`${routePrefix}/questions`, (context) =>
    context.json({
      questions: options.interaction.listPendingQuestions(),
    }),
  );

  app.get(`${routePrefix}/task-lists`, (context) =>
    context.json({
      taskLists: options.interaction.listTaskLists(),
    }),
  );

  app.get(`${routePrefix}/events`, async (context) => {
    const encoder = new TextEncoder();
    const replayFrom =
      parseReplaySequence(context.req.query("fromSequence")) ??
      parseReplaySequence(context.req.raw.headers.get("last-event-id") ?? undefined);
    let streamCleanup: (closeController: boolean) => void = () => undefined;

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          let active = true;
          let unsubscribe: () => void = () => undefined;
          let onAbort: () => void = () => undefined;
          const push = (event: InteractionTransportEvent): void => {
            if (!active) {
              return;
            }

            controller.enqueue(encoder.encode(serializeInteractionEvent(event)));
          };

          streamCleanup = (closeController: boolean): void => {
            if (!active) {
              return;
            }

            active = false;
            unsubscribe();
            context.req.raw.signal.removeEventListener("abort", onAbort);
            activeStreams.delete(streamCleanup);
            if (closeController) {
              try {
                controller.close();
              } catch {
                // Stream may already be closed or errored.
              }
            }
          };

          unsubscribe = subscribe(push);
          activeStreams.add(streamCleanup);

          for (const event of snapshot(replayFrom)) {
            push(event);
          }

          onAbort = () => {
            streamCleanup(true);
          };

          if (context.req.raw.signal.aborted) {
            streamCleanup(true);
            return;
          }

          context.req.raw.signal.addEventListener("abort", onAbort, { once: true });
        },
        cancel() {
          streamCleanup(false);
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        },
      },
    );
  });

  app.post(`${routePrefix}/questions/:id/answer`, async (context) => {
    let body: unknown;
    try {
      body = await readJsonBody(context.req.raw);
    } catch (error) {
      if (error instanceof InvalidJsonBodyError) {
        return context.json({ error: error.message }, 400);
      }

      throw error;
    }

    try {
      const response = options.interaction.answerQuestion(
        context.req.param("id"),
        normalizeResponsePayload(body),
      );

      return context.json({
        ok: true,
        response,
      });
    } catch (error) {
      if (error instanceof InteractionQuestionNotFoundError) {
        return context.json({ error: error.message }, 404);
      }

      if (error instanceof InteractionValidationError) {
        return context.json({ error: error.message }, 400);
      }

      throw error;
    }
  });

  app.post(`${routePrefix}/questions/:id/cancel`, async (context) => {
    let body: unknown;
    try {
      body = await readJsonBody(context.req.raw);
    } catch (error) {
      if (error instanceof InvalidJsonBodyError) {
        return context.json({ error: error.message }, 400);
      }

      throw error;
    }

    const cancelled = options.interaction.cancelQuestion(
      context.req.param("id"),
      normalizeCancelReason(body) ?? "Question was cancelled by the user.",
    );

    return cancelled
      ? context.json({ ok: true })
      : context.json({ error: `Question "${context.req.param("id")}" is not pending.` }, 404);
  });

  return Object.freeze({
    routePrefix,
    app,
    fetch: app.fetch,
    publish(event: InteractionEvent): void {
      emit({
        ...event,
        occurredAt: event.occurredAt ?? normalizeTimestamp(options.now),
      });
    },
    snapshot,
    close(): void {
      closed = true;
      for (const cleanup of [...activeStreams]) {
        cleanup(true);
      }
      listeners.clear();
      history.length = 0;
    },
  });
}
