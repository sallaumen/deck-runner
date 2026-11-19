// The station's task list is paginated. Charts use complete, time-bucketed history.
(() => {
  const period = byId("activity-period");
  const totals = byId("activity-totals");
  const status = byId("activity-status");
  const palette = [
    "#74caff",
    "#ffc278",
    "#bca4ff",
    "#71dbbc",
    "#ff95b6",
    "#d4dd75",
    "#7cdfe1",
    "#ffa08b",
  ];
  const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat("pt-BR", {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const tick = (value) =>
    value >= 10000 ? compact.format(value) : number.format(value);
  const time = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const hour = (seconds) => time.format(seconds * 1000);
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const color = (row) =>
    palette[row.color] ??
    `hsl(${Math.round(row.color * 137.508) % 360} 73% 73%)`;
  let sample, pending, timer;
  function marker(row, x, y) {
    const shapes = [
      '<circle r="3.5"/>',
      '<path d="M0 -4L4 0 0 4 -4 0Z"/>',
      '<rect x="-3" y="-3" width="6" height="6"/>',
      '<path d="M-3 -3L3 3M-3 3L3 -3" stroke="currentColor" stroke-width="2.5"/>',
      '<path d="M0 -4L4 3H-4Z"/>',
    ];
    return `<g transform="translate(${x} ${y})" color="${color(row)}" fill="currentColor">${shapes[row.color % shapes.length]}</g>`;
  }

  function elapsed(seconds) {
    if (!seconds) return "0 min";
    if (seconds < 1) return "< 1 s";
    if (seconds < 60) return Math.round(seconds) + " s";
    if (seconds < 3600)
      return number.format(Math.round(seconds / 6) / 10) + " min";
    const minutes = Math.round(seconds / 60);
    return (
      Math.floor(minutes / 60) +
      " h" +
      (minutes % 60 ? " " + (minutes % 60) + " min" : "")
    );
  }
  function scaleTop(peak, whole) {
    if (peak <= 0) return 1;
    const factor = 10 ** Math.floor(Math.log10(peak));
    const round = [1, 2, 3, 4, 5, 6, 8, 10].find((n) => n * factor >= peak);
    return whole
      ? Math.max(2, 2 * Math.ceil((round * factor) / 2))
      : round * factor;
  }
  function plot(target, rows, metric, title) {
    const requests = metric === "requests";
    const divisor = requests ? 1 : 60;
    const peak = rows.reduce((n, row) => Math.max(n, ...row[metric]), 0);
    if (!peak) {
      target.innerHTML =
        '<p class="activity-empty">' +
        (requests
          ? "Nenhum envio neste período."
          : "Nenhuma execução neste período.") +
        "</p>";
      return;
    }
    const sharedPeak = sample.projects.reduce(
      (n, row) => Math.max(n, ...row[metric]),
      peak,
    );
    const top = scaleTop(sharedPeak / divisor, requests);
    const count = rows[0][metric].length;
    const x = (i) => ((i + 0.5) * 480) / count;
    const y = (value) => 67 - (value / divisor / top) * 62;
    const traces = [];
    const peaks = [];
    const markers = [];
    for (const row of rows) {
      const values = row[metric];
      const max = Math.max(...values);
      if (!max) continue;
      const first = Math.max(0, values.findIndex((value) => value > 0) - 1);
      const last = Math.min(
        count,
        values.findLastIndex((value) => value > 0) + 2,
      );
      const points = values
        .slice(first, last)
        .map((value, i) => x(first + i).toFixed(1) + "," + y(value).toFixed(2))
        .join(" ");
      const i = values.indexOf(max);
      const ink = color(row);
      markers.push(marker(row, x(i), y(max)));
      traces.push(
        `<polyline points="${points}" fill="none" stroke="${ink}" stroke-width="2.25" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />`,
      );
      peaks.push(
        row.name +
          " às " +
          hour(sample.start + i * sample.bucket_seconds) +
          ", " +
          (requests ? max + " envios" : elapsed(max)),
      );
    }
    const hits = Array.from({ length: count }, (_, i) => {
      const start = sample.start + i * sample.bucket_seconds;
      const label = [
        hour(start) + "–" + hour(start + sample.bucket_seconds),
        ...rows.map(
          (r) =>
            r.name + " · " + (requests ? r.requests[i] : elapsed(r.seconds[i])),
        ),
      ].join("\n");
      return `<rect x="${(i * 480) / count}" y="0" width="${480 / count}" height="72" fill="transparent"><title>${esc(label)}</title></rect>`;
    });
    target.innerHTML = `<div class="activity-y" aria-hidden="true"><span title="${number.format(top)}">${tick(top)}</span><span title="${number.format(top / 2)}">${tick(top / 2)}</span><span>0</span></div>
      <svg role="img" aria-label="${esc(title)}" viewBox="0 0 480 72" preserveAspectRatio="none">
      <desc>${esc("Picos por projeto. " + peaks.join(". "))}</desc>
      <path class="activity-grid" d="M0 5H480 M0 36H480 M0 67H480" vector-effect="non-scaling-stroke" />
      ${traces.join("")}${markers.join("")}${hits.join("")}</svg>
      <div class="activity-x" aria-hidden="true"><span>${hour(sample.start)}</span><span>${hour((sample.start + sample.end) / 2)}</span><span>${hour(sample.end)}</span></div>`;
  }
  const shortDisplay = matchMedia(
    "(min-width: 720px) and (max-height: 600px) and (min-aspect-ratio: 6/5)",
  );
  shortDisplay.addEventListener("change", render);
  const legendPage = pager("legend-pages", render);
  function render() {
    if (!sample) return;
    const selected = byId("filter").value;
    const rows = sample.projects
      .filter((row) => !selected || row.name === selected)
      .map((row) => ({
        ...row,
        count: sum(row.requests),
        runtime: sum(row.seconds),
      }))
      .sort(
        (a, b) =>
          b.count - a.count ||
          b.runtime - a.runtime ||
          a.name.localeCompare(b.name),
      );
    totals.innerHTML =
      legendPage(rows, shortDisplay.matches ? 2 : 4, "activity-totals")
        .map(
          (row) => `<tr>
      <th scope="row" title="${esc(row.name)}"><svg viewBox="0 0 16 8" width="16" height="8" aria-hidden="true"><path d="M0 4H16" stroke="${color(row)}" stroke-width="2"/>${marker(row, 8, 4)}</svg>${esc(row.name)}</th>
      <td title="${number.format(row.count)}">${tick(row.count)}</td><td title="${esc(elapsed(row.runtime))}">${esc(elapsed(row.runtime))}</td></tr>`,
        )
        .join("") || '<tr><td colspan="3">Nenhum projeto cadastrado.</td></tr>';
    const interval = sample.bucket_seconds / 60;
    const units = document.querySelectorAll(".activity-unit");
    units[0].textContent = "por " + interval + " min";
    units[1].textContent = "min por " + interval + " min";
    plot(
      byId("request-plot"),
      rows,
      "requests",
      "Envios de testes por projeto",
    );
    plot(
      byId("runtime-plot"),
      rows,
      "seconds",
      "Minutos de execução por projeto",
    );
  }
  async function refresh() {
    clearTimeout(timer);
    pending?.abort();
    const request = (pending = new AbortController());
    try {
      const response = await fetch("/api/activity?hours=" + period.value, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
        cache: "no-store",
      });
      if (!response.ok) throw Error();
      const result = await response.json();
      if (request !== pending) return;
      sample = result;
      for (const row of result.projects)
        projectColors.set(row.name, color(row));
      render();
      status.hidden = true;
    } catch {
      if (request !== pending) return;
      status.textContent = sample
        ? "Sem conexão · dados de " + hour(sample.end)
        : "Atividade indisponível. Tentando novamente…";
      status.hidden = false;
    } finally {
      if (request === pending) {
        pending = null;
        timer = setTimeout(() => {
          if (!document.hidden) refresh();
        }, 60000);
      }
    }
  }
  period.onchange = () => {
    sample = null;
    byId("legend-pages").hidden = true;
    pages.delete("activity-totals");
    for (const id of ["activity-totals", "request-plot", "runtime-plot"])
      byId(id).replaceChildren();
    document
      .querySelectorAll(".activity-unit")
      .forEach((el) => (el.textContent = ""));
    status.textContent = "Carregando atividade…";
    status.hidden = false;
    refresh();
  };
  byId("filter").addEventListener("change", render);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  refresh();
})();
