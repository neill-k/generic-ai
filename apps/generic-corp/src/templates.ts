import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type GoalEvalSuiteSpec, type JsonObject, parseGoalEvalSuite } from "@generic-ai/sdk";
import { parse as parseYaml } from "yaml";

import {
  type CompanyConfig,
  CompanyConfigError,
  companyGoal,
  parseCompanyConfig,
} from "./company.js";

/**
 * Company templates (roadmap R15): ready-made companies a person starts from. Each one is a
 * folder under `templates/` with
 *
 * - `company.yaml`: the org chart, roles, models per tier, tools and connectors, secret grants,
 *   permissions, and the goals the company knows how to pursue;
 * - `evals.yaml`: its goal eval suite, whose cases name those goals by id;
 * - `replays/`: recorded agent turns that replay each case offline, so CI can run the suite
 *   without a model key.
 *
 * Built-in skills (standup, review, compound learning) live in `skills/` and are given to
 * every agent of every company.
 */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TEMPLATES_DIR = path.join(APP_ROOT, "templates");
export const COMPANY_SKILLS_DIR = path.join(APP_ROOT, "skills");
export const DEFAULT_TEMPLATE = "generic-corp" as const;

const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Template ids, sorted, with the default first. */
export function listCompanyTemplates(): readonly string[] {
  if (!existsSync(TEMPLATES_DIR)) {
    return [];
  }
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        TEMPLATE_ID.test(entry.name) &&
        existsSync(path.join(TEMPLATES_DIR, entry.name, "company.yaml")),
    )
    .map((entry) => entry.name)
    .sort((left, right) =>
      left === DEFAULT_TEMPLATE ? -1 : right === DEFAULT_TEMPLATE ? 1 : left.localeCompare(right),
    );
}

function templateDir(templateId: string): string {
  if (!TEMPLATE_ID.test(templateId) || !listCompanyTemplates().includes(templateId)) {
    const known = listCompanyTemplates().join(", ");
    throw new CompanyConfigError(
      `There is no company template "${templateId}". Templates: ${known === "" ? "none" : known}.`,
    );
  }
  return path.join(TEMPLATES_DIR, templateId);
}

async function readYaml(file: string, what: string): Promise<unknown> {
  try {
    return parseYaml(await readFile(file, "utf8"));
  } catch (error) {
    throw new CompanyConfigError(
      `${what} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A template's company. */
export async function loadCompanyTemplate(templateId: string): Promise<CompanyConfig> {
  const raw = await readYaml(
    path.join(templateDir(templateId), "company.yaml"),
    `Template ${templateId}`,
  );
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CompanyConfigError(`Template ${templateId} must define a company object.`);
  }
  return parseCompanyConfig({ ...raw, template: templateId });
}

export interface TemplateEvalSuite {
  readonly templateId: string;
  readonly company: CompanyConfig;
  readonly suite: GoalEvalSuiteSpec;
  /** Replay files by case id. */
  readonly replays: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A template's goal eval suite. Cases name a company goal by id (`goal: market-brief`) and get
 * its spec, so the eval replays exactly the goal the owner would start from.
 */
export async function loadTemplateEvalSuite(templateId: string): Promise<TemplateEvalSuite> {
  const dir = templateDir(templateId);
  const company = await loadCompanyTemplate(templateId);
  const raw = await readYaml(path.join(dir, "evals.yaml"), `Template ${templateId} evals`);
  if (!isRecord(raw) || !Array.isArray(raw["cases"])) {
    throw new CompanyConfigError(`Template ${templateId} evals must list cases.`);
  }
  const replays: Record<string, string> = {};
  const cases = raw["cases"].map((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      throw new CompanyConfigError(`Template ${templateId} evals case ${index} must be an object.`);
    }
    const { goal, replay, ...rest } = entry;
    let spec = goal;
    if (typeof goal === "string") {
      const named = companyGoal(company, goal);
      if (named === undefined) {
        throw new CompanyConfigError(
          `Template ${templateId} evals case ${String(entry["id"])} names goal "${goal}", which the company does not define.`,
        );
      }
      spec = named.spec;
    }
    if (typeof replay === "string") {
      const replayPath = path.resolve(dir, replay);
      if (!replayPath.startsWith(`${dir}${path.sep}`)) {
        throw new CompanyConfigError(
          `Template ${templateId} replay ${replay} is outside the template.`,
        );
      }
      replays[String(entry["id"])] = replayPath;
    }
    return { ...rest, goal: spec };
  });
  const parsed = parseGoalEvalSuite({
    kind: "generic-ai.goal-eval-suite",
    id: templateId,
    ...raw,
    cases,
    metadata: {
      ...(isRecord(raw["metadata"]) ? raw["metadata"] : {}),
      template: templateId,
    } as JsonObject,
  });
  if (!parsed.ok) {
    throw new CompanyConfigError(
      `Template ${templateId} evals are invalid: ${parsed.issues
        .slice(0, 5)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return { templateId, company, suite: parsed.value, replays };
}
