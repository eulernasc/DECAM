/**
 * DECAM - API externa somente leitura
 * Cloudflare Workers + Firestore REST / Google Service Account OAuth2.
 * O Firestore continua no plano Firebase Spark. Nenhuma credencial é enviada ao navegador.
 */
const PROJECT_ID = "decam-2cf89";
const MAX_DAYS = 31;
const PAGE_LIMIT = 5; // até 500 instrutores; se exceder, retorna erro sem omitir registros
const LOCAL_LIMIT = 60; // por isolate/minuto; não substitui rate limit distribuído
const REFRESH_MARGIN_MS = 120_000;
const encoder = new TextEncoder();

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Vary": "X-API-Key",
      ...headers
    }
  });
}
function isoDate(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y,m,d]=str.split("-").map(Number);
  if (y < 2020 || y > 2100 || m < 1 || m > 12) return false;
  const date = new Date(Date.UTC(y, m-1, d));
  return date.getUTCFullYear()===y && date.getUTCMonth()===m-1 && date.getUTCDate()===d;
}
function datesBetween(from, to) {
  const begin=Date.parse(from+"T00:00:00Z"),end=Date.parse(to+"T00:00:00Z");
  const count=Math.round((end-begin)/86_400_000)+1;
  if(!Number.isInteger(count)||count<1||count>MAX_DAYS)return null;
  return Array.from({length:count},(_,i)=>new Date(begin+i*86_400_000).toISOString().slice(0,10));
}
function asFirestoreValue(value) {
  if(!value||typeof value!=="object")return null;
  if("stringValue" in value)return value.stringValue;
  if("booleanValue" in value)return value.booleanValue===true;
  if("integerValue" in value)return Number(value.integerValue);
  if("doubleValue" in value)return Number(value.doubleValue);
  if("timestampValue" in value)return value.timestampValue;
  if("nullValue" in value)return null;
  if("mapValue" in value){
    const out=Object.create(null);
    for(const [k,v] of Object.entries(value.mapValue?.fields||{}))out[k]=asFirestoreValue(v);
    return out;
  }
  if("arrayValue" in value)return (value.arrayValue?.values||[]).map(asFirestoreValue);
  return null;
}
function docFields(doc){
  const out=Object.create(null);
  for(const [k,v] of Object.entries(doc?.fields||{}))out[k]=asFirestoreValue(v);
  return out;
}
function b64url(bytes){
  let raw="";
  for(const b of bytes)raw+=String.fromCharCode(b);
  return btoa(raw).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function bytesOfB64url(text){
  const raw=atob(text.replace(/-/g,"+").replace(/_/g,"/"));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
function pemToBytes(pem){
  const body=pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,"");
  return Uint8Array.from(atob(body),c=>c.charCodeAt(0));
}
async function hexDigest(value,cryptoImpl){
  const digest=new Uint8Array(await cryptoImpl.subtle.digest("SHA-256",encoder.encode(value)));
  return Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");
}
function sameHash(expected,actual){
  if(typeof expected!=="string"||typeof actual!=="string"||expected.length!==64||actual.length!==64)return false;
  let diff=0;
  for(let i=0;i<64;i++)diff|=expected.charCodeAt(i)^actual.charCodeAt(i);
  return diff===0;
}
function serviceAccount(env){
  // Somente dado de Worker Secret: nunca retornar nem fazer console.log() dessas informações.
  let credential;
  try{credential=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON||"");}catch{throw Error("service_account_unavailable");}
  if(credential?.type!=="service_account"||credential.project_id!==PROJECT_ID||
     typeof credential.client_email!=="string"||!credential.client_email.endsWith(".iam.gserviceaccount.com")||
     typeof credential.private_key!=="string"||!credential.private_key.includes("BEGIN PRIVATE KEY")){
    throw Error("service_account_invalid");
  }
  return credential;
}
function createGoogleTokenProvider({fetchImpl,cryptoImpl,now}){
  let cached=null,inFlight=null;
  return async function getToken(env){
    const credential=serviceAccount(env);
    const identity=credential.client_email+"|"+(credential.private_key_id||"");
    const time=now().getTime();
    if(cached&&cached.id===identity&&cached.expiresAt>time+REFRESH_MARGIN_MS)return cached.token;
    if(inFlight&&inFlight.id===identity)return inFlight.promise;
    const promise=(async()=>{
      const key=await cryptoImpl.subtle.importKey("pkcs8",pemToBytes(credential.private_key),{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
      const epoch=Math.floor(now().getTime()/1000);
      const header={alg:"RS256",typ:"JWT"};
      if(credential.private_key_id)header.kid=credential.private_key_id;
      const claim={iss:credential.client_email,scope:"https://www.googleapis.com/auth/datastore",
        aud:"https://oauth2.googleapis.com/token",iat:epoch,exp:epoch+3600};
      const prefix=b64url(encoder.encode(JSON.stringify(header)))+"."+b64url(encoder.encode(JSON.stringify(claim)));
      const signature=new Uint8Array(await cryptoImpl.subtle.sign("RSASSA-PKCS1-v1_5",key,encoder.encode(prefix)));
      const assertion=prefix+"."+b64url(signature);
      const response=await fetchImpl("https://oauth2.googleapis.com/token",{
        method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion}).toString()
      });
      if(!response.ok)throw Error("google_oauth_failed");
      const payload=await response.json();
      if(typeof payload.access_token!=="string"||!Number.isFinite(Number(payload.expires_in)))throw Error("google_oauth_invalid");
      cached={id:identity,token:payload.access_token,expiresAt:now().getTime()+Number(payload.expires_in)*1000};
      return cached.token;
    })();
    inFlight={id:identity,promise};
    try{return await promise;}finally{if(inFlight?.promise===promise)inFlight=null;}
  };
}
async function getFirestoreDoc(fetchImpl, token, url) {
  const response=await fetchImpl(url,{headers:{Authorization:"Bearer "+token,Accept:"application/json"}});
  if(response.status===404)return null;
  if(!response.ok)throw Error("firestore_access_error");
  return response.json();
}
function urlsForFirestore(base,collection,documentId,mask){
  const suffix=collection+(documentId?"/"+encodeURIComponent(documentId):"");
  const url=new URL(base+suffix);
  for(const field of mask)url.searchParams.append("mask.fieldPaths",field);
  return url;
}
function createFirestoreReader({fetchImpl,token,project=PROJECT_ID}){
  const base="https://firestore.googleapis.com/v1/projects/"+encodeURIComponent(project)+"/databases/(default)/documents/";
  return {
    async get(collection,id,mask){
      return getFirestoreDoc(fetchImpl,token,urlsForFirestore(base,collection,id,mask));
    },
    async list(collection,mask){
      const docs=[];
      let tokenPage="";
      for(let page=0;page<PAGE_LIMIT;page++){
        const url=urlsForFirestore(base,collection,null,mask);
        url.searchParams.set("pageSize","100");
        if(tokenPage)url.searchParams.set("pageToken",tokenPage);
        const result=await getFirestoreDoc(fetchImpl,token,url);
        docs.push(...(result?.documents||[]));
        tokenPage=typeof result?.nextPageToken==="string"?result.nextPageToken:"";
        if(!tokenPage)return docs;
      }
      throw Error("too_many_documents");
    }
  };
}
export function createWorkerHandler({fetchImpl=globalThis.fetch,cryptoImpl=globalThis.crypto,now=()=>new Date(),tokenProvider}={}){
  if(!fetchImpl||!cryptoImpl?.subtle)throw Error("webcrypto_fetch_required");
  const authToken=tokenProvider||createGoogleTokenProvider({fetchImpl,cryptoImpl,now});
  const hits=new Map();
  return async function handle(request,env={}){
    if(request.method!=="GET")return json({erro:"Método não permitido"},405,{"Allow":"GET"});
    if(!/^[a-f0-9]{64}$/.test(env.DECAM_API_KEY_HASH||"")||typeof env.GOOGLE_SERVICE_ACCOUNT_JSON!=="string"){
      return json({erro:"Integração indisponível"},503);
    }
    const key=request.headers.get("X-API-Key")||"";
    if(!/^decam_[a-f0-9]{64}$/.test(key))return json({erro:"Chave de integração inválida"},401);
    const hash=await hexDigest(key,cryptoImpl);
    if(!sameHash(hash,env.DECAM_API_KEY_HASH))return json({erro:"Chave de integração inválida"},401);
    const minute=Math.floor(now().getTime()/60_000);
    for(const id of hits.keys())if(id!==minute)hits.delete(id);
    const count=(hits.get(minute)||0)+1;hits.set(minute,count);
    if(count>LOCAL_LIMIT)return json({erro:"Limite temporário de consultas excedido"},429);
    let url;
    try{url=new URL(request.url);}catch{return json({erro:"URL inválida"},400);}
    if(url.search.length>2048)return json({erro:"Consulta muito longa"},400);
    const route=url.pathname.replace(/\/+$/,"")||"/";
    if(!["/v1/instrutores","/v1/programacoes"].includes(route))return json({erro:"Rota não encontrada"},404);
    const params=[...url.searchParams.entries()];
    const accepted=route==="/v1/instrutores"?[]:["instrutorId","data","inicio","fim"];
    if(params.some(([k])=>!accepted.includes(k))||new Set(params.map(([k])=>k)).size!==params.length)
      return json({erro:"Parâmetros inválidos"},400);
    let id,begin,end,days;
    if(route==="/v1/programacoes"){
      id=url.searchParams.get("instrutorId");
      if(!id||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))return json({erro:"instrutorId inválido"},400);
      const single=url.searchParams.has("data");
      if(single&&(url.searchParams.has("inicio")||url.searchParams.has("fim")))
        return json({erro:"Informe data OU inicio e fim"},400);
      begin=single?url.searchParams.get("data"):url.searchParams.get("inicio");
      end=single?begin:url.searchParams.get("fim");
      if(!isoDate(begin)||!isoDate(end))return json({erro:"Data inválida. Use AAAA-MM-DD"},400);
      days=datesBetween(begin,end);
      if(!days)return json({erro:"Período inválido. Máximo de 31 dias"},400);
    }
    try{
      const token=await authToken(env);
      const db=createFirestoreReader({fetchImpl,token});
      const at=now().toISOString();
      if(route==="/v1/instrutores"){
        const docs=await db.list("instrutores",["nome","ativo"]);
        const all=docs.map(doc=>{
          const fields=docFields(doc);
          return {id:decodeURIComponent(doc.name?.split("/").pop()||""),nome:typeof fields.nome==="string"?fields.nome.trim():"",
            ativo:fields.ativo!==false};
        }).filter(i=>i.ativo&&i.nome&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(i.id))
          .map(({id,nome})=>({id,nome})).sort((a,b)=>a.nome.localeCompare(b.nome,"pt-BR"));
        return json({instrutores:all,total:all.length,consultadoEm:at});
      }
      const instructorDoc=await db.get("instrutores",id,["nome","ativo"]);
      const instructor=docFields(instructorDoc);
      if(!instructorDoc||instructor.ativo===false||typeof instructor.nome!=="string"||!instructor.nome.trim())
        return json({erro:"Instrutor não encontrado"},404);
      const months=[...new Set(days.map(day=>day.slice(0,7)))];
      const docs=await Promise.all(months.map(async month=>{
        const doc=await db.get("agenda",id+"_"+month,["dias"]);
        return [month,docFields(doc).dias||Object.create(null)];
      }));
      const map=Object.fromEntries(docs);
      const programacoes=days.map(day=>{
        const item=map[day.slice(0,7)]?.[day.slice(-2)];
        const atividade=typeof item?.atividade==="string"&&item.atividade.trim()?item.atividade.trim():null;
        return {data:day,atividade,carroAgendado:item?.carro===true,paytrack:item?.paytrack===true,
          situacao:!item?"sem_registro":atividade?"programado":"sem_atividade"};
      });
      return json({instrutor:{id,nome:instructor.nome.trim()},inicio:begin,fim:end,programacoes,
        total:programacoes.length,consultadoEm:at});
    }catch(_error){
      // Não expor payloads, credenciais ou resposta interna do Google a terceiros.
      return json({erro:"Não foi possível consultar a programação agora"},503);
    }
  };
}
const handler=createWorkerHandler();
export default {fetch(request,env){return handler(request,env);}};
