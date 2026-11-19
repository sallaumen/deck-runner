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
  document.addEventListener("station-change", event => {
    if (document.hidden || !event.detail) return;
    const { jobs, previous } = event.detail;
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
