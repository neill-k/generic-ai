import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  type HarnessState,
  historyForPrompt,
  mergeHarnessStates,
  overviewForPrompt,
  parseProposal,
  REFINEMENT_SYSTEM_PROMPT,
  type RefinementEdit,
  type RefinementResult,
} from "@generic-ai/continual";
import {
  buildSessionContext,
  convertToLlm,
  loadEntriesFromFile,
  type SessionEntry,
  serializeConversation,
} from "@generic-ai/session";

import type {
  BackgroundGate,
  BackgroundModel,
  BackgroundReply,
  MemoryBackgroundStore,
} from "./background.js";
import type { CompanyHarvest, HarvestedScript } from "./harvest.js";
import { agentScope, COMPANY_SCOPE, type CompanyMemory, type MemoryChange } from "./memory.js";

/**
 * Dreaming (design decision 19). When an agent has been idle for a while and has done new work
 * since it last dreamed, a background job rereads its recent saved sessions and the scripts
 * harvested from its accepted work, and edits its private memory: keep what is worth keeping,
 * merge duplicates, drop what turned out wrong, and turn repeated work or a script that worked
 * into a saved procedure. It runs the refine planner ported from Prime Agent offline, between
 * tasks, instead of mid-conversation.
 *
 * It may change how the agent behaves without asking. Every change is recorded with the entries
 * before and after it, and the owner can undo any dream from the memory page.
 *
 * It can never change goal checks, the owner's permissions or standing rules, the handbook, or
 * another agent (decision 41): it only ever writes through the memory store as `dream` for the
 * agent it is dreaming for, and the store refuses everything else. The handbook is shown to it
 * as read-only context.
 */
export interface DreamResult {
  readonly agentId: string;
  readonly skipped?: string;
  readonly sessions?: number;
  readonly scripts?: number;
  readonly change?: MemoryChange;
  readonly applied?: number;
  readonly refused?: number;
  readonly reply?: BackgroundReply;
}

export interface Dreaming {
  /** Dreams for one agent now, if there is anything new. `force` skips the idle and spacing checks. */
  dream(agentId: string, options?: { readonly force?: boolean }): Promise<DreamResult>;
  /** Picks at most one agent that is due and dreams for it. */
  tick(): Promise<DreamResult | undefined>;
}

export interface DreamingOptions {
  readonly memory: CompanyMemory;
  readonly store: MemoryBackgroundStore;
  readonly model: BackgroundModel;
  readonly gate: BackgroundGate;
  /** Where saved sessions are: `<sessionsRoot>/<agentId>/<goal>.jsonl`. */
  readonly sessionsRoot: string;
  readonly harvest?: CompanyHarvest;
  readonly agents: () => Promise<readonly string[]>;
  /** When the agent last finished or started work; undefined when it is working right now. */
  readonly lastActive: (agentId: string) => Promise<Date | "working" | undefined>;
  readonly now?: () => Date;
  /** Most recent sessions reread per dream. Default 4. */
  readonly maxSessions?: number;
  /** Characters of transcript sent per dream. Default 60,000. */
  readonly maxTranscriptChars?: number;
}

const DREAM_STATE_PREFIX = "dream:";
const MAX_OUTPUT_TOKENS = 8_000;
const MAX_SCRIPT_CHARS = 6_000;

export const DREAMING_INSTRUCTIONS = `You are running offline, while the agent is idle: this is its dream. You are reviewing several of its recent work sessions at once, not a live conversation.

Edit only this agent's own store (the "local" scope). Handbook entries (the "global" scope) are the owner's and are read-only context: never propose edits to them.

Do what a person does when they sleep on a week's work:
- Keep what is worth keeping: lessons, decisions, facts about the work that will matter again. Use memory entries.
- Merge duplicates into one entry and delete the rest.
- Delete or correct entries that the sessions show were wrong or are out of date.
- When the agent kept repeating the same steps, or a harvested script did a job well, save a skill. For a harvested script, set "metadata": {"harvestId": "<the script's id>"} and use "{script}" for the script's path in the command, for example {"type":"command","command":"python3 {script} --input <path>"}. Describe its inputs in "arguments".
- Use a prompt entry only for a narrow rule about how this agent should behave, backed by evidence.
- Never add rules about goals, checks, permissions or what the agent is allowed to do; those belong to the owner.
- Prefer few, small, well-evidenced edits. An empty edits list is a fine answer.`;

async function recentSessions(
  dir: string,
  since: string | undefined,
  max: number,
): Promise<{ file: string; modified: Date }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: { file: string; modified: Date }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (since === undefined || info.mtime.toISOString() > since) {
        files.push({ file, modified: info.mtime });
      }
    } catch {
      // A session removed mid-read is skipped.
    }
  }
  return files
    .sort((left, right) => right.modified.getTime() - left.modified.getTime())
    .slice(0, max);
}

/** A saved session as readable text: what was asked, what the agent did, what tools returned. */
export function sessionTranscript(file: string): string {
  const entries = loadEntriesFromFile(file).filter(
    (entry): entry is SessionEntry => (entry as { type?: string }).type !== "session",
  );
  const { messages } = buildSessionContext(entries);
  return serializeConversation(convertToLlm(messages));
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `[Earlier part omitted.]\n${text.slice(text.length - max)}`;
}

function changeAsHistory(change: MemoryChange): RefinementResult {
  return {
    id: change.id,
    summary: `${change.summary} (by ${change.actor.kind}${change.undoneBy === undefined ? "" : ", undone by the owner"})`,
    rationale: change.rationale ?? "",
    expectedOutcome: "",
    appliedEdits: change.edits,
    harnessStatePath: "",
  };
}

export function createDreaming(options: DreamingOptions): Dreaming {
  const now = options.now ?? (() => new Date());
  const maxSessions = options.maxSessions ?? 4;
  const maxTranscript = options.maxTranscriptChars ?? 60_000;

  async function dream(agentId: string, dreamOptions: { readonly force?: boolean } = {}) {
    const blocked = await options.gate();
    if (blocked !== undefined) {
      return { agentId, skipped: blocked };
    }
    const settings = await options.store.settings();
    const last = await options.store.getState<{ readonly at?: string }>(
      `${DREAM_STATE_PREFIX}${agentId}`,
    );
    if (dreamOptions.force !== true) {
      if (!settings.dreaming.enabled) {
        return { agentId, skipped: "Dreaming is off." };
      }
      const active = await options.lastActive(agentId);
      if (active === "working") {
        return { agentId, skipped: "The agent is working." };
      }
      if (
        active !== undefined &&
        now().getTime() - active.getTime() < settings.dreaming.idleMinutes * 60_000
      ) {
        return { agentId, skipped: "The agent has not been idle long enough." };
      }
      if (
        last?.at !== undefined &&
        now().getTime() - new Date(last.at).getTime() <
          settings.dreaming.minHoursBetween * 3_600_000
      ) {
        return { agentId, skipped: "The agent dreamed recently." };
      }
    }

    const sessions = await recentSessions(
      path.join(options.sessionsRoot, agentId),
      last?.at,
      maxSessions,
    );
    const scripts: readonly HarvestedScript[] =
      (await options.harvest?.list({
        agentId,
        ...(last?.at === undefined ? {} : { since: last.at }),
      })) ?? [];
    if (sessions.length === 0 && scripts.length === 0) {
      return { agentId, skipped: "Nothing new since the last dream." };
    }

    const transcripts: string[] = [];
    const perSession = Math.floor(maxTranscript / Math.max(1, sessions.length));
    for (const session of sessions.reverse()) {
      let text: string;
      try {
        text = sessionTranscript(session.file);
      } catch {
        continue;
      }
      if (text.trim().length > 0) {
        transcripts.push(
          `<session goal="${path.basename(session.file, ".jsonl")}" updated="${session.modified.toISOString()}">\n${tail(text, perSession)}\n</session>`,
        );
      }
    }
    const scriptBlocks: string[] = [];
    for (const script of scripts.slice(-8)) {
      const content = (await options.harvest?.read(script.id)) ?? "";
      scriptBlocks.push(
        `<script id="${script.id}" file="${script.fileName}" from="${script.sourcePath}" task="${script.taskId}">\n${content.slice(0, MAX_SCRIPT_CHARS)}\n</script>`,
      );
    }

    const handbook = await options.memory.read(COMPANY_SCOPE);
    const own = await options.memory.read(agentScope(agentId));
    const merged: HarnessState = mergeHarnessStates(handbook, own);
    const history = (await options.memory.changes({ scope: agentScope(agentId), limit: 20 }))
      .slice()
      .reverse()
      .map(changeAsHistory);
    const prompt = [
      `<current_harness_state>\n${overviewForPrompt(merged)}\n</current_harness_state>`,
      `<refinement_history>\n${historyForPrompt(history)}\n</refinement_history>`,
      `<conversation>\n${transcripts.join("\n\n") || "(no new sessions)"}\n</conversation>`,
      `<harvested_scripts>\n${scriptBlocks.join("\n\n") || "(none)"}\n</harvested_scripts>`,
      `<user_refine_instructions>\n${DREAMING_INSTRUCTIONS}\n</user_refine_instructions>`,
      "Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
    ].join("\n\n");

    const at = now().toISOString();
    let reply: BackgroundReply;
    try {
      reply = await options.model({
        system: REFINEMENT_SYSTEM_PROMPT,
        prompt,
        maxTokens: MAX_OUTPUT_TOKENS,
      });
    } catch (error) {
      await options.store.recordRun("dreaming", {
        error: `${agentId}: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
    // Whatever the reply, this material has been dreamed over; don't spend on it again.
    await options.store.setState(`${DREAM_STATE_PREFIX}${agentId}`, { at });
    let proposal: ReturnType<typeof parseProposal>;
    try {
      proposal = parseProposal(reply.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options.store.recordRun("dreaming", { error: `${agentId}: ${message}`, reply });
      return {
        agentId,
        skipped: message,
        sessions: sessions.length,
        scripts: scripts.length,
        reply,
      };
    }

    const scriptsById = new Map(scripts.map((script) => [script.id, script]));
    const edits: RefinementEdit[] = proposal.edits.map((edit) => {
      const harvestId = edit.metadata?.["harvestId"];
      const script = typeof harvestId === "string" ? scriptsById.get(harvestId) : undefined;
      if (edit.kind !== "skill" || script === undefined) {
        return edit;
      }
      return { ...edit, metadata: { ...edit.metadata, scriptFile: script.fileName } };
    });
    const sources = sessions.map((session) => path.basename(session.file, ".jsonl"));
    const result =
      edits.length === 0
        ? { edits: [] }
        : await options.memory.apply({
            scope: agentScope(agentId),
            actor: { kind: "dream", id: agentId },
            origin: {
              kind: "dream",
              ref: [
                ...sources.map((goal) => `session ${goal}`),
                ...scripts.map((script) => `script ${script.id}`),
              ]
                .join(", ")
                .slice(0, 500),
            },
            edits,
            summary: `Dream: ${proposal.summary}`.slice(0, 300),
            rationale: proposal.rationale.slice(0, 2_000),
          });
    const applied = result.edits.filter((edit) => edit.applied).length;
    const refused = result.edits.filter((edit) => !edit.applied).length;
    await options.store.recordRun("dreaming", {
      result:
        `${agentId}: ${applied} change${applied === 1 ? "" : "s"}${refused === 0 ? "" : `, ${refused} refused`}. ${proposal.summary}`.slice(
          0,
          500,
        ),
      reply,
    });
    return {
      agentId,
      sessions: sessions.length,
      scripts: scripts.length,
      ...("change" in result && result.change !== undefined ? { change: result.change } : {}),
      applied,
      refused,
      reply,
    };
  }

  return {
    dream,
    async tick() {
      const settings = await options.store.settings();
      if (!settings.dreaming.enabled || (await options.gate()) !== undefined) {
        return undefined;
      }
      for (const agentId of await options.agents()) {
        const result = await dream(agentId);
        if (result.skipped === undefined) {
          // One dream per tick keeps background spend low.
          return result;
        }
      }
      return undefined;
    },
  };
}
