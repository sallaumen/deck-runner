# Projetos e agentes

## Perfis

| Perfil | Ambiente e comandos |
|---|---|
| `mix` | Elixir e PostgreSQL. Executa `mix test` ou verificações do projeto com `format`, `compile`, `lint`, `gate`, `credo` e `sobelow`. |
| `node` | Node 22 e npm. Com package-lock usa `npm ci`. Aceita `npm test` e `node --test`. |
| `python` | Python da imagem e biblioteca padrão. Executa `python3 -m unittest discover`. |
| `custom` | Imagem OCI já instalada no Deck e comando cadastrado como lista de argumentos. As dependências fazem parte da imagem. |

```sh
deck-runner projects
deck-runner add ~/projects/catalogo --profile mix --db-user postgres --port 5432
deck-runner add ~/projects/estudio --profile mix --image localhost/deck-runner:audio --no-test-partition
deck-runner add ~/projects/site --profile node
deck-runner add ~/projects/analise --profile custom --image localhost/analise:test --test '["python3","-m","pytest"]'
```

Use o usuário e a porta configurados no ambiente de testes do projeto. A senha do PostgreSQL descartável é igual ao nome do usuário. Cada container recebe um PostgreSQL próprio. O perfil Mix define `MIX_TEST_PARTITION` por tarefa. Use `--no-test-partition` quando a suíte depende do nome padrão do banco. Uma imagem Mix alternativa precisa fornecer o mesmo ambiente de inicialização da imagem base.

Com o projeto ocioso, repita `add` com a configuração completa e `--update` para alterá-la. `remove NOME` arquiva o cadastro e conserva o histórico. O comando `projects` descobre repositórios no primeiro nível de `~/projects`; `add` também aceita repositórios em subpastas. Clones independentes têm identidades distintas.

## Contrato de execução

Na aba **Na fila**, cada tarefa mostra quanto tempo já esperou. Ao passar o mouse sobre o cronômetro, aparece a hora de entrada.

1. Consulte `status` para saber se o Deck está disponível. Envie o **worktree real**, inclusive com edições locais. Informe o agente e a tarefa em `--agent` e uma descrição curta em `--label`.
2. Guarde o ID retornado por `submit`. `wait ID` acompanha até o resultado e devolve código 0 para sucesso, 1 para tarefa sem sucesso ou 2 para erro de comunicação. `job ID` inclui a revisão original, a árvore enviada, o resultado, horários e memória de pico. O cabeçalho do log no painel também mostra o pico de RAM medido e o código de saída registrado.
3. Após editar o código, envie um novo snapshot. Se a conexão cair após começar o envio e antes de receber o ID, consulte o painel pela descrição antes de reenviar. Para cancelar a própria tarefa, use `cancel ID`.
4. Mantenha verificações específicas de macOS, navegador ou release nos ambientes exigidos pelo projeto.

O snapshot contém o conteúdo atual dos arquivos versionados e arquivos novos não ignorados, com limite de 1 GiB. Exclusões entram na árvore. O bundle Git usa um commit sem ancestrais. Submódulos e links para fora do projeto exigem adaptação. Os filtros de arquivos sensíveis estão descritos em [SECURITY.md](../SECURITY.md).

Para suítes maiores, passe `--size large` (2,5 GiB) ou `--size xl` (5 GiB). O padrão é 1,25 GiB. `--timeout` aceita entre 30 e 7.200 segundos, com padrão de 1.800. O scheduler prioriza o projeto elegível com menos vagas em uso e mantém a ordem de chegada em cada projeto.
