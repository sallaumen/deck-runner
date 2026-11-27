# Instalação

## Antes de começar

O caminho validado usa macOS com uma sessão gráfica e SteamOS em modo Desktop, com a conta Linux de UID 1000. Tenha Git nas duas máquinas, Python 3.11+ e espaço para imagens, caches e pelo menos 15 GiB livres para admitir novas tarefas. O Deck precisa de Podman rootless com cgroups v2 e systemd de usuário. O primeiro build e a primeira resolução de dependências precisam de internet.

No Deck, confira `id -u`, `python3 --version`, `podman info` e `systemctl --user status`. Para a janela dedicada, instale o Google Chrome pelo Discover ou use `flatpak install flathub com.google.Chrome`. O executor roda independentemente da janela.

## Conecte o Mac ao Deck

No Desktop do Deck, abra o Konsole. Defina uma senha da conta com `passwd` se necessário. Habilite o SSH e a execução dos serviços do usuário desde o boot.

```sh
sudo systemctl enable --now sshd
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

No Mac, abra `ssh deck@steamdeck.local`. No primeiro acesso, compare a impressão da chave ED25519 mostrada pelo SSH com a exibida fisicamente no Deck. Saia com `exit`. Instale sua chave pública com `ssh-copy-id -i ~/.ssh/id_ed25519.pub deck@steamdeck.local`. Caso ainda não tenha uma chave, gere uma com `ssh-keygen -t ed25519`, escolhendo um arquivo novo. Com uma chave protegida por frase secreta, deixe-a disponível ao SSH do macOS para o login automático.

Verifique `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes deck@steamdeck.local true`. Se sua rede não resolver nomes `.local`, use um nome DNS local, uma reserva DHCP ou um alias do seu `~/.ssh/config`. Use o mesmo nome no instalador. A chave privada permanece no Mac.

## No Deck

```sh
git clone https://github.com/sallaumen/deck-runner.git
cd deck-runner
podman build -t localhost/deck-runner:mix -f Containerfile .
python3 scripts/install-deck.py
```

A imagem Mix também atende ao perfil Python. Para Node, prepare `podman pull docker.io/library/node:22-bookworm-slim`. Para projetos Mix de áudio, rode `podman build --pull=never -t localhost/deck-runner:audio -f Containerfile.audio .`. O build de áudio acrescenta FFmpeg e ffprobe à imagem Mix.

Por padrão, o serviço inicia no boot quando o *linger* está ativo. O painel abre na sessão gráfica do Plasma. Para dedicar a máquina à bancada após ligar, versões do SteamOS com `steamosctl` oferecem `steamosctl set-default-login-mode desktop`. Consulte com `steamosctl get-default-login-mode`. Para restaurar a inicialização em modo de jogo, use `steamosctl set-default-login-mode game`. A mudança vale no próximo login.

Em **Configurações do sistema → Energia**, ajuste apenas o perfil **na tomada** para manter a tela ligada e impedir a suspensão automática por inatividade. Com o Deck suspenso, a fila volta a avançar quando ele acorda. A inicialização após uma perda física de energia depende do dispositivo e do seu firmware.

## No Mac

```sh
mkdir -p ~/projects
cd ~/projects
git clone https://github.com/sallaumen/deck-runner.git
cd deck-runner
python3 scripts/install-mac.py deck@steamdeck.local
~/.local/bin/deck-runner doctor --station
```

Mantenha esse clone no local da instalação. O comando do Mac aponta para ele. O instalador testa SSH, prepara um LaunchAgent que reconecta automaticamente e verifica se o painel em `127.0.0.1:4040` pertence ao Deck esperado. A porta deve estar livre no Mac e no Deck. Para mover o clone ou trocar de host, rode novamente o instalador da nova pasta com o nome correto.

Abra **Testes no Deck** na Mesa. Use **Adicionar projeto ao Deck** para escolher um repositório. O cadastro via terminal oferece as opções de imagem e de banco descritas no [guia de projetos](projects.md).
