# Operação e recuperação

## O que inicia sozinho

| Camada | Supervisor | Verificação |
|---|---|---|
| Acesso SSH ao Deck | systemd do sistema | `systemctl is-enabled sshd` |
| Executor desde o boot | systemd do usuário e linger | `systemctl --user is-enabled deck-runner` e `loginctl show-user "$USER" -p Linger` |
| Janela ao entrar no Plasma | Autostart do KDE e `deck-runner-display.service` | `systemctl --user status deck-runner-display` |
| Túnel ao entrar no Mac | LaunchAgent `io.github.deck-runner.tunnel` | `~/.local/bin/deck-runner doctor --station` |

## Diagnóstico em ordem

Para enviar um teste, rode `deck-runner preflight --repo CAMINHO` na frente afetada. Para investigar a instalação inteira, use `doctor --repo CAMINHO`. Fora de um projeto, `doctor --station` verifica SSH, executor e túnel do painel. O destino SSH vem de `~/.config/deck-runner/host`; `DECK_RUNNER_HOST` seleciona um destino avulso.

### Decisão da frente antes do envio

`deck-runner preflight --repo CAMINHO` imprime um objeto JSON e sai com 0 quando o projeto pode tentar enviar um snapshot, ou 2 quando a consulta identifica um bloqueio. O comando consulta a estação por SSH sem criar uma tarefa. A saída de outra conversa, o conteúdo do `config.toml` e o painel podem descrever ambientes diferentes. Faça a consulta na sessão e no checkout que vão executar `submit`.

| Campo `code` | Como prosseguir |
|---|---|
| `ready` | Envie o teste. `queue_note` pode indicar pausa, memória ou vagas. Guarde o ID e aguarde o término. |
| `session_socket_denied` | O processo recebeu uma negativa ao abrir o socket. Confira o perfil efetivo da sessão. Uma frente com acesso autorizado ao mesmo checkout pode verificar o caminho e o estado do Git, executar o próprio preflight e enviar por SSH. |
| `ssh_dns`, `ssh_connection`, `ssh_timeout` | Confira o destino, a resolução do nome e a disponibilidade do Deck na rede. Com um ID já recebido, retome `wait ID`. |
| `ssh_auth`, `ssh_host_key` | Confira a identidade do usuário e a chave disponível no Mac. Se a chave da estação mudou, compare a impressão digital no Deck antes de atualizar a confiança. |
| `git_checkout`, `project_registration` | Confira o caminho real da frente e as [regras de cadastro](projects.md#perfis). Um envio da pasta principal pode conter código diferente. |
| `executor_offline`, `disk_limit` | Consulte o serviço ou o espaço no Deck de acordo com o erro. Repita o preflight após a recuperação. |
| `ssh_error`, `client_error`, `station_response` | Leia `detail` e execute `doctor --repo CAMINHO` no mesmo ambiente para obter o diagnóstico da estação e do túnel. |

Após receber o ID, retome com `wait ID --summary`. O cliente repete até três consultas consecutivas em falhas transitórias de transporte. Se a comunicação continuar indisponível, o resultado fica em aberto até a próxima consulta.

**Quando Claude e GPT divergem.** Compare o preflight no mesmo checkout em cada sessão. Uma negativa ao abrir o socket em uma delas e `ready` na outra isolam o problema no caminho da primeira. Com o Codex CLI instalado no Mac, `codex -C /caminho/da/frente` abre uma sessão local nessa pasta. Confirme `git rev-parse HEAD` e `git status --short` antes do envio. Registre a árvore que o Deck aceitou.

**Quando a frente precisa abrir Phoenix no Mac.** Faça as sondagens na sessão que vai iniciar o servidor e apenas para os serviços que o projeto usa.

- Para testar a porta local, rode `elixir -e '{:ok, s} = :gen_tcp.listen(0, ip: {127, 0, 0, 1}); :gen_tcp.close(s)'`. A porta é efêmera. Uma falha `:eperm` encerra o comando com erro antes de iniciar Phoenix.
- Para um projeto que usa Docker, `docker version --format '{{.Server.Version}}'` exige resposta do daemon. Uma negativa no socket identifica uma falha de acesso ao Docker naquela sessão.
- Para PostgreSQL, faça uma consulta `SELECT 1` com o banco, a porta e a identidade do ambiente de teste do projeto. Registre o resultado sem incluir credenciais.

Se a validação local estiver bloqueada, um `preflight` bem-sucedido ainda permite enviar os testes Linux compatíveis ao Deck. Para concluir a verificação visual, abra a rota em um navegador no ambiente autorizado com o mesmo código e confirme a conexão do LiveView quando aplicável.

### O painel está ativo e uma frente falha ao enviar

**Executor ativo** indica que o Deck verificou a fila nos últimos 15 segundos. Uma fila pausada ou com pouca memória ainda pode receber tarefas.

| Sintoma | Onde verificar |
|---|---|
| SSH falha | Teste `ssh -o BatchMode=yes deck@steamdeck.local true` na sessão de envio. Confira o código do preflight acima. |
| Serviço indisponível | No Deck, leia `journalctl --user -u deck-runner.service -n 60`. |
| SSH funciona e o painel do Mac falha | O envio pode seguir por SSH. Para recuperar o painel, consulte `~/Library/Logs/deck-runner/tunnel.log` e `lsof -nP -iTCP:4040 -sTCP:LISTEN`. O LaunchAgent aceita `launchctl kickstart -k "gui/$(id -u)/io.github.deck-runner.tunnel"`. |
| Painel do Plasma não abre | Confira `flatpak info com.google.Chrome` e `systemctl --user status deck-runner-display`. Para reiniciar a janela, use `systemctl --user restart deck-runner-display`. |

## Usar o Deck sem teclado

No Plasma, o atalho **Deck Runner** abre o painel. Use o direcional para mover o foco, **A** para selecionar e **B** para voltar. Fechar a janela mantém o executor em funcionamento.

Selecione uma tarefa para ler o log. A saída acompanha as novas linhas até você rolar para cima. **Ir ao fim** retoma o acompanhamento. O cronômetro congela durante a desconexão e recupera o tempo registrado quando o painel reconecta.

## Comparar o uso por projeto

**Envios de testes** conta cada tarefa na hora em que entrou na fila. **Tempo de execução** soma o tempo de ocupação das vagas, incluindo a preparação. Duas tarefas simultâneas de dez minutos somam vinte minutos. Os gráficos permitem filtrar o projeto e consultar as últimas 6 ou 24 horas.

## Retomar a transmissão no Mac

No Mac, emparelhe o Steam Link com o Deck e deixe sua janela aberta. Para retomar a transmissão após um reinício do Deck, instale o auxiliar opcional com `python3 mac/install-link.py` usando as ferramentas de linha de comando do Xcode. Se necessário, passe `--host-name "Nome no Steam Link"`.

Autorize `~/Applications/Deck Link.app` em **Privacidade e Segurança → Acessibilidade**. Uma nova compilação pode precisar de autorização novamente. O auxiliar espera o Steam Remote Play ficar disponível na porta TCP 27036. A fila segue funcionando mesmo durante uma interrupção do vídeo.

Para saber se o Steam Link está fechado, aberto ou transmitindo, execute `deck-runner video-status` no Mac. O diagnóstico também mostra o serviço de retomada, a autorização de Acessibilidade e a disponibilidade do Steam Remote Play. Use `deck-runner doctor` para verificar o executor enquanto o Steam inicia. Para consultar o histórico da retomada, leia `~/Library/Logs/deck-runner/steam-link.log`. Para desativá-la, descarregue o serviço e remova seu arquivo de inicialização:

```sh
launchctl bootout "gui/$(id -u)/io.github.deck-runner.steam-link"
mv ~/Library/LaunchAgents/io.github.deck-runner.steam-link.plist ~/Documents/
```

## Ajustar as vagas

No Deck ou nos controles do Mac, abra **Ocupação do Deck → Ajustar vagas** e aplique o total e o limite por projeto. Os valores persistem entre reinícios e passam a valer na próxima admissão. As tarefas em execução terminam normalmente. Consulte os limites atuais em `deck-runner status`.

## Armazenamento dos testes

Abra **Testes no disco** para consultar o uso por projeto e a margem para novos envios. A medição cobre worktrees, caches, repositórios e arquivos das tarefas. Imagens do Podman e jogos ficam fora do total.

**Limpar cópias** calcula o espaço recuperável. **Confirmar limpeza** remove apenas worktrees de tarefas encerradas que continuam elegíveis. Logs, caches e histórico têm retenção própria.

## Limites e retenção

| Recurso | Limite |
|---|---|
| Concorrência | De 1 a 32 no total. O limite por projeto pode ir até o total. Padrão inicial de 5 e 3. |
| RAM | 1,25 / 2,5 / 5 GiB por tarefa. A reserva conjunta parte de 7,5 GiB e cresce com as vagas, limitada a 512 MiB abaixo do teto dos containers. O grupo pode usar até 80% da RAM física. A fila também desconta as reservas pendentes e preserva 1,5 GiB disponíveis para o sistema. |
| CPU | Até 3 CPUs lógicas por tarefa e 5 para o conjunto. **CPU em uso**, no painel e em `deck-runner status`, é a parcela ocupada de todos os núcleos do Deck entre duas leituras, incluindo o que roda fora dos testes |
| Disco | Reserva de 10 GiB. Abaixo de 15 GiB, novos envios são recusados e a fila aguarda espaço. A 12 GiB, envios e execuções em andamento são interrompidos para dar margem ao sistema |
| Retenção | Worktrees por 24 horas, logs e referências das tarefas por 7 dias. O histórico de resultados continua em SQLite |

A admissão considera o saldo de memória reservado às tarefas ativas. A próxima tarefa de um projeto pode aguardar enquanto outro projeto com trabalho menor avança. Cada execução Mix usa um cache separado por projeto, imagem, lockfile e vaga. Uma tarefa aceita segue no Deck se o túnel fechar. Uma execução interrompida por reinício recebe o estado *interrompido*.

## Atualize e preserve a fila

No clone do Deck, atualize o código e rode `python3 scripts/install-deck.py`. Ele pausa novas admissões, espera as tarefas ativas, instala os arquivos, verifica o serviço e restaura o estado anterior da pausa. O banco e os trabalhos ficam em `~/.local/share/deck-runner`, fora da pasta de código `app/`. Para salvar a fila com o SQLite em uso, prefira a operação de backup do próprio SQLite. Copiar apenas o arquivo principal pode omitir alterações do WAL.

Em seguida, atualize o clone e repita o instalador do Mac. Para uma migração de porta, configure no Deck `DECK_RUNNER_LEGACY_PORT=8767` em `~/.config/deck-runner/service.env` antes da atualização e passe `--legacy-port 8767` no instalador do Mac. URLs antigas de leitura conservam o caminho e são redirecionadas à porta 4040.

Para parar só o painel, use `systemctl --user stop deck-runner-display`. Para desativar a inicialização da bancada, pause e aguarde as tarefas terminarem, desabilite o serviço com `systemctl --user disable --now deck-runner` e desative **Deck Runner** no Autostart do Plasma. Para encerrar o túnel no Mac, rode `launchctl bootout "gui/$(id -u)/io.github.deck-runner.tunnel"` e mova seu plist para fora de `~/Library/LaunchAgents`.
