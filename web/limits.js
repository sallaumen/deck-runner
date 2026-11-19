(() => {
  const dialog = byId("limits-dialog");
  const open = byId("edit-limits");
  const save = byId("save-limits");
  const note = byId("limit-feedback");
  const back = byId("dismiss-limits");
  const steps = [...dialog.querySelectorAll("[data-step]")];
  let original,
    draft,
    saving = false;

  function update() {
    const connected = data?.alive && document.body.dataset.state !== "offline";
    open.disabled = !connected || !data.max_slots;
    if (!dialog.open) return;
    const preview = data.instance === "preview";
    byId("limit-ram").textContent = connected
      ? gib(data.available_memory) + " GiB livres agora."
      : "Sem conexão com o Deck.";
    for (const field of ["slots", "project_slots"])
      byId("draft-" + field).value = draft[field];
    for (const step of steps) {
      const { field } = step.dataset;
      const next = draft[field] + Number(step.dataset.step);
      const max = field === "slots" ? data.max_slots : draft.slots;
      step.setAttribute("aria-disabled", saving || next < 1 || next > max);
    }
    back.disabled = saving;
    save.disabled =
      saving ||
      !connected ||
      preview ||
      (original.slots === draft.slots &&
        original.project_slots === draft.project_slots);
    dialog.setAttribute("aria-busy", saving);
    save.textContent = saving ? "Aplicando…" : "Aplicar";
  }

  function reset(values) {
    original = { slots: values.slots, project_slots: values.project_slots };
    draft = { ...original };
  }
  open.onclick = () => {
    reset(data);
    note.textContent =
      data.instance === "preview" ? "Demonstração somente para leitura." : "";
    dialog.showModal();
    update();
    steps[1].focus();
  };
  for (const step of steps) {
    step.onclick = () => {
      if (step.getAttribute("aria-disabled") === "true") return;
      draft[step.dataset.field] += Number(step.dataset.step);
      if (draft.project_slots > draft.slots) {
        draft.project_slots = draft.slots;
        note.textContent = "O limite por projeto acompanhou o total.";
      }
      update();
    };
  }
  back.onclick = () => dialog.close();
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  save.onclick = async () => {
    if (save.disabled) return;
    saving = true;
    note.textContent = "";
    update();
    try {
      const response = await fetch("/limits", {
        method: "POST",
        signal: AbortSignal.timeout(8000),
        body: new URLSearchParams({
          ...draft,
          previous_slots: original.slots,
          previous_project_slots: original.project_slots,
          token: document.querySelector("meta[name=action-token]").content,
        }),
      });
      if (response.status === 409) {
        reset(await response.json());
        note.textContent =
          "Os limites mudaram em outra tela. Confira os valores atuais e ajuste de novo.";
      } else if (response.status === 403) {
        note.textContent = "Recarregue o painel para aplicar os limites.";
      } else {
        if (!response.ok) throw Error();
        const values = await response.json();
        Object.assign(data, values);
        render();
        dialog.close();
      }
    } catch {
      note.textContent =
        "Não foi possível confirmar os limites. Confira a conexão e tente de novo.";
    } finally {
      saving = false;
      update();
    }
  };
  document.addEventListener("station-refresh", update);
})();
