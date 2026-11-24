import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import test from "node:test";
import worker from "../worker/sync.mjs";
import {decideSync,makeSyncKey} from "../dist/sync.mjs";
import {blank} from "../dist/model.mjs";
import {createVault,seal,unlock} from "../dist/vault.mjs";

const schema=readFileSync(new URL("../worker/migrations/0001_sync.sql",import.meta.url),"utf8");
const password="synthetic sample passphrase";

function fixture() {
    const sql=new DatabaseSync(":memory:");
    sql.exec(schema);
    const env={SYNC_ENABLED:"true",JOURNAL_SYNC:{prepare(query){
        return {bind(...args){return {async first(){return sql.prepare(query).get(...args);}};}};
    }},ASSETS:{fetch:()=>new Response("asset")}};
    function send(method,key,body,revision,options={}){
        const headers={Origin:"https://journal.test"};
        if(key) headers.Authorization="Bearer "+key;
        if(body) headers["Content-Type"]="application/json";
        if(revision) headers["If-Match"]=String(revision);
        return worker.fetch(new Request("https://journal.test/api/journal-sync"+(options.query||""),{
            method,headers:{...headers,...options.headers},body:body?JSON.stringify(body):undefined
        }),env);
    }
    return {sql,env,send};
}
const vault=createVault(password,blank("Synthetic"));

test("feature flag and asset fallback leave existing app available",async()=>{
    const {send,env}=fixture();
    delete env.SYNC_ENABLED;
    assert.deepEqual(await (await send("GET",null,null,null,{query:"?status"})).json(),{enabled:false});
    assert.equal((await send("GET",makeSyncKey())).status,503);
    assert.equal(await (await worker.fetch(new Request("https://journal.test/"),env)).text(),"asset");
});

test("authenticated accounts have isolated reads, writes and deletion",async()=>{
    const {sql,send}=fixture();
    const {envelope}=await vault;
    const first=makeSyncKey(),other=makeSyncKey(),unknown=makeSyncKey();
    const otherVault=await createVault(password,blank("Other"));
    assert.equal((await send("GET")).status,401);
    assert.equal((await send("POST",first,{envelope})).status,201);
    assert.equal((await send("POST",other,{envelope:otherVault.envelope})).status,201);
    const before=await (await send("GET",other)).json();
    assert.equal(before.envelope.id,otherVault.envelope.id);
    assert.equal((await send("PUT",other,{envelope,revision:1})).status,409);
    assert.equal((await send("DELETE",unknown,null,1)).status,409);
    assert.equal((await send("GET",unknown)).status,404);
    assert.deepEqual(await (await send("GET",other)).json(),before);
    assert.equal((await unlock((await (await send("GET",first)).json()).envelope,password)).journal.name,"Synthetic");
    const persisted=JSON.stringify(sql.prepare("SELECT * FROM journals").all());
    assert.equal(persisted.includes("Synthetic"),false);
    assert.equal(persisted.includes(first),false);
});

test("concurrent edits and deletion use an atomic cloud revision",async()=>{
    const {send}=fixture();
    const {envelope,key,journal}=await vault;
    const token=makeSyncKey();
    await send("POST",token,{envelope});
    const edited=await seal(envelope,key,{...journal,carePlan:"Sample A"});
    const changed=await seal(envelope,key,{...journal,carePlan:"Sample B"});
    const responses=await Promise.all([edited,changed].map(value=>send("PUT",token,{envelope:value,revision:1})));
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    assert.equal((await send("DELETE",token,null,1)).status,409);
    assert.equal((await send("DELETE",token,null,2)).status,200);
    assert.equal((await send("GET",token)).status,404);
    assert.equal((await send("PUT",token,{envelope:changed,revision:3})).status,409);
    assert.equal((await send("POST",token,{envelope})).status,409);
});

test("cross-origin requests and cleartext or oversized payloads are rejected",async()=>{
    const {send}=fixture();
    const {envelope}=await vault;
    const token=makeSyncKey();
    assert.equal((await send("POST",token,{envelope},null,{headers:{Origin:"https://other.test"}})).status,403);
    assert.equal((await send("POST",token,{envelope:{...envelope,notes:"private notes"}})).status,400);
    assert.equal((await send("POST",token,{envelope:{...envelope,sealed:"A".repeat(1_048_576)}})).status,400);
});
test("client detects which copy changed without overwriting diverged histories",async()=>{
    const {envelope}=await vault;
    const local={envelope,revision:5};
    const remote={envelope:{...envelope,sealed:"other"},revision:8};
    assert.equal(decideSync(local,remote,null),"conflict");
    assert.equal(decideSync(local,remote,{localRevision:4,cloudRevision:8}),"upload");
    assert.equal(decideSync(local,remote,{localRevision:5,cloudRevision:7}),"download");
    assert.equal(decideSync(local,remote,{localRevision:4,cloudRevision:7}),"conflict");
    assert.equal(decideSync(local,remote,{localRevision:5,cloudRevision:8}),"conflict");
    assert.equal(decideSync(local,{...remote,envelope},null),"link");
    assert.equal(decideSync(local,{...remote,envelope:{...envelope,id:crypto.randomUUID()}},null),"wrong-profile");
});
