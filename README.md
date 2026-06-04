# Aluguel de Materiais

Aplicativo desktop (Electron) para uma cooperativa controlar o aluguel/emprestimo de materiais de comunicacao, patrocinio e brindes (baloes, banners, sinalizacao de eventos, brindes personalizados, etc.).

Os dados ficam em arquivos **CSV** que podem ser abertos e editados no Excel. Nao ha banco de dados nem servidor externo: o app funciona offline. Para uso por 2-3 pessoas ao mesmo tempo, basta apontar todos os computadores para a **mesma pasta sincronizada na nuvem** (OneDrive, Google Drive ou Dropbox).

## Recursos

- **Painel**: dashboard analitico orientado a decisao. As **agencias** sao tratadas como os "usuarios" e os **materiais** como o "produto". Inclui:
  - **Barra de filtros global** (afeta todo o painel): periodo (mes atual, ultimos 30/90 dias, ano atual, todo o historico ou intervalo personalizado), agencia, material e situacao, com botao para limpar.
  - **KPIs com comparacao** vs o periodo anterior (variacao % e mini-grafico): alugueis, unidades em uso, agencias ativas, taxa de atraso e duracao media.
  - **Insights e recomendacoes** gerados automaticamente (risco de churn, capital parado, materiais perto da capacidade, surto de atrasos) e **deteccao de anomalias** (picos/quedas semanais), alem de uma frase-resumo do que mudou.
  - **Tendencias**: alugueis ao longo do tempo (com sobreposicao do periodo anterior) e unidades em uso x taxa de atraso.
  - **Engajamento das agencias**: distribuicao da base fixa entre ativas no periodo, ativas recentemente, dormentes (>90 dias) e que nunca alugaram. **Sazonalidade das reservas**: mapa de calor por dia da semana x mes, util para planejar picos de eventos.
  - Ranking de **agencias com mais reservas** e lista de **alugueis ativos**.
  - **Desempenho de materiais**: grafico de demanda e utilizacao por material.
  - Os graficos usam a biblioteca **Chart.js** embarcada localmente (`src/renderer/vendor/`), sem necessidade de internet.
- **Materiais**: cadastro, edicao, exclusao e busca por nome/descricao. Calcula automaticamente a quantidade disponivel.
- **Agencias**: cadastro, edicao, exclusao e busca. Cada agencia tem um **codigo** numerico unico (ex.: `01`, `02`, `03`), exibido nas listas, formularios e no calendario.
- **Alugueis**: registrar retirada (material, agencia, quantidade, datas), impedir alugar mais do que o disponivel e marcar devolucao. Filtros por agencia, codigo da agencia, material, situacao, faixas de data (retirada e devolucao prevista) e somente atrasados, com botao para limpar os filtros.
- **Calendario**: visao mensal e semanal dos alugueis. Cada entrada mostra o **codigo da agencia** em destaque, seguido do material e da quantidade, para identificar rapidamente a agencia.
- **Configuracoes**: escolher a pasta dos CSV, ver os caminhos atuais, validar e criar os arquivos que faltarem.
- **Concorrencia**: lock de escrita, releitura antes de gravar e auto-refresh quando os arquivos mudam.

## Como o calculo de disponibilidade funciona

```
disponivel = quantidade_total - soma das quantidades de alugueis com status "alugado"
```

## Instalacao e execucao

Pre-requisitos: [Node.js](https://nodejs.org/) 18 ou superior.

```bash
npm install
npm start
```

No primeiro uso, a pasta de dados padrao fica dentro do perfil do usuario. Va em **Configuracoes** para mudar para a pasta desejada.

## Gerar executaveis (build)

O empacotamento usa o [electron-builder](https://www.electron.build/). Ha tres scripts:

```powershell
npm run build:portable   # gera um executavel portatil (.exe que roda sem instalar)
npm run build:exe        # gera um instalador .exe (NSIS)
npm run build:win        # gera os dois de uma vez (reaproveita o download do Electron)
```

Os artefatos sao gravados na pasta `dist/`.

### Ambientes corporativos (proxy e certificado)

Em redes corporativas, o download do Electron e dos binarios auxiliares (NSIS, winCodeSign) costuma falhar por causa de proxy e de certificados internos. Configure as variaveis de ambiente abaixo **no PowerShell, na mesma sessao** em que vai rodar o build. Nao guarde credenciais nem hosts internos no repositorio.

```powershell
# Proxy corporativo (inclua usuario:senha apenas se obrigatorio; nao versione isso)
$env:HTTP_PROXY  = "http://proxy.suaempresa:8080"
$env:HTTPS_PROXY = "http://proxy.suaempresa:8080"

# Certificado raiz da empresa (resolve "unable to get local issuer certificate")
$env:NODE_EXTRA_CA_CERTS = "C:\caminho\para\certificado-raiz.pem"

# (Opcional) Espelho interno para baixar o Electron e os binarios do electron-builder
$env:ELECTRON_MIRROR = "https://repositorio-interno/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://repositorio-interno/electron-builder-binaries/"

# Depois, rode o build normalmente:
npm run build:win
```

Para o `npm install` atras do proxy, voce tambem pode configurar o npm (uma vez):

```powershell
npm config set proxy http://proxy.suaempresa:8080
npm config set https-proxy http://proxy.suaempresa:8080
npm config set cafile "C:\caminho\para\certificado-raiz.pem"
```

### Cache local / build offline

O electron-builder reaproveita o Electron ja baixado. Para reutilizar um zip baixado previamente (ou rodar offline), aponte o cache antes do build:

```powershell
# Reaproveita/define a pasta de cache do Electron
$env:ELECTRON_CACHE = "C:\caminho\para\.cache\electron"
$env:electron_config_cache = $env:ELECTRON_CACHE
```

Fallback totalmente offline: baixe em outra maquina (com internet) o arquivo `electron-vXX.X.X-win32-x64.zip` correspondente a versao do Electron usada (veja `devDependencies` no `package.json`) e coloque-o dentro de `%LOCALAPPDATA%\electron\Cache` (ou na pasta apontada por `ELECTRON_CACHE`). Com o zip no cache, o `npm install` e o build nao precisam de rede para o Electron. Os binarios do NSIS/winCodeSign ficam em `%LOCALAPPDATA%\electron-builder\Cache` e podem ser copiados da mesma forma de uma maquina que ja gerou o build.

### Icone

Nenhum icone personalizado e fornecido: o electron-builder usa o icone padrao do Electron. Para um icone proprio, coloque um arquivo `build/icon.ico` (256x256) na raiz do projeto antes do build.

## Uso por 2-3 pessoas (pasta sincronizada)

1. Instale o app em cada computador (`npm install` + `npm start`).
2. Crie/escolha uma subpasta dentro do OneDrive/Google Drive/Dropbox (ex.: `.../Cooperativa/aluguel-dados`).
3. Em **Configuracoes**, em cada computador, selecione **essa mesma pasta**.
4. O primeiro computador cria os arquivos CSV; os demais os recebem apos a sincronizacao.
5. Recomendado: marque a pasta como "sempre disponivel neste dispositivo" no cliente de sincronizacao para reduzir o atraso.

### Como a concorrencia e tratada

- **Lock de escrita** (`.app.lock`): antes de gravar, o app cria um arquivo de trava na pasta. Se outra pessoa estiver salvando, voce vera "tente novamente em instantes". Travas orfas (app fechado no meio) sao liberadas automaticamente apos ~15s.
- **Releitura antes de gravar**: toda alteracao le o CSV mais recente do disco, aplica apenas a mudanca daquele registro e grava de forma atomica (arquivo temporario + rename). Duas pessoas editando registros diferentes nao se sobrescrevem.
- **Revalidacao de regras**: o limite de disponibilidade e checado com os dados frescos do disco, evitando que duas pessoas aluguem a ultima unidade.
- **Auto-refresh**: o app observa a pasta e recarrega sozinho quando detecta mudancas (suas ou de outro computador). Tambem ha o botao **Atualizar**.

Na pratica, o fluxo e este:

1. Cada instalacao do app recebe um `userId` local, salvo em `settings.json`. Ele nao e login nem permissao; serve apenas para identificar quem criou o lock.
2. Antes de salvar qualquer material, agencia ou aluguel, o app tenta criar `.app.lock` na pasta de dados usando criacao exclusiva de arquivo. Se o arquivo ja existe, ele espera alguns segundos. Se o lock ficou sem atualizacao por tempo demais, e tratado como orfao e pode ser removido.
3. Depois de obter o lock, o app rele o CSV do disco. Ou seja, ele nao grava em cima do estado antigo que estava na tela; ele pega a versao mais recente, aplica a mudanca solicitada e so entao grava.
4. A gravacao e atomica: primeiro escreve um arquivo temporario e depois renomeia por cima do CSV final. Isso reduz o risco de arquivo truncado se o app fechar no meio da operacao.
5. Em edicoes, o app envia junto o estado original do registro (`_baseline`). Se outro usuario alterou o mesmo registro entre o carregamento da tela e o salvamento, a operacao e recusada com conflito e o usuario deve recarregar.
6. Regras sensiveis sao recalculadas dentro do lock. Por exemplo: ao criar ou editar um aluguel ativo, a disponibilidade do material e recalculada com os alugueis atuais do CSV, para evitar alugar mais unidades do que existem.

Esse mecanismo e adequado para poucas pessoas usando ocasionalmente a mesma pasta sincronizada. Ele evita a maioria dos conflitos comuns, mas nao substitui um banco de dados com transacoes.

### Limitacoes (importante)

- Uma pasta CSV sincronizada **nao** e um banco de dados transacional. Existe um atraso de sincronizacao (alguns segundos): mudancas de um computador so aparecem nos outros depois que a nuvem sincroniza.
- Em casos raros de duas gravacoes do mesmo arquivo dentro da janela de sincronizacao, o provedor pode gerar um arquivo de "copia em conflito". As protecoes reduzem muito esse risco, mas nao o eliminam no nivel do provedor de nuvem. Para 2-3 pessoas com uso ocasional, isso e aceitavel.
- Se um CSV estiver **aberto no Excel**, a gravacao do app pode falhar com uma mensagem clara (em vez de corromper o arquivo). Feche o Excel antes de salvar pelo app.

## Esquema dos CSV

Todos UTF-8 (com BOM), **separados por ponto-e-virgula (`;`)**, com linha de cabecalho. Os nomes das colunas estao em portugues. Valores que contenham `;`, aspas ou quebras de linha sao automaticamente protegidos com aspas.

Toda linha possui duas colunas de data/hora:
- `adicionado_em`: preenchida apenas na criacao do registro.
- `alterado_em`: atualizada a cada edicao do registro.

Formato das datas/hora: `YYYY-MM-DD HH:mm:ss` (horario local).

### `materiais.csv`
`id; nome; descricao; quantidade_total; observacoes; cor; adicionado_em; alterado_em`

### `agencias.csv`
`id; codigo; nome; contato; telefone; email; observacoes; adicionado_em; alterado_em`

- `codigo`: identificador numerico curto e unico da agencia (ex.: `01`, `02`, `103`). Os zeros a esquerda sao preservados (o valor e tratado como texto, nunca convertido para numero). Observacao: ao editar o CSV no Excel, ele pode remover zeros a esquerda; formate a coluna como **Texto** se for editar por la.

### `alugueis.csv`
`id; id_material; id_agencia; quantidade; data_retirada; data_prevista_devolucao; data_devolucao; situacao; observacoes; adicionado_em; alterado_em`

- `situacao`: `alugado` ou `devolvido`
- datas (`data_*`) no formato `YYYY-MM-DD`
- `id`, `id_material`, `id_agencia` gerados automaticamente (nao edite manualmente)

## Migracao de dados antigos

Versoes anteriores usavam arquivos com nomes em ingles, separados por virgula e sem colunas de data (`materials.csv`, `agencies.csv`, `rentals.csv`).

Na primeira vez que o app abrir apos a atualizacao, se esses arquivos antigos existirem na pasta de dados, eles sao convertidos automaticamente para o novo formato (`materiais.csv`, `agencias.csv`, `alugueis.csv`): virgula vira ponto-e-virgula, os cabecalhos passam para portugues e as colunas `adicionado_em`/`alterado_em` sao adicionadas (em branco para os registros antigos, pois a data original e desconhecida).

Os arquivos antigos **nao sao apagados** - ficam como backup e podem ser removidos manualmente depois que voce confirmar que a migracao deu certo. Em pasta compartilhada na nuvem, deixe um computador atualizar primeiro: ele cria os arquivos novos e os demais apenas recebem pela sincronizacao.

### Atualizacao de colunas (codigo de agencia e remocao de categoria)

Esta versao adiciona a coluna `codigo` em `agencias.csv` e remove a coluna `categoria` de `materiais.csv`. A atualizacao do cabecalho dos arquivos ja existentes (no formato novo) e feita automaticamente ao abrir o app, de forma segura:

- A leitura tolera colunas faltando (viram vazio) e ignora colunas removidas, entao os dados continuam corretos imediatamente.
- Quando o cabecalho difere do esquema atual, o app rele e regrava o arquivo com gravacao atomica (arquivo temporario + rename), **sem perder dados**. Salvar qualquer registro tambem atualiza o arquivo.
- Para as agencias ja existentes, o `codigo` fica **em branco** ate que voce edite cada agencia e atribua um codigo (o campo e obrigatorio e unico na edicao). Na lista, agencias sem codigo aparecem com `-`.

## Estrutura do projeto

```
aluguel-materiais/
  package.json
  README.md
  src/
    main/
      main.js        # ciclo de vida do app, janela, observador da pasta
      settings.js    # settings.json, caminhos dos CSV, userId
      csvStore.js    # leitura/escrita CSV atomica, criacao de arquivos
      lock.js        # trava de escrita (lock) com heartbeat
      ipc.js         # handlers IPC + regras de negocio
    preload/
      preload.js     # contextBridge -> window.api
    renderer/
      index.html     # layout, navegacao, modais
      styles.css     # tema admin
      app.js         # telas, tabelas, formularios, validacao, render do painel
      analytics.js   # funcoes puras de analise do painel (KPIs, cohorts, segmentos, etc.)
      vendor/
        chart.umd.min.js  # Chart.js embarcado (graficos do painel, offline)
```

## Premissas

- Interface em portugues (pt-BR), renderer em HTML/CSS/JS puro (sem etapa de build).
- Tres arquivos CSV separados (mais limpo que um arquivo unico).
- 2-3 usuarios simultaneos de baixa frequencia, via pasta sincronizada na nuvem.
- Datas tratadas como texto `YYYY-MM-DD` (sem fuso horario).
- Quantidades sao inteiros nao negativos.
- Editar os CSV no Excel e suportado; o app rele ao carregar, no auto-refresh e no botao Atualizar.
- Nao e possivel excluir material/agencia com aluguel ativo (protege a integridade dos dados).
