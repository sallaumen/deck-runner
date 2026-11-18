# Deck Runner

Transforme um Steam Deck em uma bancada de testes para os projetos do seu Mac. Um agente envia o worktree em que está trabalhando, recebe o identificador da tarefa e acompanha o resultado. Na tela do Deck, você vê quem está usando a máquina, o que está rodando e quando uma vaga fica livre.

![Painel do Deck Runner com duas tarefas fictícias em execução, ocupação, projetos e resultados](docs/station.png)

*Prévia com projetos fictícios. O painel instalado mostra a fila real.*

## Experimente em um minuto

Com Git e Python 3.11 ou superior, a prévia funciona sem hardware adicional. Os controles da prévia são somente para leitura.

```sh
git clone https://github.com/sallaumen/deck-runner.git
cd deck-runner
python3 scripts/preview.py
```

Abra [a demonstração local](http://127.0.0.1:4041/?screen=1). Para ver a bancada ociosa ou pausada, passe `--state idle` ou `--state paused`. Ctrl+C encerra a prévia.

## Instale a bancada

O executor usa Python, SQLite e Podman no Deck. A interface é HTML, CSS e JavaScript servidos pelo próprio processo. O Mac envia as tarefas por SSH e mantém um túnel para o painel.

1. Prepare o SSH e as imagens de teste no Deck. O [guia de instalação](docs/installation.md) traz os comandos, os pré-requisitos e a configuração de energia.
2. No clone do projeto no **Deck**, rode `python3 scripts/install-deck.py`.
3. No clone do projeto no **Mac**, rode `python3 scripts/install-mac.py deck@steamdeck.local`. O instalador verifica a identidade da estação nas duas pontas e coloca **Testes no Deck** e **Adicionar projeto ao Deck** na Mesa.
4. Abra [o painel no Mac](http://127.0.0.1:4040/) ou [a tela de acompanhamento](http://127.0.0.1:4040/?screen=1). Ao entrar no Desktop do Deck, a tela de acompanhamento abre automaticamente.

## Envie um teste

Cadastre uma vez a pasta principal do repositório em `~/projects`. Seus worktrees passam a compartilhar a fila e as vagas do projeto. O exemplo usa um projeto Elixir com PostgreSQL na porta 5432.

```sh
export PATH="$HOME/.local/bin:$PATH"
deck-runner add ~/projects/meu-app --profile mix --db-user postgres --port 5432
cd ~/projects/meu-app
deck-runner submit --repo . --agent "Codex · tarefa 42" --label "Regras de pagamento" -- mix test
```

O envio retorna um JSON com o campo `id`. Use esse valor nos comandos seguintes.

```sh
deck-runner wait ID
deck-runner logs ID --tail 80
deck-runner job ID
```

O Deck admite até **cinco tarefas no total e três por projeto**. A fila também considera memória e espaço em disco. Cada tarefa tem seu próprio diretório de trabalho, container e, no perfil Mix, banco de dados. Quando o Mac se desconecta, as tarefas aceitas continuam no Deck.

| Quero… | Onde encontrar |
|---|---|
| Cadastrar projetos Mix, Node, Python ou uma imagem própria | [Projetos e uso pelos agentes](docs/projects.md) |
| Acompanhar o caminho do snapshot até o resultado | [Arquitetura e estados](docs/architecture.md) |
| Entender a fila, revisar os limites ou recuperar a conexão | [Operação e diagnóstico](docs/operations.md) |
| Modificar a interface ou executar as verificações | [Como contribuir](CONTRIBUTING.md) e [design do painel](DESIGN.md) |
| Avaliar quais arquivos viajam e quem pode operar a fila | [Modelo de confiança](SECURITY.md) |

Distribuído sob a [licença MIT](LICENSE).
