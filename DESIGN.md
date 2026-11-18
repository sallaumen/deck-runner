# Design da estação

A estação acompanha testes a uma distância de braço, em uma tela de 1280 × 800 ao lado de outro monitor. O estado precisa ser compreensível em um olhar. Durante a execução, as informações prioritárias são agente, projeto, tempo e vagas. Quando a fila esvazia, o último resultado de cada projeto continua visível.

| Elemento | Decisão |
|---|---|
| Superfícies | Fundo azul-petróleo escuro, planos sólidos e divisórias finas. Evitam reflexos visuais em uma tela sempre ligada. |
| Hierarquia | Estado grande à esquerda, cinco segmentos de capacidade à direita, tarefas antes do histórico. No telefone, a fila precede os projetos e o histórico. |
| Semântica | Menta para conexão, tarefas e aprovação. Âmbar para pausa e reconexão. Coral para falhas. Cada cor acompanha texto ou uma descrição acessível. |
| Marca | Traço de retorno aberto com um segundo traço âmbar. O mesmo desenho identifica o lançador no Plasma, a aba do navegador e o cabeçalho. |
| Tipografia | Fonte de interface do sistema, com Inter quando disponível. Números e diagnósticos em fonte monoespaçada. Os recursos visuais são locais. |
| Atualização | Consulta a cada quatro segundos e limite de oito segundos por leitura. Atualizações preservam o foco e a última leitura disponível. |
| Interação | Tela de acompanhamento com controles recolhidos. No modo de operação, filtro, pausa, logs e cancelamento têm nomes explícitos e foco visível. |

Os valores de cor e tipografia estão em `web/dashboard.css`. Valide mudanças em 1280 × 800 e 375 × 812, com a fila vazia, ativa, pausada e sem conexão. Use `scripts/preview.py` para imagens públicas.
