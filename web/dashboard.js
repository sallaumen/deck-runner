const byId = (id) => document.getElementById(id);
const display = new URLSearchParams(location.search).has("screen");
if (display) {
  document.body.classList.add("display");
  byId("switch").href = "/";
  byId("switch").textContent = "Abrir controles";
  byId("historyTitle").textContent = "Último resultado por projeto";
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
  pending = false,
  historyLimit = 8;
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
  byId("running").classList.toggle("many", display && current.length >= 3);
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
  byId("projects").innerHTML = allNames
    .map((n) => {
      const count = active.filter((j) => j.meta.project === n).length;
      return (
        '<div class="project"><span>' +
        esc(n) +
        '</span><span class="legend"><small>' +
        count +
        "/" +
        data.project_slots +
        '</small><span class="meter" aria-hidden="true">' +
        bars(count, data.project_slots) +
        "</span></span></div>"
      );
    })
    .join("");
  const cancel = (j) =>
    '<button class="danger" data-cancel="' +
    esc(j.id) +
    '" ' +
    (j.cancel || data.instance === "preview" ? "disabled" : "") +
    ">" +
    (j.cancel ? "Cancelando…" : "Cancelar") +
    "</button>";
  const links = (j) =>
    '<div class="links hide-display"><a href="/logs/' +
    esc(j.id) +
    '">Log</a><a href="/result/' +
    esc(j.id) +
    '">Detalhes</a>' +
    cancel(j) +
    "</div>";
  const empty = (t) => '<p class="empty">' + t + "</p>";
  byId("running").innerHTML =
    current
      .map(
        (j) =>
          '<div class="job"><div class="jobhead"><strong><i class="signal"></i>' +
          esc(j.meta.label) +
          "</strong><time>" +
          duration(Date.now() / 1000 - j.started) +
          "</time></div><p>" +
          esc(j.meta.project) +
          " · " +
          esc(j.meta.owner) +
          " · " +
          Math.round(j.memory / 1048576) +
          " MiB</p><code>" +
          esc(j.meta.command.join(" ")) +
          '</code><span class="activity">' +
          esc(j.activity || "Preparando execução") +
          "</span>" +
          links(j) +
          "</div>",
      )
      .join("") ||
    empty(
      "Nenhum teste em execução" + (filter.value ? " neste projeto." : "."),
    );
  byId("waiting").innerHTML =
    (display ? waiting.slice(0, 3) : waiting)
      .map(
        (j) =>
          '<div class="queued"><strong>' +
          esc(j.meta.label) +
          "</strong><small>" +
          esc(j.meta.project) +
          " · " +
          esc(j.meta.owner) +
          "</small>" +
          links(j) +
          "</div>",
      )
      .join("") || empty("Fila vazia.");
  const projectsToShow = new Set(allNames);
  const results = display
    ? history.filter((job) => projectsToShow.delete(job.meta.project))
    : history.slice(0, historyLimit);
  byId("history").innerHTML =
    results
      .map(
        (j) =>
          '<div class="history-row"><b class="' +
          esc(j.state) +
          '">' +
          esc(labels[j.state] || j.state) +
          '</b><div><a href="/logs/' +
          esc(j.id) +
          '">' +
          esc(j.meta.label) +
          "</a><small>" +
          esc(j.meta.project) +
          " · " +
          esc(j.meta.owner) +
          '<span class="hide-display"> · <a href="/result/' +
          esc(j.id) +
          '">Detalhes</a></span></small></div><time>' +
          resultTime(j.finished) +
          "</time></div>",
      )
      .join("") || empty("Nenhum resultado registrado.");
  byId("more").hidden = display || history.length <= historyLimit;
  byId("updated").textContent =
    (data.instance === "preview"
      ? "Demonstração local · "
      : "Última leitura · ") + clock(Date.now() / 1000);
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
    const focus = document.activeElement;
    const previous = focus?.dataset.cancel
      ? '[data-cancel="' + CSS.escape(focus.dataset.cancel) + '"]'
      : focus?.matches("#history a, .links a")
        ? 'a[href="' + CSS.escape(focus.getAttribute("href")) + '"]'
        : null;
    render();
    if (previous && !focus.isConnected)
      document.querySelector(previous)?.focus({ preventScroll: true });
    byId("connection").textContent = data.alive
      ? "Conectado"
      : "Executor sem resposta";
    byId("connection").classList.toggle("online", data.alive);
  } catch {
    byId("connection").textContent = "Sem conexão";
    byId("pause").disabled = true;
    document.querySelectorAll("[data-cancel]").forEach((button) => {
      button.disabled = true;
    });
    byId("summary").textContent = "Reconectando…";
    document.body.dataset.state = "offline";
    byId("connection").classList.remove("online");
    byId("message").textContent =
      "Tentando reconectar ao Deck. Os dados exibidos são da última leitura.";
  } finally {
    pending = false;
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
byId("filter").onchange = render;
byId("more").onclick = () => {
  historyLimit += 20;
  render();
};
refresh();
setInterval(refresh, 4000);
