'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createApiHandler,isDay,daysBetween}=require('../api');

const API_KEY='decam_'+'a'.repeat(64); // apenas uma chave FALSA para testes, sem valor de produção
const HASH=createHash('sha256').update(API_KEY).digest('hex');
const clock=()=>new Date('2026-11-16T12:00:00.000Z');
function fakeDoc(data){return data?{exists:true,data:()=>data}:{exists:false,data:()=>undefined};}
function mockDb(){
  const people={
    marcos:{nome:'Marcos Batista Freire',ativo:true,cpf:'00000000000',email:'nao-expor@invalid.test'},
    izaias:{nome:'Izaías de Sene',ativo:true},
    inativo:{nome:'Ex-instrutor',ativo:false}
  };
  const schedule={
    'marcos_2026-11':{dias:{'06':{atividade:'BETIM',carro:true,paytrack:true},'07':{atividade:'DSR',carro:false,paytrack:false}}},
    'marcos_2026-12':{dias:{'01':{atividade:'VARGINHA',carro:false,paytrack:true}}}
  };
  return {collection(name){
    if(name==='instrutores')return {
      get:async()=>({docs:Object.keys(people).map(id=>({id,data:()=>people[id]}))}),
      doc:id=>({get:async()=>fakeDoc(people[id])})
    };
    if(name==='agenda')return {doc:id=>({get:async()=>fakeDoc(schedule[id])})};
    throw Error('Coleção não permitida');
  }};
}
function response(){
  return {code:0,headers:{},body:null,
    setHeader(k,v){this.headers[k]=v;return this;},
    status(code){this.code=code;return this;},
    json(data){this.body=data;return this;}
  };
}
async function call(path,query={},key=API_KEY,opts={}){
  const res=response();
  const handler=createApiHandler({
    getDb:opts.getDb||mockDb,getKeyHash:opts.getKeyHash||(()=>HASH),
    clock,logError:()=>{}
  });
  await handler({method:opts.method||'GET',path,query,headers:key?{'x-api-key':key}:{}},res);
  return res;
}

test('calendário valida datas reais e limita intervalo',()=>{
  assert.equal(isDay('2026-02-29'),false);
  assert.equal(isDay('2028-02-29'),true);
  assert.equal(isDay('2026-11-06'),true);
  assert.equal(daysBetween('2026-11-30','2026-12-01').length,2);
  assert.equal(daysBetween('2026-11-01','2026-12-02'),null);
});
test('chave ausente/inválida impede qualquer consulta',async()=>{
  assert.equal((await call('/v1/instrutores',{},null)).code,401);
  assert.equal((await call('/v1/programacoes',{instrutorId:'marcos',data:'2026-11-06'},'decam_'+'0'.repeat(64))).code,401);
  assert.equal((await call('/v1/instrutores',{},API_KEY,{getKeyHash:()=>''})).code,503);
});
test('GET apenas, sem CORS e sem cache',async()=>{
  const post=await call('/v1/instrutores',{},API_KEY,{method:'POST'});
  assert.equal(post.code,405);
  assert.equal(post.headers.Allow,'GET');
  const get=await call('/v1/instrutores');
  assert.equal(get.headers['Cache-Control'],'private, no-store, max-age=0');
  assert.equal(get.headers['Access-Control-Allow-Origin'],undefined);
});
test('instrutores expõe exclusivamente ID e nome ativos',async()=>{
  const r=await call('/v1/instrutores');
  assert.equal(r.code,200);
  assert.equal(r.body.total,2);
  assert.deepEqual(r.body.instrutores.map(x=>x.id),['izaias','marcos']);
  assert.equal(JSON.stringify(r.body).includes('cpf'),false);
  assert.equal(JSON.stringify(r.body).includes('nao-expor'),false);
});
test('retorna programação de Marcos em Betim em 06/11',async()=>{
  const r=await call('/v1/programacoes',{instrutorId:'marcos',data:'2026-11-06'});
  assert.equal(r.code,200);
  assert.equal(r.body.instrutor.nome,'Marcos Batista Freire');
  assert.equal(r.body.total,1);
  assert.deepEqual(r.body.programacoes[0],{
    data:'2026-11-06',atividade:'BETIM',carroAgendado:true,paytrack:true,situacao:'programado'
  });
});
test('DSR continua atividade, sem inferir que é destino',async()=>{
  const r=await call('/v1/programacoes',{instrutorId:'marcos',data:'2026-11-07'});
  assert.equal(r.body.programacoes[0].atividade,'DSR');
  assert.equal(r.body.programacoes[0].situacao,'programado');
});
test('sem registro não inventa destino e não usa arquivo estático',async()=>{
  const r=await call('/v1/programacoes',{instrutorId:'marcos',data:'2026-11-11'});
  assert.equal(r.code,200);
  assert.equal(r.body.programacoes[0].atividade,null);
  assert.equal(r.body.programacoes[0].situacao,'sem_registro');
});
test('intervalo cruza mês sem duplicar dados',async()=>{
  const r=await call('/v1/programacoes',{instrutorId:'marcos',inicio:'2026-11-30',fim:'2026-12-02'});
  assert.equal(r.code,200);
  assert.equal(r.body.total,3);
  assert.equal(r.body.programacoes[1].atividade,'VARGINHA');
});
test('valida parâmetros e intervalo excessivo',async()=>{
  for(const q of [
    {instrutorId:'marcos',data:'2026-02-29'},
    {instrutorId:'marcos',inicio:'2026-10-01',fim:'2026-11-10'},
    {instrutorId:'../marcos',data:'2026-11-06'},
    {instrutorId:'marcos',data:['2026-11-06','2026-11-07']},
    {instrutorId:'marcos',data:'2026-11-06',inicio:'2026-11-06',fim:'2026-11-07'}
  ]){
    const r=await call('/v1/programacoes',q);assert.equal(r.code,400,JSON.stringify(q));
  }
});
test('nunca revela instrutores desativados nem cria credenciais',async()=>{
  assert.equal((await call('/v1/programacoes',{instrutorId:'inativo',data:'2026-11-06'})).code,404);
  assert.equal((await call('/v1/programacoes',{instrutorId:'ninguém',data:'2026-11-06'})).code,400);
  assert.equal((await call('/v1/programacoes',{instrutorId:'fantasma',data:'2026-11-06'})).code,404);
});
test('erros internos retornam resposta genérica',async()=>{
  const r=await call('/v1/instrutores',{},API_KEY,{getDb:()=>({collection:()=>{throw Error('segredo interno');}})});
  assert.equal(r.code,503);
  assert.equal(JSON.stringify(r.body).includes('segredo interno'),false);
});
