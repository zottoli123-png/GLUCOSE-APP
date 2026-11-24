import {route, makeSyncKey, syncRequest, syncAccount, decideSync} from "./sync.mjs";
import {readProfiles,writeProfile,createVault,unlock,seal,decryptJournal} from "./vault.mjs";
import {kinds, dates, dose, units, factor, summary, blank, importGlucose, csv} from "./model.mjs";

const main=document.querySelector("#main");
const nav=document.querySelector("#nav");
const lockButton=document.querySelector("#lock");
const notice=document.querySelector("#notice");
const tabs=[["History","◷"],["Insights","▤"],["Graph","⌁"],["Medications","✚"],["Settings","⚙"]];
const typeNames=Object.keys(kinds);
let session, busy=false, active="History", generation=0, toastTimer;
let evidence={cards:[]};
let syncEnabled=false;
let filter="", windowDays=30, plotKind="Glucose";
let report={from:dates.local(new Date(Date.now()-29*86400000)).slice(0,10),until:dates.local(new Date()).slice(0,10),types:[],name:false,questions:false,sort:"date"};

const html=text=>String(text??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
const opt=(value,label,chosen)=>'<option value="'+html(value)+'" '+(value===chosen?"selected":"")+'>'+html(label)+'</option>';
const dateLabel=value=>dates.decode(value).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});
const types=(selected,all=false)=> (all?opt("","All types",selected):"")+typeNames.map(name=>opt(name,name,selected)).join("");
const entries=()=>[...session.journal.entries].sort((a,b)=>b.measuredAt-a.measuredAt);
const profileDefaults=journal=>({...blank(journal.name),...journal});
function show(message) {
    clearTimeout(toastTimer); notice.textContent=message;
    toastTimer=setTimeout(()=>notice.textContent="",5200);
}
function run(action) {
    return async event=>{
        event?.preventDefault();
        if(busy) return;
        busy=true;
        const submit=event?.submitter;
        if(submit) submit.disabled=true;
        try{await action(event);}catch(error){show(error.message||"Could not complete the operation.");}
        finally{busy=false;if(submit) submit.disabled=false;}
    };
}
function lock() {
    generation++;
    session=null;active="History";filter="";windowDays=30;plotKind="Glucose";
    report.types=[];report.name=false;report.questions=false;notice.textContent="";
    gate().catch(error=>show(error.message));
}
lockButton.onclick=lock;
let hiddenAt=0, backgroundTimer;
document.addEventListener("visibilitychange",()=>{
    clearTimeout(backgroundTimer);
    document.body.classList.toggle("concealed",document.hidden);
    if(document.hidden){
        hiddenAt=Date.now();
        if(session) backgroundTimer=setTimeout(lock,60000);
    }else if(session && hiddenAt && Date.now()-hiddenAt>=60000) lock();
});
window.addEventListener("pagehide",()=>{if(session) lock();});
async function gate() {
    const attempt=generation;
    nav.hidden=true;lockButton.hidden=true;main.replaceChildren();
    if(!crypto.subtle){main.textContent="Open Glucose Journal over HTTPS or localhost to use encrypted storage.";return;}
    const profiles=await readProfiles();
    if(attempt!==generation || session) return;
    main.innerHTML=`<section class="panel gate"><h1>Your health journal</h1><p class="hint">Record readings, organize medications, and prepare for visits. Your journal stays on this device.</p>
        <form id="gate" class="stack">
        <label>Profile<select name="profile">${profiles.map(p=>opt(p.id,"Profile "+p.id.slice(0,8),null)).join("")}${opt("new","Create a profile",profiles.length?"":"new")}${opt("restore","Restore an encrypted backup",null)}${syncEnabled?opt("cloud","Restore from cloud sync",null):""}</select></label>
        <label id="nameField">Profile name<input name="name" maxlength="80"></label>
        <label id="fileField" hidden>Encrypted backup<input type="file" name="backup" accept=".json,application/json"></label>
        <label id="syncKeyField" hidden>Sync key<input type="password" name="syncKey" autocomplete="off" pattern="[0-9a-f]{64}" maxlength="64"></label>
        <label>Passphrase<input type="password" name="password" required maxlength="512"></label>
        <label id="confirmField">Confirm passphrase<input type="password" name="confirmation" maxlength="512"></label>
        <p id="passHint" class="hint">Use a unique passphrase of at least 14 characters. It also unlocks your backup.</p>
        <button class="primary" id="openButton">Open profile</button></form></section>`;
    const form=document.querySelector("#gate");
    const update=()=>{
        const mode=form.elements.profile.value;
        document.querySelector("#nameField").hidden=mode!=="new";
        document.querySelector("#fileField").hidden=mode!=="restore";
        document.querySelector("#confirmField").hidden=mode!=="new";
        document.querySelector("#passHint").hidden=mode!=="new";
        form.elements.name.required=mode==="new";
        form.elements.confirmation.required=mode==="new";
        form.elements.backup.required=mode==="restore";
        document.querySelector("#syncKeyField").hidden=mode!=="cloud";
        form.elements.syncKey.required=mode==="cloud";
        document.querySelector("#openButton").textContent=mode==="new"?"Create profile":mode==="restore"?"Restore backup":mode==="cloud"?"Restore cloud journal":"Unlock profile";
    };
    form.elements.profile.onchange=update;update();
    form.onsubmit=run(async()=>{
        const mode=form.elements.profile.value;
        const password=form.elements.password.value;
        const confirmation=form.elements.confirmation.value;
        form.elements.password.value="";form.elements.confirmation.value="";
        const syncKey=form.elements.syncKey.value;
        form.elements.syncKey.value="";
        let opened,revision,envelope;
        if(mode==="cloud"){
            const remote=await syncRequest("GET",syncKey);
            envelope=remote.envelope;
            opened=await unlock(envelope,password);
            if(await readProfiles(envelope.id.toUpperCase())) throw Error("This profile already exists here. Open it and use Cloud sync in Settings.");
            const account=await syncAccount(syncKey);
            if(generation!==attempt || document.hidden) return;
            revision=await writeProfile(envelope,undefined,false,{account,localRevision:1,cloudRevision:remote.revision});
        }else if(mode==="new"){
            const name=form.elements.name.value.trim();
            if(!name || confirmation!==password) throw Error("Enter a name and matching passphrases.");
            opened=await createVault(password,blank(name));envelope=opened.envelope;
            revision=await writeProfile(envelope,undefined);
            navigator.storage?.persist?.().catch(()=>{});
        }else if(mode==="restore"){
            const file=form.elements.backup.files[0];
            if(file.size>23*1024*1024) throw Error("This backup exceeds the supported file size.");
            envelope=JSON.parse(await file.text());
            opened=await unlock(envelope,password);
            revision=await writeProfile(envelope,undefined);
        }else{
            const row=await readProfiles(mode);
            if(!row) throw Error("This profile is unavailable.");
            envelope=row.envelope;revision=row.revision;
            opened=await unlock(envelope,password);
        }
        if(generation!==attempt || document.hidden) return;
        session={...opened,envelope,revision,journal:profileDefaults(opened.journal)};
        render();
    });
}
async function save(next) {
    const current=session;
    if(!current) throw Error("Unlock your profile first.");
    const encrypted=await seal(current.envelope,current.key,next);
    if(session!==current) return false;
    const revision=await writeProfile(encrypted,current.revision);
    if(session!==current) return false;
    session={...current,envelope:encrypted,revision,journal:next};
    return true;
}
function render() {
    if(!session) return;
    nav.hidden=false;lockButton.hidden=false;
    nav.innerHTML=tabs.map(([label,icon])=>`<button data-tab="${label}" ${label===active?'aria-current="page"':""}><span aria-hidden="true">${icon}</span>${label}</button>`).join("");
    nav.querySelectorAll("button").forEach(button=>button.onclick=()=>{active=button.dataset.tab;render();main.querySelector("h1")?.focus();window.scrollTo(0,0);});
    ({History:history,Insights:insights,Graph:graph,Medications:medications,Settings:settings})[active]();
}
const pageTitle=title=>'<h1 tabindex="-1">'+title+'</h1>';
function row(entry) {
    return `<article class="entry"><div class="row between"><strong>${html(entry.kind)}${entry.detail?" · "+html(entry.detail):""}</strong>
        <button data-edit="${html(entry.id)}">Edit<span hidden> ${html(entry.kind)}</span></button></div>
        <div>${html(summary(entry,session.journal.useMMOL))} ${dose(entry.kind)?html(entry.doseStatus):""}</div>
        <small>${html(dateLabel(entry.measuredAt))} · ${html(entry.source||"Manual")}${entry.tag?" · "+html(entry.tag):""}</small>
        ${entry.source?'<small> · Imported '+html(dateLabel(entry.recordedAt))+'</small>':""}
        ${entry.notes?"<div>"+html(entry.notes)+"</div>":""}</article>`;
}
function bindRows() {
    main.querySelectorAll("[data-edit]").forEach(button=>button.onclick=()=>{
        const value=session.journal.entries.find(entry=>entry.id===button.dataset.edit);
        if(value) editor(value.kind,value);
    });
}
function history() {
    const j=session.journal;
    const ordered=entries();
    const glucose=ordered.find(entry=>entry.kind==="Glucose");
    const cutoff=dates.encode(new Date(Date.now()-windowDays*86400000));
    const shown=ordered.filter(entry=>(!filter || entry.kind===filter) && entry.measuredAt>=cutoff);
    const checks=shown.filter(row=>row.kind==="Glucose" && Number.isFinite(row.values[0]));
    const avg=checks.reduce((sum,entry)=>sum+entry.values[0],0)/checks.length;
    const due=j.reminders.filter(item=>!item.repeat && new Date(item.when)<=new Date());
    const previous=ordered.filter(e=>e.kind==="Glucose" && e.measuredAt<cutoff && e.measuredAt>=cutoff-windowDays*86400);
    const previousAvg=previous.reduce((sum,e)=>sum+e.values[0],0)/previous.length;
    const stat=n=>html(Number((n/factor("Glucose",j.useMMOL)).toFixed(1)));
    const range=j.prefs?.range;
    const inRange=range?checks.filter(e=>e.values[0]>=range[0]&&e.values[0]<=range[1]).length:0;
    main.innerHTML=pageTitle("History")+`<p class="hint">${html(j.name)}</p><div class="layout">
        <section class="panel hero"><small>Latest recorded glucose</small>
        <p class="value">${glucose?(glucose.values[0]/factor("Glucose",j.useMMOL)).toLocaleString(undefined,{maximumFractionDigits:1}):"—"}</p>
        <p>${glucose?html((j.useMMOL?"mmol/L":"mg/dL")+" · "+dateLabel(glucose.measuredAt)+" · "+(glucose.source||"Manual")):"Add a reading from your meter."}</p>
        ${glucose?.source?"<small>Imported "+html(dateLabel(glucose.recordedAt))+"</small>":""}
        <div class="row"><button id="quick">Log glucose</button><button id="care">My care plan</button></div></section>
        <section class="panel stack"><h2>Add an entry</h2><label>Record type<select id="kind">${types("Glucose")}</select></label>
        <button class="primary" id="add">Open entry form</button>
        ${due.length?"<div><h3>Due reminders</h3>"+due.map(item=>"<div>"+html(item.label)+" · "+html(new Date(item.when).toLocaleString())+"</div>").join("")+"</div>":""}</section></div>
        <section class="panel"><div class="row between"><h2>Entries</h2>
        <label>Type<select id="filter">${types(filter,true)}</select></label>
        <label>Window<select id="window">${[3,7,14,30,90,36500].map(d=>opt(String(d),d===36500?"All history":(d===1?"1 day":d+" days"),String(windowDays))).join("")}</select></label></div>
        ${checks.length?"<p class='hint'>"+checks.length+" recorded glucose "+(checks.length===1?"check":"checks")+" · Average "+stat(avg)+" · Low "+stat(Math.min(...checks.map(e=>e.values[0])))+" · High "+stat(Math.max(...checks.map(e=>e.values[0])))+" "+(j.useMMOL?"mmol/L":"mg/dL")+(previous.length?" · Prior window average "+stat(previousAvg):"")+(range?" · "+inRange+" of "+checks.length+" checks in your saved range":"")+"</p>":""}
        ${shown.length?shown.slice(0,250).map(row).join(""):'<p class="hint">No entries in this window.</p>'}
        ${shown.length>250?"<p>Showing the latest 250. Export the full filtered history in Insights.</p>":""}</section>`;
    document.querySelector("#quick").onclick=()=>editor("Glucose");
    document.querySelector("#care").onclick=()=>{active="Settings";render();document.querySelector("#carePlan").focus();};
    document.querySelector("#add").onclick=()=>editor(document.querySelector("#kind").value);
    document.querySelector("#filter").onchange=e=>{filter=e.target.value;render();};
    document.querySelector("#window").onchange=e=>{windowDays=Number(e.target.value);render();};
    bindRows();
}
function editor(kind,entry) {
    const j=session.journal;
    const [required,labels,detail]=kinds[kind];
    const when=entry?dates.decode(entry.measuredAt):new Date();
    const dialog=document.createElement("dialog");
    dialog.setAttribute("aria-labelledby","editor-title");
    dialog.innerHTML=`<h2 id="editor-title">${entry?"Edit":"Log"} ${html(kind.toLowerCase())}</h2>
      <form class="stack">${labels.map((label,index)=>{
        const saved=entry?.values[index];
        return `<label>${html(units(kind,j.useMMOL,index))}<input name="v${index}" inputmode="decimal" value="${saved==null?"":html(Number((saved/factor(kind,j.useMMOL)).toFixed(6)))}" ${index<required?"required":""}></label>`;
      }).join("")}
      ${detail?'<label>'+detail+'<input name="detail" maxlength="120" value="'+html(entry?.detail)+'" '+(kind==="Carbs"?"":"required")+'></label>':""}
      ${kind==="Medication"?'<label>Unit as entered<input name="unit" maxlength="30" value="'+html(entry?.unit)+'"></label>':""}
      ${dose(kind)?'<label>Status<select name="status">'+["Unsure","Scheduled","Taken","Skipped"].map(s=>opt(s,s,entry?.doseStatus||"Unsure")).join("")+'</select></label>':""}
      <label>Measured or happened at<input name="when" type="datetime-local" required value="${dates.local(when)}"></label>
      <label>Tag<input name="tag" list="tag-list" maxlength="80" value="${html(entry?.tag)}"></label><datalist id="tag-list">${j.tags.map(tag=>opt(tag,tag,null)).join("")}</datalist>
      <label>Notes<textarea name="notes" rows="3" maxlength="10000" ${kind==="Note"?"required":""}>${html(entry?.notes)}</textarea></label>
      <div class="row"><button class="primary">Save entry</button><button id="cancelEdit" type="button">Cancel</button>
      ${entry?'<button id="deleteEntry" class="danger" type="button">Delete entry</button>':""}</div></form>`;
    main.append(dialog);dialog.showModal();
    dialog.onclose=()=>dialog.remove();
    const form=dialog.querySelector("form");
    const initial=labels.map((_,i)=>form.elements["v"+i].value);
    dialog.querySelector("#cancelEdit").onclick=()=>dialog.close();
    form.onsubmit=run(async()=>{
        const fields=new FormData(form);
        const values=labels.map((_,index)=>{
            const value=String(fields.get("v"+index)).trim();
            if(!value) return null;
            const normalized=value.replace(",",".");
            if(!/^-?\d+(?:\.\d+)?$/.test(normalized) || (Number(normalized)<0 && kind!=="Temperature") ||
                Math.abs(Number(normalized))>100000) throw Error("Check "+units(kind,j.useMMOL,index)+".");
            return entry && value===initial[index]?entry.values[index]:Number(normalized)*factor(kind,j.useMMOL);
        });
        if(kind==="Medication" && values[0]!=null && !String(fields.get("unit")).trim()) throw Error("Enter the unit for this medication amount.");
        const measuredAt=entry && fields.get("when")===dates.local(when)?entry.measuredAt:dates.encode(fields.get("when"));
        if(!Number.isFinite(measuredAt)) throw Error("Check the entry date.");
        const updated={...entry,id:entry?.id||crypto.randomUUID(),kind,measuredAt,
            recordedAt:entry?.recordedAt??dates.encode(new Date()),values,detail:String(fields.get("detail")||"").trim(),
            unit:String(fields.get("unit")||"").trim(),notes:String(fields.get("notes")||"").trim(),
            tag:String(fields.get("tag")||"").trim(),doseStatus:fields.get("status")||"Unsure"};
        if(!await save({...j,entries:j.entries.filter(item=>item.id!==updated.id).concat(updated)})) return;
        dialog.close();render();show("Entry saved");
    });
    if(entry) dialog.querySelector("#deleteEntry").onclick=run(async()=>{
        if(!confirm("Delete this entry?")) return;
        if(await save({...j,entries:j.entries.filter(item=>item.id!==entry.id)})){dialog.close();render();show("Entry deleted");}
    });
}
function graph() {
    const cutoff=dates.encode(new Date(Date.now()-windowDays*86400000));
    const points=entries().filter(e=>e.kind===plotKind&&e.measuredAt>=cutoff&&Number.isFinite(e.values[0])&&(!dose(e.kind)||e.doseStatus==="Taken"));
    const yUnit=units(plotKind,session.journal.useMMOL,0);
    main.innerHTML=pageTitle("Graph")+`<section class="panel stack"><div class="row"><label>Measurement<select id="plot">${typeNames.filter(k=>k!=="Note"&&k!=="Medication").map(k=>opt(k,k,plotKind)).join("")}</select></label><label>Window<select id="plotWindow">${[1,3,7,14,30,90,180,36500].map(d=>opt(String(d),d===36500?"All history":(d===1?"1 day":d+" days"),String(windowDays))).join("")}</select></label></div>
      <div>${points.length} checks · ${html(yUnit)}</div>
      ${points.length?'<canvas id="plotCanvas" width="660" height="220" aria-hidden="true"></canvas><details open><summary>Recorded values</summary>'+points.slice(0,100).map(row).join("")+'</details>':'<p class="hint">No values in this window.</p>'}</section>`;
    document.querySelector("#plot").onchange=e=>{plotKind=e.target.value;render();};
    document.querySelector("#plotWindow").onchange=e=>{windowDays=Number(e.target.value);render();};
    if(points.length){
        const canvas=document.querySelector("#plotCanvas");
        const paint=canvas.getContext("2d");
        const values=points.map(p=>p.values[0]/factor(plotKind,session.journal.useMMOL));
        let min=Infinity,max=-Infinity;
        for(const n of values){min=Math.min(min,n);max=Math.max(max,n);}
        const first=points.at(-1).measuredAt,last=points[0].measuredAt;
        paint.fillStyle=getComputedStyle(canvas).getPropertyValue("--accent").trim();
        paint.font="14px system-ui";
        paint.fillText(String(Number(max.toFixed(2))),5,27);
        if(min!==max) paint.fillText(String(Number(min.toFixed(2))),5,200);
        for(const [i,point] of points.entries()){
            const x=last===first?335:55+580*(point.measuredAt-first)/(last-first);
            const y=max===min?110:195-170*(values[i]-min)/(max-min);
            paint.beginPath();paint.arc(x,y,4,0,2*Math.PI);paint.fill();
        }
    }
    bindRows();
}
function medications(){
    const records=entries().filter(e=>dose(e.kind));
    const latest=records.find(e=>e.doseStatus==="Taken");
    const plans=session.journal.reminders.filter(r=>r.category==="Medication");
    main.innerHTML=pageTitle("Medications")+`<div class="layout"><section class="panel"><h2>Record a dose</h2>
       <div class="row"><button class="primary" id="med">Log medication</button><button id="insulin">Log insulin</button></div></section>
       <section class="panel"><h2>Last recorded as taken</h2>${latest?row(latest):"<p>No dose marked as taken.</p>"}</section></div>
       <section class="panel"><div class="row between"><h2>Medication plans</h2><button id="newPlan">Set up a reminder</button></div>${plans.length?plans.map(r=>"<p>"+html(r.label+" · "+(r.repeat||"Once"))+"</p>").join(""):"<p>No medication plans saved.</p>"}</section>
       <section class="panel"><h2>Medication history</h2>${records.length?records.slice(0,250).map(row).join(""):"<p>No medication entries.</p>"}</section>`;
    document.querySelector("#med").onclick=()=>editor("Medication");
    document.querySelector("#insulin").onclick=()=>editor("Insulin");
    document.querySelector("#newPlan").onclick=()=>{active="Settings";render();document.querySelector("#reminderForm").elements.category.value="Medication";document.querySelector("#reminderForm").elements.label.focus();};
    bindRows();
}
function download(name,data,type){
    const url=URL.createObjectURL(new Blob([data],{type}));
    const anchor=document.createElement("a");anchor.href=url;anchor.download=name;
    document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function reportRows() {
    const start=dates.encode(report.from+"T00:00"),end=dates.encode(report.until+"T00:00");
    const next=new Date(report.until+"T00:00");next.setDate(next.getDate()+1);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start) return [];
    const filtered=entries().filter(e=>e.measuredAt>=start&&e.measuredAt<dates.encode(next)&&(!report.types.length||report.types.includes(e.kind)));
    return report.sort==="type"?filtered.sort((a,b)=>a.kind.localeCompare(b.kind)):filtered;
}
function insights(){
    const j=session.journal;
    const found=reportRows();
    main.innerHTML=pageTitle("Insights")+`<div class="layout"><section class="panel stack"><h2>Visit report</h2>
        <div class="row"><label>From<input type="date" id="from" value="${html(report.from)}"></label><label>Through<input type="date" id="until" value="${html(report.until)}"></label></div>
        <details><summary>Choose measurements</summary><p class="hint">No selections includes all types.</p>${typeNames.map(k=>`<label class="check"><input type="checkbox" data-type="${html(k)}" ${report.types.includes(k)?"checked":""}>${html(k)}</label>`).join("")}</details>
        <label>Sort by<select id="sort">${opt("date","Date",report.sort)}${opt("type","Type",report.sort)}</select></label>
        <label class="check"><input type="checkbox" id="includeName" ${report.name?"checked":""}>Include profile name in printout</label>
        <label class="check"><input type="checkbox" id="includeQuestions" ${report.questions?"checked":""}>Include visit questions in printout</label>
        <div class="row"><button id="csvExport">Download CSV</button><button id="print">Print or save PDF</button></div>
        <p class="hint">Reports contain readable health data. Save encrypted backups in Settings.</p>
        <form id="templateForm" class="row"><label>Template name<input name="name" required maxlength="60"></label><button>Save template</button></form>
        ${j.templates.map((t,i)=>'<div class="row"><button data-template="'+i+'">'+html(t.label)+'</button><button class="danger" aria-label="Delete template '+html(t.label)+'" data-delete-template="'+i+'">Delete</button></div>').join("")}</section>
        <section class="panel"><h2>Evidence library</h2>${evidence.cards.length?evidence.cards.map(c=>`<details><summary>${html(c.title)}</summary><p>${html(c.finding)}</p><p>${html(c.population)}</p><p>${html(c.limitations)}</p><small>Reviewed ${html(c.reviewed_on)}</small><ul>${c.sources.filter(s=>/^https:\/\//.test(s.url)).map(s=>'<li><a target="_blank" rel="noopener noreferrer" href="'+html(s.url)+'">Open source</a></li>').join("")}</ul></details>`).join(""):"<p>Reviewed material will appear here with an approved update.</p>"}
        <p><a target="_blank" rel="noopener noreferrer" href="https://www.niddk.nih.gov/health-information/diabetes/financial-help-diabetes-care">Financial help for diabetes care</a></p></section></div>
        <section class="panel"><h2>Report preview</h2><div id="report" class="report"></div></section>`;
    const content=()=>{
        const lines=reportRows();
        return ["Glucose Journal · Visit report",report.from+" through "+report.until,
            report.name?j.name:"",lines.length+" entries",
            report.questions&&j.visitQuestions?"Visit questions\n"+j.visitQuestions:"",
            ...lines.map(e=>[dateLabel(e.measuredAt),e.kind,e.detail,summary(e,j.useMMOL),dose(e.kind)?e.doseStatus:"",
                e.source||"Manual",e.tag,e.notes].filter(Boolean).join(" · "))].filter(Boolean);
    };
    const refresh=()=>document.querySelector("#report").textContent=content().slice(0,100).join("\n\n")+(reportRows().length>95?"\n\nFull report includes all matching entries.":"");
    refresh();
    for(const key of ["from","until","sort"]) document.querySelector("#"+key).onchange=e=>{report[key]=e.target.value;refresh();};
    for(const [id,key] of [["includeName","name"],["includeQuestions","questions"]]) document.querySelector("#"+id).onchange=e=>{report[key]=e.target.checked;refresh();};
    main.querySelectorAll("[data-type]").forEach(box=>box.onchange=()=>{report.types=[...main.querySelectorAll("[data-type]:checked")].map(x=>x.dataset.type);refresh();});
    document.querySelector("#csvExport").onclick=()=>download("GlucoseJournal.csv",csv(reportRows(),j.useMMOL),"text/csv");
    document.querySelector("#print").onclick=()=>{
        const printout=document.createElement("div"); printout.className="report";
        printout.textContent=content().join("\n\n");
        const before=[...main.children];before.forEach(element=>element.hidden=true);main.append(printout);
        const finish=()=>{printout.remove();before.forEach(element=>element.hidden=false);};
        window.addEventListener("afterprint",finish,{once:true});window.print();
        
    };
    document.querySelector("#templateForm").onsubmit=run(async event=>{
        const label=event.currentTarget.elements.name.value.trim();
        if(!label) return;
        if(await save({...j,templates:[...j.templates,{label,settings:{...report}}]})) render();
    });
    main.querySelectorAll("[data-template]").forEach(b=>b.onclick=()=>{report={...j.templates[Number(b.dataset.template)].settings};render();});
    main.querySelectorAll("[data-delete-template]").forEach(b=>b.onclick=run(async()=>{
        if(await save({...j,templates:j.templates.filter((_,i)=>i!==Number(b.dataset.deleteTemplate))})) render();
    }));
}
function settings(){
    const j=session.journal;
    main.innerHTML=pageTitle("Settings")+`<div class="layout">
    <section class="panel stack"><h2>Profile preferences</h2><form id="profileSettings" class="stack">
    <label>Display name<input name="name" maxlength="80" required value="${html(j.name)}"></label>
    <label>Glucose unit<select name="unit">${opt("mg","mg/dL",j.useMMOL?"mmol":"mg")}${opt("mmol","mmol/L",j.useMMOL?"mmol":"mg")}</select></label>
    <details><summary>Care-team glucose range</summary><p class="hint">Optional. Enter the range your care team gave you in mg/dL.</p>
    <label>Lower (mg/dL)<input name="low" type="number" min="1" max="10000" step="any" value="${html(j.prefs?.range?.[0])}"></label>
    <label>Upper (mg/dL)<input name="high" type="number" min="1" max="10000" step="any" value="${html(j.prefs?.range?.[1])}"></label></details>
    <label>Tags, one per line<textarea name="tags" rows="4">${html(j.tags.join("\n"))}</textarea></label>
    <button class="primary">Save preferences</button></form></section>
    <section class="panel stack"><h2>Care and supplies</h2><form id="careForm" class="stack">
    <label>My care plan<textarea id="carePlan" name="carePlan" maxlength="60000" rows="5">${html(j.carePlan)}</textarea></label>
    <label>Questions for my visit<textarea name="visitQuestions" maxlength="20000" rows="3">${html(j.visitQuestions)}</textarea></label>
    <label>Refill and supply notes<textarea name="refillNotes" maxlength="20000" rows="3">${html(j.refillNotes)}</textarea></label>
    <button class="primary">Save care notes</button></form>
    <details><summary>Supply inventory</summary><form id="supplies" class="stack"><label>Supply<input name="supply" required maxlength="80"></label><label>Quantity on hand<input name="quantity" type="number" min="0" max="100000" required></label><label>Refill date<input name="refill" type="date"></label><button>Save supply</button></form>
    ${j.supplies.map((s,i)=>`<div class="entry"><strong>${html(s.supply)}</strong><small>${html(s.quantity)} on hand${s.refill?" · Refill "+html(s.refill):""}</small><button data-drop-supply="${i}" type="button">Remove supply</button></div>`).join("")}</details>
    <details><summary>Nutrition label calculator</summary><form id="nutrition" class="stack"><label>Carbs per serving (g)<input name="carbs" type="number" min="0" max="5000" step="any" required></label><label>Servings eaten<input name="servings" type="number" min="0.01" max="100" step="any" required></label><button>Calculate carbs</button><output id="nutritionOutput"></output></form></details></section>
    <section class="panel stack"><h2>Reminders</h2><p class="hint">Past-due one-time items appear in History. Import the calendar file to get device reminders and repetitions.</p>
    <form id="reminderForm" class="stack"><label>Category<select name="category"><option>Glucose</option><option>Medication</option><option>Refill</option><option>Other</option></select></label><label>Reminder label<input name="label" required maxlength="100"></label>
    <label>Date and time<input type="datetime-local" name="when" required></label>
    <label>Repeat<select name="repeat"><option value="">Once</option><option>Daily</option><option>Weekly</option><option>Monthly</option></select></label>
    <button>Add reminder</button></form>
    ${j.reminders.map((r,i)=>`<div class="entry"><strong>${html(r.label)}</strong><small>${html(new Date(r.when).toLocaleString())} · ${html(r.repeat||"Once")}</small><div class="row"><button data-calendar="${i}">Calendar file</button><button class="danger" data-reminder="${i}">Delete</button></div></div>`).join("")}</section>
    ${syncEnabled?`<section class="panel stack"><h2>Cloud sync</h2>
    <p class="hint">Optional. Save this encrypted profile to the cloud and use the same sync key and journal passphrase on your other devices.</p>
    <button id="makeSyncKey" type="button">Generate a new sync key</button>
    <form id="cloudSync" class="stack"><label>Sync key<input name="key" type="password" pattern="[0-9a-f]{64}" maxlength="64" autocomplete="off" spellcheck="false" required></label>
    <p id="copyKey" class="hint" hidden>Save this key in your password manager before uploading. You’ll need the key and journal passphrase to restore.</p>
    <div class="row"><button data-action="POST">Create cloud copy</button><button data-action="PUT">Sync now</button><button data-action="DELETE" class="danger">Delete cloud copy</button></div></form>
    <button id="conflictCopy" type="button" hidden>Download encrypted cloud copy</button>
    <p id="syncMessage" role="status"></p></section>`:""}
    <section class="panel stack"><h2>Import and backup</h2><button id="backup">Download encrypted backup</button>
    <p class="hint">Backup stores this profile only. Keep a copy outside the browser. Restore is available from the locked screen.</p>
    <form id="import" class="stack"><label>Import glucose CSV<input type="file" name="csv" accept=".csv,text/csv" required></label>
    <small>Columns must be measured_at, glucose, unit, source. Use an ISO date with a time zone.</small>
    <button>Review import</button></form>
    <button class="danger" id="erase">Delete this profile</button></section></div>`;
    if(syncEnabled) bindCloudSync();
    document.querySelector("#profileSettings").onsubmit=run(async e=>{
        const fields=new FormData(e.currentTarget);const name=String(fields.get("name")).trim();
        if(!name) throw Error("Enter a profile name.");
        const tags=[...new Set(String(fields.get("tags")).split("\n").map(x=>x.trim()).filter(Boolean))].slice(0,100);
        const limits=[fields.get("low"),fields.get("high")];
        const range=limits.every(v=>v==="")?null:limits.map(Number);
        if(range&&(!range.every(n=>Number.isFinite(n)&&n>0)||range[0]>=range[1])) throw Error("Enter both limits with the upper limit above the lower limit.");
        if(await save({...j,name,useMMOL:fields.get("unit")==="mmol",tags,prefs:{...j.prefs,range}})){render();show("Preferences saved");}
    });
    document.querySelector("#careForm").onsubmit=run(async e=>{
        const values=Object.fromEntries(new FormData(e.currentTarget));
        if(await save({...j,...values})){render();show("Care notes saved");}
    });
    document.querySelector("#supplies").onsubmit=run(async e=>{
        const data=Object.fromEntries(new FormData(e.currentTarget));
        data.supply=data.supply.trim();
        if(!data.supply) throw Error("Name the supply.");
        const supplies=j.supplies.filter(s=>s.supply.toLowerCase()!==data.supply.toLowerCase());
        if(await save({...j,supplies:[...supplies,data]})){render();document.querySelector("#supplies").closest("details").open=true;}
    });
    main.querySelectorAll("[data-drop-supply]").forEach(b=>b.onclick=run(async()=>{
        if(await save({...j,supplies:j.supplies.filter((_,i)=>i!==Number(b.dataset.dropSupply))})){
            render();document.querySelector("#supplies").closest("details").open=true;
        }
    }));
    document.querySelector("#nutrition").onsubmit=e=>{
        e.preventDefault();
        const values=new FormData(e.currentTarget);
        const carbs=Number(values.get("carbs")),servings=Number(values.get("servings"));
        document.querySelector("#nutritionOutput").textContent=carbs+" g × "+servings+" = "+Number((carbs*servings).toFixed(2))+" g";
    };
    document.querySelector("#reminderForm").onsubmit=run(async e=>{
        const data=Object.fromEntries(new FormData(e.currentTarget));
        const time=new Date(data.when);
        if(!data.label.trim()||!Number.isFinite(time.getTime())) throw Error("Enter a label and valid time.");
        if(await save({...j,reminders:[...j.reminders,{id:crypto.randomUUID(),...data,when:time.toISOString()}]})) render();
    });
    main.querySelectorAll("[data-reminder]").forEach(b=>b.onclick=run(async()=>{
        if(await save({...j,reminders:j.reminders.filter((_,i)=>i!==Number(b.dataset.reminder))})) render();
    }));
    main.querySelectorAll("[data-calendar]").forEach(b=>b.onclick=()=>{
        const r=j.reminders[Number(b.dataset.calendar)];
        const date=value=>new Date(value).toISOString().replace(/[-:]|\.\d{3}/g,"");
        const label=r.label.replace(/[\\;,\n\r]/g,c=>/[\n\r]/.test(c)?"\\n":"\\"+c);
        const repeat={Daily:"DAILY",Weekly:"WEEKLY",Monthly:"MONTHLY"}[r.repeat];
        download("GlucoseJournal-Reminder.ics",["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Glucose Journal//EN",
            "BEGIN:VEVENT","UID:"+r.id,"DTSTAMP:"+date(new Date()),"DTSTART:"+date(r.when),"SUMMARY:"+label,
            ...(repeat?["RRULE:FREQ="+repeat]:[]),"BEGIN:VALARM","TRIGGER:PT0M","ACTION:DISPLAY",
            "DESCRIPTION:Glucose Journal reminder","END:VALARM","END:VEVENT","END:VCALENDAR",""].join("\r\n"),"text/calendar");
    });
    document.querySelector("#backup").onclick=()=>download("GlucoseJournal-Encrypted.json",JSON.stringify(session.envelope),"application/json");
    document.querySelector("#erase").onclick=run(async()=>{
        if(!confirm("Delete this profile and all its entries from this browser?")) return;
        const current=session;await writeProfile(current.envelope,current.revision,true);lock();show("Profile deleted");
    });
    document.querySelector("#import").onsubmit=run(async e=>{
        const file=e.currentTarget.elements.csv.files[0];
        if(!file||file.size>4*1024*1024) throw Error("Choose a CSV smaller than 4 MB.");
        const result=importGlucose(await file.text(),j.entries);
        if(!result.added.length){show("No new readings. "+result.duplicates+" duplicates skipped.");return;}
        if(!confirm("Import "+result.added.length+" readings and skip "+result.duplicates+" duplicates?")) return;
        if(await save({...j,entries:j.entries.concat(result.added)})){render();show("Readings imported");}
    });
}
function bindCloudSync() {
    const form=document.querySelector("#cloudSync");
    const keyInput=form.elements.key;
    const message=document.querySelector("#syncMessage");
    const conflictButton=document.querySelector("#conflictCopy");
    document.querySelector("#makeSyncKey").onclick=()=>{
        keyInput.type="text";
        keyInput.value=makeSyncKey();
        document.querySelector("#copyKey").hidden=false;
        keyInput.select();
    };
    form.onsubmit=run(async event=>{
        const operation=event.submitter?.dataset.action;
        if(!operation) return;
        const current=session;
        const key=keyInput.value;
        const profile=current.envelope.id.toUpperCase();
        keyInput.value="";
        keyInput.type="password";
        document.querySelector("#copyKey").hidden=true;
        conflictButton.hidden=true;
        conflictButton.onclick=null;
        message.textContent="";
        try {
            const local=await readProfiles(profile);
            if(local.revision!==current.revision) throw Error("This copy changed in another tab. Reopen the profile first.");
            const account=await syncAccount(key);
            if(operation==="POST"){
                if(!confirm("Upload an encrypted copy of this profile? Save your sync key and passphrase first.")) return;
                const created=await syncRequest("POST",key,{envelope:local.envelope});
                if(session!==current) return;
                const revision=await writeProfile(local.envelope,local.revision,false,
                    {account,localRevision:local.revision+1,cloudRevision:created.revision});
                if(session===current) session={...current,revision};
                message.textContent="Cloud copy created.";
                return;
            }
            const remote=await syncRequest("GET",key);
            if(session!==current) return;
            const link=local.cloudLink?.account===account?local.cloudLink:null;
            const decision=decideSync(local,remote,link);
            if(decision==="wrong-profile") throw Error("This sync key belongs to a different profile.");
            const decrypted=await decryptJournal(remote.envelope,current.key);
            if(session!==current) return;
            if(operation==="DELETE"){
                if(!confirm("Delete your cloud copy? Your local profile will stay on this device.")) return;
                await syncRequest("DELETE",key,undefined,remote.revision);
                message.textContent="Cloud copy deleted. This device still has its local copy.";
                return;
            }
            if(decision==="conflict"){
                conflictButton.hidden=false;
                conflictButton.onclick=()=>download("GlucoseJournal-Cloud-Conflict.json",JSON.stringify(remote.envelope),"application/json");
                throw Error("This device and the cloud have different histories. Both copies were kept. Download both encrypted backups before choosing which history to use.");
            }
            let cloudRevision=remote.revision;
            let envelope=local.envelope;
            let journal=current.journal;
            if(decision==="upload"){
                const updated=await syncRequest("PUT",key,{envelope,revision:remote.revision});
                cloudRevision=updated.revision;
            }else if(decision==="download"){
                envelope=remote.envelope;
                journal=profileDefaults(decrypted);
            }
            if(session!==current) return;
            const revision=await writeProfile(envelope,local.revision,false,
                {account,localRevision:local.revision+1,cloudRevision});
            if(session!==current) return;
            session={...current,envelope,journal,revision};
            render();
            show("Journal synced");
        } catch(error) {
            if(session!==current) return;
            message.textContent=error.name==="TimeoutError"||error instanceof TypeError
                ? "Local copy is still on this device. Try sync again when online."
                : error.message;
        }
    });
}
async function checkSync() {
    try{
        const result=await fetch(route+"?status",{cache:"no-store",credentials:"omit"});
        if(result.ok) syncEnabled=(await result.json()).enabled===true;
    }catch{}
}
fetch("./evidence.bundle.json",{credentials:"same-origin"}).then(r=>r.json()).then(bundle=>{
    if(bundle.schema===1&&Array.isArray(bundle.cards)){evidence=bundle;if(session&&active==="Insights") render();}
}).catch(()=>{});
if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{show("Offline installation is unavailable in this browser.");});
gate().catch(error=>show(error.message));
function refreshSyncCapability(){
    checkSync().then(()=>{
        if(!syncEnabled || busy) return;
        if(!session && !document.activeElement?.closest("#gate")) return gate();
    }).catch(()=>{});
}
window.addEventListener("online",refreshSyncCapability);
refreshSyncCapability();
