// Station effects consume committed state transitions, never the metrics ticker.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const launched = new Map();
  function lightLaunch(job) {
    const row = Array.from(document.querySelectorAll("#running [data-job]")).find(el => el.dataset.job === job.id);
    if (!row) return;
    row.classList.add("launch-glow");
    clearTimeout(launched.get(row));
    launched.set(row, setTimeout(() => {row.classList.remove("launch-glow"); launched.delete(row);}, 1050));
  }
  const scenes = new Map();
  function dismiss(node) {
    clearTimeout(scenes.get(node));
    scenes.delete(node);
    node.hidden = true;
    node.getAnimations({subtree:true}).forEach(a=>a.cancel());
  }
  function showFor(node, ms) {
    dismiss(node);
    node.hidden = false;
    if (!reduced.matches) {
      node.animate([{opacity:0,transform:"translateX(-36px) scale(.96)",easing:"cubic-bezier(.1,.75,.15,1)"},
        {opacity:1,transform:"none",offset:.14},{opacity:1,transform:"none",offset:.88,easing:"cubic-bezier(.55,0,.9,.35)"},
        {opacity:0,transform:"translateX(12px)"}],{duration:ms,fill:"both"});
    }
    scenes.set(node,setTimeout(()=>dismiss(node),ms));
  }
  function showLaunch(job) {
    byId("fx-launch-name").textContent = job.meta.project;
    showFor(byId("fx-launch"),1900);
  }

  function showResult(job) {
    const node = byId("fx-result");
    node.dataset.state = job.state;
    byId("fx-project").textContent = job.meta.project;
    byId("fx-run-id").textContent = "#" + job.id.slice(-6);
    byId("fx-verdict").textContent = "Passou!";
    byId("fx-symbol").textContent = "✓";
    byId("fx-job-name").textContent = job.meta.label;
    showFor(node,3200);
  }

  document.addEventListener("station-change", event => {
    if (document.hidden || !event.detail) return;
    const { jobs, previous } = event.detail;
    const result = jobs.find(job=>job.state==="passed");
    if (result && display && !reduced.matches) showResult(result);
    const started = jobs.find(job=>job.state==="running");
    if (started && display && !reduced.matches) showLaunch(started);
    if (!reduced.matches && jobs.some(job => job.state === "queued")) {
      const tab = document.querySelector('[data-view="waiting"]');
      tab.getAnimations().filter(a=>a.id==="queue-arrival").forEach(a=>a.cancel());
      tab.animate([{color:"#ffc278",boxShadow:"inset 0 -3px #ffc278"},{color:"var(--text)",boxShadow:"inset 0 0 transparent"}],
        {id:"queue-arrival",duration:760,easing:"cubic-bezier(.22,1,.36,1)"});
    }
    if (!reduced.matches) {
      const delta = data.jobs.filter(j => j.state === "running").length - previous.jobs.filter(j => j.state === "running").length;
      if (delta) {
        const count = byId("used-count");
        count.getAnimations().forEach(a => a.cancel());
        const lift = delta > 0 ? -6 : 4;
        count.animate([{transform:"scale(1)"},{transform:"translateY("+lift+"px) rotate(-6deg) scale(1.32)",offset:.26},
          {transform:"translateY(1px) scale(.96)",offset:.66},{transform:"scale(1)"}],
          {duration:440,easing:"cubic-bezier(.2,.64,.26,1)"});
      }
    }
    if (!reduced.matches) jobs.filter(j => j.state === "running").forEach(lightLaunch);
  });
})();
