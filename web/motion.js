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

  function showResult(job,batch=[job],enter=true,preview=false) {
    const node = byId("fx-result");
    node.dataset.state = job.state;
    byId("fx-project").textContent = job.meta.project;
    const ink=byId("fx-project-ink");
    ink.hidden=!projectColors.has(job.meta.project);
    ink.style.backgroundColor=projectColors.get(job.meta.project)||"";
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
    updateScore(job,preview);
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

  function resetEffects() {
    for (const node of Array.from(scenes.keys())) dismiss(node);
    for (const [row, timer] of launched) {clearTimeout(timer);row.classList.remove("launch-glow");}
    launched.clear();
    resultWindow.clear();
    byId("fx-sparks").replaceChildren();
    for (const selector of ["#used-count",'[data-view="waiting"]',"#live-note","[data-job]"]) {
      for (const node of document.querySelectorAll(selector)) node.getAnimations().forEach(a=>a.cancel());
    }
  }
  reduced.addEventListener("change",resetEffects);

  document.addEventListener("station-resync", resetEffects);
  document.addEventListener("station-refresh", () => {
    if (offline && scenes.size) resetEffects();
  });
  window.addEventListener("pagehide",resetEffects);
  document.addEventListener("visibilitychange",()=>{ if(document.hidden) resetEffects(); });

  const dialog=byId("fx-dialog"), modeInput=byId("fx-mode");
  const modeKey="deck-runner:effects:v1";
  const modes={arcade:"Piloto, brilho e placar de resultado.",quiet:"Destaques nas linhas e no cabeçalho.",off:"Somente os dados da fila."};
  let mode="arcade";
  function setMode(value) {
    mode=Object.hasOwn(modes,value)?value:"arcade";
    modeInput.value=mode;
    document.documentElement.dataset.effects=mode;
    byId("fx-audition").disabled=mode!=="arcade";
    byId("fx-mode-help").textContent=reduced.matches && mode==="arcade" ? "O sistema pediu movimento reduzido. Os avisos aparecem parados." : modes[mode];
    resetEffects();
  }
  try {setMode(localStorage.getItem(modeKey));} catch {setMode("arcade");}
  modeInput.onchange=()=>{
    setMode(modeInput.value);
    try {localStorage.setItem(modeKey,mode);} catch { /* Applies to this window. */ }
  };
  reduced.addEventListener("change",()=>setMode(mode));
  window.addEventListener("storage",e=>{if(e.key===modeKey || !e.key) setMode(e.newValue);});
  byId("fx-settings").onclick=()=>{dialog.showModal();modeInput.focus();};
  byId("fx-back").onclick=()=>dialog.close();
  dialog.addEventListener("close",()=>byId("fx-settings").focus({preventScroll:true}));

  byId("fx-audition").addEventListener("click",e=>{
    const state=e.target.closest("[data-demo]")?.dataset.demo;
    if (!state || mode!=="arcade") return;
    dialog.close();
    resetEffects();
    const now=Date.now()/1000;
    const sample={id:"000000000000",state,started:now-24,finished:now,
      meta:{project:"Demonstração",label:"Prévia dos efeitos do painel"}};
    if(state==="running") showLaunch(sample);
    else {showResult(sample,[sample],true,true);byId("fx-run-id").textContent="PRÉVIA";}
  });

  // Opening a log or an operator dialog gives that surface the user's attention.
  const panels = document.querySelectorAll("dialog");
  const dialogChanges = new MutationObserver(() => {
    if(document.querySelector("dialog[open]")) resetEffects();
  });
  for (const panel of panels) dialogChanges.observe(panel,{attributes:true,attributeFilter:["open"]});

  let recentInstance;
  const recent=[];
  function drawRecent() {
    byId("fx-recent-count").textContent=String(recent.length);
    byId("fx-no-events").hidden=recent.length>0;
    if (!byId("fx-recent").open) return;
    const list=byId("fx-recent-list");
    list.replaceChildren(...recent.map(item=>{
      const row=document.createElement("li"),when=document.createElement("time"),what=document.createElement("span");
      when.textContent=clock(item.at);what.textContent=item.text;row.append(when,what);return row;
    }));
  }
  function remember(jobs) {
    for(const job of [...jobs].sort((a,b)=>(a.finished||a.started||a.created)-(b.finished||b.started||b.created))) {
      const verb={running:"Começou",queued:"Na fila"}[job.state] || labels[job.state] || job.state;
      recent.unshift({at:job.finished||job.started||job.created,text:verb+" · "+job.meta.project+" · "+job.meta.label});
    }
    recent.length=Math.min(12,recent.length);
    drawRecent();
  }
  document.addEventListener("station-resync",()=>{
    if(recentInstance!==data?.instance) {recentInstance=data?.instance;recent.length=0;drawRecent();}
  });
  byId("fx-recent").addEventListener("toggle",drawRecent);

  function recentWins(job) {
    const sample=data.jobs.filter(item=>item.meta.project===job.meta.project && Number.isFinite(item.finished) && Object.hasOwn(verdicts,item.state))
      .sort((a,b)=>b.finished-a.finished || b.id.localeCompare(a.id)).slice(0,12);
    if(sample[0]?.id!==job.id) return 0;
    const stop=sample.findIndex(item=>item.state!=="passed");
    return stop<0?sample.length:stop;
  }
  function updateScore(job,preview) {
    const combo=byId("fx-combo"), score=byId("fx-score");
    const n=job.state==="passed" ? (preview?3:recentWins(job)) : 0;
    const value=n===12?"12+":String(n);
    const changed=combo.hidden || score.textContent!==value || combo.dataset.job!==job.id;
    combo.hidden=n<2;
    combo.dataset.job=job.id;
    score.textContent=value;
    if(n>=2 && changed && !reduced.matches) {
      score.getAnimations().forEach(a=>a.cancel());
      score.animate([{transform:"scale(.64) rotate(-8deg)"},{transform:"translateY(-8px) scale(1.26) rotate(5deg)",offset:.32},
        {transform:"translateY(2px) scale(.92)",offset:.67},{transform:"none"}],
        {duration:520,delay:190,easing:"cubic-bezier(.24,.68,.27,1)",fill:"backwards"});
    }
  }

  document.addEventListener("station-change", event => {
    if (document.hidden || !event.detail) return;
    const { jobs, previous } = event.detail;
    remember(jobs);
    if (mode!=="arcade" || document.querySelector("dialog[open]")) return;
    const busy=j=>j.state==="running" || j.state==="queued";
    if (!reduced.matches && !data.paused && data.alive && previous.jobs.some(busy) && !data.jobs.some(busy)) {
      const slots=Array.from(byId("slots").children);
      slots.forEach((slot,index)=>slot.animate([{opacity:.35},{backgroundColor:"#b4ebdc",opacity:.85,offset:.28},{opacity:1}],
        {duration:480,delay:Math.round(180*index/Math.max(1,slots.length-1)),easing:"cubic-bezier(.15,.7,.23,1)"}));
    }
    if (!reduced.matches) {
      const completed=new Set(jobs.filter(j=>Object.hasOwn(verdicts,j.state)).map(j=>j.id));
      for(const segment of byId("trend").children) if(completed.has(segment.dataset.resultId)) {
        segment.animate([{transform:"scaleY(1)"},{transform:"scaleY(2.4)",offset:.22},{transform:"scaleY(1)"}],
          {duration:640,easing:"cubic-bezier(.21,.75,.3,1)"});
      }
    }
    const result = mainResult(jobs);
    if (result && display) presentResults(jobs);
    const started = jobs.find(job=>job.state==="running");
    if (started && display) showLaunch(started);
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
