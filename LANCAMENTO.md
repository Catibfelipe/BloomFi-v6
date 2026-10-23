# Guia de lançamento do BloomFi (versão oficial 6.3.1)

Siga na ordem. Tudo começa em **modo de teste** (nenhum dinheiro real), e só no fim você liga o modo real.

> **Novo na versão 6:** caçador de assinaturas, previsão do saldo dia a dia, alertas automáticos do Wally (e alertas que a pessoa cria), lançar por frase ou voz, **Wally com IA** (opcional) e **Família e casal** (espaço compartilhado, cada um com o seu login). Os passos novos são o **4b** (IA, opcional) e os itens 4 e 5 do **Passo 3** (planos).

> **Novo na versão 6.1 — planos por número de bancos:** **Essencial R$ 14,90** (sem conexão com bancos), **Plus R$ 24,90** (até 3 bancos) e **Premium R$ 34,90** (até 6). O plano Família saiu: cada pessoa, inclusive num espaço compartilhado, usa o próprio plano. Os bancos só conectam depois da primeira cobrança e são desconectados sozinhos na Pluggy quando o plano deixa de cobri-los, para você não pagar conexão de quem não paga.

> **Novo na versão 6.2 — o Wally anota e conversa por voz:** peça "wally, adicione um novo investimento de 10000 em CDB Bradesco" (ou "gastei 45 no mercado ontem", "crie uma meta de viagem de 8.000 até dezembro", "conta de luz de 150 todo dia 10"…) e o Wally prepara um **cartão para confirmar**: nada é salvo antes do **Confirmar** (ou de um "sim"), e tudo tem **Desfazer**. Funciona sem IA e fica ainda melhor com ela. O chat ganhou **microfone** (fala em vez de digitar) e **respostas em voz alta**. Também foram corrigidos o **código de e-mail** que às vezes não chegava ao criar a conta (veja o 🔴 do Passo 2) e a **senha que às vezes travava** ao entrar.

> **Novo na versão 6.3 — IA no próprio aparelho:** o Wally com IA agora roda no celular ou no computador da pessoa, sem a Anthropic: nada é enviado, não há chave para cadastrar nem custo por pergunta, e funciona sem internet depois de baixada. Veja o **Passo 4b**.

> **Versão oficial:** não existe mais nenhum dado de exemplo nem banco de demonstração. Cada conta começa vazia e só mostra o que a própria pessoa lança, o que chega do celular dela e o que vem do banco dela pelo Open Finance. Quem testou as versões anteriores com dados de exemplo tem esses dados apagados sozinho na primeira vez que abrir (os lançamentos verdadeiros ficam).

---

## O que o BloomFi faz

| Recurso | Como funciona |
|---|---|
| **Conta com nome, e-mail e senha** | Todo mundo cria uma conta (ou entra na que já tem). O e-mail é confirmado com um código de 6 números. A senha **nunca sai do aparelho**: ela vira chaves no próprio celular ou computador (Argon2id) e o servidor recebe só um valor derivado. Ao criar a conta, a pessoa recebe uma **chave de recuperação** para o caso de esquecer a senha. |
| **Celular e computador iguais** | Com a mesma conta, os dados aparecem iguais nos dois, sincronizados sozinhos a cada mudança, com **criptografia de ponta a ponta**: você (dono do servidor) não consegue ler as finanças de ninguém. |
| **Gastos do celular entram sozinhos** | Em **Conexões → Gastos do celular**, a pessoa cria um link pessoal e o app mostra o passo a passo: no **iPhone**, uma automação do app Atalhos manda cada compra do **Apple Pay** (e, se ela quiser, os **SMS do banco** e, no iOS 27, os **avisos do app do banco**, que pegam compras online e com **cartão virtual**); no **Android**, o app gratuito **MacroDroid** repassa os avisos da **Carteira do Google** e dos bancos. O BloomFi escolhe o cartão e a categoria, pede confirmação quando não tem certeza e aprende para a próxima. Quando o extrato chega pelo **Open Finance**, a compra é reconhecida e **nunca conta duas vezes**. |
| **Segurança reforçada** | Verificação em duas etapas (app autenticador + 10 códigos reserva), e-mail a cada novo acesso, código por e-mail quando alguém erra a senha muitas vezes, lista de aparelhos com **desconectar e apagar à distância**, sessões que expiram e percebem cópia, **PIN conferido pelo servidor** (10 erros e ele é apagado), biometria, bloqueio automático, pedido da senha completa a cada 30 dias, senhas vazadas recusadas e histórico de segurança. |
| **Só números de verdade** | Nada de dados de exemplo ou banco de demonstração: a conta começa com o saldo e a renda que a pessoa informar (ou zerada). Se as chaves da Pluggy não estiverem configuradas, a tela de bancos avisa que a conexão automática ainda não está disponível, em vez de mostrar um banco de mentira. |
| **Quem já usava a versão 4** | Ao abrir, desbloqueia com o PIN antigo e cria a conta (ou entra): tudo o que estava no aparelho entra na conta, criptografado, e a assinatura antiga vai junto. |
| **Foco no celular** | Telas de entrada, cadastro, desbloqueio e configuração pensadas para o celular; no computador, o mesmo app com menu lateral. |
| **Caçador de assinaturas** | Acha sozinho o que é cobrado todo mês ou todo ano (streaming, apps, academia…), mostra o total por mês e por ano e avisa quando um preço sobe, quando algo foi cobrado duas vezes e quando aparece uma assinatura nova. A pessoa marca "já cancelei", "não é assinatura" ou "me avisar antes de renovar". |
| **Previsão do saldo dia a dia** | Os próximos 30 dias com as contas, faturas e entradas já conhecidas (e, se a pessoa quiser, o gasto de costume do dia a dia): mostra o dia em que o dinheiro acaba, se acabar, e o menor saldo do período. |
| **Alertas automáticos do Wally** | Gasto fora do normal, cobrança repetida, cartão perto do limite, orçamento estourando, conta atrasada, dinheiro acabando — e alertas que a própria pessoa cria (ex.: "mercado passou de R$ 800 no mês"). Com os gastos do celular, um aviso na hora para compras acima de um valor. |
| **Lançar por frase ou voz** | "comprei tênis 600 em 3x ontem no Nubank" já preenche valor, categoria, data, cartão e parcelas. Também pelo microfone. |
| **O Wally anota por você** | No chat do Wally, a pessoa pede do jeito dela — "adicione um investimento de 10.000 em CDB Bradesco", "gastei 45 no mercado", "recebo 5.000 de salário todo dia 5", "crie uma meta de viagem de 8.000", "coloque um orçamento de 800 para mercado", "me avise quando o mercado passar de 900", "crie uma conta chamada Itaú com saldo de 500", "adicione um cartão Nubank com limite de 5.000" — e ele mostra um cartão com tudo preenchido (valor, categoria, data, conta, que dá para trocar ali mesmo). **Nada é salvo antes do Confirmar** (ou de responder "sim"), e cada cartão tem **Desfazer**. Funciona sem IA; com a IA ligada ele entende frases mais soltas e várias coisas de uma vez ("Confirmar todos"). |
| **Falar com o Wally** | Botão de **microfone** no chat (a pessoa fala e o Wally entende), as respostas e os cartões são **lidos em voz alta** quando a pergunta foi falada (ou sempre, ligando o alto-falante no topo), e cada resposta tem o botão de ouvir. Tudo usa a voz do próprio celular ou navegador: não custa nada e o áudio não passa pelo servidor do BloomFi. |
| **Wally com IA (opcional)** | A pessoa baixa a IA no próprio aparelho (uma vez) e pergunta qualquer coisa sobre o próprio dinheiro. Tudo roda no aparelho: nenhuma pergunta ou número é enviado, sem custo e sem limite. Em aparelhos sem WebGPU a opção avisa que não está disponível. |
| **Família e casal** | Um espaço compartilhado: cada pessoa com o próprio login, convite por link com aprovação do dono, conta conjunta, cartão da casa, metas e orçamentos em comum, "por Bia" em cada lançamento e a visão **Tudo / Só meu / Casa**. Criptografado de ponta a ponta como o resto. Cada pessoa usa o próprio plano. |
| **Planos por número de bancos** | **Essencial** (R$ 14,90, sem conexão com bancos), **Plus** (R$ 24,90, até 3 bancos) e **Premium** (R$ 34,90, até 6). Banco só conecta depois da primeira cobrança: no teste grátis não, e quem assina durante o teste pode tocar em **Pagar agora e liberar os bancos**. Troca de plano pelo próprio app. Plano menor, assinatura encerrada ou cartão recusado: o banco que o plano não cobre para de atualizar na hora e é desconectado na Pluggy depois de 3 dias (7 se o cartão foi recusado). |

Tudo o que já existia continua: contas e cartões com fatura e parcelas, agenda de contas, investimentos (aporte sai como débito), orçamentos, metas, relatórios, Wally, Open Finance, lembretes, assinatura com 7 dias grátis e o visual de sempre.

---

## Passo 0 — Contas que você vai precisar

| Serviço | Para quê | Custo |
|---|---|---|
| **Domínio próprio** (registro.br) | Endereço do site (ex.: `bloomfi.com.br`) e remetente dos e-mails | cerca de R$ 40 por ano |
| **GitHub** (github.com) | Guardar o código; o Netlify publica a partir dele | Grátis |
| **Netlify** (netlify.com) | Hospedar o site, o app e o servidor | Plano grátis atende o começo |
| **Resend** (resend.com) | E-mails com os códigos de confirmação e os avisos de segurança. **Agora é obrigatório** | Plano grátis (3.000 e-mails por mês) |
| **Stripe** (stripe.com/br) | Cobrar a assinatura | Taxa por cobrança, confira em stripe.com/br/pricing |
| **Pluggy** (pluggy.ai) | Open Finance | Teste grátis; produção é contratada com eles |

> ⚠️ O Netlify **Drop** (arrastar a pasta) **não publica o servidor**. Publique pelo GitHub (Passo 5).

---

## Passo 1 — Gerar as chaves do servidor (1 minuto)

1. Abra o arquivo `ferramentas/gerar-chaves.html` (dois cliques; roda só no seu computador).
2. Clique em **Gerar chaves**.
3. Guarde os três valores num lugar seguro (ex.: gerenciador de senhas) **e faça uma cópia de segurança**:
   - `APP_SECRET`
   - `LICENSE_PRIVATE_JWK`
   - `VAPID_PRIVATE_JWK` (notificações)

> 🔴 **Nunca troque o `APP_SECRET` depois do lançamento.** Ele protege as contas: se mudar, ninguém consegue mais entrar nem abrir a cópia sincronizada. Também nunca mande essas chaves para ninguém.

---

## Passo 2 — Domínio e e-mails (Resend)

Sem e-mail funcionando ninguém consegue criar conta, então este passo vem antes de tudo.

1. Registre o domínio em **registro.br** (ex.: `bloomfi.com.br`).
2. Crie a conta em **resend.com** → **Domains → Add Domain** → digite o seu domínio.
3. O Resend mostra alguns registros DNS (TXT e MX). Cadastre-os onde o domínio é administrado (no registro.br, em **DNS → Editar zona**, ou no Netlify, se você passar o DNS para ele no Passo 5). Volte ao Resend e clique em **Verify**. Pode levar de alguns minutos a algumas horas.
4. Em **API Keys → Create API Key** (permissão *Sending access*), copie a chave: ela vira a variável `RESEND_API_KEY`.
5. O remetente vira `EMAIL_FROM`, por exemplo: `BloomFi <nao-responda@bloomfi.com.br>`.

> 🔴 **"O código não chega no e-mail" = domínio ainda não verificado.** Enquanto o domínio não aparecer como **Verified** no Resend, e enquanto o `EMAIL_FROM` for o remetente de teste (`onboarding@resend.dev`), o Resend **só entrega para o e-mail dono da conta Resend**: qualquer outra pessoa que tente criar conta fica sem o código. Depois de verificar o domínio, coloque no Netlify `EMAIL_FROM` = `BloomFi <nao-responda@bloomfi.com.br>` (com o seu domínio) e publique de novo (**Deploys → Trigger deploy**).
>
> Desde a versão 6.2, quando o envio falha o app avisa na hora ("Não conseguimos enviar o e-mail agora…") em vez de deixar a pessoa esperando, os códigos anteriores continuam valendo por um tempo (quem pediu "reenviar" pode usar o primeiro que chegar) e o log da função (**Logs → Functions → api**) mostra uma linha `[e-mail] não enviado` com o motivo que o Resend deu.

> Se a chave do Resend já foi mostrada a alguém (por exemplo, numa conversa), **apague-a e crie outra** em API Keys.

---

## Passo 3 — Stripe (pagamentos)

1. Crie a conta em stripe.com/br. Fique no **modo de teste** (chave no canto superior direito).
2. **Developers → API keys** → copie a **Secret key** (`sk_test_...`). Ela vira `STRIPE_SECRET_KEY`. Também serve uma **chave restrita** (`rk_test_...` / `rk_live_...`, mais segura): dê a ela permissão **Write** em **Customers**, **Subscriptions**, **Checkout Sessions** e **Customer portal** — é só isso que o app usa do Stripe. Se faltar alguma, o log da função no Netlify (Logs → Functions → api) mostra uma linha `[stripe]` dizendo qual.
3. **Settings → Billing → Customer portal** → ative o portal e marque **"Customers can cancel subscriptions"**. É por ele que o cliente cancela sozinho (exigência do Código de Defesa do Consumidor). Deixe **desligado** "Customers can switch plans": a troca de plano é feita pelo próprio app.
4. **Planos:** já vêm prontos — **Essencial R$ 14,90** (sem bancos), **Plus R$ 24,90** (até 3 bancos) e **Premium R$ 34,90** (até 6 bancos). Não precisa criar nada no Stripe: o checkout cria a cobrança com esses nomes e valores. Para mudar valores ou quantidades, use `PLAN_ESSENCIAL_CENTS`, `PLAN_PLUS_CENTS` e `PLAN_PREMIUM_CENTS` (em centavos) e `PLAN_PLUS_BANKS` e `PLAN_PREMIUM_BANKS`. (Opcional: crie os produtos "BloomFi Essencial", "BloomFi Plus" e "BloomFi Premium" com preço mensal e coloque os IDs `price_...` em `STRIPE_PRICE_ESSENCIAL`, `STRIPE_PRICE_PLUS` e `STRIPE_PRICE_PREMIUM`.)
5. **Troca de plano e bancos:** a pessoa troca em **Ajustes → Assinatura → Mudar de plano**: o plano novo é cobrado na hora e o anterior é encerrado com crédito pelos dias não usados, que o Stripe desconta nas cobranças seguintes. Os bancos só conectam depois da primeira cobrança; quem assina durante o teste grátis tem a primeira cobrança no fim do teste, mas pode tocar em **Pagar agora e liberar os bancos**.

---

## Passo 4 — Pluggy (Open Finance)

1. Crie a conta em dashboard.pluggy.ai e crie uma **Application**.
2. Copie o **Client ID** e o **Client Secret**: viram `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET`.
3. Para bancos reais, peça à Pluggy o **acesso de produção** (eles pedem dados da empresa e a política de privacidade). Na mesma conversa, **confirme o preço por conexão e se existe mensalidade mínima** — os planos foram calculados com R$ 2,75 por banco conectado por mês.
4. No site oficial use **`PLUGGY_SANDBOX=false`**. O `true` serve só para testar: ele mostra também o banco fictício "Pluggy Bank" (usuário `user-ok`, senha `password-ok`), que inventa números. Se alguém conectou esse banco durante os testes, ao voltar para `false` ele some sozinho do app, junto com os números dele (o servidor nem entrega mais esses dados).

> Enquanto a Pluggy não liberar a produção, deixe `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET` **vazios** no site oficial. O app mostra "A conexão automática com bancos ainda não está disponível" e todo o resto (lançamentos, gastos do celular, importação de extrato) funciona normalmente. Quando a Pluggy liberar, é só cadastrar as duas e publicar de novo.

O aviso de "novos lançamentos do banco" (webhook) é configurado sozinho pelo app em cada conexão, com um endereço secreto por conta. Não precisa cadastrar nada no painel da Pluggy.

---

## Passo 4b — Wally com IA (no aparelho, nada a configurar)

Desde a versão 6.3, a IA do Wally **roda no celular ou no computador de cada pessoa** (WebLLM, com o modelo Qwen3, de código aberto). Não existe chave, conta ou custo para você, e nenhuma pergunta sai do aparelho.

- A pessoa liga em **Wally → Conhecer o Wally com IA** (ou **Ajustes → Wally com IA**) e escolhe **Leve** (~1,1 GB, para a maioria dos celulares) ou **Completa** (~2,3 GB, para computadores e celulares com bastante memória). O app indica a melhor para o aparelho.
- O download acontece uma vez só, direto do **Hugging Face** (onde o modelo é publicado), e fica guardado no navegador. Depois funciona sem internet e sem limite de perguntas.
- Precisa de **WebGPU**: Chrome ou Edge atualizados no computador e no Android, e Safari no iPhone com iOS 26. Onde não houver, a opção mostra o aviso e o Wally continua respondendo do jeito simples (que já anota gastos, investimentos, metas etc.).
- Pedidos claros para anotar ("gastei 45 no mercado", "investimento de 10000 em CDB Bradesco") continuam indo direto para o cartão, sem passar pela IA: é instantâneo e exato. A IA entra nas perguntas livres ("dá para trocar de carro este ano?").
- A segurança do site (`netlify.toml`) já libera o download do modelo (`huggingface.co`, `*.hf.co` e `raw.githubusercontent.com`). Não mude isso.

> Se você tinha cadastrado `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_MONTHLY_LIMIT` ou `AI_TRIAL_LIMIT` no Netlify, pode apagar: o servidor não usa mais. Apague também a chave em platform.claude.com, se ela existir.

---

## Passo 5 — Publicar (GitHub + Netlify)

**No GitHub:**
1. Crie um repositório **privado** chamado `bloomfi`.
2. Clique em **uploading an existing file** e arraste **todo o conteúdo** da pasta do projeto (menos `node_modules`, `dist` e o arquivo `.env`, se existirem). Clique em **Commit changes**.

**No Netlify:**
1. **Add new project → Import an existing project → GitHub** → escolha `bloomfi`.
2. As configurações de build já vêm do arquivo `netlify.toml`; não mexa.
3. Antes de publicar, em **Environment variables**, adicione (os nomes também estão no `.env.example`):

   | Variável | Valor |
   |---|---|
   | `APP_SECRET` | do Passo 1 |
   | `LICENSE_PRIVATE_JWK` | do Passo 1 (o texto inteiro, com as chaves `{ }`) |
   | `VAPID_PRIVATE_JWK` | do Passo 1 |
   | `RESEND_API_KEY` | do Passo 2 (**obrigatório**) |
   | `EMAIL_FROM` | ex.: `BloomFi <nao-responda@bloomfi.com.br>` |
   | `APP_ORIGIN` | o endereço principal do site, sem barra no fim, ex.: `https://bloomfi.com.br` |
   | `STRIPE_SECRET_KEY` | `sk_test_...` para testar; `sk_live_...` (ou a chave restrita `rk_live_...`) no lançamento (Passo 9) |
   | `PLUGGY_CLIENT_ID` / `PLUGGY_CLIENT_SECRET` | da Pluggy (deixe vazio até ter a produção, veja o Passo 4) |
   | `PLUGGY_SANDBOX` | `false` (`true` só enquanto testa com o banco fictício) |
   | `LEGAL_NAME` / `LEGAL_ID` / `LEGAL_ADDRESS` | seu nome completo ou razão social, CPF ou CNPJ e endereço (rua, número, bairro, cidade - UF, CEP): preenchem os Termos, a Privacidade e o rodapé do site sozinhos (a lei do comércio eletrônico pede esses dados no site) |
   | `FREE_ACCESS_EMAILS` | e-mails da família, separados por vírgula (opcional; usam de graça com o plano Premium — os bancos deles custam para você na Pluggy) |
   | `SUPPORT_EMAIL` / `SUPPORT_WHATSAPP` | contato de suporte mostrado no app, no site e nos Termos (o e-mail é necessário para os Termos; WhatsApp opcional, só com números, ex.: `5511999998888`) |
   | `IOS_SHORTCUT_URL` | link do atalho pronto do iPhone (opcional, veja o Passo 7) |
   | `PLAN_ESSENCIAL_CENTS` / `PLAN_PLUS_CENTS` / `PLAN_PREMIUM_CENTS` | preço de cada plano em centavos (opcionais; padrões 1490, 2490 e 3490) |
   | `PLAN_PLUS_BANKS` / `PLAN_PREMIUM_BANKS` | quantos bancos cada plano conecta (opcionais; padrões 3 e 6) |
   | `STRIPE_PRICE_ESSENCIAL` / `STRIPE_PRICE_PLUS` / `STRIPE_PRICE_PREMIUM` | IDs de preço criados no Stripe (opcionais) |
   | `SPACE_MAX_MEMBERS` | pessoas por espaço compartilhado (opcional; padrão 5) |

   > Deixe as variáveis com o escopo padrão (**All scopes**): os Termos e a Privacidade são preenchidos durante a publicação (build).

4. **Deploy**. Em ~1 minuto você recebe o link `https://….netlify.app`.
5. **Domínio:** em **Domain management → Add a domain**, coloque o seu domínio, siga as instruções de DNS e marque-o como **principal** (o Netlify ativa o HTTPS sozinho e manda o endereço `.netlify.app` para ele). O `APP_ORIGIN` tem que ser exatamente esse endereço principal: o servidor recusa chamadas que venham de outro endereço.

Contas, sessões, a cópia criptografada, os gastos do celular e os lembretes usam o armazenamento do próprio Netlify (Netlify Blobs), e uma função roda de hora em hora (lembretes e limpeza). Não precisa configurar mais nada.

Para atualizar depois: envie os arquivos novos ao GitHub do mesmo jeito e o Netlify publica sozinho. Quem já instalou vê "Nova versão disponível → Atualizar", **sem perder dados**.

---

## Passo 6 — Testar antes de lançar (modo teste)

Use dois aparelhos (um celular e um computador). No celular, instale o app na tela de início (Safari → Compartilhar → Adicionar à Tela de Início; no Android, Chrome → ⋮ → Instalar app).

**Conta**
- [ ] O site abre; **Começar 7 dias grátis** leva ao app em `/app/`.
- [ ] **Criar minha conta** → o código chega no e-mail (olhe o spam na primeira vez) → aparece a **chave de recuperação** → guarde-a.
- [ ] Ative o **PIN** e/ou a **biometria**. Feche e abra o app: ele pede o PIN.
- [ ] No computador, **Já tenho conta** → os mesmos dados aparecem; chega o e-mail "Novo acesso à sua conta".
- [ ] Lance um gasto no celular: em alguns segundos ele aparece no computador (e vice-versa).

**Gastos do celular**
- [ ] **Conexões → Gastos do celular** → escolha iPhone ou Android → siga o passo a passo → no último passo o app manda um teste: aparece "Teste recebido".
- [ ] Faça uma compra pequena por aproximação (ou receba um aviso do banco): o gasto aparece no BloomFi. Confirme o cartão e a categoria na primeira vez.

**Segurança**
- [ ] **Ajustes → Segurança → Verificação em duas etapas**: escaneie o QR no Google Authenticator (ou similar) e guarde os códigos reserva. Entrar em outro aparelho passa a pedir o código.
- [ ] **Trocar senha** no computador (com "Sair dos outros aparelhos" marcado): o celular pede para entrar de novo com a senha nova.
- [ ] **Ajustes → Segurança → Aparelhos conectados → Desconectar** um aparelho, marcando **Apagar os dados dele também**: na próxima vez que ele abrir com internet, os dados somem dele (continuam na conta).
- [ ] **Esqueci minha senha** → código no e-mail → chave de recuperação → senha nova → tudo continua lá.

**Assinatura e bancos**
- [ ] **Ajustes → Assinatura → Assinar agora** → cartão de teste `4242 4242 4242 4242`, validade futura, CVC qualquer → "Assinatura ativa!".
- [ ] **Gerenciar ou cancelar** abre o portal do Stripe.
- [ ] **Conexões → Conectar banco** (com `PLUGGY_SANDBOX=true`, só durante o teste) → banco de teste da Pluggy → contas, transações e investimentos aparecem. Depois volte para `false`.
- [ ] Uma conta nova começa **vazia**: só aparece o saldo e a renda que você informar no começo.
- [ ] **Ajustes → Lembretes de contas** no celular instalado → **Enviar um aviso de teste** chega.

**Novidades da versão 6**
- [ ] **+** → digite "almoço 32 ontem" (ou toque no microfone e fale) → **Usar** → salvar.
- [ ] **Assinaturas** (menu): com alguns meses de lançamentos, Netflix, Spotify, academia etc. aparecem com o total por mês.
- [ ] **Início → Próximos 30 dias**: o gráfico mostra o saldo dia a dia; toque em **Ver dias**.
- [ ] **Wally → Alertas → Ajustar → Novo alerta**: crie "Um lugar ou serviço" = mercado, R$ 200 por mês.
- [ ] No computador (Chrome) e no celular: **Wally → Conhecer o Wally com IA → Baixar a IA** (use o Wi-Fi) → a barra chega a 100% → pergunte "quanto gastei com mercado este mês?". Feche e abra o app: a IA responde sem baixar de novo (a primeira pergunta mostra "Acordando a IA…" por alguns segundos). Teste também com o Wi-Fi desligado.

**Novidades da versão 6.2**
- [ ] **Wally** → escreva "wally adicione um novo investimento de 10000 em cdb bradesco" → aparece o cartão **Novo investimento** com tudo preenchido → **Confirmar** → em **Investimentos** aparece o CDB Bradesco → volte ao Wally e toque em **Desfazer** → ele some.
- [ ] Escreva "gastei 45 no mercado ontem" → responda **sim** → o gasto aparece em **Gastos**.
- [ ] Toque no **microfone** (o navegador pede permissão na primeira vez), fale "crie uma meta de viagem de 8000 até dezembro" → o cartão aparece e o Wally lê em voz alta → diga **"pode confirmar"** pelo microfone.
- [ ] Toque no **alto-falante** no topo do Wally: as respostas passam a ser lidas em voz alta mesmo quando você digita.
- [ ] Crie uma conta nova com um e-mail que **não** é o da conta Resend: o código tem que chegar (se não chegar, é o 🔴 do Passo 2).
- [ ] **Família → Criar um espaço → Convidar alguém** → abra o link em outro aparelho, com outra conta → **Pedir para entrar** → aprove → compartilhe uma conta e lance um gasto nela dos dois lados.
- [ ] **Ajustes → Assinatura → Assinar agora**: aparecem Essencial, Plus e Premium. Escolha o **Plus** → cartão de teste `4242 4242 4242 4242` → de volta ao app, **Conexões → Open Finance** diz que os bancos são liberados na primeira cobrança → **Pagar agora e liberar os bancos** → **Conectar banco** funciona (até 3).
- [ ] **Ajustes → Assinatura → Mudar de plano → Premium** → no Stripe (Customers), a assinatura do Plus aparece encerrada e só a do Premium fica ativa.

---

## Passo 7 — Atalho pronto do iPhone (opcional, recomendado)

Sem ele, o app ensina a montar a automação à mão (uns 9 toques). Com ele, a pessoa só instala o atalho, cola o link pessoal e liga a automação. Você monta uma vez, no seu iPhone:

1. No app **Atalhos**, toque em **+** para criar um atalho e dê o nome **BloomFi**.
2. Adicione a ação **Texto**. Toque dentro dela, depois em **Entrada do Atalho** (na faixa acima do teclado) e escolha **Cartão ou Tiquete**.
3. Adicione a ação **Obter Conteúdo do URL**. No lugar de "URL", cole o seu próprio link pessoal (pegue um em Conexões → Gastos do celular).
4. Toque em **Mostrar Mais**: **Método** = **POST**, **Pedir Corpo** = **JSON**. Adicione três campos de **Texto**: `valor` = **Entrada do Atalho › Valor**; `local` = **Entrada do Atalho › Comerciante**; `cartao` = a variável **Texto**.
5. Abra os detalhes do atalho (toque no nome, no topo → **Detalhes**/**Configurar**) → **Perguntas de Importação** (*Import Questions*) → **Adicionar Pergunta** → escolha o campo de URL da ação **Obter Conteúdo do URL** e escreva: `Cole aqui o seu link pessoal do BloomFi (Conexões → Gastos do celular)`. Assim, cada pessoa cola o próprio link ao instalar, e o seu nunca vai junto.
6. Toque em **Compartilhar → Copiar Link do iCloud**. O link tem o formato `https://www.icloud.com/shortcuts/…`.
7. No Netlify, crie a variável `IOS_SHORTCUT_URL` com esse link e faça um novo deploy. O botão **Instalar o atalho do BloomFi** aparece no passo a passo do iPhone.

> Teste instalando o atalho por esse link num iPhone (o seu serve): ele deve perguntar o link pessoal. Depois de instalar, crie a automação **Transação** apontando para o atalho, como o app explica.

---

## Passo 8 — Família e amigos de graça

- **Pelo e-mail:** coloque os e-mails em `FREE_ACCESS_EMAILS`. Quem criar conta com um desses e-mails (e confirmar o código) usa de graça, com o plano Premium (até 6 bancos).
- **Por código:** abra `ferramentas/gerar-codigo-acesso.html`, cole o `APP_SECRET`, o e-mail da pessoa, quantos dias e **o plano** (Essencial, Plus ou Premium) — ou, no Terminal, `npm run acesso -- email@exemplo.com 365 plus`. Mande o código para a pessoa colar em **Assinatura → Tenho um código de acesso**. O código só funciona na conta com aquele e-mail e uma única vez.
- Lembre: cada banco que essas pessoas conectarem custa para você na Pluggy. Na dúvida, dê o Essencial.

---

## Passo 9 — Ligar o modo real

1. **Stripe:** ative a conta (dados pessoais/CNPJ e conta bancária), configure o Customer portal também no modo real e troque `STRIPE_SECRET_KEY` por `sk_live_...` ou pela chave restrita `rk_live_...` com as quatro permissões do Passo 3 (e os `STRIPE_PRICE_*`, se usou, pelos preços do modo real). Para conferir o modo real sem pagar nada: crie uma conta nova, assine durante os 7 dias grátis (o cartão só seria cobrado no fim do teste), veja "Assinatura ativa!" e cancele em **Gerenciar ou cancelar**.
2. **Pluggy:** produção liberada → chaves de produção e `PLUGGY_SANDBOX=false`. Sem produção ainda, chaves vazias (o app avisa que a conexão com bancos chega em breve).
3. **Preço no site:** se mudar os preços ou os bancos dos planos (`PLAN_*`), troque também os textos "R$ 14,90", "R$ 24,90", "R$ 34,90", "até 3" e "até 6" em `index.html` e em `legal/termos.html`.
4. **Termos e Privacidade:** cadastre `LEGAL_NAME`, `LEGAL_ID`, `LEGAL_ADDRESS` e `SUPPORT_EMAIL`. Na publicação, as páginas `/termos.html` e `/privacidade.html` são preenchidas sozinhas e o aviso "Faltam os dados" some. (Os textos ficam em `legal/`; revisão de um advogado é recomendada.)
5. Faça um novo deploy (Netlify → Deploys → Trigger deploy) e abra o site: confira o preço, os Termos preenchidos e crie a sua própria conta.

---

## Testar no seu computador

- **Mac, sem programar:** dois cliques em `Testar no Mac.command` (na pasta da Mesa, que já tem o arquivo `.env` com as suas chaves; o Stripe ali está em **modo de teste**, então nenhuma cobrança é de verdade). O app abre em `http://localhost:8888/app/`. Os códigos de e-mail também aparecem na janela do Terminal (útil enquanto o domínio não está verificado no Resend).
- **Para quem programa:**

```bash
npm install
npm test                               # servidor, contas, ataques simulados, capturas, faturas, sincronização, IA, espaços e planos
npm run build && npm run local:teste   # app completo com Stripe, Pluggy e e-mail simulados (códigos no Terminal)
```

---

## O que protege o quê

| Situação | O que acontece |
|---|---|
| Alguém copia o banco de dados do servidor | Encontra nomes e e-mails criptografados, senhas que nunca estiveram lá e finanças criptografadas com chaves que o servidor não tem. |
| Alguém descobre a senha de um cliente | Com a verificação em duas etapas ligada, ainda precisa do código do celular. O dono recebe e-mail a cada novo acesso e pode desconectar os outros aparelhos. |
| Alguém tenta adivinhar a senha | Cada rede fica cada vez mais lenta depois de 5 erros; com muitos erros de vários lugares, entrar num aparelho novo também pede um código no e-mail. |
| Celular perdido ou roubado | O app pede PIN, biometria ou senha; o PIN é conferido pelo servidor (10 erros e ele é apagado). Em outro aparelho: **Aparelhos conectados → Desconectar**, com **Apagar os dados dele também**. |
| Alguém copia os arquivos do aparelho | Os dados estão criptografados; o PIN não pode ser adivinhado a partir da cópia porque depende de um segredo do servidor. |
| Alguém tenta criar conta com o e-mail de outra pessoa | Não consegue: nada é criado sem o código que chega ao e-mail. |
| Alguém tenta descobrir se um e-mail tem conta no BloomFi | A resposta é a mesma e leva o mesmo tempo (pelo menos 1,5 s) com ou sem conta, no cadastro e no "esqueci minha senha". O dono recebe no máximo um aviso por hora de "tentaram criar conta com o seu e-mail". |
| Um convite de espaço cai em mãos erradas | O link vale uma única vez e por 7 dias, e ninguém entra sem a aprovação do dono do espaço. O segredo do link fica depois do "#", parte que o navegador nunca envia ao servidor. |
| Alguém é tirado de um espaço (ou sai) | Perde o acesso na hora: o servidor não entrega mais nada a essa conta, e o que era compartilhado sai do aparelho dela quando o app abre. |
| Uma pergunta ao Wally com IA | Não sai do aparelho: a IA roda nele. O único acesso à internet é o download do modelo (do Hugging Face), que não leva nenhum dado da pessoa. |
| Alguém de um espaço manda dados estragados ou maliciosos | Cada item compartilhado é conferido no aparelho de quem recebe (números, datas, cores e tipos); o que não serve é corrigido ou descartado. Se uma tela ainda assim falhar, aparece um aviso com saída (tentar de novo, Início ou Família), nunca a tela branca. |
| Uma conta que perdeu as chaves (senha redefinida sem a chave de recuperação) | Continua listada no espaço, mas não lê nem sobrescreve a cópia compartilhada até receber um convite novo. |
| Alguém tenta conectar mais bancos do que o plano permite | O servidor conta as conexões de cada conta e confere o plano no Stripe (não confia na licença do app): um banco a mais é desconectado na Pluggy na hora — mesmo se a pessoa reusar a janela de conexão ou nem abrir o app depois. Licença de outra conta ou forjada não adianta. |
| Alguém para de pagar com bancos conectados | Os bancos param de atualizar na hora e são desconectados na Pluggy depois de 3 dias (7 se o cartão foi recusado), para você não pagar a conexão de quem não paga. Os dados que já estavam no app ficam com a pessoa. |
| Alguém forja o endereço de origem para fugir dos limites de tentativas | No Netlify só vale o endereço que a própria plataforma informa; cabeçalhos enviados pelo visitante são ignorados. |

---

## Limitações que você deve conhecer

- **Sem a senha e sem a chave de recuperação, a cópia na nuvem não pode ser aberta.** É o preço da criptografia de ponta a ponta. A pessoa pode criar uma senha nova pelo e-mail, mas começa com a nuvem vazia; os aparelhos que ainda tiverem os dados os enviam de novo.
- **O PIN precisa de internet** (o servidor confere). Sem internet, a pessoa entra com a senha ou a biometria.
- **iPhone:** a automação "Transação" (Apple Pay) existe no iOS 17 ou mais novo e pega compras por aproximação; compras online e com cartão virtual entram pelos avisos do banco (iOS 27) ou pelo Open Finance. Lembretes no iPhone exigem o app instalado na tela de início (iOS 16.4+).
- **Android:** o MacroDroid precisa da permissão de ler notificações e de ficar liberado da economia de bateria; o app explica como.
- **A trava de renovação roda no aparelho.** A licença é assinada e não dá para falsificar, mas alguém com conhecimento técnico poderia modificar o app no próprio navegador. O que fica 100% protegido no servidor é o que o servidor faz (Open Finance, sincronização, contas).
- **Biometria** exige suporte a "passkeys com PRF" (iPhone com iOS 18+, Android e Chrome/Edge recentes). Onde não houver, ficam o PIN e a senha.
- **iPhone com Modo de Isolamento:** ele bloqueia um recurso que protege a senha (WebAssembly). O app explica como liberar só para o site do BloomFi.
- **Wally com IA** pode errar como qualquer IA; ele usa só os números do app e não é consultoria financeira. Em aparelhos sem WebGPU, com pouca memória ou se a IA falhar, responde do jeito simples. Um modelo pequeno é menos esperto que as IAs da nuvem: ele erra mais em perguntas complicadas, e em celulares mais simples pode levar alguns segundos por resposta. Por isso o que ele **anota** sempre passa por um cartão que a pessoa confere e confirma.
- **Voz:** entender a fala depende do navegador. Funciona no Chrome (Android e computador) e no Safari do iPhone; no app instalado na tela de início do iPhone, a Apple às vezes não libera o reconhecimento — aí o app avisa e a pessoa usa o microfone do próprio teclado para ditar. Ler as respostas em voz alta funciona em todos. O reconhecimento do Chrome e do Safari pode usar os servidores do Google ou da Apple para entender a fala (como o ditado do teclado).
- **Espaço compartilhado:** quem está no espaço pode editar e apagar o que é compartilhado (como uma planilha em conjunto) — por isso o dono aprova cada pessoa. Quem sai ou é tirado já viu o que estava lá e continua com a chave antiga do espaço: o servidor não entrega mais nada a essa conta, mas, para um sigilo total depois de uma saída brigada, o melhor é criar um espaço novo e compartilhar de novo. Se alguém redefinir a senha **sem** a chave de recuperação, precisa de um convite novo para voltar a ver o espaço.
- **Custos sob ataque:** o servidor limita tentativas por conta e por rede, mas um volume enorme de acessos ainda gasta créditos do Netlify (no plano grátis o site sai do ar se acabarem). Use o plano Personal do Netlify no lançamento.
- **Nenhum sistema é 100% seguro.** O BloomFi passou por revisão do código e por ataques simulados (todas as rotas sem sessão, de outro site, com dados forjados, espaços de outras pessoas e mais), que agora rodam a cada teste. Para um app financeiro com clientes pagantes, um teste de invasão feito por uma empresa especializada antes de crescer é o próximo passo recomendado.
