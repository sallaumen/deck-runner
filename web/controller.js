(() => {
  const dialog = byId("station-dialog");
  const back = byId("dialog-back"),
    confirm = byId("confirm-leave");
  const note = byId("dialog-message"),
    log = byId("dialog-log");
  const context = byId("dialog-context"),
    end = byId("log-end");
  const station = new URLSearchParams(location.search).get("station") === "1";
  let reading = null;

  function atEnd() {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= 3;
  }
  function followOutput() {
    if (!reading || reading.output === undefined) return;
    if (log.hidden || log.textContent !== reading.output) {
      log.textContent = reading.output;
      log.hidden = false;
      log.scrollTop = log.scrollHeight;
    }
  }
  function updateEndButton() {
    if (atEnd()) followOutput();
    const hide = !dialog.open || log.hidden || atEnd();
    if (hide && document.activeElement === end)
      log.focus({ preventScroll: true });
    end.hidden = hide;
  }
  log.addEventListener("scroll", updateEndButton);
  end.onclick = () => {
    log.scrollTop = log.scrollHeight;
    log.focus({ preventScroll: true });
    updateEndButton();
  };
  back.onclick = () => dialog.close();

  async function readOutput() {
    const view = reading;
    if (
      document.hidden ||
      !dialog.open ||
      !view ||
      view.loading ||
      view.complete
    )
      return;
    view.loading = true;
    const job = data?.jobs.find((j) => j.id === view.id);
    const live = job?.state === "running" || job?.state === "queued";
    const state =
      { running: "Em execução", queued: "Na fila" }[job?.state] ||
      labels[job?.state] ||
      job?.state;
    if (live || !job) delete dialog.dataset.readOutcome;
    else {
      const ink =
        job.state === "passed"
          ? "good"
          : ["cancelled", "interrupted"].includes(job.state)
            ? "stopped"
            : "problem";
      dialog.dataset.readOutcome = ink;
      if (
        view.wasLive &&
        document.documentElement.dataset.effects !== "off" &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        const color = {
          good: "#aaf5d2",
          stopped: "#ffbd78",
          problem: "#ffac9b",
        }[ink];
        context.animate([{ color }, { color: "var(--muted)" }], {
          duration: 980,
        });
      }
    }
    view.wasLive = live;
    const title =
      job?.meta.label || (view.isLog ? "Log da tarefa" : "Detalhes da tarefa");
    if (byId("dialog-title").textContent !== title)
      byId("dialog-title").textContent = title;
    const details = [
      view.isLog ? "Log" : "Detalhes",
      job?.meta.project,
      job?.meta.owner,
      state,
      job?.meta.command?.join(" "),
    ]
      .filter(Boolean)
      .join(" · ");
    if (context.textContent !== details) context.textContent = details;
    context.hidden = false;
    try {
      const res = await fetch(view.href, {
        cache: "no-store",
        signal: AbortSignal.any([
          view.cancel.signal,
          AbortSignal.timeout(8000),
        ]),
      });
      if (!res.ok) throw Error();
      const content = await res.text();
      if (!dialog.open || reading !== view) return;
      view.output = content;
      if (log.hidden || atEnd()) followOutput();
      updateEndButton();
      note.textContent = "";
      view.complete = !view.isLog || !live;
    } catch {
      if (dialog.open && reading === view)
        note.textContent = "Leitura interrompida. Tentando novamente…";
    } finally {
      view.loading = false;
    }
  }
  document.addEventListener("station-refresh", readOutput);
  document.addEventListener("visibilitychange", readOutput);
  dialog.addEventListener("close", () => {
    if (dialog.open || !reading) return;
    const view = reading;
    reading = null;
    view.cancel.abort();
    const links = [...document.querySelectorAll("a[href]")];
    const target =
      links.find((el) => el.href === view.href && el.getClientRects().length) ||
      byId("switch");
    target.focus();
  });
  document.addEventListener("click", (event) => {
    const item = event.target.closest('a[href^="/logs/"], a[href^="/result/"]');
    if (
      !item ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const isLog = item.pathname.startsWith("/logs/");
    if (!isLog && !station) return;
    event.preventDefault();
    reading?.cancel.abort();
    reading = {
      id: item.pathname.split("/").pop(),
      href: item.href,
      isLog,
      cancel: new AbortController(),
    };
    dialog.classList.add("reader");
    const heading = byId("reader-heading");
    heading.tabIndex = 0;
    heading.setAttribute("data-scroll", "");
    heading.scrollTop = 0;
    log.textContent = "";
    log.hidden = confirm.hidden = end.hidden = true;
    note.textContent = "Carregando…";
    dialog.showModal();
    back.focus();
    readOutput();
  });

  // Only the dedicated Plasma window gets controls for the physical display.
  if (!station) return;
  document.body.classList.add("station");
  const link = byId("switch");
  const next = new URL(link.href);
  next.searchParams.set("station", "1");
  link.href = next;
  const leave = byId("leave");
  leave.hidden = false;
  byId("pad-help").hidden = false;
  for (const [index, section] of [
    ...document.querySelectorAll("main section, .overview"),
  ].entries()) {
    const heading = section.querySelector("h1,h2");
    if (!heading) continue;
    heading.id ||= "station-heading-" + index;
    section.tabIndex = 0;
    section.setAttribute("aria-labelledby", heading.id);
  }
  function askLeave() {
    reading?.cancel.abort();
    reading = null;
    dialog.classList.remove("reader");
    const heading = byId("reader-heading");
    heading.removeAttribute("tabindex");
    heading.removeAttribute("data-scroll");
    byId("dialog-title").textContent = "Voltar à área de trabalho?";
    note.textContent = "Os testes continuam rodando no Deck.";
    context.hidden = log.hidden = end.hidden = true;
    confirm.hidden = false;
    dialog.showModal();
    confirm.focus();
  }
  leave.onclick = askLeave;
  confirm.onclick = async () => {
    confirm.disabled = true;
    try {
      const res = await fetch("/display/close", {
        method: "POST",
        body: new URLSearchParams({
          token: document.querySelector("meta[name=action-token]").content,
        }),
      });
      if (!res.ok) throw Error();
    } catch {
      note.textContent =
        "O painel continua aberto. Tente de novo ou use Alt+F4.";
    } finally {
      confirm.disabled = false;
    }
  };
  function move(key) {
    const vertical = key === "ArrowUp" || key === "ArrowDown";
    const sign = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
    const active = document.activeElement;
    if (
      vertical &&
      active?.matches("[data-scroll]") &&
      active.scrollHeight > active.clientHeight
    ) {
      const before = active.scrollTop;
      active.scrollBy(0, sign * active.clientHeight * 0.6);
      if (before !== active.scrollTop) return;
    }
    const root = document.querySelector("dialog[open]") || document;
    const candidates = [
      ...root.querySelectorAll(
        'button:enabled, a[href], select:enabled, summary, [tabindex="0"]',
      ),
    ].filter((el) => el.getClientRects().length && !el.closest("[hidden]"));
    const rect = (el) => el.getBoundingClientRect();
    const origin = candidates.includes(active) ? rect(active) : null;
    let best = candidates[0],
      cost = Infinity;
    if (origin) {
      best = null;
      for (const item of candidates) {
        if (item === active) continue;
        const r = rect(item);
        const dx = (r.left + r.right - origin.left - origin.right) / 2;
        const dy = (r.top + r.bottom - origin.top - origin.bottom) / 2;
        const forward = sign * (vertical ? dy : dx);
        if (forward <= 2) continue;
        const perpendicular = Math.abs(vertical ? dx : dy);
        const score = forward + perpendicular * 3;
        if (score < cost) {
          best = item;
          cost = score;
        }
      }
    }
    if (best) {
      best.setAttribute("data-pad-focus", "");
      best.focus();
    } else if (vertical && root === document && !panelsFit.matches)
      window.scrollBy(0, (sign * innerHeight) / 2);
  }
  const backAction = () => {
    const open = document.querySelector("dialog[open]");
    if (open) {
      if (open.getAttribute("aria-busy") !== "true") open.close();
    } else askLeave();
  };
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (!e.repeat) backAction();
    } else if (
      e.key.startsWith("Arrow") &&
      !(
        e.target instanceof HTMLSelectElement &&
        e.key !== "ArrowRight" &&
        e.key !== "ArrowLeft"
      )
    ) {
      e.preventDefault();
      move(e.key);
    }
  });
  let frame = 0,
    held = "",
    repeatAt = 0;
  function poll(time) {
    frame = 0;
    if (document.hidden) return;
    const pads = [...navigator.getGamepads()].filter(
      (p) => p?.mapping === "standard",
    );
    if (!pads.length) {
      held = "";
      return;
    }
    let input = "";
    for (const p of pads) {
      const pressed = (i) => p.buttons[i]?.pressed;
      const [x, y] = p.axes;
      input = pressed(1)
        ? "back"
        : pressed(0)
          ? "accept"
          : pressed(12)
            ? "ArrowUp"
            : pressed(13)
              ? "ArrowDown"
              : pressed(14)
                ? "ArrowLeft"
                : pressed(15)
                  ? "ArrowRight"
                  : Math.max(Math.abs(x), Math.abs(y)) < 0.55
                    ? ""
                    : Math.abs(x) > Math.abs(y)
                      ? x > 0
                        ? "ArrowRight"
                        : "ArrowLeft"
                      : y > 0
                        ? "ArrowDown"
                        : "ArrowUp";
      if (input) break;
    }
    if (
      input &&
      document.hasFocus() &&
      (input !== held || (input.startsWith("Arrow") && time >= repeatAt))
    ) {
      if (input === "back") backAction();
      else if (input === "accept") {
        const active = document.activeElement;
        if (active instanceof HTMLSelectElement) {
          active.selectedIndex = (active.selectedIndex + 1) % active.length;
          active.dispatchEvent(new Event("change"));
        } else if (active.matches("button, a, summary")) active.click();
      } else move(input);
      repeatAt = time + (input === held ? 160 : 400);
    }
    held = input;
    frame = requestAnimationFrame(poll);
  }
  const start = () => {
    if (!frame && !document.hidden && navigator.getGamepads)
      frame = requestAnimationFrame(poll);
  };
  window.addEventListener("gamepadconnected", start);
  document.addEventListener("visibilitychange", start);
  start();
})();
