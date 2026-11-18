on run
    set toolPath to quoted form of ((POSIX path of (path to home folder)) & ".local/bin/deck-runner")
    set chosenFolder to choose folder with prompt "Escolha o repositório que deseja testar no Deck" default location (POSIX file ((POSIX path of (path to home folder)) & "projects/") as alias)
    set repoPath to POSIX path of chosenFolder
    set options to ""
    try
        if (do shell script "test -f " & quoted form of (repoPath & "mix.exs") & " && echo mix || echo auto") is "mix" then
            set dbRole to text returned of (display dialog "Usuário do PostgreSQL de testes. O banco temporário usará esse nome também como senha." default answer "postgres" with title "Adicionar projeto ao Deck")
            set dbPort to text returned of (display dialog "Porta usada em config/test.exs" default answer "5432" with title "Adicionar projeto ao Deck")
            set options to " --db-user " & quoted form of dbRole & " --port " & quoted form of dbPort
        end if
        do shell script toolPath & " add " & quoted form of repoPath & options
        display dialog "Projeto disponível para os agentes." buttons {"Fechar", "Ver painel"} default button "Ver painel" with title "Testes no Deck"
        if button returned of result is "Ver painel" then do shell script toolPath & " open"
    on error messageText number errorNumber
        if errorNumber is not -128 then display alert "O cadastro não foi concluído" message messageText
    end try
end run
