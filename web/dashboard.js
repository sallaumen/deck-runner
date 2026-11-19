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
const duration = (s) =>
  s < 60 ? Math.floor(s) + " s" : Math.floor(s / 60) + " min";
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
  byId("trend").innerHTML = recent
    .map((j) => {
      const description = [
        j.meta.project,
        j.meta.label,
        labels[j.state] || j.state,
        resultTime(j.finished),
      ].join(" · ");
      return (
        '<span role="listitem" class="' +
        esc(j.state) +
        '" aria-label="' +
        esc(description) +
        '" title="' +
        esc(description) +
        '"></span>'
      );
    })
    .join("");
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
  byId("summary").textContent = data.paused
    ? "Fila pausada"
    : active.length
      ? active.length === 1
        ? "Teste em andamento"
        : "Testes em andamento"
      : queued.length
        ? "Aguardando vaga"
        : "Pronto para testar";
  if (!data.alive) byId("summary").textContent = "Executor sem resposta";
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
    const status = running
      ? duration(Date.now() / 1000 - j.started)
      : clock(j.created);
    const links = display
      ? ""
      : '<div class="links"><a href="/logs/' +
        esc(j.id) +
        '">Log</a><a href="/result/' +
        esc(j.id) +
        '">Detalhes</a>' +
        cancel(j) +
        "</div>";
    const detail = running
      ? '<div class="task-detail"><code title="' +
        esc(j.meta.command.join(" ")) +
        '">' +
        esc(j.meta.command.join(" ")) +
        '</code><span title="' +
        esc(j.activity) +
        '">' +
        esc(j.activity || "Preparando execução") +
        "</span></div>"
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
      '</small></div><div class="task-usage"><time>' +
      status +
      "</time>" +
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
  byId("updated").textContent =
    (data.instance === "preview"
      ? "Demonstração local · "
      : "Última leitura · ") + clock(lastRead);
}
function showOffline() {
  byId("summary").textContent = "Reconectando…";
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
    data = incoming;
    lastRead = Date.now() / 1000;
    offline = false;
    render();
    if (!previous || previous.instance !== data.instance) document.dispatchEvent(new Event("station-resync"));
    signalChanges(previous?.instance === data.instance ? previous : null);
    resync = document.hidden;
    byId("connection").textContent = data.alive
      ? "Conectado"
      : "Executor sem resposta";
    byId("connection").classList.toggle("online", data.alive);
  } catch {
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
function signalChanges(previous) {
  const known = new Map(previous?.jobs.map((j) => [j.id, j.state]));
  const changed = previous
    ? data.jobs.filter(
        (j) =>
          known.get(j.id) !== j.state &&
          (known.has(j.id) ||
            j.state === "running" ||
            j.state === "queued" ||
            (j.finished || j.created) >= lastRead - 30),
      )
    : data.jobs;
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
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
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
  document.dispatchEvent(new CustomEvent("station-change", {detail: { jobs: changed, previous }}));
}
function fromStream() {
  if (pending) retryRefresh = true;
  else refresh();
}
function connect() {
  if (document.hidden) {
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
