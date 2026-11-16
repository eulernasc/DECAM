# DECAM

Agenda operacional de instrutores, com dados no Firebase Spark.

## API externa (Cloudflare Workers)

A integração externa consulta instrutores e programações sem acesso administrativo. Usa Cloudflare Workers gratuito e Firestore REST, sem Firebase Blaze ou Cloud Functions. **Código pronto e testes aprovados; precisa configurar credenciais e publicar na Cloudflare para funcionar.**

- [Documentação e ativação](./API-INTEGRACAO-DECAM.md)
- Código: [worker/src/index.js](./worker/src/index.js)
- Testes automatizados: [worker/test/api.test.mjs](./worker/test/api.test.mjs)

Não envie chaves do Google ou da Cloudflare ao integrador; somente a URL real e a chave privada exclusiva da API depois que estiver ativo.
