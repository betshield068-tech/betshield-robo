# MUDANÇA AQUI: De v1.41.0 para v1.58.2
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# Instala o pnpm
RUN npm install -g pnpm

# Copia os arquivos de configuração
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./

# Instala dependências
RUN pnpm install

# Copia o resto do código
COPY . .

# Expõe as variáveis de ambiente
ENV NODE_ENV=production

# Comando para rodar o robô
CMD ["pnpm", "start"]