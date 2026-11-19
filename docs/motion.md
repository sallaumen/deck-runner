# Efeitos da estação

Na tela de acompanhamento, abra **Efeitos** no rodapé. Escolha **Arcade** e, em **Experimentar no painel**, selecione **Início**, **Aprovação** ou **Falha**. A prévia desaparece sozinha. Você pode experimentar mesmo com todas as vagas ocupadas. A escolha de intensidade fica salva nesse navegador.

![A doca recebe duas execuções fictícias. O bilhete indica os projetos e o piloto percorre a plataforma. Os placares menta e coral distinguem uma aprovação de uma falha.](arcade.gif)

## Como ler o painel de relance

No modo Arcade, uma nave chega ao portal quando uma execução começa. O bilhete âmbar identifica a tarefa. Ao terminar, a nave parte e duas faixas diagonais enquadram o placar. As cores distinguem aprovação, falha e interrupção. Na doca ociosa, o piloto espera na plataforma. Com movimento reduzido, a cena fica parada.

| O que aconteceu | O que aparece |
|---|---|
| Uma tarefa entrou na fila | A aba **Na fila** ganha um pulso âmbar. |
| Um teste começou | O piloto anuncia o projeto e a tarefa, a linha acende e o número de vagas em uso salta. Partidas que chegam na mesma atualização compartilham um aviso com a contagem e os nomes dos projetos. |
| Há testes rodando | No modo Arcade, o piloto caminha junto ao nome dos projetos ativos. Quando chega uma linha nova de saída, a atividade da tarefa ganha um breve destaque. Em Discreto ou com movimento reduzido, o piloto fica parado. |
| Um teste passou | Um placar menta aparece por 3,2 segundos. Estrelas acompanham a entrada. O número dourado conta aprovações consecutivas do mesmo projeto a partir da segunda. O painel examina até 12 resultados recentes por projeto e exibe **12+** ao atingir esse limite. |
| Um teste falhou | O placar coral entra de lado e freia. O texto identifica a tarefa e a duração aparece quando o executor registrou início e fim. |
| O executor interrompeu um teste | Um placar âmbar mostra o motivo, como cancelamento, tempo esgotado ou limite de disco. |
| Vários testes terminaram juntos | O mesmo placar reúne as contagens. Uma falha tem prioridade sobre as aprovações até o aviso desaparecer. |

Em **Discreto**, acompanhe as mudanças pelas linhas e pelo cabeçalho. Em **Sem efeitos**, os contadores, os resultados e os gráficos continuam atualizando. Com movimento reduzido ativado no sistema, o modo Arcade usa avisos compactos e parados. Todos os modos são silenciosos.

Ao abrir um log, você pode continuar lendo e usando o controle enquanto outros testes terminam. Para rever algo que passou pelo canto do olho, abra **Efeitos → Últimos avisos**. A lista guarda até 12 mudanças observadas nesta sessão. Ao voltar da suspensão ou reconectar, a estação retoma a partir da fila atual. As demonstrações ficam fora do histórico.
