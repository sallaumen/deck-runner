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
      assert.equal(await page.locator("#leave").isVisible(), false);
      await page.goto(url.origin + "/?screen=1&station=1");
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.keyboard.press("ArrowDown");
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "switch",
      );
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "leave",
      );
      await page.keyboard.press("Enter");
      assert.equal(
        await page
          .locator("#confirm-leave")
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("dialog").isVisible(), false);
      await page.getByRole("link", { name: "Abrir controles" }).click();
      assert.equal(new URL(page.url()).searchParams.get("station"), "1");
      await page.locator("#history a").first().click();
      await page.getByText(/resultado é fictício/).waitFor();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      // Exercise a standard controller after Steam Input switches to gamepad mode.
      await page.evaluate(() => {
        window.fixturePad = {
          mapping: "standard",
          axes: [0, 0],
          buttons: Array.from({ length: 16 }, () => ({ pressed: false })),
        };
        Object.defineProperty(navigator, "getGamepads", {
          value: () => [window.fixturePad],
        });
        document.querySelector("#switch").focus();
        window.dispatchEvent(new Event("gamepadconnected"));
      });
      async function gamepad(input) {
        await page.evaluate(async (input) => {
          const pad = window.fixturePad;
          if (input === "right") pad.axes[0] = 0.9;
          else pad.buttons[input].pressed = true;
          const tick = () =>
            new Promise((resolve) => requestAnimationFrame(resolve));
          await tick();
          await tick();
          pad.axes[0] = 0;
          for (const key of pad.buttons) key.pressed = false;
          await tick();
          await tick();
        }, input);
      }
      await gamepad("right");
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "leave",
      );
      await gamepad(0);
      assert.equal(await page.locator("dialog").isVisible(), true);
      await gamepad(1);
      assert.equal(await page.locator("dialog").isVisible(), false);
      await gamepad(1);
      let closed = 0;
      await page.route("**/display/close", (route) => {
        assert.equal(route.request().method(), "POST");
        closed++;
        return route.fulfill({ status: 204 });
      });
      await page.locator("#confirm-leave").click();
      await page.waitForFunction(
        () => !document.querySelector("#confirm-leave").disabled,
      );
      assert.equal(closed, 1);
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 375, height: 812 });
      [width, viewport] = await dimensions();
      assert.equal(width, viewport);
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
