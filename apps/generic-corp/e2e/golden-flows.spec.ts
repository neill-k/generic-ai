import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { type ScriptedServer, startScriptedServer, tempDataDir } from "./harness.js";

// The golden flows through the real dashboard, server, cascade and permissions gate. Only the model
// is scripted (see scripted-server.mjs).

let server: ScriptedServer;
let data: ReturnType<typeof tempDataDir>;
let outbox: string;

test.beforeAll(async () => {
  data = tempDataDir();
  outbox = path.join(data.dir, "outbox.jsonl");
  server = await startScriptedServer({
    dataDir: data.dir,
    env: { E2E_OUTBOX: outbox, GENERIC_CORP_TURN_LEASE_MS: "5000" },
  });
});

test.afterAll(async () => {
  await server?.stop();
  data?.remove();
});

function sentEmails(): unknown[] {
  try {
    return readFileSync(outbox, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

async function send(page: import("@playwright/test").Page, text: string) {
  await page.goto(`${server.url}/classic/#/chat`);
  // A fresh load of #/chat opens a new conversation, so each flow reads only its own thread.
  await expect(page.locator("#company-name")).toHaveText("Scripted Corp");
  await page.getByLabel("Message to the CEO").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/#\/chat\/.+/);
  return page.url();
}

test("chat: the owner asks the CEO and the reply appears in the thread", async ({ page }) => {
  await send(page, "Say hello to the team.");
  const messages = page.locator("#messages");
  await expect(messages.locator(".bubble.owner").last()).toContainText("Say hello to the team.");
  await expect(messages).toContainText("Hello from the CEO.");
  await expect(messages).toContainText("CEO");
});

test("delegation: the CEO hands work to the VP and reports the result", async ({ page }) => {
  await send(page, "Please delegate the chair count to operations.");
  await expect(page.locator("#messages")).toContainText("The VP reports: 42 chairs counted.");

  // The board shows both tasks of the cascade as done.
  await page.getByRole("link", { name: "Board" }).click();
  const done = page.locator('.column[aria-label="Done"]');
  await expect(page.locator(".board")).toContainText("Count the chairs in the office.");
  await expect(page.locator(".board")).toContainText(
    "Please delegate the chair count to operations.",
  );
  await expect(done).toContainText("Count the chairs in the office.");

  // The org chart lists both agents.
  await page.getByRole("link", { name: "Org chart" }).click();
  await expect(page.locator("#view")).toContainText("Chief Executive Officer");
  await expect(page.locator("#view")).toContainText("VP of Operations");
});

test("permissions: an action outside them is refused and listed, and runs once allowed", async ({
  page,
}) => {
  await send(page, "Email the customer that the order shipped.");
  await expect(page.locator("#messages")).toContainText("Sending is off, so I drafted the email");
  expect(sentEmails()).toEqual([]);

  await page.getByRole("link", { name: "Permissions" }).click();
  const refused = page.locator("table.refusals");
  await expect(refused).toContainText("send_email");
  await expect(refused).toContainText("the owner has not allowed sending messages");
  await page.getByLabel(/Send messages on my behalf/).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#view")).toContainText("Saved.");

  await send(page, "Email the customer that the order shipped, please.");
  await expect(page.locator("#messages")).toContainText("Email sent.", { timeout: 30_000 });
  expect(sentEmails()).toEqual([{ to: "customer@example.com", body: "Your order shipped today." }]);
});

test("memory: the owner adds to the handbook, edits it, and undoes a removal", async ({ page }) => {
  await page.goto(`${server.url}/classic/#/memory`);
  await expect(page.locator("h1")).toHaveText("Memory");
  await page.getByLabel("Title").fill("How Neill likes updates");
  await page.getByLabel("Content").fill("Short, plain, on his phone.");
  await page.getByRole("button", { name: "Add" }).click();
  const entries = page.locator(".memory-entries");
  await expect(entries).toContainText("Short, plain, on his phone.");
  await expect(entries).toContainText("From: You");

  await entries.getByRole("button", { name: "Edit" }).click();
  await entries.getByLabel("Content").fill("Short and plain.");
  await entries.getByRole("button", { name: "Save" }).click();
  await expect(entries).toContainText("Short and plain.");

  await entries.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("#view")).toContainText("Nothing here yet.");
  await page.locator(".memory-change").first().getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".memory-entries")).toContainText("Short and plain.");
});
