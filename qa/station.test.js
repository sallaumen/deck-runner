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
      await page.locator("#request-plot polyline").first().waitFor();
      assert.equal(await page.locator("#activity-totals tr").count(), 4);
      assert.equal(await page.locator("#runtime-plot polyline").count(), 4);
      const firstColor = await page
        .locator("#request-plot polyline")
        .first()
        .getAttribute("stroke");
      assert.equal(
        firstColor,
        await page
          .locator("#runtime-plot polyline")
          .first()
          .getAttribute("stroke"),
      );
      const period = page.getByRole("combobox", {
        name: "Período dos gráficos",
      });
      await period.selectOption("24");
      await page.getByText("por 60 min", { exact: true }).waitFor();
      await page.route("**/api/activity?hours=6", (route) => route.abort());
      await period.selectOption("6");
      await page.getByText(/Atividade indisponível/).waitFor();
      assert.equal(await page.locator("#activity-totals tr").count(), 0);
      await page.unroute("**/api/activity?hours=6");
      await period.selectOption("24");
      await page.locator("#request-plot polyline").first().waitFor();
      const adjust = page.getByRole("button", { name: "Ajustar vagas" });
      const apply = page.getByRole("button", { name: "Aplicar", exact: true });
      await adjust.click();
      await page
        .getByRole("button", { name: "Aumentar vagas no Deck" })
        .click();
      assert.ok(await apply.isDisabled(), "preview is read-only");
      await page.getByRole("button", { name: "Voltar", exact: true }).click();

      let live = { ...sample, instance: "qa" };
      await page.route("**/api/status", (route) =>
        route.fulfill({ json: live }),
      );
      await page.evaluate(() => refresh());
      await adjust.click();
      for (let i = 0; i < 3; i++)
        await page.getByLabel("Aumentar vagas no Deck").click();
      for (let i = 0; i < 2; i++)
        await page.getByLabel("Aumentar vagas por projeto").click();
      let postCount = 0;
      await page.route("**/limits", (route) => {
        const body = new URLSearchParams(route.request().postData());
        assert.equal(route.request().method(), "POST");
        assert.equal(body.get("slots"), "8");
        assert.equal(body.get("project_slots"), "5");
        assert.equal(body.get("previous_slots"), "5");
        postCount++;
        live = { ...live, slots: 8, project_slots: 5 };
        return route.fulfill({ json: { slots: 8, project_slots: 5 } });
      });
      await apply.click();
      await page.locator("#usage").getByText("2 / 8").waitFor();
      assert.equal(postCount, 1);
      await page.reload();
      await page
        .locator("#policy")
        .getByText(/5 execuções/)
        .waitFor();
      await adjust.click();
      await page.getByLabel("Diminuir vagas por projeto").click();
      await page.unroute("**/limits");
      await page.route("**/limits", (route) =>
        route.fulfill({ status: 409, json: { slots: 7, project_slots: 3 } }),
      );
      await apply.click();
      await page.getByText(/Os limites mudaram/).waitFor();
      assert.equal(await page.locator("#draft-slots").innerText(), "7");
      await page.keyboard.press("Escape");
      await page.unroute("**/limits");
      await page.unroute("**/api/status");
      await page.evaluate(() => refresh());
      let [width, viewport, bottom] = await dimensions();
      assert.equal(width, viewport);
      assert.ok(
        bottom <= 800,
        "Active station should fit the Deck's native screen",
      );
      await page.getByRole("link", { name: "Abrir controles" }).click();
      await page.locator("#filter").selectOption("atlas");
      assert.equal(await page.locator("#running .job").count(), 1);
      await page
        .locator("#activity-totals th")
        .getByText("atlas", { exact: true })
        .waitFor();
      assert.equal(await page.locator("#activity-totals tr").count(), 1);
      assert.equal(await page.locator("#request-plot polyline").count(), 1);
      await page.getByText("Adicionar projeto", { exact: true }).click();
      await page.setViewportSize({ width: 375, height: 812 });
      [width, viewport] = await dimensions();
      assert.equal(width, viewport);
      await page.getByRole("link", { name: "Log", exact: true }).click();
      await page
        .locator("#station-dialog")
        .getByText(/resultado é fictício/)
        .waitFor();
      assert.equal(new URL(page.url()).pathname, "/");
      await page.getByRole("button", { name: "Voltar", exact: true }).click();
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
      assert.equal(await page.locator("#station-dialog").isVisible(), false);
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
      await page.locator("#edit-limits").focus();
      await gamepad(0);
      await page.locator("#limits-dialog[open]").waitFor();
      await gamepad(0);
      assert.equal(await page.locator("#draft-slots").innerText(), "6");
      await gamepad(1);
      assert.ok(!(await page.locator("#limits-dialog").isVisible()));
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "edit-limits",
      );
      await page.locator("#switch").focus();
      await gamepad("right");
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "leave",
      );
      await gamepad(0);
      assert.equal(await page.locator("#station-dialog").isVisible(), true);
      await gamepad(1);
      assert.equal(await page.locator("#station-dialog").isVisible(), false);
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
      await page.unroute("**/api/status");
      await page.goto(url.href + "&station=1");
      await page.setViewportSize({ width: 1280, height: 800 });
      const job = sample.jobs.find((j) => j.state === "running");
      const logPath = "/logs/" + job.id;
      let outputText = Array.from({ length: 150 }, (_, i) => "Linha " + i).join(
        "\n",
      );
      let readCount = 0,
        unavailable = false;
      await page.route("**" + logPath, (route) => {
        readCount++;
        return unavailable
          ? route.abort()
          : route.fulfill({ body: outputText, contentType: "text/plain" });
      });
      await page
        .locator("#running")
        .getByRole("link", { name: job.meta.label, exact: true })
        .click();
      const body = page.locator("#dialog-log");
      await body.getByText("Linha 149", { exact: false }).waitFor();
      assert.ok(await body.evaluate((e) => e.scrollTop > 0));
      await body.evaluate((e) => {
        e.focus();
        e.scrollTop = 80;
      });
      await page.getByRole("button", { name: "Ir ao fim" }).waitFor();
      const held = await body.textContent();
      const refresh = () => page.evaluate(() => refresh());
      unavailable = true;
      await refresh();
      await page.getByText(/Leitura interrompida/).waitFor();
      assert.equal(await body.textContent(), held);
      unavailable = false;
      outputText =
        "Somente as linhas recentes estão neste lote.\nFim do teste.";
      await page.route("**/api/status", (route) =>
        route.fulfill({
          json: {
            ...sample,
            jobs: sample.jobs.map((j) =>
              j.id === job.id
                ? { ...j, state: "passed", finished: Date.now() / 1000 }
                : j,
            ),
          },
        }),
      );
      await refresh();
      await page
        .locator("#dialog-context")
        .getByText(/Passou/)
        .waitFor();
      await page.waitForFunction(
        () => !document.getElementById("dialog-message").textContent,
      );
      assert.equal(await body.textContent(), held);
      assert.equal(await body.evaluate((e) => e.scrollTop), 80);
      await page.getByRole("button", { name: "Ir ao fim" }).click();
      await body.getByText(/Fim do teste/).waitFor();
      const readsAtFinish = readCount;
      await refresh();
      assert.equal(readCount, readsAtFinish);
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        (href) => document.activeElement.getAttribute("href") === href,
        logPath,
      );
      assert.equal(await page.locator("#station-dialog").isVisible(), false);
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
