export const kinds = {
    "Glucose":[1,["Glucose (mg/dL)"]],
    "Weight":[1,["Weight (lb)"]],
    "Blood pressure":[2,["Systolic (mmHg)","Diastolic (mmHg)","Heart rate (bpm)"]],
    "Insulin":[1,["Amount (units)"],"Insulin name"],
    "Lab A1C":[1,["Lab A1C (%)"]],
    "Medication":[0,["Amount"],"Medication name"],
    "Oxygen":[1,["SpO₂ (%)","Heart rate (bpm)"]],
    "Temperature":[1,["Temperature (°F)"]],
    "Exercise":[0,["Duration (min)"],"Activity"],
    "Ketones":[1,["Blood ketones (mmol/L)"]],
    "Carbs":[1,["Carbs (g)","Fat (g)","Fiber (g)","Sugar (g)","Protein (g)","Calories (kcal)"],"Food"],
    "Note":[0,[]],
    "INR":[1,["INR"]]
};
export const dates = {
    encode: date => new Date(date).getTime()/1000-978307200,
    decode: value => new Date((value+978307200)*1000),
    local: date => new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)
};
export const dose = kind => ["Insulin","Medication"].includes(kind);
export const units = (kind,mmol,index) => kind==="Glucose" && mmol ? "Glucose (mmol/L)" : kinds[kind][1][index];
export const factor = (kind,mmol) => kind==="Glucose" && mmol ? 18.0182 : 1;
export function summary(entry,mmol) {
    return entry.values.flatMap((value,index)=>{
        if (value == null || !units(entry.kind,mmol,index)) return [];
        const formatted = Number((value/factor(entry.kind,mmol)).toFixed(3));
        return entry.kind==="Medication" ? formatted+" "+entry.unit : units(entry.kind,mmol,index)+": "+formatted;
    }).join(" · ");
}
export function blank(name) {
    return {schema:1,name,useMMOL:false,carePlan:"",visitQuestions:"",refillNotes:"",entries:[],
        tags:["Fasting","Before a meal","After a meal","Before bed","Exercise"],reminders:[],templates:[],supplies:[],prefs:{}};
}
export function fromCSV(text) {
    const rows = [];
    let row = [], value = "", quoted = false;
    for(let i=0;i<text.length;i++){
        const char = text[i];
        if(quoted){
            if(char==='"' && text[i+1]==='"'){value+='"';i++;}
            else if(char==='"') quoted=false;
            else value+=char;
        } else if(char==='"' && !value) quoted=true;
        else if(char===','){row.push(value);value="";}
        else if(char==='\n'){row.push(value.replace(/\r$/,""));rows.push(row);row=[];value="";}
        else value+=char;
    }
    if(quoted) throw Error("CSV has an unclosed quoted field.");
    if(row.length || value) rows.push([...row,value.replace(/\r$/,"")]);
    return rows;
}
export function importGlucose(text, existing) {
    const [headers,...rows]=fromCSV(text.replace(/^\uFEFF/,""));
    const required=["measured_at","glucose","unit","source"];
    if(!headers || !required.every(name=>headers.includes(name))) throw Error("CSV needs measured_at, glucose, unit, source.");
    const index=name=>headers.indexOf(name);
    const fingerprint=entry=>JSON.stringify([entry.measuredAt,entry.values[0],entry.source]);
    const seen=new Set(existing.filter(entry=>entry.kind==="Glucose" && entry.source).map(fingerprint));
    const added=[];
    let duplicates=0;
    for(const [i,row] of rows.entries()){
        if(row.every(cell=>!cell.trim())) continue;
        const raw=row[index("measured_at")]?.trim() || "";
        const measuredAt=dates.encode(raw);
        const unit=row[index("unit")]?.trim();
        const glucose=row[index("glucose")]?.trim();
        const source=row[index("source")]?.trim();
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d.*(?:Z|[+-]\d\d:\d\d)$/i.test(raw) ||
            !Number.isFinite(measuredAt) || !["mg/dL","mmol/L"].includes(unit) ||
            !/^\d+(?:\.\d+)?$/.test(glucose??"") || Number(glucose)<=0 || Number(glucose)>100000 ||
            !source || source.length>100) throw Error("Check date, glucose, unit and source on CSV row "+(i+2)+".");
        const entry={id:crypto.randomUUID(),kind:"Glucose",measuredAt,recordedAt:dates.encode(new Date()),
            values:[Number(glucose)*(unit==="mmol/L"?18.0182:1)],source,originalValue:Number(glucose),originalUnit:unit,
            detail:"",unit:"",notes:"",tag:"",doseStatus:"Unsure"};
        const key=fingerprint(entry);
        if(seen.has(key)){duplicates++;continue;}
        seen.add(key);added.push(entry);
    }
    return {added,duplicates};
}
export function csv(entries,mmol) {
    const cell = data => {
        let value=String(data ?? "");
        if(/^[\s\uFEFF]*[=+@-]/.test(value)) value="'"+value;
        return '"'+value.replaceAll('"','""')+'"';
    };
    const rows=entries.map(entry=>[entry.id,entry.kind,dates.decode(entry.measuredAt).toISOString(),
        dates.decode(entry.recordedAt).toISOString(),entry.source||"Manual",entry.detail,dose(entry.kind)?entry.doseStatus:"",
        entry.tag,summary(entry,mmol),entry.notes].map(cell).join(","));
    return ["ID,Type,Measured at,Recorded at,Source,Name,Status,Tag,Values,Notes",...rows].join("\r\n")+"\r\n";
}
