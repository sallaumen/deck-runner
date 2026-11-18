# Modelo de confiança

Deck Runner serve uma pessoa e seus agentes, com acesso SSH já autorizado entre o Mac e o Deck. Todas as sessões do mesmo usuário com acesso ao painel podem administrar a fila e ler os logs. O nome do agente é uma identificação declarada para acompanhamento. Execute apenas código de repositórios e dependências em que você confia.

A interface escuta em `127.0.0.1:4040` em ambas as máquinas. O túnel usa OpenSSH com verificação estrita da chave do host. A interface valida Host e origem e exige um token para ações de escrita. Acesse a bancada pelo túnel. Publicar a porta com um proxy ou para a internet amplia o acesso aos dados e aos controles.

O Mac envia uma árvore Git sem histórico. O cliente omite arquivos novos ignorados, alguns diretórios locais de ferramentas e formatos conhecidos de credenciais. Arquivos versionados com nome sensível ou campos de credencial preenchidos em dotenv podem bloquear o envio. Esses filtros não detectam todo segredo possível. Revise o conteúdo do projeto e trate snapshots, logs e recibos como privados.

Os testes rodam em containers Podman rootless com limites de recursos, um worktree próprio e acesso de leitura ao repositório do projeto no Deck. Dependências e testes podem usar a rede. Alguns perfis usam o usuário root **dentro** do container durante a preparação. A fronteira de confiança é o dono do Deck e do código executado.

Para relatar uma vulnerabilidade, use o recurso privado de comunicação do repositório quando disponível, ou contate o mantenedor diretamente. Evite publicar credenciais, snapshots, IPs e logs reais em issues.
