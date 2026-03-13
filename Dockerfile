# MUDANÇA AQUI: De v1.41.0 para v1.58.2
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# 1. Instala o Xvfb (Monitor Virtual)
RUN apt-get update && apt-get install -y xvfb

# 2. Instala o pnpm
RUN npm install -g pnpm

# Copia os arquivos de configuração
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./

# Instala dependências
RUN pnpm install

# Copia o resto do código
COPY . .

# Expõe as variáveis de ambiente
ENV NODE_ENV=production

# 3. Comando MUDADO: Inicia o monitor virtual e roda o robô dentro dele
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1366x768x24", "pnpm", "start"]