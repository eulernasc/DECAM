'use strict';

const {createHash,timingSafeEqual}=require('node:crypto');
const MAX_DAYS=31;
const MINUTE_QUOTA=60; // Limite aproximado POR INSTÂNCIA, não um rate limit distribuído.
const buckets=new Map();

function digest(value){return createHash('sha256').update(value,'utf8').digest();}
function isAuthorized(raw,storedHex){
  if(typeof raw!=='string'||!/^decam_[a-f0-9]{64}$/.test(raw))return false;
  if(typeof storedHex!=='string'||!/^[a-f0-9]{64}$/.test(storedHex))return false;
  return timingSafeEqual(digest(raw),Buffer.from(storedHex,'hex'));
}
function isDay(str){
  if(typeof str!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(str))return false;
  const [y,m,d]=str.split('-').map(Number);
  if(y<2020||y>2100||m<1||m>12)return false;
  const utc=new Date(Date.UTC(y,m-1,d));
  return utc.getUTCFullYear()===y&&utc.getUTCMonth()===m-1&&utc.getUTCDate()===d;
}
function daysBetween(inicio,fim){
  const start=Date.parse(inicio+'T00:00:00.000Z'),end=Date.parse(fim+'T00:00:00.000Z');
  const span=(end-start)/86400000+1;
  if(span<1||span>MAX_DAYS)return null;
  return Array.from({length:span},(_,i)=>new Date(start+i*86400000).toISOString().slice(0,10));
}
function throttled(key,now){
  const minute=Math.floor(now.getTime()/60000);
  const bucket=key+'-'+minute;
  for(const oldKey of buckets.keys())if(!oldKey.endsWith('-'+minute))buckets.delete(oldKey);
  const count=(buckets.get(bucket)||0)+1;
  buckets.set(bucket,count);
  return count>MINUTE_QUOTA;
}
function respond(res,code,data){
  res.status(code).json(data);
}
function jsonHeaders(res){
  res.setHeader('Cache-Control','private, no-store, max-age=0');
  res.setHeader('Pragma','no-cache');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Vary','X-API-Key');
}
function validQuery(query,allowed){
  return Object.keys(query||{}).every(key=>allowed.includes(key)&&typeof query[key]==='string');
}
function createApiHandler({getDb,getKeyHash,clock=()=>new Date(),logError=()=>{}}){
  if(typeof getDb!=='function'||typeof getKeyHash!=='function')throw Error('Dependências inválidas');
  return async function decamHandler(req,res){
    jsonHeaders(res);
    if(req.method!=='GET'){
      res.setHeader('Allow','GET');
      return respond(res,405,{erro:'Método não permitido'});
    }
    const key=String(req.headers?.['x-api-key']||'');
    let hash;
    try{hash=getKeyHash();}catch(_e){return respond(res,503,{erro:'Integração indisponível'});}
    if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))return respond(res,503,{erro:'Integração indisponível'});
    if(!isAuthorized(key,hash))return respond(res,401,{erro:'Chave de integração inválida'});
    const now=clock();
    if(throttled(hash.slice(0,16),now))return respond(res,429,{erro:'Limite temporário de consultas excedido'});
    const path=String(req.path||req.url?.split('?')[0]||'').replace(/\/+$/,'');
    try{
      if(path==='/v1/instrutores'){
        if(!validQuery(req.query||{},[]))return respond(res,400,{erro:'Parâmetros não aceitos'});
        const snap=await getDb().collection('instrutores').get();
        const itens=snap.docs
          .filter(doc=>doc.data()?.ativo!==false)
          .map(doc=>({id:doc.id,nome:String(doc.data()?.nome||'').trim()}))
          .filter(i=>i.nome)
          .sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'));
        return respond(res,200,{instrutores:itens,total:itens.length,consultadoEm:now.toISOString()});
      }
      if(path==='/v1/programacoes'){
        const q=req.query||{};
        if(!validQuery(q,['instrutorId','data','inicio','fim']))
          return respond(res,400,{erro:'Parâmetros inválidos'});
        const id=q.instrutorId;
        if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))
          return respond(res,400,{erro:'instrutorId inválido'});
        const single=typeof q.data==='string';
        if(single&&(q.inicio!==undefined||q.fim!==undefined))
          return respond(res,400,{erro:'Informe data OU inicio e fim'});
        if(!single&&(typeof q.inicio!=='string'||typeof q.fim!=='string'))
          return respond(res,400,{erro:'Informe data OU inicio e fim'});
        const inicio=single?q.data:q.inicio, fim=single?q.data:q.fim;
        if(!isDay(inicio)||!isDay(fim))
          return respond(res,400,{erro:'Data inválida. Use AAAA-MM-DD'});
        const dates=daysBetween(inicio,fim);
        if(!dates)return respond(res,400,{erro:'Período inválido. Máximo de 31 dias'});
        const db=getDb();
        const inst=await db.collection('instrutores').doc(id).get();
        if(!inst.exists||inst.data()?.ativo===false)return respond(res,404,{erro:'Instrutor não encontrado'});
        const nome=String(inst.data()?.nome||'').trim();
        if(!nome)return respond(res,404,{erro:'Instrutor não encontrado'});
        const months=[...new Set(dates.map(day=>day.slice(0,7)))];
        const monthDocs=await Promise.all(months.map(async month=>{
          const doc=await db.collection('agenda').doc(id+'_'+month).get();
          return [month,doc.exists?doc.data()?.dias||{}:{}];
        }));
        const monthMap=Object.fromEntries(monthDocs);
        const programacoes=dates.map(day=>{
          const dia=day.slice(8,10);
          const entry=monthMap[day.slice(0,7)]?.[dia];
          const atividade=typeof entry?.atividade==='string'&&entry.atividade.trim()?entry.atividade.trim():null;
          return {
            data:day,
            atividade,
            carroAgendado:entry?.carro===true,
            paytrack:entry?.paytrack===true,
            situacao:!entry?'sem_registro':atividade?'programado':'sem_atividade'
          };
        });
        return respond(res,200,{
          instrutor:{id,nome},inicio,fim,programacoes,total:programacoes.length,
          consultadoEm:now.toISOString()
        });
      }
      return respond(res,404,{erro:'Rota não encontrada'});
    }catch(err){
      // Nunca envia exceções, documentos ou dados de autenticação para o consumidor.
      logError(err?.code||'internal_error');
      return respond(res,503,{erro:'Não foi possível consultar a programação agora'});
    }
  };
}
module.exports={createApiHandler,isAuthorized,isDay,daysBetween};
