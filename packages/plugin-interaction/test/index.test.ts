import { describe, expect, it } from "vitest";

import {
  InteractionQuestionCancelledError,
  InteractionQuestionTimeoutError,
  createHonoInteractionTransport,
  createInteractionPlugin,
  kind,
  name,
} from "../src/index.js";

describe("@generic-ai/plugin-interaction", () => {
  it("creates a plugin with ask_user and task_write pi tools", () => {
    const interaction = createInteractionPlugin();

    expect(interaction.name).toBe(name);
    expect(interaction.kind).toBe(kind);
    expect(interaction.piTools.map((tool) => tool.name)).toEqual([
      "ask_user",
      "task_write",
    ]);
  });

  it("waits for askUser answers and publishes transport events", async () => {
    const events: string[] = [];
    const interaction = createInteractionPlugin({
      transports: [
        {
          publish(event) {
            events.push(event.type);
          },
        },
      ],
    });

    const questionPromise = interaction.askUser({
      question: "Pick one",
      kind: "single_choice",
      choices: [
        { id: "a", label: "Option A" },
        { id: "b", label: "Option B" },
      ],
    });

    const pending = interaction.listPendingQuestions();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.question).toBe("Pick one");

    const answered = interaction.answerQuestion(pending[0]!.id, { choiceId: "b" });
    expect(answered.choiceIds).toEqual(["b"]);
    expect(answered.choiceLabels).toEqual(["Option B"]);
    await expect(questionPromise).resolves.toEqual(answered);
    expect(events).toEqual(["question.requested", "question.answered"]);
  });

  it("times out or cancels pending questions", async () => {
    const interaction = createInteractionPlugin();

    await expect(
      interaction.askUser({
        question: "This should time out",
        kind: "text",
        timeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(InteractionQuestionTimeoutError);

    const pendingPromise = interaction.askUser({
      question: "This should cancel",
      kind: "text",
    });
    const pending = interaction.listPendingQuestions();

    expect(interaction.cancelQuestion(pending[0]!.id, "User cancelled the prompt.")).toBe(true);
    await expect(pendingPromise).rejects.toBeInstanceOf(InteractionQuestionCancelledError);
  });

  it("updates visible task lists through the service and tool definition", async () => {
    const interaction = createInteractionPlugin();
    const taskWriteTool = interaction.piTools.find((tool) => tool.name === "task_write");

    expect(taskWriteTool).toBeDefined();

    const taskList = interaction.taskWrite({
      listId: "build",
      title: "Build tasks",
      tasks: [
        { id: "t1", description: "Write package", status: "completed" },
        { id: "t2", description: "Run checks", status: "in_progress" },
      ],
    });

    expect(interaction.getTaskList("build")).toEqual(taskList);

    const result = await taskWriteTool!.execute(
      "tool-call-1",
      {
        listId: "default",
        tasks: [{ id: "t3", description: "Open PR", status: "pending" }],
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details.listId).toBe("default");
    expect(result.content[0]?.type).toBe("text");
    expect(interaction.getTaskList().tasks).toEqual([
      { id: "t3", description: "Open PR", status: "pending" },
    ]);
  });

  it("exposes a Hono transport for SSE, snapshots, and answer routes", async () => {
    const interaction = createInteractionPlugin();
    const transport = createHonoInteractionTransport({
      interaction,
      routePrefix: "/interaction",
    });
    interaction.attachTransport(transport);

    interaction.taskWrite({
      tasks: [{ id: "t1", description: "Wait for user", status: "in_progress" }],
    });
    const pendingPromise = interaction.askUser({
      question: "Need your answer",
      kind: "text",
    });
    const [pendingQuestion] = interaction.listPendingQuestions();

    const health = await transport.app.request("/interaction/health");
    expect(await health.json()).toEqual({
      plugin: name,
      adapter: "hono",
      pendingQuestions: 1,
      taskLists: 1,
      historySize: 2,
    });

    const taskListsResponse = await transport.app.request("/interaction/task-lists");
    expect(await taskListsResponse.json()).toEqual({
      taskLists: interaction.listTaskLists(),
    });

    const questionsResponse = await transport.app.request("/interaction/questions");
    expect(await questionsResponse.json()).toEqual({
      questions: interaction.listPendingQuestions(),
    });

    const eventsResponse = await transport.app.request("/interaction/events");
    const reader = eventsResponse.body?.getReader();
    const firstChunk = await reader?.read();
    await reader?.cancel();
    const firstText = Buffer.from(firstChunk?.value ?? new Uint8Array()).toString("utf8");

    expect(transport.snapshot().map((event) => event.type)).toEqual([
      "task_list.updated",
      "question.requested",
    ]);
    expect(firstText).toContain("event: task_list.updated");

    const answerResponse = await transport.app.request(
      `/interaction/questions/${pendingQuestion!.id}/answer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Approved" }),
      },
    );
    const answered = await answerResponse.json();
    expect(answered.ok).toBe(true);
    await expect(pendingPromise).resolves.toMatchObject({ text: "Approved" });
  });

  it("keeps ask_user tool execution blocked until the Hono answer route responds", async () => {
    const interaction = createInteractionPlugin();
    const transport = createHonoInteractionTransport({
      interaction,
      routePrefix: "/interaction",
    });
    interaction.attachTransport(transport);

    const askUserTool = interaction.piTools.find((tool) => tool.name === "ask_user");
    expect(askUserTool).toBeDefined();

    const execution = askUserTool!.execute(
      "tool-call-2",
      {
        question: "Type a value",
        kind: "text",
      },
      undefined,
      undefined,
      {} as never,
    );

    const [pendingQuestion] = interaction.listPendingQuestions();
    expect(pendingQuestion?.question).toBe("Type a value");

    await transport.app.request(`/interaction/questions/${pendingQuestion!.id}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "done" }),
    });

    await expect(execution).resolves.toMatchObject({
      details: {
        text: "done",
      },
    });
  });
});
