# Operação e recuperação

## O que inicia sozinho

| Camada | Supervisor | Verificação |
|---|---|---|
| Acesso SSH ao Deck | systemd do sistema | `systemctl is-enabled sshd` |
| Executor desde o boot | systemd do usuário e linger | `systemctl --user is-enabled deck-runner` e `loginctl show-user "$USER" -p Linger` |
| Janela ao entrar no Plasma | Autostart do KDE e `deck-runner-display.service` | `systemctl --user status deck-runner-display` |
| Túnel ao entrar no Mac | LaunchAgent `io.github.deck-runner.tunnel` | `~/.local/bin/deck-runner doctor` |

O painel e a fila atendem somente em loopback. No Mac, abra **Testes no Deck**. O modo **Tela do Deck** privilegia execução, ocupação e resultado por projeto. **Abrir controles** permite filtrar, pausar novas admissões, consultar logs e cancelar uma tarefa. A sequência recente resume até 12 resultados dos projetos ativos. Um estado offline conserva a última leitura e informa quando o painel está tentando reconectar.

## Diagnóstico em ordem

1. No Mac, execute `deck-runner doctor`. Ele verifica o SSH, a pulsação do executor e se o identificador da estação obtido pela porta local corresponde ao mesmo Deck.
2. Se o SSH falhar, confirme que o Deck está acordado, na mesma rede e com `sshd` ativo. Teste `ssh -o BatchMode=yes deck@steamdeck.local true`. Se você trocou de rede ou de roteador, reveja a resolução do nome local. Se o SSH avisar que a identidade do host mudou, confira a chave no próprio Deck antes de confiar na nova identidade.
3. Se o executor falhar, use no Deck `journalctl --user -u deck-runner.service -n 60`. Se o painel não abrir no Plasma, confirme `flatpak info com.google.Chrome` e rode `systemctl --user restart deck-runner-display.service`. A janela usa um perfil separado do navegador.
4. Se apenas o túnel falhar, consulte `~/Library/Logs/deck-runner/tunnel.log` e `lsof -nP -iTCP:4040 -sTCP:LISTEN` no Mac. Para refazer a conexão, use `launchctl kickstart -k "gui/$(id -u)/io.github.deck-runner.tunnel"`. Em uma rede conhecida, o LaunchAgent volta a tentar sozinho. Ele acompanha a sessão do usuário no Mac.
5. Se um teste aguarda, leia o motivo no painel. Se encontrar uma falha, abra o log e confirme a árvore de origem com `deck-runner job ID` antes de repetir.

O arquivo `~/.config/deck-runner/host` no Mac guarda o destino. O cliente também aceita `DECK_RUNNER_HOST` para uma conexão avulsa. Para mudar a conexão persistente, rode o instalador do Mac novamente.

## Limites e retenção

| Recurso | Limite |
|---|---|
| Concorrência | 5 tarefas no Deck, até 3 por repositório |
| RAM | 1,25 / 2,5 / 5 GiB por tarefa. Reserva de até 7,5 GiB no conjunto, margem de 1,5 GiB no host, teto de 8 GiB para os containers |
| CPU | Até 3 CPUs lógicas por tarefa e 5 para o conjunto |
| Disco | Admissão a partir de 15 GiB livres. Durante a execução, proteção abaixo de 10 GiB |
| Retenção | Worktrees por 24 horas, logs e referências das tarefas por 7 dias. O histórico de resultados continua em SQLite |

A admissão considera o saldo de memória reservado às tarefas ativas. A próxima tarefa de um projeto pode aguardar enquanto outro projeto com trabalho menor avança. Cada execução Mix usa um cache separado por projeto, imagem, lockfile e vaga. Uma tarefa aceita segue no Deck se o túnel fechar. Uma execução interrompida por reinício recebe o estado *interrompido*.

## Atualize e preserve a fila

No clone do Deck, atualize o código e rode `python3 scripts/install-deck.py`. Ele pausa novas admissões, espera as tarefas ativas, instala os arquivos, verifica o serviço e restaura o estado anterior da pausa. O banco e os trabalhos ficam em `~/.local/share/deck-runner`, fora da pasta de código `app/`. Para salvar a fila com o SQLite em uso, prefira a operação de backup do próprio SQLite. Copiar apenas o arquivo principal pode omitir alterações do WAL.

Em seguida, atualize o clone e repita o instalador do Mac. Para uma migração de porta, configure no Deck `DECK_RUNNER_LEGACY_PORT=8767` em `~/.config/deck-runner/service.env` antes da atualização e passe `--legacy-port 8767` no instalador do Mac. URLs antigas de leitura conservam o caminho e são redirecionadas à porta 4040.

Para parar só o painel, use `systemctl --user stop deck-runner-display`. Para desativar a inicialização da bancada, pause e aguarde as tarefas terminarem, desabilite o serviço com `systemctl --user disable --now deck-runner` e desative **Deck Runner** no Autostart do Plasma. Para encerrar o túnel no Mac, rode `launchctl bootout "gui/$(id -u)/io.github.deck-runner.tunnel"` e mova seu plist para fora de `~/Library/LaunchAgents`.
