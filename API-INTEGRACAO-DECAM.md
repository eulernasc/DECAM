# DECAM — API Cloudflare (Firebase Spark)

**Status:** API implementada, testada e compilada. Ainda NÃO está online: falta configurar a Cloudflare e as credenciais do Google. **Não precisa de Blaze**.

## O que será entregue ao parceiro depois de ativar

- URL real HTTPS do Worker (Cloudflare informa depois do deploy).
- Chave de integração privada iniciada por decam_; deve ficar apenas no servidor do parceiro.
- Endpoints GET /v1/instrutores e GET /v1/programacoes.

## Consultas

Listar instrutores ativos: GET URL_REAL/v1/instrutores
Programação de um dia: GET URL_REAL/v1/programacoes?instrutorId=marcos&data=2026-11-06
Até 31 dias: GET URL_REAL/v1/programacoes?instrutorId=marcos&inicio=2026-11-01&fim=2026-11-30

Todas as chamadas precisam do cabeçalho HTTP X-API-Key com a chave privada.

Exemplo de programação fictícia: Marcos, 06/11/2026, atividade BETIM, carroAgendado true, paytrack true. A API real devolve os dados atuais do Firestore; a atividade também pode ser DSR, FÉRIAS, treinamento etc., não necessariamente uma cidade.

Retorno JSON: instrutor {id,nome}; inicio, fim; programacoes [{data,atividade,carroAgendado,paytrack,situacao}]; total; consultadoEm.
Situações possíveis: programado, sem_atividade, sem_registro. O sistema parceiro deverá consultar periodicamente, por exemplo a cada 15 minutos, e atualizar por instrutor.id + data. A API não envia webhooks.

## Passo 1 — Conta de serviço somente leitura no Google Cloud

Acessar: https://console.cloud.google.com/iam-admin/serviceaccounts?project=decam-2cf89

1. Criar conta de serviço nova e exclusiva (decam-api-readonly).
2. Dar somente o papel Cloud Datastore Viewer (roles/datastore.viewer). NÃO usar Owner/Editor/Datastore User.
3. Na aba Keys, gerar chave privada JSON, se a política permitir. Manter em local seguro, nunca enviar ao amigo, ao ChatGPT, ao GitHub ou ao frontend.

ATENÇÃO: contas de serviço acessam dados com IAM, ignorando regras de segurança dos aplicativos Firestore. A permissão viewer dá acesso de leitura a outras coleções do projeto, mesmo que nossa API exponha só duas. Se a chave for comprometida, revogue-a imediatamente. A criação de chaves pode estar bloqueada por política organizacional; não a desative sem avaliar a segurança.

## Passo 2 — Cloudflare Workers Free

Abrir https://dash.cloudflare.com/ e criar conta gratuita. Na pasta DECAM/worker, usando Node.js 22+ instalado:

    npm install
    npx wrangler login
    npx wrangler deploy

O deploy cria o Worker decam-consulta-api. Antes de configurar os segredos, ele não permite consultas.

## Passo 3 — Segredos na Cloudflare

Na pasta raiz DECAM, executar localmente (a chave gerada NÃO deve ser colada em conversa):

    node scripts/gerar-chave-api.cjs

O comando mostra uma chave privada decam_... para o parceiro e um hash SHA-256 de 64 caracteres.

Cloudflare → Workers & Pages → decam-consulta-api → Settings → Variables and Secrets → Add Secret:

- DECAM_API_KEY_HASH: colar somente o HASH gerado.
- GOOGLE_SERVICE_ACCOUNT_JSON: colar o conteúdo integral do JSON da conta de serviço.

Ambos precisam ser do tipo Secret. NÃO adicionar no wrangler.toml, no GitHub ou no HTML.
É possível usar a CLI na pasta worker: npx wrangler secret put DECAM_API_KEY_HASH e npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON.
Se preferir a CLI para o JSON, preserve todos os caracteres/newlines e nunca copie a credencial para um comando versionado. Reimplantar se necessário: npx wrangler deploy.

## Passo 4 — Testar e entregar

Copiar a URL HTTPS real terminada em workers.dev informada pela Cloudflare. Verificar do servidor (não navegador):

    curl -H "X-API-Key: SUA_CHAVE_PRIVADA" "URL_REAL/v1/instrutores"
    curl -H "X-API-Key: SUA_CHAVE_PRIVADA" "URL_REAL/v1/programacoes?instrutorId=marcos&data=2026-11-06"

Chave inválida deve responder 401. URL, chave privada e exemplos de rotas são os únicos dados para enviar ao parceiro. Não expor a credencial de serviço Google.

## Segurança, limites e validação

- API HTTP GET apenas, autenticada por chave de 256 bits; Worker guarda hash da chave, e JSON Google é protegido em segredo separado.
- Google Service Account assina JWT RS256 pelo WebCrypto para receber token OAuth2 e consultar somente os documentos necessários em Firestore REST.
- Não expõe CPF, telefone ou email; máximo de 31 dias por solicitação; bloqueia parâmetros duplicados; não habilita CORS; resposta sem cache.
- Controle aproximado de 60 chamadas/min por isolate, não limite global distribuído. Cloudflare Workers Free tem cota diária e limite de CPU; Firestore Spark também tem cotas de leitura. Acima delas, as consultas podem falhar.
- O plano Spark permanece ativo, sem Cloud Functions. Código antigo em functions/ e firebase.json é legado, NÃO usar para ativar esta integração.
- Testes e empacotamento sem publicação: .github/workflows/worker-check.yml; módulo: worker/src/index.js; configuração: worker/wrangler.toml.
- O campo consultadoEm é o instante da API, não o momento em que a agenda foi editada.
