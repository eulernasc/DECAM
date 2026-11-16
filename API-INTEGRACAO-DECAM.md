# DECAM | API de consulta de programações (v1)

**Situação:** código pronto para implantação. **Não está online até concluir o deploy do Firebase**.
Repositório público: somente implementação e documentação. Nenhuma chave real foi publicada.

## Finalidade e origem dos dados

Permitir que um integrador autorizado atualize o próprio sistema consultando periodicamente os dados **atuais** da agenda DECAM no Firestore do projeto \`decam-2cf89\`. Não é necessário editar a agenda do DECAM.

A coleção \`instrutores\` contém os IDs/nome; os documentos da coleção \`agenda\` seguem \`{instrutorId}_{AAAA-MM}\` e o campo \`dias.{DD}\` guarda \`atividade\`, \`carro\`, \`paytrack\`. A API não usa o JSON de importação armazenado em \`index.html\`.

**Atenção:** \`atividade\` é texto livre (por exemplo \`BETIM\`, \`DSR\`, \`FÉRIAS\`, \`TREINAMENTO\`). Não se deve interpretar automaticamente toda atividade como destino de viagem. Não há horários na estrutura atual.

## Segurança

- Somente requisições HTTPS **GET** e campos explicitamente autorizados; não há criação, edição nem exclusão.
- Header obrigatório \`X-API-Key: decam_<64 caracteres hexadecimais>\`. O Firebase guarda **apenas o hash SHA-256** dessa chave em Cloud Secret Manager (\`DECAM_API_KEY_HASH\`), não a chave original.
- A API foi pensada para conexão **servidor a servidor**: **não inserir a chave no HTML, JavaScript do navegador, URLs, repositório, analytics ou logs**.
- A função precisa aceitar invocação HTTP externa (Cloud Run), mas rejeita consultas de dados sem chave válida. CORS desativado para reduzir uso indevido pelo navegador; CORS não é uma medida de autenticação.
- Saídas não incluem CPF, e-mail, telefone, matrícula nem outros campos do cadastro.
- Há um limite de 60 consultas/minuto **por instância**, não uma cota global distribuída. Para controles globais avançados é necessário configurar política de API Gateway/Cloud Armor.
- Respostas marcadas como \`Cache-Control: no-store\`; máximo de 31 dias por consulta; \`maxInstances: 3\` para limitar escala/custo. Monitore faturamento e configure alertas.

## Rotas

Prefixo: **URL real da função \`decamApi\` informada após a implantação** (ex.: \`https://REGIAO-PROJETO.cloudfunctions.net/decamApi\`; não usar exemplo como endereço operacional).

### 1. GET /v1/instrutores

Sem parâmetros. Lista instrutores ativos (somente \`id\` e \`nome\`).

Exemplo de resposta:

\`\`\`json
{
  "instrutores": [{"id":"marcos","nome":"Marcos Batista Freire"}],
  "total":1,
  "consultadoEm":"2026-11-16T12:00:00.000Z"
}
\`\`\`

### 2. GET /v1/programacoes?instrutorId=marcos&data=2026-11-06

\`\`\`json
{
  "instrutor":{"id":"marcos","nome":"Marcos Batista Freire"},
  "inicio":"2026-11-06",
  "fim":"2026-11-06",
  "programacoes":[{
    "data":"2026-11-06",
    "atividade":"BETIM",
    "carroAgendado":true,
    "paytrack":true,
    "situacao":"programado"
  }],
  "total":1,
  "consultadoEm":"2026-11-16T12:00:00.000Z"
}
\`\`\`

**Importante:** o JSON de Betim é **ilustrativo**, inspirado no print. Não foi consultada uma gravação real do Firestore. A API retornará o que estiver salvo no Firestore no instante da consulta.

### 3. GET /v1/programacoes?instrutorId=marcos&inicio=2026-11-01&fim=2026-11-30

Retorna \`programacoes\` com todos os dias do intervalo, inclusive aqueles sem registro. Aceita no máximo 31 dias; a consulta pode cruzar meses.

Valores de \`situacao\`:

- \`programado\`: existe texto de atividade.
- \`sem_atividade\`: existe registro do dia, mas sem texto.
- \`sem_registro\`: o dia não existe na agenda salva.

### Códigos de erro

\`400\` argumentos inválidos; \`401\` sem chave válida; \`404\` instrutor inexistente/inativo ou rota desconhecida; \`405\` método diferente de GET; \`429\` limite temporário; \`503\` segredo não provisionado ou falha transitória na consulta. Não expor erros detalhados ao integrador.

## Ativação no Firebase (etapa ainda pendente)

**Pré-requisito:** Firebase \`decam-2cf89\` no plano **Blaze** e usuário com permissão de deploy de Cloud Functions e Secret Manager. Cloud Functions precisa de conta de faturamento, mesmo possuindo franquia sem custo. Não há implantação automática a partir do GitHub Pages.

Execute na pasta raiz do projeto com Node.js 22 instalado:

\`\`\`bash
node scripts/gerar-chave-api.cjs
\`\`\`

O comando mostra **uma chave privada** para o integrador e **seu hash SHA-256**. Salve a chave em cofre e nunca faça commit ou envie em canal público.

Instale/use a CLI, autentique e grave o **HASH** no Secret Manager:

\`\`\`bash
npx firebase-tools@latest login
npx firebase-tools@latest functions:secrets:set DECAM_API_KEY_HASH --project decam-2cf89
\`\`\`

Quando a CLI pedir o valor do segredo, **cole apenas o HASH de 64 caracteres, não a chave**.

Confira as mudanças e implante somente a codebase da integração:

\`\`\`bash
npx firebase-tools@latest deploy --only functions:decam-integration --project decam-2cf89
\`\`\`

A função é \`decamApi\` na região \`southamerica-east1\`. A CLI mostrará a URL HTTPS **real**. Copie essa URL antes de enviar ao integrador. Não aceite qualquer solicitação de exclusão de função não relacionada.

Para atualizar/rotacionar a chave, gere outro par e atualize o Secret Manager. Depois **publique novamente a função** para usar a nova versão do segredo; a chave antiga deixa de funcionar.

### Teste após publicação

No **servidor do integrador**, nunca no navegador:

\`\`\`bash
curl --fail-with-body -H "X-API-Key: SUA_CHAVE_PRIVADA" "URL_REAL/v1/instrutores"
curl --fail-with-body -H "X-API-Key: SUA_CHAVE_PRIVADA" "URL_REAL/v1/programacoes?instrutorId=marcos&data=2026-11-06"
\`\`\`

A resposta deve corresponder à agenda atual do DECAM. Verifique retorno 401 com chave errada e 405 para POST. Somente depois disponibilize a integração para produção.

## Contrato de atualização do sistema do integrador

Esta é uma **API de consulta**, não um webhook. **A API não envia atualizações sozinha**: o sistema parceiro deve consultar periodicamente, como a cada 15 minutos, armazenando a última programação recebida e atualizando-a por \`instrutor.id + data\`. Também deve remover/substituir a programação anterior caso o DECAM altere uma atividade. Use \`consultadoEm\` como o horário da consulta, não como a data da última alteração da agenda.

Não integre por leitura direta do Firestore: a chave de acesso à API só dá acesso às duas rotas aprovadas, não às demais coleções. Este sistema de integração não permite marcar voagens nem modificar operações.
