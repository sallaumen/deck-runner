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
  const ink = projectColors.get(name);
  return ink
    ? '<svg class="project-dot" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="' +
        esc(ink) +
        '"/></svg>'
    : "";
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
  byId("usage").textContent = active.length + " / " + data.slots;
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
  const workBox = byId("work-space");
  workBox.classList.toggle(
    "spacious",
    panelsFit.matches &&
      workView === "running" &&
      current.length > 0 &&
      current.length <= 3 &&
      workBox.clientHeight >= current.length * 98,
  );
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
            '<div class="history-row"><b class="' +
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
    data = await r.json();
    lastRead = Date.now() / 1000;
    offline = false;
    render();
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
refresh();
setInterval(refresh, 4000);
