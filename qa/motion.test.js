import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { webkit } from "playwright";

test(
  "arcade scenes follow committed jobs and release the screen",
  { timeout: 55000 },
  async () => {
    const service = spawn(
      "python3",
      [
        "-u",
        fileURLToPath(new URL("../scripts/preview.py", import.meta.url)),
        "--port",
        "0",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const output = createInterface({ input: service.stdout });
    let browser, context;
    try {
      const [banner] = await once(output, "line", {
        signal: AbortSignal.timeout(8000),
      });
      const origin = new URL(banner.match(/http:\/\/\S+/)[0]).origin;
      browser = await webkit.launch();
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.flights = 0;
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (frames, options) {
          if (options?.id === "bay-flight") window.flights++;
          return animate.call(this, frames, options);
        };
        window.mediaStarts = 0;
        HTMLMediaElement.prototype.play = () => {
          window.mediaStarts++;
          return Promise.resolve();
        };
        if (window.AudioContext)
          window.AudioContext = class extends AudioContext {
            constructor(...args) {
              super(...args);
              window.mediaStarts++;
            }
          };
      });
      const status = await (
        await context.request.get(origin + "/api/status")
      ).json();
      const seed = status.jobs.find((job) => job.state === "running");
      const t = Math.floor(Date.now() / 1000);
      function job(id, state, offset = 0) {
        return {
          ...seed,
          id: id.toString(16).padStart(12, "0"),
          state,
          created: t + offset - 15,
          started: state === "queued" ? null : t + offset - 12,
          finished: ["queued", "running"].includes(state) ? null : t + offset,
          meta: {
            ...seed.meta,
            project: "estudio",
            label: "Verificar sincronização da biblioteca",
          },
        };
      }
      let jobs = [job(1, "passed", -3)];
      await page.route("**/api/status", (route) =>
        route.fulfill({ json: { ...status, observed_at: t, jobs } }),
      );
      await page.goto(origin + "/?screen=1&station=1");
      await page.locator("#connection.online").waitFor();
      const result = page.locator("#fx-result"),
        launch = page.locator("#fx-launch");
      const update = async (next) => {
        jobs = next;
        await page.evaluate(() => refresh());
        await page.waitForFunction(
          (expected) => JSON.stringify(data.jobs) === expected,
          JSON.stringify(next),
        );
      };
      const opened = page.locator("#fx-dialog");
      const settings = page.locator("#fx-settings");
      const mode = page.locator("#fx-mode");
      const geometry = () =>
        page.evaluate(() =>
          [".work", ".archive", ".project-activity"].map((s) => {
            const r = document.querySelector(s).getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }),
        );
      const before = await geometry();
      assert.ok(await result.isHidden());
      await page.locator("#switch").focus();
      await update([jobs[0], job(2, "queued")]);
      await update([jobs[0], job(2, "running")]);
      await launch.waitFor();
      assert.equal(
        await launch.locator("#fx-launch-name").innerText(),
        "estudio",
      );
      assert.equal(await page.locator("#used-count").innerText(), "1");
      assert.equal(
        await page.locator("#fx-launch-task").innerText(),
        jobs[1].meta.label,
      );
      const pilot = page.locator(".bay-runner .fx-pilot");
      const stride = () =>
        pilot.evaluate((el) => getComputedStyle(el).animationName);
      assert.equal(await stride(), "working-stride");
      assert.equal(await page.evaluate(() => window.flights), 1);
      assert.equal(
        await page.locator("#bay-job").getAttribute("href"),
        "/logs/" + jobs[1].id,
      );
      await update([
        jobs[0],
        { ...jobs[1], activity: "Compiling 7 files (.ex)" },
      ]);
      const latest = page.locator("#running .task-output");
      assert.ok(await latest.evaluate((el) => el.getAnimations().length > 0));
      assert.equal(await page.evaluate(() => window.flights), 1);
      await update([job(1, "passed", -3), job(2, "passed")]);
      assert.equal(await stride(), "none");
      assert.equal(await page.evaluate(() => window.flights), 2);
      await result.waitFor();
      assert.equal(await page.locator("#fx-verdict").innerText(), "Passou!");
      assert.equal(await page.locator("#fx-score").innerText(), "2");
      assert.equal(await page.locator("#fx-elapsed").innerText(), "12s");
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "switch",
      );
      assert.deepEqual(await geometry(), before);
      assert.equal(
        await result.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        }),
        false,
      );
      await update([...jobs, job(3, "failed", 1)]);
      assert.equal(await page.locator("#fx-verdict").innerText(), "Falhou");
      assert.ok(
        await page
          .locator("#fx-batch")
          .innerText()
          .then((s) => s.includes("Passou") && s.includes("Falhou")),
      );
      assert.ok(await page.locator("#fx-combo").isHidden());
      await update([...jobs, job(4, "passed", 2)]);
      assert.equal(await page.locator("#fx-verdict").innerText(), "Falhou");
      await result.waitFor({ state: "hidden", timeout: 4600 });
      await update(jobs);
      assert.ok(await result.isHidden());
      await settings.click();
      await page.locator("#fx-recent summary").click();
      assert.ok((await page.locator("#fx-recent-list li").count()) >= 4);
      await update([...jobs, job(5, "passed", 3)]);
      assert.ok(await result.isHidden());
      await mode.selectOption("off");
      await page.locator("#fx-back").click();
      await page.reload();
      await page.locator("#connection.online").waitFor();
      await settings.click();
      assert.equal(await mode.inputValue(), "off");
      await mode.selectOption("arcade");
      const current = JSON.stringify(jobs);
      await page.locator('[data-demo="passed"]').click();
      await result.waitFor();
      assert.equal(
        await page.locator("#fx-project").innerText(),
        "Demonstração",
      );
      assert.equal(
        await page.evaluate(() => JSON.stringify(data.jobs)),
        current,
      );
      assert.ok(await opened.isHidden());
      await update([...jobs, job(9, "failed", 8)]);
      assert.equal(await page.locator("#fx-verdict").innerText(), "Falhou");
      assert.equal(await page.locator("#fx-project").innerText(), "estudio");
      assert.ok(await page.locator("#fx-batch").isHidden());
      await page.emulateMedia({ reducedMotion: "reduce" });
      await result.waitFor({ state: "hidden" });
      for (const [width, height, state, title] of [
        [1280, 800, "timeout", "Tempo esgotado"],
        [800, 500, "disk_limit", "Limite de disco"],
        [375, 812, "output_limit", "Limite de log"],
      ]) {
        await page.setViewportSize({ width, height });
        await settings.click();
        await page.locator("#fx-back").click();
        await update([...jobs, job(jobs.length + 10, state, 10)]);
        await result.waitFor();
        assert.equal(await page.locator("#fx-verdict").innerText(), title);
        const bounds = await result.boundingBox();
        assert.ok(
          bounds.x >= 0 &&
            bounds.y >= 0 &&
            bounds.x + bounds.width <= width + 1 &&
            bounds.y + bounds.height <= height + 1,
        );
        assert.equal(
          await result.evaluate(
            (el) => el.getAnimations({ subtree: true }).length,
          ),
          0,
        );
      }
      const active = job(90, "running", 15);
      const beforeReduced = await page.evaluate(() => window.flights);
      await update([...jobs, active]);
      assert.equal(await stride(), "none");
      assert.equal(await page.evaluate(() => window.flights), beforeReduced);
      await update(
        jobs.map((j) =>
          j.id === active.id
            ? { ...j, activity: "Running ExUnit with seed: 7" }
            : j,
        ),
      );
      assert.equal(await latest.evaluate((el) => el.getAnimations().length), 0);
      await page.route("**/api/status", (route) =>
        route.fulfill({ status: 503, body: "Offline" }),
      );
      await page.evaluate(() => refresh());
      assert.ok(await result.isHidden());
      await page.unroute("**/api/status");
      await page.route("**/api/status", (route) =>
        route.fulfill({ json: { ...status, jobs } }),
      );
      await page.evaluate(() => refresh());
      assert.ok(await result.isHidden());
      assert.equal(await page.evaluate(() => window.mediaStarts), 0);
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
