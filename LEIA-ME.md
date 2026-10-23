# BloomFi: sua coruja do dinheiro (versão oficial 6.3.1)

App de finanças pessoais para celular e computador (o mesmo app, com a tela adaptada), instalável como app. Versão oficial: sem dados de exemplo nem banco de demonstração; cada conta começa vazia e só mostra os números da própria pessoa. Inclui:

- **conta com nome, e-mail e senha**: e-mail confirmado por código, senha que nunca sai do aparelho, chave de recuperação
- **celular e computador iguais**: sincronização automática com **criptografia de ponta a ponta**
- **gastos do celular entram sozinhos**: Apple Pay (app Atalhos), SMS e avisos do app do banco no iPhone; Carteira do Google e avisos dos bancos no Android (MacroDroid), inclusive compras online e com cartão virtual
- **segurança**: verificação em duas etapas, e-mail a cada novo acesso, aparelhos conectados com desconexão e apagamento à distância, PIN conferido pelo servidor, biometria, bloqueio automático e senhas vazadas recusadas
- **site de apresentação** em `/` e o app em `/app/`
- contas e cartões com fatura e parcelas, **agenda** de contas, orçamentos, metas, relatórios e o assistente **Wally**
- **investimentos**: aplicações saem da conta como **débito**, resgates voltam como crédito
- **Open Finance** (Pluggy) para bancos, cartões e investimentos automáticos, sem contar duas vezes o que já veio do celular
- **caçador de assinaturas**, **previsão do saldo dia a dia** e **alertas automáticos do Wally** (inclusive alertas criados pela pessoa)
- **lançar por frase ou voz**: "comprei tênis 600 em 3x ontem" vira um lançamento pronto
- **o Wally anota por você**: "adicione um investimento de 10.000 em CDB Bradesco", "gastei 45 no mercado", "crie uma meta de viagem de 8.000" viram um cartão para confirmar (nada é salvo antes), com **Desfazer**; funciona sem IA
- **falar com o Wally**: microfone no chat e respostas lidas em voz alta, com a voz do próprio aparelho
- **Wally com IA (opcional), no próprio aparelho**: modelo Qwen3 rodando no navegador (WebLLM + WebGPU), baixado uma vez; nenhuma pergunta sai do aparelho, sem chave, sem custo e sem limite
- **Família e casal**: espaços compartilhados, cada pessoa com o seu login (e o seu plano), convite por link com aprovação e criptografia de ponta a ponta
- **assinatura mensal** (Stripe) com 7 dias grátis: **Essencial** (sem bancos), **Plus** (até 3 bancos) ou **Premium** (até 6 bancos)

👉 **Para publicar e lançar, siga o [LANCAMENTO.md](LANCAMENTO.md).**

## Como a segurança funciona (resumo técnico)

- A senha passa por **Argon2id** (64 MiB, 3 passadas) no aparelho. Dela saem, por HKDF, a chave de login (o servidor guarda só um scrypt dela), a chave que tranca a chave dos dados junto com uma parte que só o servidor tem, e a chave local do aparelho.
- Cada registro local é criptografado com **AES-256-GCM** e preso ao seu lugar ("loja:id"). A cópia na nuvem é um bloco único AES-GCM que só os aparelhos da conta abrem.
- Nome e e-mail ficam criptografados no servidor; o e-mail é procurado por HMAC.
- Sessão em cookie `__Host-` HttpOnly, Secure, SameSite=Strict, trocado a cada 3 dias, com detecção de cookie copiado. Toda rota do app exige o cabeçalho `X-BloomFi`, a origem certa e corpo JSON.
- Códigos por e-mail, códigos do autenticador, códigos reserva, tickets e PINs são contados e usados com compare-and-set (nada vale duas vezes, nem com pedidos simultâneos).
- Os gastos do celular chegam por HTTPS ao link pessoal e são criptografados na hora para a chave pública da conta (ECIES P-256).
- **Espaços compartilhados:** a chave do espaço nasce no aparelho do dono; cada pessoa a guarda no servidor trancada com uma chave derivada dos seus próprios dados (o servidor não abre). O convite leva um segredo no `#` do link (nunca enviado ao servidor): dele saem a prova que o servidor confere (só o hash fica guardado) e a chave que abre a caixa do convite. O dono aprova cada pessoa; a cópia compartilhada é AES-GCM presa ao id do espaço, e o que chega dela só pode virar registro daquele espaço.
- **Wally com IA:** roda no aparelho, numa thread própria (Web Worker) com WebLLM; o modelo vem do Hugging Face e fica no cache do navegador. As ferramentas leem os dados já abertos no aparelho e só devolvem o necessário ao modelo (sem ids). O servidor não tem rota de IA. O código da IA (~6 MB) não vai junto na instalação do app: é baixado na primeira vez que a pessoa liga a IA.
- **O Wally anota:** o que ele prepara (com ou sem IA) é só uma proposta no aparelho; nada é salvo antes de a pessoa confirmar o cartão, e o que a IA pede passa pelas mesmas checagens e ações dos formulários. A voz usa o reconhecimento e a fala do próprio navegador: o BloomFi não recebe áudio.
- Política de segurança do conteúdo (CSP) sem scripts de fora: só os do próprio site e o WebAssembly do Argon2.

## Estrutura

| Pasta/arquivo | O que é |
|---|---|
| `index.html`, `src/landing.css`, `public/landing/` | Site de apresentação (página inicial) |
| `app/index.html`, `src/` | O app (React), publicado em `/app/` |
| `src/lib/keys.js`, `src/lib/account.js` | Chaves e contas no aparelho (cadastro, entrada, 2FA, recuperação) |
| `src/db.js`, `src/lib/vault.js` | Banco de dados local criptografado, PIN, biometria, backups |
| `src/lib/sync.js` | Sincronização criptografada entre aparelhos |
| `src/lib/capture.js`, `src/components/PhoneCapture.jsx` | Gastos do celular (leitura dos avisos, cartão, categoria, duplicados) |
| `src/components/Auth.jsx`, `Lock.jsx`, `Security.jsx` | Telas de conta, desbloqueio e segurança |
| `src/lib/ledger.js` | Contas, cartões, faturas, parcelas e agenda |
| `src/lib/push.js`, `server/webpush.js`, `public/push-sw.js` | Lembretes e alertas (notificações) |
| `src/lib/billing.js` | Assinatura e licença no aparelho |
| `src/lib/openfinance.js` | Open Finance (Pluggy) |
| `src/lib/subscriptions.js`, `forecast.js`, `alerts.js`, `quickparse.js` | Caçador de assinaturas, previsão dia a dia, alertas do Wally, lançar por frase ou voz |
| `src/lib/aiTools.js`, `src/lib/aiChat.js`, `src/lib/aiSpec.js`, `src/lib/localAi.js`, `src/lib/localAi.worker.js` | Wally com IA no aparelho (ferramentas, instruções, o modelo local e a sua thread) |
| `src/lib/aiActions.js`, `src/pages/Advisor.jsx` | O Wally anota: frases e pedidos da IA viram cartões para confirmar, com desfazer |
| `src/lib/voice.js` | Falar com o Wally: microfone e respostas em voz alta |
| `src/lib/spaces.js`, `src/pages/Space.jsx`, `server/spaces.js` | Família e casal (chaves, convites, visões, cópia compartilhada) |
| `server/accounts.js`, `server/security.js` | Contas, sessões, 2FA, PIN, recuperação (servidor) |
| `server/wallet.js` | Links pessoais e caixa de entrada criptografada dos gastos do celular |
| `server/handler.js`, `server/storage.js`, `server/emails.js` | Rotas, armazenamento (Netlify Blobs) e e-mails |
| `netlify/functions/` | Liga o servidor ao Netlify (inclui a função de hora em hora) |
| `legal/termos.html`, `legal/privacidade.html`, `scripts/legal-pages.js` | Termos e Privacidade; seus dados (`LEGAL_NAME`, `LEGAL_ID`, `SUPPORT_EMAIL`) entram sozinhos na publicação |
| `ferramentas/` | Gerar chaves e códigos de acesso (abrir no navegador, offline) |
| `test/` | Testes do servidor, ataques simulados e serviços falsos |
| `.env.example` | Lista de variáveis de ambiente |

## Comandos

```bash
npm install
npm run dev            # desenvolvimento
npm run build          # gera dist/
npm test               # servidor, contas, ataques simulados, capturas, faturas, sincronização, IA e espaços compartilhados
npm run local:teste    # app + servidor com pagamentos, bancos e e-mail simulados (depois do build)
npm run build:link     # versão de página única (link do claude.ai), sem servidor
python3 scripts/inline-artifact.py saida.html   # junta essa versão num arquivo só
```
