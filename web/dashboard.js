const byId = (id) => document.getElementById(id);
const display = new URLSearchParams(location.search).has("screen");
if (display) {
  document.body.classList.add("display");
  byId("switch").href = "/";
  byId("switch").textContent = "Abrir controles";
}
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = {
  passed: "Passou",
  failed: "Falhou",
  cancelled: "Cancelado",
  interrupted: "Interrompido",
  timeout: "Expirou",
  disk_limit: "Disco cheio",
  output_limit: "Limite de log",
};
const gib = (n) =>
  (n / 1073741824).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const clock = (s) =>
  new Date(s * 1000).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
const resultTime = (s) => {
  const date = new Date(s * 1000);
  return date.toDateString() === new Date().toDateString()
    ? clock(s)
    : date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) +
        " · " +
        clock(s);
};
function stopwatch(seconds) {
  const pair = (n) => String(n).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  return (
    (minutes >= 60 ? Math.floor(minutes / 60) + ":" : "") +
    pair(minutes % 60) +
    ":" +
    pair(seconds % 60)
  );
}
const bars = (used, total) =>
  Array.from(
    { length: total },
    (_, i) => '<i class="' + (i < used ? "used" : "") + '"></i>',
  ).join("");
let data,
  lastRead,
  pending = false,
  offline = false;
const projectColors = new Map();
let sampleTime = 0,
  sampleMark = 0,
  advancing = false,
  clockTimer;
function stationTime() {
  return sampleTime + (advancing ? (performance.now() - sampleMark) / 1000 : 0);
}
function syncStopwatches(incoming, previous) {
  const observed = Number.isFinite(incoming.observed_at)
    ? incoming.observed_at
    : Date.now() / 1000;
  const same = previous && previous.instance === incoming.instance;
  const estimate = stationTime();
  if (!incoming.alive && same) sampleTime = estimate;
  else
    sampleTime =
      same && advancing && Math.abs(estimate - observed) < 2
        ? Math.max(estimate, observed)
        : observed;
  sampleMark = performance.now();
  advancing = Boolean(incoming.alive);
}
function tickStopwatches() {
  clearTimeout(clockTimer);
  if (document.hidden) return;
  const now = stationTime();
  let next = Infinity;
  for (const node of document.querySelectorAll(
    "#running:not([hidden]) time[data-started], #station-dialog[open] time[data-started]",
  )) {
    const elapsed = Math.max(0, now - Number(node.dataset.started));
    const seconds = Math.floor(elapsed);
    const value = stopwatch(seconds);
    if (node.textContent !== value) {
      node.textContent = value;
      node.dateTime = "PT" + seconds + "S";
    }
    next = Math.min(next, (1 - (elapsed - seconds)) * 1000);
  }
  if (advancing && Number.isFinite(next))
    clockTimer = setTimeout(tickStopwatches, Math.max(16, Math.ceil(next)));
}

function updateHeadline(active, queued) {
  const busy = active.length > 0 && data.alive && !offline;
  const names = [...new Set(active.map((job) => job.meta.project))];
  const summary = byId("summary-name");
  const extra = byId("summary-more");
  const context = byId("run-context");
  byId("summary").querySelector(".runner-emblem").hidden = !busy;
  if (busy) {
    summary.textContent = names.slice(0, 2).join(" / ");
    summary.title = names.join(", ");
    extra.hidden = names.length <= 2;
    if (!extra.hidden) {
      extra.textContent = "+" + (names.length - 2);
      extra.setAttribute(
        "aria-label",
        "Outros projetos: " + names.slice(2).join(", "),
      );
      extra.title = names.slice(2).join(", ");
    }
    context.textContent =
      (active.length === 1
        ? "1 teste em execução"
        : active.length + " testes em execução") +
      (data.paused ? " · fila pausada" : "");
  } else {
    extra.hidden = true;
    summary.removeAttribute("title");
    summary.textContent = offline
      ? "Reconectando…"
      : !data.alive
        ? "Executor sem resposta"
        : data.paused
          ? "Fila pausada"
          : queued.length
            ? "Aguardando vaga"
            : "Pronto para testar";
  }
  context.hidden = !busy;
}
function activityLine(job) {
  if (job.cancel) return "Cancelamento solicitado";
  const line = (job.activity || "").trim();
  if (!line) return "Preparando execução";
  if (/^(?:Source|Snapshot|Tree): [0-9a-f]{40,64}$/.test(line))
    return "Cópia do projeto preparada";
  const compile = /^Compiling (\d+) files? \((\.[\w]+)\)$/.exec(line);
  if (compile)
    return (
      "Compilando " +
      compile[1] +
      (compile[1] === "1" ? " arquivo " : " arquivos ") +
      compile[2]
    );
  if (line.startsWith("Resolving Hex dependencies"))
    return "Resolvendo dependências do Mix";
  if (
    line.startsWith("Running ExUnit with seed:") ||
    (/^\.{2,}$/.test(line) && job.meta.command[0] === "mix")
  )
    return "Executando testes do ExUnit";
  return line;
}
function highlightOutput(previous) {
  if (
    !previous ||
    previous.instance !== data.instance ||
    !data.alive ||
    document.hidden ||
    document.documentElement.dataset.effects !== "arcade" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.querySelector("dialog[open]")
  )
    return;
  const earlier = new Map(
    previous.jobs
      .filter((j) => j.state === "running")
      .map((j) => [j.id, j.activity]),
  );
  const changed = new Set(
    data.jobs
      .filter(
        (j) =>
          j.state === "running" &&
          j.activity &&
          earlier.has(j.id) &&
          earlier.get(j.id) !== j.activity,
      )
      .map((j) => j.id),
  );
  for (const row of document.querySelectorAll("#running:not([hidden]) .job")) {
    if (!changed.has(row.dataset.job)) continue;
    const line = row.querySelector(".task-output");
    if (line.getClientRects().length)
      line.animate(
        [
          { color: "#fff0be", transform: "translateX(3px)" },
          { color: "#c9ded5", transform: "none" },
        ],
        { duration: 600, easing: "ease-out" },
      );
  }
}
function projectDot(name) {
  const ink = projectColors.get(name) || "none";
  return (
    '<svg class="project-dot" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="' +
    esc(ink) +
    '"/></svg>'
  );
}
function writeRows(id, html) {
  const box = byId(id);
  if (box.lastMarkup === html) return;
  const focus = document.activeElement;
  const restore =
    box.contains(focus) && (focus.getAttribute("href") || focus.dataset.cancel);
  box.innerHTML = html;
  box.lastMarkup = html;
  if (restore) {
    const next = [...box.querySelectorAll("a,button")].find(
      (el) => (el.getAttribute("href") || el.dataset.cancel) === restore,
    );
    (next || document.querySelector('[data-view="' + id + '"]'))?.focus({
      preventScroll: true,
    });
  }
}
const pages = new Map();
let workView = "running",
  archiveView = "history",
  workChosen = false;
const panelsFit = matchMedia("(min-width: 720px) and (min-aspect-ratio: 6/5)");

function showChange(view) {
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    byId(view).animate([{ opacity: 0.68 }, { opacity: 1 }], { duration: 130 });
  }
}
function pager(id, redraw) {
  const nav = byId(id);
  const label = nav.getAttribute("aria-label");
  nav.innerHTML =
    '<button type="button" aria-label="Página anterior · ' +
    label +
    '"><i class="chevron prev"></i></button><span aria-live="polite"></span><button type="button" aria-label="Próxima página · ' +
    label +
    '"><i class="chevron"></i></button>';
  const [prev, next] = nav.querySelectorAll("button");
  const counter = nav.querySelector("span");
  let key, last;
  function turn(delta) {
    const n = (pages.get(key) || 0) + delta;
    if (n < 0 || n > last) return;
    pages.set(key, n);
    redraw();
    showChange(key);
  }
  prev.onclick = () => turn(-1);
  next.onclick = () => turn(1);
  return (items, size, view) => {
    key = view;
    last = Math.max(0, Math.ceil(items.length / size) - 1);
    const page = Math.min(pages.get(key) || 0, last);
    pages.set(key, page);
    nav.hidden = !last;
    if (last) {
      const text = page + 1 + "/" + (last + 1);
      if (counter.textContent !== text) counter.textContent = text;
      prev.setAttribute("aria-disabled", page === 0);
      next.setAttribute("aria-disabled", page === last);
    }
    return items.slice(page * size, (page + 1) * size);
  };
}
const workPage = pager("work-pages", render);
const archivePage = pager("archive-pages", render);
function room(id) {
  if (!panelsFit.matches) return 4;
  const box = byId(id);
  return Math.max(
    1,
    Math.floor(
      box.clientHeight /
        parseFloat(getComputedStyle(box).getPropertyValue("--row-height")),
    ),
  );
}
function activate(view, manual = false) {
  if (view === "running" || view === "waiting") {
    workView = view;
    if (manual) workChosen = true;
  } else archiveView = view;
  for (const button of document.querySelectorAll("[data-view]")) {
    const name = button.dataset.view;
    const visible = name === workView || name === archiveView;
    button.setAttribute("aria-pressed", visible);
    byId(name).hidden = !visible;
  }
}
document.querySelectorAll("[data-view]").forEach((button) => {
  button.onclick = () => {
    const view = button.dataset.view;
    const changed = button.getAttribute("aria-pressed") !== "true";
    activate(view, true);
    if (data) render();
    if (changed) showChange(view);
  };
});
byId("enroll").onclick = () => byId("enroll-dialog").showModal();
function render() {
  const active = data.jobs
    .filter((j) => j.state === "running")
    .sort((a, b) => a.started - b.started);
  const queued = data.jobs
    .filter((j) => j.state === "queued")
    .sort((a, b) => a.created - b.created);
  const allNames = data.projects.map((p) => p.name);
  const filter = byId("filter");
  if (JSON.stringify(allNames) !== filter.dataset.names) {
    const old = filter.value;
    filter.innerHTML =
      '<option value="">Todos os projetos</option>' +
      allNames.map((n) => "<option>" + esc(n) + "</option>").join("");
    filter.value = allNames.includes(old) ? old : "";
    filter.dataset.names = JSON.stringify(allNames);
  }
  const select = (j) => !filter.value || j.meta.project === filter.value;
  const current = active.filter(select),
    waiting = queued.filter(select);
  const history = data.jobs
    .filter((j) => !["queued", "running"].includes(j.state) && select(j))
    .sort((a, b) => b.finished - a.finished);
  const recent = history
    .filter((j) => allNames.includes(j.meta.project))
    .slice(0, 12)
    .reverse();
  byId("trendSummary").textContent = recent.length
    ? recent.filter((j) => j.state === "passed").length +
      " de " +
      recent.length +
      " passaram"
    : "Sem resultados";
  writeRows(
    "trend",
    recent
      .map((j) => {
        const description = [
          j.meta.project,
          j.meta.label,
          labels[j.state] || j.state,
          resultTime(j.finished),
        ].join(" · ");
        return (
          '<span role="listitem" data-result-id="' +
          esc(j.id) +
          '" class="' +
          esc(j.state) +
          '" aria-label="' +
          esc(description) +
          '" title="' +
          esc(description) +
          '"></span>'
        );
      })
      .join(""),
  );
  if (!workChosen && !byId("work-space").contains(document.activeElement))
    activate(!current.length && waiting.length ? "waiting" : "running");
  byId("used-count").textContent = String(active.length);
  byId("slot-count").textContent = " / " + data.slots;
  byId("runningCount").textContent = current.length;
  document.body.dataset.state = data.paused
    ? "paused"
    : active.length
      ? "busy"
      : "idle";
  byId("slots").innerHTML = bars(active.length, data.slots);
  byId("ram").textContent = gib(data.available_memory) + " GiB";
  byId("disk").textContent = gib(data.disk_free) + " GiB";
  updateHeadline(active, queued);
  if (!offline && byId("message").textContent !== (data.reason || ""))
    byId("message").textContent = data.reason || "";
  byId("policy").textContent =
    "Até " + data.project_slots + " execuções por projeto";
  byId("pause").disabled = !data.alive || data.instance === "preview";
  byId("pause").textContent = data.paused ? "Retomar fila" : "Pausar fila";
  byId("projectCount").textContent = allNames.length;
  byId("waitingCount").textContent = waiting.length;
  const projectsToShow = new Set(allNames);
  const results = display
    ? history.filter((j) => projectsToShow.delete(j.meta.project))
    : history;
  const activeRows = workPage(
    workView === "running" ? current : waiting,
    room("work-space"),
    workView,
  );
  const sideRows = archivePage(
    archiveView === "history" ? results : allNames,
    room("archive-space"),
    archiveView,
  );
  const empty = (text) => '<p class="empty">' + text + "</p>";
  const cancel = (j) =>
    '<button class="danger" data-cancel="' +
    esc(j.id) +
    '" ' +
    (offline || j.cancel || data.instance === "preview" ? "disabled" : "") +
    ">" +
    (j.cancel ? "Cancelando…" : "Cancelar") +
    "</button>";
  const task = (j) => {
    const name = esc(j.meta.label),
      project = esc(j.meta.project),
      owner = esc(j.meta.owner);
    const running = j.state === "running";
    const title = display
      ? '<a class="job-title" href="/logs/' + esc(j.id) + '">' + name + "</a>"
      : name;
    const status = !running
      ? "<time>" + clock(j.created) + "</time>"
      : Number.isFinite(j.started)
        ? '<time class="stopwatch" role="timer" aria-live="off" aria-label="Tempo em execução" data-started="' +
          j.started +
          '">—</time>'
        : '<time class="stopwatch">—</time>';
    const links = display
      ? ""
      : '<div class="links"><a href="/logs/' +
        esc(j.id) +
        '">Log</a><a href="/result/' +
        esc(j.id) +
        '">Detalhes</a>' +
        cancel(j) +
        "</div>";
    const command = esc(j.meta.command.join(" "));
    const activity = esc(activityLine(j));
    const detail = running
      ? '<div class="task-detail"><span class="task-output" title="Última atividade: ' +
        esc(j.activity || activityLine(j)) +
        '"><b aria-hidden="true">›</b> ' +
        activity +
        '</span><code title="' +
        command +
        '">' +
        command +
        "</code></div>"
      : "";
    return (
      '<div class="task-row ' +
      (running ? "job" : "queued") +
      '" data-job="' +
      esc(j.id) +
      '"><div class="task-main"><strong title="' +
      name +
      '">' +
      title +
      '</strong><small title="' +
      project +
      " · " +
      owner +
      '">' +
      projectDot(j.meta.project) +
      "<b>" +
      project +
      "</b> · " +
      owner +
      '</small></div><div class="task-usage">' +
      status +
      (running
        ? "<small>" + Math.round(j.memory / 1048576) + " MiB</small>"
        : "") +
      "</div>" +
      links +
      detail +
      "</div>"
    );
  };
  writeRows(
    workView,
    activeRows.map(task).join("") ||
      empty(
        workView === "running"
          ? filter.value
            ? "Nenhum teste em execução neste projeto."
            : "Nenhum teste em execução."
          : "Fila vazia.",
      ),
  );
  if (archiveView === "projects") {
    writeRows(
      "projects",
      sideRows
        .map((n) => {
          const count = active.filter((j) => j.meta.project === n).length;
          return (
            '<div class="project"><strong title="' +
            esc(n) +
            '">' +
            projectDot(n) +
            esc(n) +
            '</strong><span class="legend"><small>' +
            count +
            "/" +
            data.project_slots +
            '</small><span class="meter" aria-hidden="true">' +
            bars(count, data.project_slots) +
            "</span></span></div>"
          );
        })
        .join("") || empty("Nenhum projeto cadastrado."),
    );
  } else {
    writeRows(
      "history",
      sideRows
        .map(
          (j) =>
            '<div class="history-row" data-job="' +
            esc(j.id) +
            '"><b class="' +
            esc(j.state) +
            '">' +
            esc(labels[j.state] || j.state) +
            '</b><div><a href="/logs/' +
            esc(j.id) +
            '" title="' +
            esc(j.meta.label) +
            '">' +
            esc(j.meta.label) +
            '</a><small title="' +
            esc(j.meta.owner) +
            '"><span>' +
            esc(j.meta.project) +
            " · " +
            esc(j.meta.owner) +
            "</span>" +
            (!display
              ? '<a href="/result/' + esc(j.id) + '">Detalhes</a>'
              : "") +
            "</small></div><time>" +
            resultTime(j.finished) +
            "</time></div>",
        )
        .join("") || empty("Nenhum resultado registrado."),
    );
  }
  if (offline) showOffline();
  tickStopwatches();
  byId("updated").textContent =
    (data.instance === "preview"
      ? "Demonstração local · "
      : "Última leitura · ") + clock(lastRead);
}
function showOffline() {
  byId("summary-name").textContent = "Reconectando…";
  document.body.dataset.state = "offline";
  byId("connection").textContent = "Sem conexão";
  byId("connection").classList.remove("online");
  byId("pause").disabled = true;
  byId("message").textContent =
    "Tentando reconectar ao Deck. Os dados exibidos são da última leitura.";
}
async function refresh() {
  if (pending) return;
  pending = true;
  try {
    const r = await fetch("/api/status", {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw Error();
    const previous = offline || resync ? null : data;
    const incoming = await r.json();
    syncStopwatches(incoming, previous);
    data = incoming;
    lastRead = Date.now() / 1000;
    offline = false;
    render();
    highlightOutput(previous);
    if (!previous || previous.instance !== data.instance)
      document.dispatchEvent(new Event("station-resync"));
    signalChanges(previous?.instance === data.instance ? previous : null);
    resync = document.hidden;
    byId("connection").textContent = data.alive
      ? "Conectado"
      : "Executor sem resposta";
    byId("connection").classList.toggle("online", data.alive);
  } catch {
    sampleTime = stationTime();
    advancing = false;
    offline = true;
    if (data) render();
    else showOffline();
  } finally {
    pending = false;
    document.dispatchEvent(new Event("station-refresh"));
    if (retryRefresh && !document.hidden) {
      retryRefresh = false;
      queueMicrotask(refresh);
    }
  }
}
async function action(path) {
  try {
    const r = await fetch(path, {
      method: "POST",
      body: new URLSearchParams({
        token: document.querySelector("meta[name=action-token]").content,
      }),
    });
    if (r.status === 403) {
      location.reload();
      return;
    }
    if (!r.ok) throw Error();
    await refresh();
  } catch {
    byId("message").textContent =
      "Não foi possível confirmar a ação. Confira a fila.";
  }
}
byId("pause").onclick = () => {
  if (data) action(data.paused ? "/resume" : "/pause");
};
document.addEventListener("click", (e) => {
  const id = e.target.dataset.cancel;
  if (id) action("/cancel/" + id);
});
byId("filter").onchange = () => {
  pages.clear();
  if (data) render();
};
let layoutFrame = 0;
const observer = new ResizeObserver(() => {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    if (data) render();
  });
});
for (const id of ["work-space", "archive-space"]) observer.observe(byId(id));
let events,
  resync = true,
  retryRefresh = false;
// Keep a bounded memory across successive 100-result windows. A result can
// reappear as the latest for a project without representing another finish.
const observedStates = new Map();
function signalChanges(previous) {
  if (!previous) observedStates.clear();
  const known = observedStates;
  const boundary = previous?.observed_at ?? lastRead - 30;
  const changed = previous
    ? data.jobs.filter(
        (j) =>
          known.get(j.id) !== j.state &&
          (known.has(j.id) ||
            j.state === "running" ||
            j.state === "queued" ||
            (j.finished || j.created) >= boundary),
      )
    : data.jobs;
  for (const job of data.jobs) {
    known.delete(job.id);
    known.set(job.id, job.state);
  }
  while (known.size > Math.max(512, data.jobs.length))
    known.delete(known.keys().next().value);
  if (!changed.length) {
    if (!previous) byId("live-note").textContent = "";
    return;
  }
  const latest = changed.reduce((a, b) =>
    (b.finished || b.started || b.created) >
    (a.finished || a.started || a.created)
      ? b
      : a,
  );
  const state =
    { queued: "Entrou na fila", running: "Começou" }[latest.state] ||
    labels[latest.state] ||
    latest.state;
  const note = byId("live-note");
  note.textContent =
    state +
    " · " +
    latest.meta.project +
    " · " +
    clock(latest.finished || latest.started || latest.created) +
    (previous && changed.length > 1 ? "  +" + (changed.length - 1) : "");
  note.title = latest.meta.label;
  note.dataset.state = latest.state;
  if (!previous) return;
  if (
    document.documentElement.dataset.effects !== "off" &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    const accent = ["failed", "disk_limit", "timeout", "output_limit"].includes(
      latest.state,
    )
      ? "#ffac9b"
      : latest.state === "queued"
        ? "#ffc278"
        : "#aaf5d2";
    note.animate(
      [
        { color: accent, opacity: 0.55 },
        { color: accent, opacity: 1, offset: 0.3 },
        { color: "var(--muted)", opacity: 1 },
      ],
      { duration: 1100 },
    );
    const ids = new Set(changed.map((j) => j.id));
    for (const row of document.querySelectorAll("[data-job]")) {
      if (ids.has(row.dataset.job) && row.getClientRects().length)
        row.animate(
          [
            { backgroundColor: "rgb(170 245 210 / 16%)" },
            { backgroundColor: "transparent" },
          ],
          { duration: 900 },
        );
    }
  }
  document.dispatchEvent(
    new CustomEvent("station-change", { detail: { jobs: changed, previous } }),
  );
}
function fromStream() {
  if (pending) retryRefresh = true;
  else refresh();
}
function connect() {
  if (document.hidden) {
    clearTimeout(clockTimer);
    events?.close();
    events = null;
    resync = true;
    return;
  }
  if (!events && window.EventSource) {
    events = new EventSource("/api/events");
    events.addEventListener("queue", fromStream);
  }
  fromStream();
}
document.addEventListener("visibilitychange", connect);
window.addEventListener("pagehide", () => {
  clearTimeout(clockTimer);
  resync = true;
  events?.close();
  events = null;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) connect();
});
connect();
// Metrics and log tails can change without a queue transition. Polling also covers older hosts.
setInterval(() => {
  if (
    !document.hidden &&
    (offline ||
      !lastRead ||
      events?.readyState !== 1 ||
      Date.now() / 1000 - lastRead >= 4)
  )
    fromStream();
}, 4000);
