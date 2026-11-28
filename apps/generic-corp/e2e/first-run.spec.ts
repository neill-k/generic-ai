import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { startScriptedServer, tempDataDir } from "./harness.js";

// The owner's first run, as RUN-LOCALLY.md describes it, on the scripted model (never a live one):
// the Claude API key screen is reachable, a goal set from the home screen gets a drafted
// definition of done, the CEO delegates, the VP writes a deliverable to the drive, the server is
// killed mid-turn and restarted, the turn resumes, the checks pass, the goal is done, and the
// deliverable is on the shelf.

test("first run: sign-in screen, then a goal through delegation, a restart and the drive to done", async ({
  page,
}) => {
  const data = tempDataDir();
  const hangFile = path.join(data.dir, "vp-turn-started");
  const env = { E2E_HANG_FILE: hangFile, GENERIC_CORP_TURN_LEASE_MS: "2000" };
  try {
    const first = await startScriptedServer({ dataDir: data.dir, env });

    // Where the owner adds the API key that powers agents: More, then Claude API key.
    await page.goto(`${first.url}/`);
    await expect(page.getByRole("heading", { name: "Goals" })).toBeVisible();
    await page.getByRole("link", { name: "More" }).first().click();
    await page.getByRole("link", { name: /Claude API key/ }).click();
    await expect(page.getByRole("heading", { name: "Claude API key" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "API key", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in with Claude" })).toHaveCount(0);

    // The first goal, typed on the Goals screen.
    await page.getByRole("link", { name: "Goals" }).first().click();
    await page.getByLabel("Set a goal").fill("Please delegate the chair count.");
    await page.getByRole("button", { name: "Set goal" }).click();
    await expect(
      page.getByRole("heading", { name: "Please delegate the chair count." }),
    ).toBeVisible();
    const goalUrl = new URL(page.url());

    // The VP has written its deliverable and is mid-turn: pull the plug.
    await expect.poll(() => existsSync(hangFile), { timeout: 20_000 }).toBe(true);
    expect(readFileSync(hangFile, "utf8")).toBe(String(first.process.pid));
    await first.kill();

    const second = await startScriptedServer({ dataDir: data.dir, env });
    try {
      await page.goto(`${second.url}/${goalUrl.hash}`);
      await expect(page.locator(".status-line")).toHaveText("Done.", { timeout: 30_000 });
      await expect(page.getByRole("heading", { name: "What done means" })).toBeVisible();
      await expect(page.locator(".checklist-item")).not.toHaveCount(0);

      // The VP's turn resumed from its saved step instead of starting over: one write, ever.
      const goalId = decodeURIComponent(goalUrl.hash.split("/").at(-1) ?? "");
      const vpSession = readFileSync(
        path.join(data.dir, "sessions", "vp-ops", `${goalId}.jsonl`),
        "utf8",
      );
      expect(vpSession.match(/"name":"write"/g)?.length).toBe(1);
      const tree = (await (await fetch(`${second.url}/api/tasks`)).json()) as {
        tasks: Array<{ agentId: string; status: string }>;
      };
      expect(tree.tasks.map((task) => `${task.agentId}:${task.status}`).sort()).toEqual([
        "ceo:succeeded",
        "vp-ops:succeeded",
      ]);

      // Where deliverables appear: More, then Deliverables.
      await page.getByRole("link", { name: "More" }).first().click();
      await page.getByRole("link", { name: /Deliverables/ }).click();
      await expect(page.getByRole("heading", { name: "Deliverables" })).toBeVisible();
      await expect(page.getByText("chair-count.md").first()).toBeVisible();
    } finally {
      await second.stop();
    }
  } finally {
    data.remove();
  }
});
