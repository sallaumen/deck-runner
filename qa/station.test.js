import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { webkit } from "playwright";

test(
  "station, controls, resource limits and reconnection",
  { timeout: 50000 },
  async () => {
    const fixture = fileURLToPath(
      new URL("../scripts/preview.py", import.meta.url),
    );
    const service = spawn("python3", ["-u", fixture, "--port", "0"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const output = createInterface({ input: service.stdout });
    let browser, context;
    try {
      const [line] = await once(output, "line", {
        signal: AbortSignal.timeout(8000),
      });
      const url = new URL(line.match(/http:\/\/\S+/)[0]);
      browser = await webkit.launch();
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url.href);
      await page
        .getByRole("heading", { name: "Testes em andamento" })
        .waitFor();
      assert.equal(await page.locator("#usage").innerText(), "2 / 5");
      assert.equal(await page.locator("#history .history-row").count(), 4);
      const sample = await (
        await context.request.get(url.origin + "/api/status")
      ).json();
      const dimensions = () =>
        page.evaluate(() => [
          document.documentElement.scrollWidth,
          innerWidth,
          document.querySelector("footer").getBoundingClientRect().bottom,
        ]);
      let [width, viewport, bottom] = await dimensions();
      assert.equal(width, viewport);
      assert.ok(
        bottom <= 800,
        "Active station should fit the Deck's native screen",
      );
      await page.getByRole("link", { name: "Abrir controles" }).click();
      await page.locator("#filter").selectOption("atlas");
      assert.equal(await page.locator("#running .job").count(), 1);
      await page.getByText("Adicionar projeto", { exact: true }).click();
      await page.setViewportSize({ width: 375, height: 812 });
      [width, viewport] = await dimensions();
      assert.equal(width, viewport);
      await page.getByRole("link", { name: "Log", exact: true }).click();
      assert.ok((await page.locator("body").innerText()).includes("fictício"));
      await page.goto(url.href);
      await page.locator("#usage").getByText("2 / 5").waitFor();
      let mode = "offline";
      await page.route("**/api/status", (route) => {
        if (mode === "offline") return route.abort();
        const jobs = sample.jobs.filter((j) => j.state !== "running");
        return route.fulfill({
          json: { ...sample, jobs, paused: mode === "paused" },
        });
      });
      await page
        .getByRole("heading", { name: "Reconectando…" })
        .waitFor({ timeout: 12000 });
      mode = "idle";
      await page
        .getByRole("heading", { name: "Pronto para testar" })
        .waitFor({ timeout: 12000 });
      mode = "paused";
      await page
        .getByRole("heading", { name: "Fila pausada" })
        .waitFor({ timeout: 12000 });
      assert.deepEqual(errors, []);
    } finally {
      try {
        await context?.close();
      } finally {
        try {
          await browser?.close();
        } finally {
          output.close();
          service.kill();
        }
      }
    }
  },
);
