export const route="/api/journal-sync";
export function makeSyncKey() {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,"0")).join("");
}
export async function syncRequest(method,key,body,revision) {
    const headers={Authorization:"Bearer "+key};
    if(body) headers["Content-Type"]="application/json";
    if(revision) headers["If-Match"]=String(revision);
    const result=await fetch(route,{method,headers,body:body?JSON.stringify(body):undefined,
        cache:"no-store",redirect:"error",credentials:"omit",signal:AbortSignal.timeout(12000)});
    const data=await result.json();
    if(!result.ok) throw Error(data.error||"Sync could not finish.");
    return data;
}
export function sameEnvelope(a,b) {
    return a.id.toUpperCase()===b.id.toUpperCase() && a.format===b.format && a.salt===b.salt && a.sealed===b.sealed;
}
export function decideSync(local,remote,link) {
    if(local.envelope.id.toUpperCase()!==remote.envelope.id.toUpperCase()) return "wrong-profile";
    if(sameEnvelope(local.envelope,remote.envelope)) return "link";
    if(!link) return "conflict";
    const localChanged = local.revision !== link.localRevision;
    const cloudChanged = remote.revision !== link.cloudRevision;
    if(localChanged && !cloudChanged) return "upload";
    if(!localChanged && cloudChanged) return "download";
    return "conflict";
}

export async function syncAccount(key) {
    const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(key));
    return Array.from(new Uint8Array(hash), b=>b.toString(16).padStart(2,"0")).join("");
}
