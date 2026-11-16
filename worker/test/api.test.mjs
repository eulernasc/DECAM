import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto,createHash,generateKeyPairSync,verify} from "node:crypto";
import {createWorkerHandler} from "../src/index.js";

const KEY="decam_"+"a".repeat(64); // FICTÍCIA, nunca entregue ao integrador
const HASH=createHash("sha256").update(KEY).digest("hex");
const ENV={DECAM_API_KEY_HASH:HASH,GOOGLE_SERVICE_ACCOUNT_JSON:"fake-test-service-account"};
const NOW=()=>new Date("2026-11-16T12:00:00.000Z");
const BASE="https://decam-consulta-api.test";
const project="projects/decam-2cf89/databases/(default)/documents/";

function val(value){
  if(value===null)return {nullValue:null};
  if(typeof value==="string")return {stringValue:value};
  if(typeof value==="boolean")return {booleanValue:value};
  if(typeof value==="number")return {integerValue:String(value)};
  if(Array.isArray(value))return {arrayValue:{values:value.map(val)}};
  if(typeof value==="object")return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,val(v)]))}};
  throw Error("fixture invalid");
}
function document(collection,id,data){
  return {name:project+collection+"/"+id,fields:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,val(v)]))};
}
const people=[
  document("instrutores","marcos",{nome:"Marcos Batista Freire",ativo:true,cpf:"12345678900",email:"secret@example.com"}),
  document("instrutores","izaias",{nome:"Izaías de Sene",ativo:true}),
  document("instrutores","inativo",{nome:"Ex-instrutor",ativo:false})
];
const agenda={
  "marcos_2026-11":document("agenda","marcos_2026-11",{
    dias:{"06":{atividade:"BETIM",carro:true,paytrack:true},"07":{atividade:"DSR",carro:false,paytrack:false}}
  }),
  "marcos_2026-12":document("agenda","marcos_2026-12",{dias:{"01":{atividade:"VARGINHA",carro:false,paytrack:true}}})
};
function response(obj,status=200){return new Response(JSON.stringify(obj),{status,headers:{"Content-Type":"application/json"}});}
function firestoreFetch(url,options){
  const address=new URL(url);
  assert.equal(address.origin,"https://firestore.googleapis.com");
  assert.equal(options.headers.Authorization,"Bearer token-test");
  assert.equal(options.method,undefined);
  const suffix=decodeURIComponent(address.pathname.split("/documents/")[1]||"");
  if(suffix==="instrutores"){
    assert.ok(address.searchParams.getAll("mask.fieldPaths").includes("nome"));
    return Promise.resolve(response({documents:people}));
  }
  if(suffix.startsWith("instrutores/")){
    const item=people.find(p=>p.name.endsWith("/"+suffix.split("/")[1]));
    return Promise.resolve(item?response(item):response({error:"not found"},404));
  }
  if(suffix.startsWith("agenda/")){
    const id=suffix.split("/")[1];
    return Promise.resolve(agenda[id]?response(agenda[id]):response({error:"not found"},404));
  }
  throw Error("Unexpected Firestore endpoint: "+url);
}
function handler(fetchImpl=firestoreFetch,options={}){
  return createWorkerHandler({cryptoImpl:webcrypto,fetchImpl,now:NOW,
    tokenProvider:options.tokenProvider||async()=> "token-test"});
}
async function ask(h,path,options={}){
  const req=new Request(BASE+path,{method:options.method||"GET",headers:options.hasOwnProperty("key")?(options.key?{"X-API-Key":options.key}:{}):{"X-API-Key":KEY}});
  const res=await h(req,options.env||ENV);
  return {status:res.status,body:await res.json(),headers:res.headers};
}

test("sem chave ou hash inválido não consulta o Firestore",async()=>{
  const h=handler();
  assert.equal((await ask(h,"/v1/instrutores",{key:null})).status,401);
  assert.equal((await ask(h,"/v1/instrutores",{key:"decam_"+"f".repeat(64)})).status,401);
  assert.equal((await ask(h,"/v1/instrutores",{env:{...ENV,DECAM_API_KEY_HASH:""}})).status,503);
});
test("só GET, sem CORS e sem cache",async()=>{
  const h=handler();
  const r=await ask(h,"/v1/instrutores",{method:"POST"});
  assert.equal(r.status,405);
  assert.equal(r.headers.get("Allow"),"GET");
  const good=await ask(h,"/v1/instrutores");
  assert.equal(good.status,200);
  assert.match(good.headers.get("Cache-Control"),/no-store/);
  assert.equal(good.headers.get("Access-Control-Allow-Origin"),null);
});
test("lista apenas instrutores ativos com ID e nome; sem CPF nem email",async()=>{
  const r=await ask(handler(),"/v1/instrutores");
  assert.equal(r.status,200);
  assert.equal(r.body.total,2);
  assert.deepEqual(r.body.instrutores.map(x=>x.id),["izaias","marcos"]);
  assert.equal(JSON.stringify(r.body).includes("cpf"),false);
  assert.equal(JSON.stringify(r.body).includes("secret@example.com"),false);
});
test("resposta Marcos → Betim 06/11/2026 sem dados extras",async()=>{
  const r=await ask(handler(),"/v1/programacoes?instrutorId=marcos&data=2026-11-06");
  assert.equal(r.status,200);
  assert.equal(r.body.instrutor.nome,"Marcos Batista Freire");
  assert.deepEqual(r.body.programacoes,[{
    data:"2026-11-06",atividade:"BETIM",carroAgendado:true,paytrack:true,situacao:"programado"
  }]);
});
test("DSR é atividade; sem registro não vira destino inventado",async()=>{
  const h=handler();
  const r=await ask(h,"/v1/programacoes?instrutorId=marcos&inicio=2026-11-07&fim=2026-11-08");
  assert.equal(r.body.programacoes[0].atividade,"DSR");
  assert.equal(r.body.programacoes[1].atividade,null);
  assert.equal(r.body.programacoes[1].situacao,"sem_registro");
});
test("consulta cruza meses",async()=>{
  const r=await ask(handler(),"/v1/programacoes?instrutorId=marcos&inicio=2026-11-30&fim=2026-12-02");
  assert.equal(r.status,200);
  assert.equal(r.body.total,3);
  assert.equal(r.body.programacoes[1].atividade,"VARGINHA");
});
test("parâmetros inválidos e duplicados são rejeitados",async()=>{
  const h=handler();
  const bad=[
    "instrutorId=../marcos&data=2026-11-06",
    "instrutorId=marcos&data=2026-02-29",
    "instrutorId=marcos&inicio=2026-10-01&fim=2026-12-01",
    "instrutorId=marcos&inicio=2026-11-07&fim=2026-11-06",
    "instrutorId=marcos&data=2026-11-06&data=2026-11-07",
    "instrutorId=marcos&data=2026-11-06&inicio=2026-11-06",
    "instrutorId=marcos&data=2026-11-06&token=sensitive"
  ];
  for(const query of bad)assert.equal((await ask(h,"/v1/programacoes?"+query)).status,400,query);
  assert.equal((await ask(h,"/v1/nao-existe")).status,404);
});
test("instrutor inativo e inexistente não retornam programação",async()=>{
  const h=handler();
  assert.equal((await ask(h,"/v1/programacoes?instrutorId=inativo&data=2026-11-06")).status,404);
  assert.equal((await ask(h,"/v1/programacoes?instrutorId=fantasma&data=2026-11-06")).status,404);
});
test("erros internos do Firestore são genéricos",async()=>{
  const h=handler(async()=>{throw Error("dados secretos");});
  const r=await ask(h,"/v1/instrutores");
  assert.equal(r.status,503);
  assert.equal(JSON.stringify(r.body).includes("dados secretos"),false);
});
test("Service Account OAuth assina JWT RS256, token secreto nunca aparece em resposta",async()=>{
  const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048,publicExponent:0x10001});
  const credentials={type:"service_account",project_id:"decam-2cf89",
    client_email:"decam-reader@decam-2cf89.iam.gserviceaccount.com",private_key_id:"test-key",
    private_key:privateKey.export({format:"pem",type:"pkcs8"}).toString()};
  let oauthCalls=0, firestoreCalls=0;
  const fetchMock=async (url,options)=>{
    if(url==="https://oauth2.googleapis.com/token"){
      oauthCalls++;
      const form=new URLSearchParams(options.body);
      assert.equal(form.get("grant_type"),"urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [head,claims,sig]=form.get("assertion").split(".");
      const tokenClaims=JSON.parse(Buffer.from(claims,"base64url").toString());
      assert.equal(tokenClaims.aud,"https://oauth2.googleapis.com/token");
      assert.equal(tokenClaims.scope,"https://www.googleapis.com/auth/datastore");
      assert.equal(tokenClaims.iss,credentials.client_email);
      assert.ok(verify("RSA-SHA256",Buffer.from(head+"."+claims),publicKey,Buffer.from(sig,"base64url")));
      return response({access_token:"token-test",token_type:"Bearer",expires_in:3600});
    }
    firestoreCalls++;
    return firestoreFetch(url,options);
  };
  const h=createWorkerHandler({cryptoImpl:webcrypto,now:NOW,fetchImpl:fetchMock});
  const env={DECAM_API_KEY_HASH:HASH,GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify(credentials)};
  assert.equal((await ask(h,"/v1/instrutores",{env})).status,200);
  assert.equal((await ask(h,"/v1/instrutores",{env})).status,200);
  assert.equal(oauthCalls,1,"token OAuth reutilizado em memória quando ainda válido");
  assert.equal(firestoreCalls,2);
});
test("token service account inválido ou indisponível não vaza credenciais",async()=>{
  const h=createWorkerHandler({cryptoImpl:webcrypto,now:NOW,fetchImpl:firestoreFetch});
  const invalid=await ask(h,"/v1/instrutores",{env:{...ENV,GOOGLE_SERVICE_ACCOUNT_JSON:"{"}});
  assert.equal(invalid.status,503);
  assert.equal(JSON.stringify(invalid.body).includes("service_account"),false);
});
