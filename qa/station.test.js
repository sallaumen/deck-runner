import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { webkit } from "playwright";

test(
  "station, controls, resource limits and reconnection",
  { timeout: 90000 },
  async (t) => {
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
      await page.getByRole("heading", { name: "estudio / atlas" }).waitFor();
      assert.equal(await page.locator("#usage").innerText(), "2 / 5");
      assert.equal(await page.locator("#history .history-row").count(), 4);
      const sample = await (
        await context.request.get(url.origin + "/api/status")
      ).json();
      // Compare the same controls in one live document, after layout and observers settle.
      const boxes = (selectors) =>
        page.evaluate(async (selectors) => {
          await Promise.all(
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.effect?.getTiming().iterations !== Infinity,
              )
              .map((animation) => animation.finished.catch(() => {})),
          );
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return Object.fromEntries(
            selectors.map((selector) => {
              const r = document
                .querySelector(selector)
                .getBoundingClientRect();
              return [selector, [r.x, r.y, r.width, r.height]];
            }),
          );
        }, selectors);
      const dimensions = () =>
        page.evaluate(() => [
          document.documentElement.scrollWidth,
          innerWidth,
          document.querySelector("footer").getBoundingClientRect().bottom,
        ]);
      await page.locator("#request-plot polyline").first().waitFor();
      assert.equal(await page.locator("#activity-totals tr").count(), 4);
      assert.equal(await page.locator("#runtime-plot polyline").count(), 4);
      await page
        .getByRole("button", { name: "Ordenar por tempo de execução" })
        .click();
      assert.equal(
        await page.locator("[aria-sort] button").getAttribute("data-order"),
        "runtime",
      );
      await page.getByRole("button", { name: "Ordenar por envios" }).click();
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
      const diskButton = page.locator("#open-storage");
      await diskButton.click();
      await page.locator("#storage-projects tr").first().waitFor();
      const diskDialog = page.locator("#storage-dialog");
      assert.match(
        await page.locator("#disk-headroom").innerText(),
        /de margem para novos testes/,
      );
      const diskParts = ["#storage-dialog", "#storage-back", "#clean-storage"];
      const diskBefore = await boxes(diskParts);
      const clean = diskDialog.getByRole("button", { name: "Limpar cópias" });
      await clean.click();
      const confirmDisk = diskDialog.getByRole("button", {
        name: "Confirmar limpeza",
      });
      await confirmDisk.waitFor();
      assert.deepEqual(await boxes(diskParts), diskBefore);
      await diskDialog.getByRole("button", { name: "Cancelar" }).click();
      await clean.waitFor();
      let cleaned = 0;
      await page.route("**/storage/clean", (route) => {
        const form = new URLSearchParams(route.request().postData());
        assert.equal(form.get("plan"), "preview");
        assert.ok(form.get("token"));
        cleaned++;
        return route.fulfill({ status: 409, json: { started: false } });
      });
      await clean.click();
      await confirmDisk.click();
      await diskDialog.getByText(/A medição mudou/).waitFor();
      assert.equal(cleaned, 1);
      await diskDialog.getByRole("button", { name: "Voltar" }).click();
      assert.ok(await diskButton.evaluate((b) => b === document.activeElement));
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
      const limitParts = [
        "#limits-dialog",
        "#save-limits",
        "#dismiss-limits",
        ".limit-row",
      ];
      const limitsBefore = await boxes(limitParts);
      await page.getByLabel("Diminuir vagas por projeto").click();
      await page.unroute("**/limits");
      await page.route("**/limits", (route) =>
        route.fulfill({ status: 409, json: { slots: 7, project_slots: 3 } }),
      );
      await apply.click();
      await page.getByText(/Os limites mudaram/).waitFor();
      assert.deepEqual(await boxes(limitParts), limitsBefore);
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
      assert.equal(new URL(page.url()).searchParams.get("project"), "atlas");
      await page.reload();
      await page.locator("#running .job").first().waitFor();
      assert.equal(await page.locator("#filter").inputValue(), "atlas");
      assert.equal(await page.locator("#running .job").count(), 1);
      await page
        .locator("#activity-totals th")
        .getByText("atlas", { exact: true })
        .waitFor();
      assert.equal(await page.locator("#activity-totals tr").count(), 1);
      assert.equal(await page.locator("#request-plot polyline").count(), 1);
      await page
        .getByRole("button", { name: "Adicionar projeto", exact: true })
        .click();
      await page
        .locator("#enroll-dialog")
        .getByRole("button", { name: "Voltar" })
        .click();
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
      let outputText = "Preparando tarefa";
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
      await body.getByText("Preparando tarefa").waitFor();
      const readerParts = [
        "#station-dialog",
        "#reader-heading",
        "#dialog-log",
        "#dialog-back",
      ];
      const readerBefore = await boxes(readerParts);
      outputText = Array.from({ length: 150 }, (_, i) => "Linha " + i).join(
        "\n",
      );
      await page.evaluate(() => refresh());
      await body.getByText("Linha 149", { exact: false }).waitFor();
      assert.deepEqual(await boxes(readerParts), readerBefore);
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
      assert.deepEqual(await boxes(readerParts), readerBefore);
      assert.equal(await body.textContent(), held);
      unavailable = false;
      outputText =
        "Somente as linhas recentes estão neste lote.\n22 tests, 0 failures\nFim do teste.";
      await page.route("**/api/status", (route) =>
        route.fulfill({
          json: {
            ...sample,
            jobs: sample.jobs.map((j) =>
              j.id === job.id
                ? {
                    ...j,
                    state: "passed",
                    finished: Date.now() / 1000,
                    peak: 192 * 1048576,
                    exit_code: 0,
                    meta: {
                      ...j.meta,
                      label: "Título extenso ".repeat(40),
                      command: [
                        "mix",
                        "test",
                        "arquivo_muito_longo/".repeat(90),
                      ],
                    },
                  }
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
      assert.equal(
        await page.locator("#suite-summary").innerText(),
        "ExUnit · 22 testes, 0 falhas",
      );
      assert.equal(await body.evaluate((e) => e.scrollTop), 80);
      await page.getByRole("button", { name: "Ir ao fim" }).click();
      await body.getByText(/Fim do teste/).waitFor();
      assert.deepEqual(await boxes(readerParts), readerBefore);
      await page.locator("#reader-heading").focus();
      await page.keyboard.press("ArrowDown");
      assert.ok(
        await page
          .locator("#reader-heading")
          .evaluate(
            (el) => el.scrollTop > 0 && el.scrollHeight > el.clientHeight,
          ),
      );
      assert.equal(
        await page.locator("#reader-resources").innerText(),
        "Pico de RAM 192 MiB · Código de saída 0",
      );
      const readsAtFinish = readCount;
      await refresh();
      assert.equal(readCount, readsAtFinish);
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        (href) => document.activeElement.getAttribute("href") === href,
        logPath,
      );
      assert.equal(await page.locator("#station-dialog").isVisible(), false);
      // Exercise each list at higher concurrency and after a Deck display resize.
      const repeat = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
      const names = repeat(35, (i) => "projeto-" + i + "-" + "x".repeat(35));
      const manyJobs = (n, state, base) =>
        repeat(n, (i) => ({
          ...job,
          id: (base + i).toString(16).padStart(12, "0"),
          state,
          finished: state === "passed" ? Date.now() / 1000 - i : null,
          meta: {
            ...job.meta,
            project: names[i % names.length],
            label: state + " tarefa " + i + " " + "texto longo ".repeat(8),
            owner: "Codex · " + "agente ".repeat(12),
          },
        }));
      const completed = manyJobs(35, "passed", 900);
      completed[0].state = "interrupted";
      completed[1].state = "output_limit";
      const crowded = {
        ...sample,
        slots: 32,
        project_slots: 16,
        projects: names.map((name) => ({ name })),
        reason: "Aguardando memória para a próxima tarefa.",
        jobs: [
          ...manyJobs(32, "running", 300),
          ...manyJobs(76, "queued", 600),
          ...completed,
        ],
      };
      await page.unroute("**/api/status");
      let shown = crowded;
      await page.route("**/api/status", (route) =>
        shown ? route.fulfill({ json: shown }) : route.abort(),
      );
      const series = await (
        await context.request.get(url.origin + "/api/activity?hours=6")
      ).json();
      series.projects = names.map((name, i) => ({
        ...series.projects[0],
        name,
        color: i,
      }));
      await page.route("**/api/activity?hours=*", (route) =>
        route.fulfill({ json: series }),
      );
      for (const mode of ["?station=1&screen=1", "?station=1"]) {
        await page.goto(url.origin + "/" + mode);
        await page.locator("#usage").getByText("32 / 32").waitFor();
        for (const [w, h] of [
          [1280, 800],
          [1152, 720],
          [1024, 640],
          [800, 500],
        ]) {
          await page.setViewportSize({ width: w, height: h });
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          const geometry = await page.evaluate(() => {
            const sectionFits = (id) => {
              const box = document.getElementById(id);
              return [
                ...box.querySelectorAll(".task-row,.project,.history-row"),
              ]
                .filter((e) => e.offsetHeight)
                .every(
                  (e) =>
                    e.getBoundingClientRect().bottom <=
                    box.getBoundingClientRect().bottom + 1,
                );
            };
            window.scrollTo(0, 10000);
            return [
              document.documentElement.scrollHeight,
              document.documentElement.scrollWidth,
              scrollY,
              sectionFits("work-space"),
              sectionFits("archive-space"),
              document.querySelector("footer").getBoundingClientRect().bottom,
            ];
          });
          assert.deepEqual(
            geometry.slice(0, 5),
            [h, w, 0, true, true],
            mode + " at " + w + "x" + h + " " + geometry,
          );
          assert.ok(geometry[5] <= h + 1);
          const badges = page.locator("#history .history-row > b");
          assert.ok(
            await badges.evaluateAll((items) =>
              items.every((el) => {
                const text = document.createRange();
                text.selectNodeContents(el);
                return (
                  text.getClientRects().length === 1 &&
                  text.getBoundingClientRect().right <=
                    el.getBoundingClientRect().right + 1
                );
              }),
            ),
            "Result labels must fit on one line at " + w,
          );
          const chartEdges = await boxes([
            ".activity-x",
            ".activity-notice",
            "#activity-totals",
            "#legend-pages",
          ]);
          const bottomOf = (rect) => rect[1] + rect[3];
          assert.ok(
            bottomOf(chartEdges[".activity-x"]) <=
              chartEdges[".activity-notice"][1] + 1,
            "Chart status overlaps the time axis at " + w,
          );
          assert.ok(
            bottomOf(chartEdges["#activity-totals"]) <=
              chartEdges["#legend-pages"][1] + 1,
            "Legend pager overlaps a project at " + w,
          );
          const shell = [
            "header",
            ".overview",
            "#summary",
            ".notice-slot",
            "#edit-limits",
            "#usage",
            ".layout",
            ".work",
            ".archive",
            ".trend",
            "#work-space",
            "#archive-space",
            ".project-activity",
            "#request-plot",
            "#runtime-plot",
            "footer",
            '[data-view="waiting"]',
          ];
          const baseline = await boxes(shell);
          const jobRect = await boxes(["#running .job"]);
          shown = { ...sample, jobs: [job] };
          await refresh();
          await page.locator("#usage").getByText("1 / 5").waitFor();
          assert.deepEqual(
            await boxes(shell),
            baseline,
            "One job changed the dashboard at " + w + "x" + h,
          );
          assert.deepEqual(
            await boxes(["#running .job"]),
            jobRect,
            "Row resized when the queue shrank",
          );
          shown = {
            ...sample,
            jobs: [],
            projects: [],
            paused: true,
            reason: "Aguardando espaço e memória. ".repeat(35),
          };
          await refresh();
          await page.locator("#running .empty").waitFor();
          assert.deepEqual(
            await boxes(shell),
            baseline,
            "Empty station moved controls",
          );
          assert.ok(
            await page
              .locator("#message")
              .evaluate((el) => el.scrollHeight > el.clientHeight),
          );
          shown = null;
          await refresh();
          await page.getByRole("heading", { name: "Reconectando…" }).waitFor();
          assert.deepEqual(
            await boxes(shell),
            baseline,
            "Offline state moved controls",
          );
          shown = crowded;
          await refresh();
          await page.locator("#usage").getByText("32 / 32").waitFor();
        }
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      for (const [view, id, kind, count] of [
        ["waiting", "work-pages", ".queued", 76],
        ["running", "work-pages", ".job", 32],
        ["projects", "archive-pages", ".project", 35],
        ["history", "archive-pages", ".history-row", 35],
      ]) {
        await page.locator('[data-view="' + view + '"]').click();
        const next = page.locator("#" + id + " button").last(),
          seen = new Set();
        for (let p = 0; p < count; p++) {
          for (const t of await page
            .locator("#" + view + " " + kind)
            .allTextContents())
            seen.add(t);
          if ((await next.getAttribute("aria-disabled")) === "true") break;
          await next.click();
        }
        assert.equal(seen.size, count, view + " exposes all pages");
      }
      const legendNext = page.locator("#legend-pages button").last();
      const firstLegend = await page.locator("#activity-totals").innerText();
      await legendNext.click();
      assert.notEqual(
        await page.locator("#activity-totals").innerText(),
        firstLegend,
      );
      const chartParts = [
        ".work",
        ".archive",
        ".project-activity",
        ".activity-key",
        "#requests-title",
        "#request-plot",
        "#runtime-plot",
        "#activity-period",
        ".activity-notice",
        "footer",
      ];
      const chartBefore = await boxes(chartParts);
      const plots = ["#request-plot > svg", "#runtime-plot > svg"];
      const plotBefore = await boxes(plots);
      await page.unroute("**/api/activity?hours=*");
      let activityReply = { ...series, projects: [] };
      await page.route("**/api/activity?hours=*", (route) =>
        activityReply
          ? route.fulfill({ json: activityReply })
          : route.fulfill({ status: 503, body: "Unavailable" }),
      );
      await period.selectOption("24");
      await page.locator("#request-plot .activity-empty").waitFor();
      assert.deepEqual(
        await boxes(chartParts),
        chartBefore,
        "Empty charts resized the panel",
      );
      activityReply = null;
      await period.selectOption("6");
      await page.getByText(/Atividade indisponível/).waitFor();
      assert.deepEqual(
        await boxes(chartParts),
        chartBefore,
        "Chart error moved the panel",
      );
      activityReply = {
        ...series,
        projects: series.projects.map((row) => ({
          ...row,
          requests: row.requests.map((value) => value * 100000),
          seconds: row.seconds.map((value) => value * 100000),
        })),
      };
      await period.selectOption("24");
      const topTick = page.locator("#request-plot .activity-y span").first();
      await topTick.waitFor();
      assert.notEqual(
        await topTick.textContent(),
        await topTick.getAttribute("title"),
      );
      assert.deepEqual(
        await boxes(chartParts),
        chartBefore,
        "Large totals resized the panel",
      );
      assert.deepEqual(
        await boxes(plots),
        plotBefore,
        "Axis labels shifted the drawing area",
      );
      await page.addInitScript(() => {
        window.EventSource = class extends EventTarget {
          readyState = 1;
          constructor() {
            super();
            window.queueStream = this;
          }
          close() {
            this.readyState = 2;
          }
        };
      });
      shown = { ...sample, jobs: [] };
      await page.goto(url.origin + "/?screen=1&station=1");
      await page.locator("#usage").getByText("0 / 5").waitFor();
      const pushedJob = {
        ...job,
        created: Date.now() / 1000,
        started: null,
        finished: null,
        state: "queued",
      };
      const pushQueue = () =>
        page.evaluate(() =>
          window.queueStream.dispatchEvent(new Event("queue")),
        );
      shown.jobs = [pushedJob];
      await pushQueue();
      await page
        .locator("#live-note")
        .getByText(/Entrou na fila/)
        .waitFor({ timeout: 1800 });
      assert.equal(await page.locator("#waiting .queued").count(), 1);
      await page.emulateMedia({ reducedMotion: "reduce" });
      shown.jobs = [
        { ...pushedJob, started: Date.now() / 1000, state: "running" },
      ];
      await pushQueue();
      await page
        .locator("#live-note")
        .getByText(/Começou/)
        .waitFor({ timeout: 1800 });
      assert.equal(
        await page
          .locator("#running .job")
          .evaluate((el) => el.getAnimations().length),
        0,
      );
      const noteBefore = await page.locator("#live-note").textContent();
      await page.evaluate(() => refresh());
      assert.equal(await page.locator("#live-note").textContent(), noteBefore);
      await t.test(
        "stopwatches tick between reads, freeze offline and settle on the recorded finish",
        async () => {
          await page.goto("about:blank");
          await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
          await page.clock.pauseAt(new Date("2030-01-01T00:00:05Z"));
          const stamp = 1_700_000_000;
          const jobs = sample.jobs
            .filter((j) => j.state === "running")
            .map((j, i) => ({
              ...j,
              started: stamp - (i ? 3599 : 59),
              finished: null,
              activity: "Compiling 15 files (.ex)",
            }));
          // Sample inside the second, away from WebKit's timer rounding boundary.
          shown = { ...sample, observed_at: stamp + 0.25, jobs };
          let connected = true,
            reads = 0;
          await page.unroute("**/api/status");
          await page.route("**/api/status", (route) => {
            reads++;
            return connected
              ? route.fulfill({ json: shown })
              : route.fulfill({ status: 503 });
          });
          await page.goto(url.origin + "/?screen=1&station=1");
          const row = page.locator('#running [data-job="' + jobs[0].id + '"]');
          const first = row.locator("time");
          const second = page.locator(
            '#running [data-job="' + jobs[1].id + '"] time',
          );
          await first.waitFor({ state: "attached" });
          assert.equal(await first.textContent(), "00:59");
          assert.equal(await second.textContent(), "59:59");
          assert.match(await row.innerText(), /Compilando 15 arquivos .ex/);
          await row.locator("a").focus();
          const identity = await first.elementHandle();
          const before = reads;
          await page.clock.runFor(1000);
          assert.equal(await first.textContent(), "01:00");
          assert.equal(await second.textContent(), "1:00:00");
          await page.clock.runFor(1000);
          assert.equal(await first.textContent(), "01:01");
          assert.equal(await second.textContent(), "1:00:01");
          assert.equal(reads, before);
          assert.ok(
            await first.evaluate(
              (el, ref) =>
                el === ref &&
                el.closest(".job").contains(document.activeElement),
              identity,
            ),
          );
          await row.locator("a").evaluate((el) => el.click());
          const reader = page.locator("#reader-clock");
          assert.equal(await reader.textContent(), "01:01");
          connected = false;
          await refresh();
          await page.clock.runFor(1000);
          assert.equal(await reader.textContent(), "01:01");
          assert.equal(await first.textContent(), "01:01");
          connected = true;
          shown.observed_at = stamp + 7;
          await refresh();
          assert.equal(await reader.textContent(), "01:06");
          shown.jobs = jobs.map((j, i) =>
            i ? j : { ...j, state: "passed", finished: stamp + 7 },
          );
          await refresh();
          assert.equal(await first.count(), 0);
          assert.equal(await reader.getAttribute("datetime"), "PT66S");
          await page.clock.runFor(1100);
          assert.equal(await reader.textContent(), "01:06");
          assert.ok((await reader.getAttribute("data-started")) === null);
        },
      );
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
