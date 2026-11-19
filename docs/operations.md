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
3. Se o executor falhar, use no Deck `journalctl --user -u deck-runner.service -n 60`. Se o painel não abrir no Plasma, confirme `flatpak info com.google.Chrome` e rode `systemctl --user restart deck-runner-display.service`. A janela usa um perfil separado do navegador. O supervisor acompanha o processo real desse perfil, inclusive quando o Flatpak o inicia fora do serviço. A janela abre ao entrar no Desktop. Para sair, toque em **Fechar painel** ou pressione **B** e confirme com **A**. O executor continua atendendo os agentes. O atalho **Deck Runner** abre o painel de novo. Se o Chrome pedir atualização ao iniciar, atualize o Flatpak pelo Discover e reinicie apenas o serviço da janela.
4. Se apenas o túnel falhar, consulte `~/Library/Logs/deck-runner/tunnel.log` e `lsof -nP -iTCP:4040 -sTCP:LISTEN` no Mac. Para refazer a conexão, use `launchctl kickstart -k "gui/$(id -u)/io.github.deck-runner.tunnel"`. Em uma rede conhecida, o LaunchAgent volta a tentar sozinho. Ele acompanha a sessão do usuário no Mac.
5. Se um teste aguarda, leia o motivo no painel. Se encontrar uma falha, abra o log e confirme a árvore de origem com `deck-runner job ID` antes de repetir.

O arquivo `~/.config/deck-runner/host` no Mac guarda o destino. O cliente também aceita `DECK_RUNNER_HOST` para uma conexão avulsa. Para mudar a conexão persistente, rode o instalador do Mac novamente.

## Usar o Deck sem teclado

Ao entrar na área de trabalho do Plasma, o atalho de inicialização abre **Deck Runner**. Use o analógico esquerdo ou o direcional para mover o foco. **A** seleciona. **B** volta de um log ou abre a confirmação para fechar o painel. O botão **Fechar painel** também funciona com o toque, o mouse e o teclado. O atalho **Deck Runner** na área de trabalho reabre a janela. Para jogar, use o modo Big Picture no Steam ou o atalho do SteamOS para o modo de jogo.

Na tela do Deck, alterne **Em execução** e **Na fila** à esquerda ou **Resultados** e **Projetos** à direita. Quando a lista ocupa mais de uma página, as setas junto ao título mostram os itens seguintes. Na aba **Projetos**, a lista começa pelos projetos com mais testes em execução. Em caso de empate, aparece primeiro quem tem mais tarefas na fila. A paginação dos totais por projeto mantém as linhas de todos os projetos nos gráficos.

Durante os testes, o título mostra os projetos em execução. Se houver mais de dois, o número ao lado indica quantos outros estão ativos. Cada linha identifica a tarefa, o projeto, o agente e a última atividade informada pelo teste. O cronômetro usa o horário do Deck e conta os segundos entre as leituras da fila, inclusive quando o log está aberto. Quando a conexão cai, o relógio para. Ao reconectar, volta ao tempo do executor. Ao terminar, o log mostra a duração registrada.

No Deck ou no painel do Mac, selecione o nome de uma tarefa na tela de acompanhamento para ler o log. Se o título ou o comando forem longos, mova o foco para o cabeçalho e use o direcional para percorrer o texto. O cabeçalho e a saída rolam separadamente, e **Voltar** permanece no mesmo lugar. A saída acompanha as novas linhas enquanto você estiver no fim. Ao rolar para cima, o painel mantém sua posição. **Ir ao fim** volta a acompanhar a execução. Quando o teste termina, o painel faz a última leitura e mostra o resultado. **Voltar** devolve o foco à tarefa.

## Comparar o uso por projeto

Na faixa inferior, **Envios de testes** conta cada tarefa uma vez, na hora em que entrou na fila. Uma suíte com 27 casos conta como um envio. **Tempo de execução** soma os minutos em que as tarefas de cada projeto ocuparam vagas, incluindo a preparação do ambiente. Duas tarefas que rodam por dez minutos ao mesmo tempo somam vinte minutos. A espera na fila fica fora dessa soma.

A janela de **6 horas** usa intervalos de 15 minutos. Em **24 horas**, cada intervalo tem uma hora. Os gráficos têm o mesmo eixo de tempo e cada projeto mantém a sua cor. A tabela começa ordenada por envios. Selecione **Tempo** para comparar quanto tempo de execução cada projeto consumiu, ou **Envios** para voltar à contagem. Com o mouse, pare sobre um intervalo para ver os valores das linhas. Na tela de controles, o filtro de projeto também se aplica aos gráficos.

A leitura é atualizada a cada minuto com o histórico dos projetos cadastrados, incluindo tarefas em andamento e projetos com zero envios no período.

## Retomar a transmissão no Mac

Emparelhe o Steam Link, escolha o Desktop como destino da transmissão e deixe a janela aberta. O componente opcional **Deck Link** observa a inicialização do Deck pelo túnel local. Depois de um reinício, o executor atende a fila assim que inicia. O Deck Link recebe o novo identificador de boot quando o processo Steam está escutando na porta TCP 27036. Só então ele procura o computador emparelhado e aciona o botão de iniciar na janela do Steam Link. O Steam Link pode recriar a janela de vídeo durante a conexão. O Deck Link reaplica a posição e o tamanho da transmissão anterior. Fechar o aplicativo Steam Link encerra o monitoramento daquela sessão. A fila funciona enquanto a transmissão está fechada.

Instale no Mac com as ferramentas de linha de comando do Xcode disponíveis:

```sh
python3 mac/install-link.py
```

Se o computador aparecer com outro nome na tela de emparelhamento, acrescente `--host-name "Nome no Steam Link"`. O macOS pede acesso de **Acessibilidade** para `~/Applications/Deck Link.app`. A autorização permite selecionar o botão do Steam Link. O auxiliar usa a árvore de acessibilidade do aplicativo e dispensa a gravação da tela. Uma atualização do executável compilado localmente pode exigir adicionar a nova cópia em **Privacidade e Segurança → Acessibilidade**. Repetir a instalação da mesma versão preserva a cópia autorizada.

Para saber se o Steam Link está fechado, aberto ou transmitindo, execute `deck-runner video-status` no Mac. O diagnóstico também mostra o serviço de retomada, a autorização de Acessibilidade e a disponibilidade do Steam Remote Play. Use `deck-runner doctor` para verificar o executor enquanto o Steam inicia. Para consultar o histórico da retomada, leia `~/Library/Logs/deck-runner/steam-link.log`. Para desativá-la, descarregue o serviço e remova seu arquivo de inicialização:

```sh
launchctl bootout "gui/$(id -u)/io.github.deck-runner.steam-link"
mv ~/Library/LaunchAgents/io.github.deck-runner.steam-link.plist ~/Documents/
```

## Ajustar as vagas

Na tela principal do Deck ou do Mac, selecione **Ajustar vagas** ao lado de **Ocupação do Deck**. Use **+** e **−** para escolher o total e o máximo que um único projeto pode ocupar. Selecione **Aplicar**. O toque, o teclado e o direcional com o botão A funcionam nessa janela.

A mudança vale para a próxima admissão e fica salva após suspensão, reinício e atualização. Ao reduzir o total abaixo da ocupação atual, as tarefas em andamento terminam normalmente. A fila volta a preencher vagas quando a ocupação fica abaixo do novo limite. O total e o limite por projeto são compartilhados por todos os agentes e worktrees. O comando `deck-runner status` mostra os valores atuais.

## Armazenamento dos testes

Em **Testes no disco**, ao lado do disco livre, confira os blocos ocupados pelas cópias de trabalho, caches de compilação, repositórios Git e arquivos das tarefas. A margem indica quantos bytes ainda separam o disco livre do limite de admissão. Quando ela acaba, a janela calcula quanto liberar para aceitar novos testes. A tabela separa os valores por projeto. Uma medição em segundo plano é compartilhada pelos painéis e reutilizada por até três minutos. O horário indica quando ela terminou. Imagens do Podman, bancos externos e jogos ficam fora desses totais.

**Limpar cópias** mostra quantos testes encerrados entram na limpeza. **Confirmar limpeza** remove somente as cópias daquela medição que o Git reconhece e que continuam encerradas. O cache, os repositórios, os logs e o histórico permanecem disponíveis. A janela pode ser fechada durante a operação. Ao terminar, o painel mede de novo. Sem uma limpeza manual, continua valendo a retenção normal das cópias por um dia.

## Limites e retenção

| Recurso | Limite |
|---|---|
| Concorrência | De 1 a 32 no total. O limite por projeto pode ir até o total. Padrão inicial de 5 e 3. |
| RAM | 1,25 / 2,5 / 5 GiB por tarefa. A reserva conjunta parte de 7,5 GiB e cresce com as vagas, limitada a 512 MiB abaixo do teto dos containers. O grupo pode usar até 80% da RAM física. A fila também desconta as reservas pendentes e preserva 1,5 GiB disponíveis para o sistema. |
| CPU | Até 3 CPUs lógicas por tarefa e 5 para o conjunto |
| Disco | Reserva de 10 GiB. Abaixo de 15 GiB, novos envios são recusados e a fila aguarda espaço. A 12 GiB, envios e execuções em andamento são interrompidos para dar margem ao sistema |
| Retenção | Worktrees por 24 horas, logs e referências das tarefas por 7 dias. O histórico de resultados continua em SQLite |

A admissão considera o saldo de memória reservado às tarefas ativas. A próxima tarefa de um projeto pode aguardar enquanto outro projeto com trabalho menor avança. Cada execução Mix usa um cache separado por projeto, imagem, lockfile e vaga. Uma tarefa aceita segue no Deck se o túnel fechar. Uma execução interrompida por reinício recebe o estado *interrompido*.

## Atualize e preserve a fila

No clone do Deck, atualize o código e rode `python3 scripts/install-deck.py`. Ele pausa novas admissões, espera as tarefas ativas, instala os arquivos, verifica o serviço e restaura o estado anterior da pausa. O banco e os trabalhos ficam em `~/.local/share/deck-runner`, fora da pasta de código `app/`. Para salvar a fila com o SQLite em uso, prefira a operação de backup do próprio SQLite. Copiar apenas o arquivo principal pode omitir alterações do WAL.

Em seguida, atualize o clone e repita o instalador do Mac. Para uma migração de porta, configure no Deck `DECK_RUNNER_LEGACY_PORT=8767` em `~/.config/deck-runner/service.env` antes da atualização e passe `--legacy-port 8767` no instalador do Mac. URLs antigas de leitura conservam o caminho e são redirecionadas à porta 4040.

Para parar só o painel, use `systemctl --user stop deck-runner-display`. Para desativar a inicialização da bancada, pause e aguarde as tarefas terminarem, desabilite o serviço com `systemctl --user disable --now deck-runner` e desative **Deck Runner** no Autostart do Plasma. Para encerrar o túnel no Mac, rode `launchctl bootout "gui/$(id -u)/io.github.deck-runner.tunnel"` e mova seu plist para fora de `~/Library/LaunchAgents`.
