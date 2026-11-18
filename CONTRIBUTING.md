# Como contribuir

O runtime usa a biblioteca padrão do Python. O dashboard usa arquivos estáticos. Faça uma alteração por branch e descreva no pull request o comportamento anterior, a mudança e a verificação executada.

| Arquivo | Responsabilidade |
|---|---|
| `client.py`, `catalog.py`, `settings.py` | Cadastro, snapshot e comunicação do Mac |
| `server.py`, `profiles.py` | Fila durável, admissão, limites e interface HTTP local |
| `run-project.sh`, `Containerfile*` | Preparação de dependências, banco e imagens |
| `web/` | Interface e marca da estação |
| `scripts/` | Instalação nos dois dispositivos e prévia local |

## Verificações

```sh
python3 -m unittest discover -v
node --check web/dashboard.js
shellcheck open-panel.sh run-project.sh
npm ci --prefix qa
(cd qa && npx playwright install webkit)
npm test --prefix qa
```

A suíte Python cobre concorrência, pausa, cancelamento, recursos, integridade do snapshot, cadastros, origem das ações e compatibilidade de URLs. A suíte de interface usa um WebKit headless, um único contexto e dados fictícios. O CI executa esses testes no Linux. Uma primeira instalação de WebKit no Linux pode exigir `npx playwright install --with-deps webkit`.

Para mudanças no transporte, valide também em um Mac e um Deck: instale, execute `doctor`, envie um teste e acompanhe-o após reconectar o túnel. Mudanças na inicialização gráfica precisam de inspeção no Plasma. Guarde recibos locais e capturas de instalações reais fora do repositório público.
