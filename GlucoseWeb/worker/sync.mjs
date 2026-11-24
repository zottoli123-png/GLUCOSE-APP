const maxBytes = 1_048_576;
const route = "/api/journal-sync";
const tokenPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i;
const response = (status, payload) => Response.json(payload, {
    status,
    headers: {"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"}
});
const error = (status, message) => response(status, {error:message});

async function accountHash(token) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
}

async function readBody(request) {
    if (!request.body || request.headers.get("Content-Type") !== "application/json") return null;
    const reader = request.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); }
    catch { return null; }
}

function validEnvelope(value) {
    if (!value || Object.keys(value).sort().join(",") !== "format,id,salt,sealed" || value.format !== 1 ||
        typeof value.id !== "string" || !idPattern.test(value.id) || typeof value.salt !== "string" ||
        typeof value.sealed !== "string" || value.salt.length !== 24 || value.sealed.length < 40) return false;
    try { return atob(value.salt).length === 16 && atob(value.sealed).length >= 28; }
    catch { return false; }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname !== route) return env.ASSETS.fetch(request);
        if (request.method === "GET" && url.search === "?status")
            return response(200,{enabled:env.SYNC_ENABLED === "true" && Boolean(env.JOURNAL_SYNC)});
        if (env.SYNC_ENABLED !== "true" || !env.JOURNAL_SYNC) return error(503,"Cloud sync is unavailable.");
        if (url.search || !["GET","POST","PUT","DELETE"].includes(request.method))
            return error(405,"Unsupported sync request.");
        const token = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if (!token || !tokenPattern.test(token)) return error(401,"Enter your sync key.");
        if (request.method !== "GET" && request.headers.get("Origin") !== url.origin)
            return error(403,"Open Glucose Journal directly to sync.");
        const owner = await accountHash(token);
        const db = env.JOURNAL_SYNC;
        try {
            if (request.method === "GET") {
                const row = await db.prepare("SELECT envelope, revision FROM journals WHERE owner = ?").bind(owner).first();
                if (!row?.envelope) return error(404,"No active cloud journal matches this key.");
                return response(200,{envelope:JSON.parse(row.envelope),revision:row.revision});
            }
            if (request.method === "DELETE") {
                const expected = Number(request.headers.get("If-Match"));
                if (!Number.isSafeInteger(expected) || expected < 1) return error(400,"Cloud revision required.");
                const deleted = await db.prepare(
                    "UPDATE journals SET envelope = NULL, profile_id = NULL, revision = revision + 1 WHERE owner = ? AND revision = ? AND envelope IS NOT NULL RETURNING revision"
                ).bind(owner,expected).first();
                return deleted ? response(200,{deleted:true}) : error(409,"Cloud journal changed. Review the latest copy first.");
            }
            const body = await readBody(request);
            if (!validEnvelope(body?.envelope)) return error(400,"Invalid or oversized encrypted journal.");
            const {envelope,revision} = body;
            const id = envelope.id.toUpperCase();
            const packed = JSON.stringify(envelope);
            if (request.method === "POST") {
                const created = await db.prepare(
                    "INSERT INTO journals(owner, profile_id, envelope, revision) VALUES (?, ?, ?, 1) ON CONFLICT(owner) DO NOTHING RETURNING revision"
                ).bind(owner,id,packed).first();
                return created ? response(201,created) : error(409,"This key has already been used.");
            }
            if (!Number.isSafeInteger(revision) || revision < 1) return error(400,"Cloud revision required.");
            const updated = await db.prepare(
                "UPDATE journals SET envelope = ?, revision = revision + 1 WHERE owner = ? AND profile_id = ? AND revision = ? AND envelope IS NOT NULL RETURNING revision"
            ).bind(packed,owner,id,revision).first();
            return updated ? response(200,updated) : error(409,"Cloud journal changed. Both copies were kept.");
        } catch {
            return error(503,"Cloud sync is unavailable. Keep your local copy and try again later.");
        }
    }
};
