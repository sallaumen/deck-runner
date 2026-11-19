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

  function showResult(job,batch=[job],enter=true) {
    const node = byId("fx-result");
    node.dataset.state = job.state;
    byId("fx-project").textContent = job.meta.project;
    byId("fx-run-id").textContent = "#" + job.id.slice(-6);
    const counts = new Map();
    for (const entry of batch) counts.set(entry.state, (counts.get(entry.state)||0)+1);
    const summary=byId("fx-batch");
    summary.hidden=batch.length<2;
    summary.textContent=Array.from(counts,([state,count])=>count+" × "+(labels[state]||state)).join("   ·   ");
    const verdict = verdicts[job.state];
    byId("fx-verdict").textContent = verdict.title;
    byId("fx-symbol").textContent = verdict.symbol;
    byId("fx-job-name").textContent = job.meta.label;
    const time=byId("fx-elapsed");
    const seconds=Number.isFinite(job.started) && Number.isFinite(job.finished) ? Math.max(0,Math.round(job.finished-job.started)) : null;
    time.hidden = seconds===null;
    if (seconds!==null) {
      time.dateTime="PT"+seconds+"S";
      time.textContent=seconds>=60 ? Math.floor(seconds/60)+"m "+String(seconds%60).padStart(2,"0")+"s" : seconds+"s";
    }
    if (enter) {
      showFor(node,3200);
      byId("fx-sparks").replaceChildren();
      if (job.state==="passed" && !reduced.matches) victorySparks();
    } else if(job.state!=="passed") {
      byId("fx-sparks").replaceChildren();
    }
  }

  const verdicts = {
    passed:{title:"Passou!",symbol:"✓",rank:1}, failed:{title:"Falhou",symbol:"×",rank:5},
    cancelled:{title:"Cancelado",symbol:"■",rank:2}, interrupted:{title:"Interrompido",symbol:"Ⅱ",rank:3},
    timeout:{title:"Tempo esgotado",symbol:"◷",rank:4}, disk_limit:{title:"Limite de disco",symbol:"!",rank:4},
    output_limit:{title:"Limite de log",symbol:"!",rank:4}
  };
  function mainResult(jobs) {
    return jobs.filter(j=>Object.hasOwn(verdicts,j.state)).sort((a,b)=>
      verdicts[b.state].rank-verdicts[a.state].rank || (b.finished||b.created)-(a.finished||a.created))[0];
  }

  function victorySparks() {
    // Two fans frame the result; the centre stays quiet for reading.
    const host=byId("fx-sparks");
    for (const [index,[x,y,spin]] of [[-118,-65,-60],[-168,18,-32],[-100,96,38],[-54,-102,-25],
      [120,-84,60],[166,6,22],[92,95,-40],[45,-108,26]].entries()) {
      const spark=document.createElement("i");
      spark.className=index%3===0?"fx-star":"fx-chip";
      host.append(spark);
      const side=x<0?-1:1;
      const flight=spark.animate([{opacity:0,transform:"translate("+side*45+"px,4px) scale(.25)"},
        {opacity:1,offset:.12},{opacity:1,offset:.57},{opacity:0,transform:"translate("+x+"px,"+y+"px) rotate("+spin+"deg) scale(.65)"}],
        {duration:680+(index%3)*85,delay:[50,115,170,240][index%4],easing:"cubic-bezier(.19,.72,.21,1)",fill:"both"});
      flight.finished.then(()=>spark.remove(),()=>spark.remove());
    }
  }

  const resultWindow = new Map();
  function presentResults(jobs) {
    const node=byId("fx-result");
    const enter=node.hidden;
    if (enter) resultWindow.clear();
    for (const job of jobs) if (Object.hasOwn(verdicts,job.state)) resultWindow.set(job.id,job);
    const batch=Array.from(resultWindow.values());
    if (batch.length) showResult(mainResult(batch),batch,enter);
  }

  document.addEventListener("station-change", event => {
    if (document.hidden || !event.detail) return;
    const { jobs, previous } = event.detail;
    const result = mainResult(jobs);
    if (result && display && !reduced.matches) presentResults(jobs);
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
