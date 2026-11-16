// Exemplo seguro para BACKEND Node.js 22+ do sistema parceiro.
// Nunca coloque a chave em HTML/React/app móvel ou código público.
// Ambiente necessário: DECAM_API_BASE_URL e DECAM_API_KEY.
// Uso: node exemplos/cliente-integracao.mjs marcos 2026-11-06

const base=String(process.env.DECAM_API_BASE_URL||'').replace(/\/+$/,'');
const key=process.env.DECAM_API_KEY||'';
const id=process.argv[2];
const data=process.argv[3];
if(!base.startsWith('https://')||!key||!id||! /^\d{4}-\d{2}-\d{2}$/.test(data||'')){
  console.error('Configure DECAM_API_BASE_URL, DECAM_API_KEY e informe instrutorId e data AAAA-MM-DD');
  process.exit(1);
}
const url=new URL(base+'/v1/programacoes');
url.searchParams.set('instrutorId',id);
url.searchParams.set('data',data);
const controller=new AbortController();
const timeout=setTimeout(()=>controller.abort(),12000);
try{
  const response=await fetch(url,{method:'GET',headers:{'X-API-Key':key,'Accept':'application/json'},signal:controller.signal});
  const data=await response.json();
  if(!response.ok)throw new Error('DECAM respondeu HTTP '+response.status+': '+(data.erro||'falha'));
  // Atualize os registros do seu banco usando (instrutor.id, programacao.data).
  // Não trate DSR/férias/treinamentos como destinos de viagem.
  console.log(JSON.stringify(data,null,2));
}catch(err){
  console.error('Falha de consulta à API DECAM:',err.message);
  process.exitCode=1;
}finally{clearTimeout(timeout);}
