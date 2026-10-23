#!/bin/bash
# BloomFi — roda o app oficial completo no seu Mac (pagamentos no modo de teste do Stripe: nenhuma cobrança de verdade).
# Dê dois cliques neste arquivo. Para parar, feche a janela do Terminal.
cd "$(dirname "$0")"
clear
echo "BloomFi — versão oficial rodando no seu computador"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Falta o Node.js. Vou abrir o site para você baixar (escolha a versão LTS)."
  echo "   Depois de instalar, dê dois cliques neste arquivo de novo."
  open "https://nodejs.org/pt"
  read -r -p "Pressione Enter para fechar…"; exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Seu Node.js é antigo (v$NODE_MAJOR). Instale a versão LTS em https://nodejs.org/pt"
  open "https://nodejs.org/pt"
  read -r -p "Pressione Enter para fechar…"; exit 1
fi
if [ ! -f .env ]; then
  echo "❌ Não encontrei o arquivo .env com as chaves nesta pasta."
  read -r -p "Pressione Enter para fechar…"; exit 1
fi

if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "📦 Instalando (só na primeira vez ou depois de uma atualização, ~1 minuto)…"
  npm install --no-audit --no-fund || { read -r -p "Falhou. Pressione Enter…"; exit 1; }
fi
echo "🔨 Preparando o app…"
npm run build --silent || { read -r -p "Falhou. Pressione Enter…"; exit 1; }

echo
echo "✅ Abrindo o app em http://localhost:8888/app/ no navegador."
echo "   O site de apresentação fica em http://localhost:8888"
echo "   Pagamentos no modo de teste do Stripe: use o cartão 4242 4242 4242 4242 · validade futura · CVC qualquer"
echo "   Os códigos de e-mail (criar conta, esqueci a senha) também aparecem aqui nesta janela."
echo "   Para parar, feche esta janela."
echo
(sleep 2; open "http://localhost:8888/app/") &
node scripts/servidor-local.mjs
