import type {
  BackgroundGate,
  BackgroundModel,
  BackgroundReply,
  MemoryBackgroundStore,
} from "./background.js";
import { jsonInReply } from "./background.js";
import {
  agentScope,
  COMPANY_SCOPE,
  type CompanyMemory,
  type MemoryEdit,
  type MemoryScope,
} from "./memory.js";

/**
 * The preference scanner (design decision 18). A background model reads the owner's new chat
 * messages and files each lasting preference as company-wide (the handbook) or for one agent.
 * Whether a preference spreads "depends on the preference", so the model decides, and every
 * entry points back to the message it came from. It never touches permissions or the owner's
 * standing rules (those live in the permissions store), and it cannot change anything the owner
 * wrote or edited: the memory store refuses it.
 */
export interface OwnerMessage {
  readonly messageId: string;
  readonly threadId: string;
  readonly text: string;
  readonly createdAt: string;
  /** The agent the owner was talking to. */
  readonly agentId: string;
}

export interface PreferenceScanResult {
  readonly scanned: number;
  readonly filed: number;
  readonly refused: number;
  readonly skipped?: string;
  readonly reply?: BackgroundReply;
}

export interface PreferenceScanner {
  scan(options?: { readonly signal?: AbortSignal }): Promise<PreferenceScanResult>;
}

export interface PreferenceScannerOptions {
  readonly memory: CompanyMemory;
  readonly store: MemoryBackgroundStore;
  readonly model: BackgroundModel;
  readonly gate: BackgroundGate;
  /** Owner messages, oldest first. */
  readonly messages: () => Promise<readonly OwnerMessage[]>;
  /** The company's agents, so the model can file a preference for one of them. */
  readonly agents: () => Promise<readonly { readonly id: string; readonly title: string }[]>;
  /** Most messages read in one call. Default 30. */
  readonly batchSize?: number;
}

const CURSOR_KEY = "scanner-cursor";
const MAX_MESSAGE_CHARS = 2_000;
const MAX_OUTPUT_TOKENS = 2_000;

export const PREFERENCE_SCANNER_PROMPT = `You read a company owner's chat messages to his AI staff and pick out lasting preferences: how he likes work done, what he cares about, facts about himself or the company that will matter again.

Rules:
- Only lasting preferences and facts. Skip one-off requests ("write the Q3 report"), questions, and anything only true for one task.
- File each one as "company" when it applies to everyone, or under one agent's id when it is only about that agent's work. When unsure, use "company".
- If an existing entry already says it, update that entry (give its id) instead of adding a duplicate. If the owner changed his mind, update the entry to the new preference.
- Do not record what agents are or are not allowed to do as permissions; the owner sets those elsewhere. You may still note a preference about it.
- Quote the owner's exact words that show the preference, and give the message id.
- Write each preference as a short instruction or fact, in the third person ("Neill wants...", "The owner prefers...").
- Most messages contain none. An empty list is the usual answer.

Reply with JSON only:
{"preferences":[{"scope":"company or an agent id","id":"existing entry id, only to update","title":"a few words","content":"the preference","quote":"the owner's words","messageId":"..."}]}`;

interface ProposedPreference {
  readonly scope: string;
  readonly id?: string;
  readonly title: string;
  readonly content: string;
  readonly quote?: string;
  readonly messageId?: string;
}

function parsePreferences(text: string): ProposedPreference[] {
  const parsed = jsonInReply(text) as { preferences?: unknown };
  if (!Array.isArray(parsed?.preferences)) {
    throw new Error("The scanner's reply had no preferences list.");
  }
  return parsed.preferences.flatMap((item): ProposedPreference[] => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const value = item as Record<string, unknown>;
    const text = (key: string) =>
      typeof value[key] === "string" && (value[key] as string).trim().length > 0
        ? (value[key] as string).trim()
        : undefined;
    const scope = text("scope");
    const title = text("title");
    const content = text("content");
    if (scope === undefined || title === undefined || content === undefined) {
      return [];
    }
    const id = text("id");
    const quote = text("quote");
    const messageId = text("messageId");
    return [
      {
        scope,
        title,
        content,
        ...(id === undefined ? {} : { id }),
        ...(quote === undefined ? {} : { quote }),
        ...(messageId === undefined ? {} : { messageId }),
      },
    ];
  });
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createPreferenceScanner(options: PreferenceScannerOptions): PreferenceScanner {
  const batchSize = options.batchSize ?? 30;
  return {
    async scan(scanOptions = {}) {
      const blocked = await options.gate();
      if (blocked !== undefined) {
        return { scanned: 0, filed: 0, refused: 0, skipped: blocked };
      }
      const cursor = (await options.store.getState<{ readonly after?: string }>(CURSOR_KEY)) ?? {};
      const all = await options.messages();
      const fresh = all
        .filter((message) => cursor.after === undefined || message.createdAt > cursor.after)
        .slice(0, batchSize);
      if (fresh.length === 0) {
        return { scanned: 0, filed: 0, refused: 0, skipped: "No new owner messages." };
      }
      const agents = await options.agents();
      const agentIds = new Set(agents.map((agent) => agent.id));
      const handbook = await options.memory.read(COMPANY_SCOPE);
      const existing: string[] = [];
      for (const entry of [
        ...Object.values(handbook.entries.prompt),
        ...Object.values(handbook.entries.memory),
      ]) {
        existing.push(`- [company:${entry.id}] ${entry.title}: ${clip(entry.content, 300)}`);
      }
      for (const agent of agents) {
        const state = await options.memory.read(agentScope(agent.id));
        for (const entry of Object.values(state.entries.prompt)) {
          existing.push(`- [${agent.id}:${entry.id}] ${entry.title}: ${clip(entry.content, 300)}`);
        }
      }
      const prompt = [
        "<agents>",
        ...agents.map((agent) => `- ${agent.id}: ${agent.title}`),
        "</agents>",
        "",
        "<existing_entries>",
        existing.length === 0 ? "(none)" : existing.join("\n"),
        "</existing_entries>",
        "",
        "<owner_messages>",
        ...fresh.map(
          (message) =>
            `[${message.messageId}] to ${message.agentId}, ${message.createdAt}:\n${clip(message.text, MAX_MESSAGE_CHARS)}`,
        ),
        "</owner_messages>",
      ].join("\n");

      let reply: BackgroundReply;
      try {
        reply = await options.model({
          system: PREFERENCE_SCANNER_PROMPT,
          prompt,
          maxTokens: MAX_OUTPUT_TOKENS,
          ...(scanOptions.signal === undefined ? {} : { signal: scanOptions.signal }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await options.store.recordRun("scanner", { error: message });
        throw error;
      }
      const last = fresh.at(-1) as OwnerMessage;
      let proposals: ProposedPreference[];
      try {
        proposals = parsePreferences(reply.text);
      } catch (error) {
        // A malformed reply is skipped rather than retried forever: move past these messages.
        await options.store.setState(CURSOR_KEY, { after: last.createdAt });
        const message = error instanceof Error ? error.message : String(error);
        await options.store.recordRun("scanner", { error: message, reply });
        return { scanned: fresh.length, filed: 0, refused: 0, skipped: message, reply };
      }

      const byId = new Map(fresh.map((message) => [message.messageId, message]));
      let filed = 0;
      let refused = 0;
      // One change per preference, so each entry points at exactly the message it came from and
      // the owner can undo one without the others.
      for (const proposal of proposals) {
        const scope: MemoryScope | undefined =
          proposal.scope === "company"
            ? COMPANY_SCOPE
            : agentIds.has(proposal.scope)
              ? agentScope(proposal.scope)
              : undefined;
        if (scope === undefined) {
          refused += 1;
          continue;
        }
        const state = await options.memory.read(scope);
        const target = proposal.id === undefined ? undefined : state.entries.prompt[proposal.id];
        const source = proposal.messageId === undefined ? undefined : byId.get(proposal.messageId);
        const ref =
          source === undefined
            ? undefined
            : `thread/${source.threadId}/message/${source.messageId}`;
        const edit: MemoryEdit = {
          action: target === undefined ? "create" : "update",
          kind: "prompt",
          ...(target === undefined ? {} : { id: target.id }),
          title: proposal.title,
          content: proposal.content,
          path: "preferences",
        };
        const result = await options.memory.apply({
          scope,
          actor: { kind: "scanner" },
          origin: {
            kind: "chat",
            ...(ref === undefined ? {} : { ref }),
            ...(proposal.quote === undefined ? {} : { note: clip(proposal.quote, 500) }),
          },
          edits: [edit],
          summary: `Noticed in your chats: "${proposal.title}"`,
        });
        filed += result.edits.filter((applied) => applied.applied).length;
        refused += result.edits.filter((applied) => !applied.applied).length;
      }
      await options.store.setState(CURSOR_KEY, { after: last.createdAt });
      await options.store.recordRun("scanner", {
        result: `Read ${fresh.length} messages, filed ${filed} preferences.`,
        reply,
      });
      return { scanned: fresh.length, filed, refused, reply };
    },
  };
}
