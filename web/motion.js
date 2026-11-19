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
    if (!reduced.matches) jobs.filter(j => j.state === "running").forEach(lightLaunch);
  });
})();
