// Only the dedicated Plasma window gets controls for the physical display.
if (new URLSearchParams(location.search).get("station") === "1") {
  document.body.classList.add("station");
  const link = byId("switch");
  const next = new URL(link.href);
  next.searchParams.set("station", "1");
  link.href = next;
  const leave = byId("leave"),
    dialog = byId("station-dialog");
  const back = byId("dialog-back"),
    confirm = byId("confirm-leave");
  const note = byId("dialog-message"),
    log = byId("dialog-log");
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
    byId("dialog-title").textContent = "Voltar à área de trabalho?";
    note.textContent = "Os testes continuam rodando no Deck.";
    log.hidden = true;
    confirm.hidden = false;
    dialog.showModal();
    confirm.focus();
  }
  leave.onclick = askLeave;
  back.onclick = () => dialog.close();
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
  let logRequest;
  dialog.addEventListener("close", () => {
    logRequest?.abort();
  });
  document.addEventListener("click", async (event) => {
    const item = event.target.closest('a[href^="/logs/"], a[href^="/result/"]');
    if (!item || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    byId("dialog-title").textContent = item.pathname.startsWith("/logs/")
      ? "Log da tarefa"
      : "Detalhes da tarefa";
    note.textContent = "Carregando…";
    log.textContent = "";
    log.hidden = confirm.hidden = true;
    dialog.showModal();
    back.focus();
    const request = (logRequest = new AbortController());
    try {
      const res = await fetch(item.href, { signal: request.signal });
      if (!res.ok) throw Error();
      const content = await res.text();
      if (request.signal.aborted) return;
      log.textContent = content;
      log.hidden = false;
      note.textContent = "";
    } catch {
      if (!request.signal.aborted)
        note.textContent = "Não foi possível carregar a tarefa.";
    }
  });

  function move(key) {
    const vertical = key === "ArrowUp" || key === "ArrowDown";
    const sign = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
    const active = document.activeElement;
    if (active === log && vertical && log.scrollHeight > log.clientHeight) {
      const before = log.scrollTop;
      log.scrollBy(0, sign * log.clientHeight * 0.6);
      if (before !== log.scrollTop) return;
    }
    const root = dialog.open ? dialog : document;
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
    } else if (vertical && !dialog.open)
      window.scrollBy(0, (sign * innerHeight) / 2);
  }
  const backAction = () => (dialog.open ? dialog.close() : askLeave());
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
}
