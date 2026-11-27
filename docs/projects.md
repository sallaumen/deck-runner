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

No perfil Mix, cada tarefa recebe um PostgreSQL próprio. Use o usuário e a porta esperados pelo projeto. A senha do banco descartável é igual ao nome do usuário. O perfil define `MIX_TEST_PARTITION` por tarefa. Use `--no-test-partition` quando a suíte depende do nome padrão do banco. Uma imagem Mix alternativa precisa fornecer o mesmo ambiente de inicialização da imagem base.

Com o projeto ocioso, repita `add` com a configuração completa e `--update` para alterá-la. `remove NOME` arquiva o cadastro e conserva o histórico. O comando `projects` descobre repositórios no primeiro nível de `~/projects`. O comando `add` também aceita repositórios em subpastas.

Worktrees vinculados e clones cujo `origin` é o caminho absoluto da pasta principal cadastrada (ou do seu `.git`) compartilham o cadastro e a fila. Por exemplo, `git clone ~/projects/catalogo /tmp/revisao` permite enviar `submit --repo /tmp/revisao`, incluindo as edições dessa cópia. Um cadastro próprio da cópia tem prioridade. Clones feitos de uma URL de rede continuam exigindo seu próprio cadastro ou um worktree do projeto já cadastrado.

## Contrato de execução

| Comando | Resposta para a frente |
|---|---|
| `preflight --repo CAMINHO` | JSON com `ready` e `code`. Saída 0 permite tentar o envio. Saída 2 indica um bloqueio. |
| `submit --repo CAMINHO --agent AGENTE --label RÓTULO -- COMANDO` | `id`, `state`, `snapshot_commit` e `tree` confirmam que o Deck aceitou o conteúdo. |
| `job ID --summary` | Uma leitura imediata. A saída 0 significa que a consulta funcionou, inclusive para tarefas na fila ou que falharam. |
| `wait ID --summary` | Aguarda o término. Transições vão para stderr e o recibo JSON vai para stdout. Saída 0 para `passed`, 1 para outro estado final e 2 para erro de consulta. |
| `logs ID --tail 40` | Últimas 40 linhas. O padrão é 100. Use `--tail 0` para o log completo. |

No recibo, `tree` identifica os arquivos testados e `command` delimita o que foi executado. `state` vem do executor. `exit_code` pode ser nulo, por exemplo ao cancelar uma tarefa ainda na fila. `test_summary` traz o último rodapé reconhecido de ExUnit, unittest ou Node (TAP/contador nativo) nos últimos 32 KiB de log. Pode ser nulo para outros comandos, logs expirados ou estações antigas. Em suítes que imprimem vários rodapés, relate esse valor como a última contagem registrada. Para a revisão de origem, horários ou pico de memória, consulte `job ID` sem a opção de resumo.

Para comunicar o resultado, use uma frase como `Projeto X passou em mix test test/arquivo_test.exs (4 testes, 0 falhas). Job ID, árvore TREE.` Se o executor marcar falha mesmo após um rodapé verde, relate a falha e consulte o fim do log. Se a contagem estiver ausente, informe apenas o que o comando e o estado comprovam.

O snapshot contém os arquivos versionados, as exclusões e os arquivos novos não ignorados. O limite do upload é 1 GiB. Submódulos e links para fora do projeto exigem preparação. Os filtros de credenciais estão no [modelo de confiança](../SECURITY.md).

Passe `--size large` (2,5 GiB) ou `--size xl` (5 GiB) para suítes maiores. O padrão é 1,25 GiB. `--timeout` aceita de 30 a 7.200 segundos, com padrão de 3.600. Para investigar falhas ou validar o navegador em outro ambiente, consulte o [guia de operação](operations.md#decisão-da-frente-antes-do-envio).
