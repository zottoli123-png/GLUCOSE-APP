import assert from "node:assert/strict";
import test from "node:test";
import {blank, dates, importGlucose, csv, kinds} from "../dist/model.mjs";
import {createVault, seal, unlock} from "../dist/vault.mjs";

const fixture="measured_at,glucose,unit,source\n2026-11-22T14:00:00Z,123,mg/dL,Test meter";
const passphrase="local synthetic sample passphrase";

test("all record types and Swift Date epoch",()=>{
    assert.equal(Object.keys(kinds).length,13);
    assert.equal(dates.encode("2001-01-01T00:00:00Z"),0);
    assert.equal(dates.decode(0).toISOString(),"2001-01-01T00:00:00.000Z");
});

test("repeat imports are idempotent without eliminating an independent reading",()=>{
    const first=importGlucose(fixture,[]).added;
    assert.equal(first.length,1);
    assert.equal(importGlucose(fixture,first).duplicates,1);
    assert.equal(importGlucose(fixture.replace("Test meter","Second meter"),first).added.length,1);
});

test("invalid unit, absent time zone and trailing malformed row fail the import",()=>{
    assert.throws(()=>importGlucose(fixture.replace("mg/dL","mg"),[]),/CSV row/);
    assert.throws(()=>importGlucose(fixture.replace("00Z","00"),[]),/CSV row/);
    assert.throws(()=>importGlucose(fixture+"\n,42,mg/dL,Test",[]),/CSV row/);
});

test("CSV neutralizes spreadsheet formulas and quotes multiline notes",()=>{
    const [entry]=importGlucose(fixture,[]).added;
    const out=csv([{...entry,notes:'  =1+1\n"test"'}],false);
    assert.match(out,/"'  =1\+1\n""test"""/);
});

test("vault round trips and refuses wrong passphrases, tampering and another identity",async()=>{
    const journal=blank("Sample journal");
    const {envelope,key}=await createVault(passphrase,journal);
    assert.ok(!JSON.stringify(envelope).includes(journal.name));
    assert.deepEqual((await unlock(envelope,passphrase)).journal,journal);
    await assert.rejects(unlock(envelope,"wrong phrase"),/could not be verified/);
    await assert.rejects(unlock({...envelope,id:crypto.randomUUID()},passphrase),/could not be verified/);
    const first=envelope.sealed[0]==="A"?"B":"A";
    await assert.rejects(unlock({...envelope,sealed:first+envelope.sealed.slice(1)},passphrase),/could not be verified/);
    assert.notEqual((await seal(envelope,key,journal)).sealed,envelope.sealed);
});
