# Gyra Qualificacao

Aplicacao web para apoio ao fluxo de credito da GP, integrando consulta ao GYRA+, dados do SAP Business One e um assistente analitico chamado MARCI.

O projeto possui duas frentes principais:

- **Motor de Credito / Qualificar Cliente**: consulta CNPJ no GYRA+, aplica a leitura das politicas de credito e gera um resumo operacional para o time.
- **MARCI**: assistente de decisao de credito que recebe perguntas por chat, consulta GYRA+ e SAP quando ha CNPJ, e retorna uma analise integrada com cards objetivos.

## Funcionalidades

### Pagina Inicial

- Direciona o usuario para o Motor de Credito ou para o MARCI.
- Mantem o fluxo antigo de credito separado da experiencia de chat.

### Motor de Credito / Qualificar Cliente

- Consulta CNPJ no GYRA+.
- Reaproveita relatorios ja criados dentro da janela configurada.
- Exibe status geral, riscos e regras de politica acionadas.
- Gera texto de resumo para copia, incluindo a estrutura de "Cadastro Rapido cliente a vista".
- Gera payload para PDF/ODG quando aplicavel.
- Permite atualizar manualmente no SAP o campo de ultima analise de credito.
- Quando o resultado indica cliente a vista/reprovado/negado, busca e exibe telefone do cliente vindo do SAP.

### MARCI

- Interface de chat para analise de credito.
- Entrada por texto com envio por `Enter`.
- Sugestoes de mensagens preenchem o input sem executar automaticamente.
- Botao de copiar resposta com fallback para navegadores sem Clipboard API segura.
- Tela protegida por PIN antes do acesso.
- Ao receber um CNPJ, consulta automaticamente GYRA+ e SAP.
- Trata GYRA+ `PENDING` com cards de acompanhamento e sugestao para verificar novamente.
- Retorna cards padronizados por categoria, como `GYRA+`, `SAP`, `Analise`, `Status` e `Acao`.
- Integra com Claude API para gerar leitura executiva quando configurado.
- Se o GYRA+ estiver `PENDING`, nao chama Claude.
- Se SAP falhar ou nao retornar dados, ainda analisa com os dados disponiveis do GYRA+.
- Quando o resultado indica cliente a vista/reprovado/negado, retorna um card com telefone do cliente.

### Integracao GYRA+

- Autenticacao via API do GYRA+.
- Criacao ou reutilizacao de relatorios por CNPJ.
- Leitura de status, risco, score, regras de politica, faturamento, limite recomendado e socios atuais.
- Tratamento especial para relatorios em processamento.

### Integracao SAP Business One

- Resolucao de `CardCode` pelo CNPJ via HANA.
- Consulta de titulos em aberto pela procedure:

```text
"SBO_GPIMPORTS"."spcGPTitulosEmAberto"
```

- Exibicao de ate 5 linhas da procedure no MARCI.
- Indicadores SAP:
  - valor total no ano atual;
  - percentual em atraso no ano atual;
  - percentual em atraso no ano anterior.
- Indicacao visual de titulos:
  - em atraso;
  - vence hoje;
  - a vencer.
- Atualizacao do campo `U_dtUltimaAnaliseCredito` via Service Layer.
- Atualizacao em lote para matriz e filiais/subcodigos relacionados pela raiz do CNPJ.
- Retornos possiveis da atualizacao SAP:
  - `success`: todos os codigos atualizados;
  - `partial`: alguns codigos atualizados;
  - `failed`: nenhum codigo atualizado;
  - `skipped`: atualizacao nao aplicavel.

## Arquitetura

### Frontend

- Vue 3.
- Vue Router.
- Axios para comunicacao com backend.
- Componentes principais:
  - `src/components/QualificarCliente.vue`
  - `src/components/MarciPage.vue`
  - `src/components/HomePage.vue`

### Backend

- Node.js com Express.
- Entrada principal: `backend/server.js`.
- Integracoes:
  - GYRA+ via REST API;
  - SAP Service Layer via HTTPS;
  - SAP HANA via `@sap/hana-client`;
  - banco local via `mysql2`/pool existente.

## Setup

### Frontend

Instale as dependencias na raiz do projeto:

```bash
npm install
```

Execute em desenvolvimento:

```bash
npm run serve
```

Gere build de producao:

```bash
npm run build
```

Execute lint:

```bash
npm run lint
```

### Backend

Entre na pasta do backend:

```bash
cd backend
```

Instale as dependencias:

```bash
npm install
```

Execute o servidor:

```bash
npm start
```

Ou diretamente:

```bash
node server.js
```

## Variaveis de Ambiente

O backend depende de variaveis para as integracoes externas. As principais sao:

```env
PORT=8080

GYRA_CLIENT_ID=
GYRA_CLIENT_SECRET=
GYRA_POLICY_ID=
MARCI_GYRA_REUSE_DAYS=45

ANTHROPIC_API_KEY=
CLAUDE_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-20250514
ANTHROPIC_MAX_TOKENS=1200

HANA_SERVER=
HANA_PORT=
HANA_UID=
HANA_PWD=
HANA_SCHEMA=

BASE_SAP=
COMPANYDB_SAP=
SAP_USER=
SAP_PASSWORD=

SAP_TITULOS_PROCEDURE="SBO_GPIMPORTS"."spcGPTitulosEmAberto"
```

Observacao: `ANTHROPIC_API_KEY` e `CLAUDE_API_KEY` sao tratados como alternativas. Basta configurar uma delas.

## Deploy / VM

Para PM2, a aplicacao backend deve apontar para `backend/server.js` usando a pasta `backend` como `cwd`.

Exemplo conceitual:

```js
module.exports = {
  apps: [
    {
      name: 'motor-credito',
      cwd: './backend',
      script: 'server.js',
      node_args: '--enable-source-maps',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
```

Depois de alterar frontend, gere o build e garanta que a VM esteja servindo o `dist` atualizado.

## Fluxo Basico Do MARCI

1. Usuario envia uma mensagem com CNPJ.
2. Backend identifica o CNPJ e roteia para analise integrada.
3. GYRA+ e consultado ou reaproveitado.
4. SAP e consultado para resolver `CardCode` e executar a procedure de titulos.
5. Se GYRA+ estiver `PENDING`, MARCI retorna acompanhamento sem chamar Claude.
6. Se houver dados suficientes e chave Claude configurada, MARCI envia o contexto para a LLM.
7. Resposta volta como JSON estruturado e o frontend renderiza texto, cards, fontes e sugestoes.

## Observacoes

- Nao commitar arquivos `.env` com credenciais.
- O backend usa certificados SAP com `rejectUnauthorized: false` no Service Layer por causa do ambiente atual.
- Arquivos temporarios de build/log nao devem ser adicionados ao git.
