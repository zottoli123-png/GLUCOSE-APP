const encoder = new TextEncoder();
const maxSize = 16 * 1024 * 1024;
const encode = bytes => {
    const src = new Uint8Array(bytes);
    let text = "";
    for (let index = 0; index < src.length; index += 8192) text += String.fromCharCode(...src.subarray(index,index+8192));
    return btoa(text);
};
const decode = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const context = envelope => encoder.encode("GlucoseJournal:v1:" + envelope.id.toUpperCase());

export async function keyFor(envelope, passphrase) {
    if (!envelope || envelope.format !== 1 ||
        !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(envelope.id) ||
        typeof envelope.salt !== "string" || envelope.salt.length !== 24 ||
        typeof envelope.sealed !== "string" || envelope.sealed.length > maxSize * 1.34 ||
        encoder.encode(passphrase).length > 1024) throw Error("Invalid profile or backup format.");
    const salt = decode(envelope.salt);
    if (salt.length !== 16) throw Error("Invalid backup salt.");
    const initial = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations:600_000,hash:"SHA-256"},
        initial, {name:"AES-GCM",length:256}, false, ["encrypt","decrypt"]);
}
export async function seal(envelope, key, journal) {
    const bytes = encoder.encode(JSON.stringify(journal));
    if (bytes.length > maxSize - 28) throw Error("Journal is full. Export your records before adding more.");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:context(envelope)},key,bytes);
    const sealed = new Uint8Array(encrypted.byteLength + 12);
    sealed.set(iv);
    sealed.set(new Uint8Array(encrypted),12);
    return {...envelope,sealed:encode(sealed)};
}
export async function unlock(envelope, passphrase) {
    const key = await keyFor(envelope,passphrase);
    let journal;
    try {
        const bytes = decode(envelope.sealed);
        const data = await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(0,12),additionalData:context(envelope)},key,bytes.slice(12));
        journal = JSON.parse(new TextDecoder().decode(data));
    } catch { throw Error("The passphrase or encrypted backup could not be verified."); }
    if (journal.schema !== 1 || !Array.isArray(journal.entries)) throw Error("This backup requires a compatible app version.");
    return {key,journal};
}
export async function createVault(passphrase,journal) {
    if (passphrase.length < 14) throw Error("Use a unique passphrase with at least 14 characters.");
    const envelope = {format:1,id:crypto.randomUUID().toUpperCase(),salt:encode(crypto.getRandomValues(new Uint8Array(16))),sealed:""};
    const key = await keyFor(envelope,passphrase);
    return {envelope:await seal(envelope,key,journal),key,journal};
}

let database;
function db() {
    database ??= new Promise((resolve,reject) => {
        const open = indexedDB.open("glucose-journal",1);
        open.onupgradeneeded = () => open.result.createObjectStore("profiles",{keyPath:"id"});
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => { database = null; reject(open.error); };
    });
    return database;
}
export async function readProfiles(id) {
    const conn = await db();
    return new Promise((resolve,reject) => {
        const store = conn.transaction("profiles").objectStore("profiles");
        const request = id ? store.get(id) : store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
export async function writeProfile(envelope, revision, remove = false) {
    const conn = await db();
    return new Promise((resolve,reject) => {
        const id = envelope.id.toUpperCase();
        const tx = conn.transaction("profiles","readwrite");
        const store = tx.objectStore("profiles");
        const request = store.get(id);
        let error;
        request.onsuccess = () => {
            if (request.result?.revision !== revision) {
                error = Error(revision === undefined ? "This profile already exists here." : "This profile changed elsewhere. Lock and reopen it.");
                tx.abort();
                return;
            }
            if (remove) store.delete(id);
            else store.put({id,envelope,revision:(revision ?? 0)+1});
        };
        tx.oncomplete = () => resolve((revision ?? 0)+1);
        tx.onabort = () => reject(error || tx.error || Error("Could not save the profile."));
    });
}
