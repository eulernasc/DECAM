'use strict';

// Serviço isolado de leitura. Não expõe o Admin SDK ao navegador DECAM.
const {onRequest}=require('firebase-functions/v2/https');
const {defineSecret}=require('firebase-functions/params');
const {logger}=require('firebase-functions');
const {initializeApp,getApps}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const {createApiHandler}=require('./api');

if(!getApps().length)initializeApp();
const apiKeyHash=defineSecret('DECAM_API_KEY_HASH');
const handler=createApiHandler({
  getDb:()=>getFirestore(),
  getKeyHash:()=>apiKeyHash.value(),
  logError:code=>logger.error('DECAM read-only integration query failed',{code})
});

exports.decamApi=onRequest({
  region:'southamerica-east1',
  secrets:[apiKeyHash],
  cors:false,
  invoker:'public', // Acesso HTTP aberto, mas TODOS os dados exigem X-API-Key válida.
  memory:'256MiB',
  cpu:1,
  timeoutSeconds:30,
  maxInstances:3,
  concurrency:30,
},handler);
