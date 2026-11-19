// Disk scans run independently from the queue and return a bounded cleanup plan.
(() => {
  const dialog = byId("storage-dialog"),
    open = byId("open-storage");
  const clean = byId("clean-storage"),
    back = byId("storage-back");
  const note = byId("storage-feedback");
  const groups = [
    ["worktrees", "Cópias de teste", "#aaf5d2"],
    ["cache", "Cache", "#74caff"],
    ["repos", "Git", "#bca4ff"],
    ["jobs", "Arquivos de tarefas", "#ffc278"],
  ];
  const units = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
  const bytes = (n) =>
    n >= 1024 ** 3
      ? units.format(n / 1024 ** 3) + " GiB"
      : n >= 1024 ** 2
        ? units.format(n / 1024 ** 2) + " MiB"
        : n
          ? "< 1 MiB"
          : "0 B";
  let view,
    plan,
    timer,
    loading = false,
    sending = false,
    failed = false,
    message = "";
  function renderDisk() {
    const r = view?.report;
    byId("storage-used").textContent = r ? bytes(r.total) : "—";
    byId("storage-total").textContent = r ? bytes(r.total) : "—";
    byId("storage-time").textContent = r
      ? "Medido às " + clock(r.measured)
      : "";
    if (data)
      byId("disk-policy").textContent =
        bytes(data.disk_free) +
        " livres no Deck. Reserva de " +
        bytes(data.disk_reserve ?? 10 * 1024 ** 3) +
        ". Novos testes exigem " +
        bytes(data.disk_admit ?? 15 * 1024 ** 3) +
        " livres.";
    if (r && dialog.dataset.rendered !== r.plan) {
      let start = 0;
      byId("storage-bar").innerHTML = groups
        .map(([key, , ink]) => {
          const width = r.total ? (100 * r.groups[key]) / r.total : 0;
          const rect =
            '<rect x="' +
            start +
            '" width="' +
            width +
            '" height="4" fill="' +
            ink +
            '"/>';
          start += width;
          return rect;
        })
        .join("");
      byId("storage-groups").innerHTML = groups
        .map(
          ([key, label, ink]) =>
            '<span><svg width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="3" fill="' +
            ink +
            '"/></svg> ' +
            label +
            " <b>" +
            esc(bytes(r.groups[key])) +
            "</b></span>",
        )
        .join("");
      byId("storage-projects").innerHTML = r.projects
        .map(
          (p) =>
            "<tr><th>" +
            esc(p.name || "Sem projeto identificado") +
            "</th>" +
            [p.worktrees, p.cache, p.repos + p.jobs, p.total]
              .map((n) => "<td>" + esc(bytes(n)) + "</td>")
              .join("") +
            "</tr>",
        )
        .join("");
      dialog.dataset.rendered = r.plan;
    }
    if (plan && (plan !== r?.plan || view?.state !== "idle")) plan = null;
    byId("storage-eligible").textContent =
      view?.state === "cleaning"
        ? "Limpando cópias encerradas…"
        : view?.state === "error" || failed
          ? "Medição indisponível"
          : r
            ? bytes(r.reclaimable) + " recuperáveis"
            : "Medindo espaço…";
    const result = view?.outcome;
    const feedback =
      message ||
      (failed || view?.state === "error"
        ? "A medição será tentada novamente."
        : plan
          ? "Remover " +
            r.count +
            " cópias de testes encerrados? Os logs e resultados ficam disponíveis."
          : view?.state === "measuring"
            ? "Calculando o espaço ocupado pelas pastas de teste…"
            : view?.state === "cleaning"
              ? "Você pode fechar esta janela. Os testes continuam."
              : result
                ? result.removed +
                  " cópias removidas. " +
                  (result.skipped
                    ? result.skipped + " ignoradas."
                    : "Logs e resultados preservados.")
                : "A limpeza remove apenas cópias de testes encerrados. Logs, resultados e cache ficam disponíveis.");
    if (note.textContent !== feedback) note.textContent = feedback;
    clean.textContent = plan ? "Confirmar limpeza" : "Limpar cópias";
    clean.disabled =
      sending ||
      failed ||
      offline ||
      !data?.alive ||
      data.instance === "preview" ||
      view?.state !== "idle" ||
      !r?.count;
    back.textContent = plan ? "Cancelar" : "Voltar";
  }
  async function read() {
    if (loading || document.hidden) return;
    clearTimeout(timer);
    loading = true;
    try {
      const response = await fetch("/api/storage", {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw Error();
      view = await response.json();
      failed = false;
    } catch {
      failed = true;
      plan = null;
    } finally {
      loading = false;
      renderDisk();
      timer = setTimeout(
        read,
        failed || !view || view.state !== "idle"
          ? 2500
          : dialog.open
            ? 8000
            : 60000,
      );
    }
  }
  open.onclick = () => {
    plan = null;
    message = "";
    renderDisk();
    dialog.showModal();
    back.focus();
    read();
  };
  back.onclick = () => {
    if (plan) {
      plan = null;
      renderDisk();
    } else dialog.close();
  };
  clean.onclick = async () => {
    if (clean.disabled || !view?.report) return;
    if (!plan) {
      message = "";
      plan = view.report.plan;
      renderDisk();
      return;
    }
    const chosen = plan;
    plan = null;
    sending = true;
    renderDisk();
    try {
      const response = await fetch("/storage/clean", {
        method: "POST",
        body: new URLSearchParams({
          token: document.querySelector('meta[name="action-token"]').content,
          plan: chosen,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 409)
        message = "A medição mudou. Confira os valores antes de confirmar.";
      else if (!response.ok) throw Error();
      else {
        view.state = "cleaning";
        message = "";
      }
    } catch {
      message =
        "Não foi possível confirmar a limpeza. Confira o estado antes de tentar novamente.";
    } finally {
      sending = false;
      renderDisk();
      read();
    }
  };
  dialog.addEventListener("close", () => {
    plan = null;
    open.focus({ preventScroll: true });
  });
  document.addEventListener("station-refresh", renderDisk);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) read();
  });
  read();
})();
