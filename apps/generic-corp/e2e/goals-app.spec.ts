import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { type ScriptedServer, startScriptedServer } from "./harness.js";

// The new app at `/` (decision 47): set a goal from the home screen, follow it to done, and
// change what done means from the side panel. Runs on the scripted model, never a live one.

let server: ScriptedServer;
let dataDir: string;

test.beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "generic-corp-goals-app-"));
  server = await startScriptedServer({ dataDir });
});

test.afterAll(async () => {
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test("sets a goal, follows it to done and edits what done means", async ({ page }) => {
  await page.goto(`${server.url}/`);
  await expect(page.getByRole("heading", { name: "Goals" })).toBeVisible();

  await page.getByLabel("Set a goal").fill("Count the chairs in the office");
  await page.getByRole("button", { name: "Set goal" }).click();

  await expect(page.getByRole("heading", { name: "Count the chairs in the office" })).toBeVisible();
  await expect(page.locator(".status-line")).toHaveText("Done.", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "What done means" })).toBeVisible();
  await expect(page.locator(".checklist-item")).not.toHaveCount(0);

  await page.getByRole("button", { name: "Edit" }).click();
  const panel = page.getByRole("dialog", { name: "What done means" });
  await panel.getByLabel("Done means").fill("Every chair is counted.\nThe count is on the drive.");
  await panel.getByRole("button", { name: "Save new version" }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator(".checklist-item")).toHaveCount(2);
  await expect(page.getByText("Version 2.")).toBeVisible();

  await page.getByRole("link", { name: "← Goals" }).click();
  await expect(page.locator(".goal-card")).toHaveCount(1);

  await page.getByRole("link", { name: "Org chart" }).first().click();
  await page.getByRole("link", { name: /Chief Executive Officer/ }).click();
  await expect(page.getByRole("dialog", { name: "Chief Executive Officer" })).toBeVisible();
});

test("fits a phone screen", async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${server.url}/`);
  await expect(page.getByRole("heading", { name: "Goals" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await page.close();
});
