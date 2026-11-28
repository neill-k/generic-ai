import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { type ScriptedServer, startScriptedServer } from "./harness.js";

// The quality dial and spending limit in an agent's card on the org chart (decisions 22 and
// 42). Runs on the scripted model, never a live one.

let server: ScriptedServer;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-limits-app-"));
  server = await startScriptedServer({ dataDir });
});

test.afterAll(async () => {
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test("sets an agent's quality and spending limit from its card", async ({ page }) => {
  await page.goto(`${server.url}/#/org`);
  await page.getByRole("link", { name: /Chief Executive Officer/ }).click();
  const panel = page.getByRole("dialog", { name: "Chief Executive Officer" });
  await panel.getByRole("tab", { name: "Limits" }).click();

  await panel.getByRole("radio", { name: /Cheap/ }).check();
  await expect(panel.getByRole("radio", { name: /Cheap/ })).toBeChecked();
  await panel.getByRole("button", { name: "Show models" }).click();
  await expect(panel.getByText(/Runs on .*haiku/)).toBeVisible();

  await expect(panel.getByText(/No limit\./)).toBeVisible();
  await panel.getByLabel("Period").selectOption("day");
  await panel.getByLabel("Dollars").fill("5");
  await panel.getByRole("button", { name: "Set limit" }).click();
  await expect(panel.getByText("$0 of $5.00 today.")).toBeVisible();

  const limits = await (await page.request.get(`${server.url}/api/limits`)).json();
  expect(Object.values(limits.agents)).toEqual([
    expect.objectContaining({ limit: { period: "day", maxCostUsd: 5 } }),
  ]);

  await panel.getByRole("button", { name: "Remove limit" }).click();
  await expect(panel.getByText(/No limit\./)).toBeVisible();
});

test("sets the company limit and the plan-limit choice, and makes a backup", async ({ page }) => {
  await page.goto(`${server.url}/#/more`);
  await page.getByRole("link", { name: /Usage and limits/ }).click();
  const company = page.getByRole("region", { name: "Company spending limit" });
  await company.getByLabel("Period").selectOption("week");
  await company.getByLabel("Tokens").fill("200000");
  await company.getByRole("button", { name: "Set limit" }).click();
  await expect(company.getByText("0 of 200.0k tokens this week.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Spending by agent" })).toBeVisible();

  await page.goto(`${server.url}/#/sign-in`);
  await page.getByRole("radio", { name: /Use an API key until then/ }).check();
  await expect(page.getByText(/No Anthropic API key is set/)).toBeVisible();
  const plan = await (await page.request.get(`${server.url}/api/settings/plan-limit`)).json();
  expect(plan).toMatchObject({ behaviour: "api_key", limited: false });

  await page.goto(`${server.url}/#/backups`);
  await expect(page.getByRole("heading", { name: "Backups", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.locator(".backup-list li")).not.toHaveCount(0, { timeout: 20_000 });
});
