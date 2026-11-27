import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { type ScriptedServer, startScriptedServer, tempDataDir } from "./harness.js";

// The golden flows through the real app, server, cascade and permissions gate. Only the model
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
  await page.goto(`${server.url}/`);
  // Each request becomes its own goal, so each flow reads only its own conversation.
  await expect(page.getByRole("heading", { name: "Goals" })).toBeVisible();
  await page.getByLabel("Set a goal").fill(text);
  await page.getByRole("button", { name: "Set goal" }).click();
  await expect(page).toHaveURL(/#\/goals\/.+/);
  return page.url();
}

const conversation = (page: import("@playwright/test").Page) =>
  page.locator("section", { hasText: "Conversation with the CEO" }).locator(".messages");

test("chat: the owner asks the CEO and the reply appears in the thread", async ({ page }) => {
  await send(page, "Say hello to the team.");
  const messages = conversation(page);
  await expect(messages.locator(".message.owner").last()).toContainText("Say hello to the team.");
  await expect(messages).toContainText("Hello from the CEO.");
  await expect(messages).toContainText("CEO");
});

test("delegation: the CEO hands work to the VP and reports the result", async ({ page }) => {
  await send(page, "Please delegate the chair count to operations.");
  await expect(conversation(page)).toContainText("The VP reports: 42 chairs counted.");

  // Activity lists both tasks of the cascade as finished.
  await page.getByRole("link", { name: "Activity" }).first().click();
  const finished = page.getByRole("region", { name: "Recently finished" });
  await expect(finished).toContainText("Count the chairs in the office.");
  await expect(finished).toContainText("Please delegate the chair count to operations.");

  // The org chart lists both agents.
  await page.getByRole("link", { name: "Org chart" }).first().click();
  await expect(page.locator("main")).toContainText("Chief Executive Officer");
  await expect(page.locator("main")).toContainText("VP of Operations");
});

test("permissions: an action outside them is refused and listed, and runs once allowed", async ({
  page,
}) => {
  await send(page, "Email the customer that the order shipped.");
  await expect(conversation(page)).toContainText("Sending is off, so I drafted the email");
  expect(sentEmails()).toEqual([]);

  await page.goto(`${server.url}/#/permissions`);
  const refused = page.locator("ul.refusals");
  await expect(refused).toContainText("send_email");
  await expect(refused).toContainText("the owner has not allowed sending messages");
  await page.getByLabel(/Send messages on my behalf/).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("main")).toContainText("Saved.");

  await send(page, "Email the customer that the order shipped, please.");
  await expect(conversation(page)).toContainText("Email sent.", { timeout: 30_000 });
  expect(sentEmails()).toEqual([{ to: "customer@example.com", body: "Your order shipped today." }]);
});

test("memory: the owner adds to the handbook, edits it, and undoes a removal", async ({ page }) => {
  await page.goto(`${server.url}/#/memory`);
  await expect(page.locator("h1")).toHaveText("Memory");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Title").fill("How Neill likes updates");
  await page.getByLabel("What should be remembered").fill("Short, plain, on his phone.");
  await page.getByRole("button", { name: "Save" }).click();
  const entries = page.locator(".memory-entries");
  await expect(entries).toContainText("Short, plain, on his phone.");
  await expect(entries).toContainText("From: You");

  await entries.getByRole("button", { name: "Edit" }).click();
  await entries.getByLabel("What should be remembered").fill("Short and plain.");
  await entries.getByRole("button", { name: "Save" }).click();
  await expect(entries).toContainText("Short and plain.");

  await entries.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("main")).toContainText("Nothing in the handbook yet.");
  await page.locator(".memory-changes li").first().getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".memory-entries")).toContainText("Short and plain.");
});

test("memory: a preference from the owner's chat lands in the handbook", async ({ page }) => {
  await send(page, "From now on, always use metric units.");
  await page.goto(`${server.url}/#/memory`);
  await page.getByRole("button", { name: "Scan chats now" }).click();
  const entries = page.locator(".memory-entries");
  await expect(entries).toContainText("Use metric units.");
  await expect(entries).toContainText("From: Noticed in your chats");
  await expect(page.locator("main")).toContainText("Preference scanner: last ran");
});
