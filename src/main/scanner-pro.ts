import * as dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config();

const CONFIG = {
  user: process.env.BETFAST_USER || "",
  pass: process.env.BETFAST_PASS || "",
  gameUrl: "https://betfast.bet.br/br/casino/gamepage?gameid=25383",
};

async function runNuclearScanner() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();

  // 1. Criamos um canal de comunicação direto e blindado
  await page.exposeFunction("logClickToTerminal", (data: any) => {
    console.log(`\n📍 CLIQUE CAPTURADO!`);
    console.log(`   X: ${data.x}`);
    console.log(`   Y: ${data.y}`);
    console.log(`   Elemento: ${data.tag} | Role: ${data.role}`);
    console.log(`   Frame URL: ${data.url.substring(0, 60)}...`);
    console.log(`-----------------------------------------------`);
  });

  console.log("🛡️ INICIANDO NUCLEAR SCANNER...");

  // 2. Injetamos o rastreador em TODOS os frames que nascerem (inclusive os protegidos)
  await page.addInitScript(() => {
    window.addEventListener(
      "mousedown",
      (e) => {
        const el = e.target as HTMLElement;
        const data = {
          x: e.clientX,
          y: e.clientY,
          tag: el.tagName,
          role: el.getAttribute("data-role") || "n/a",
          url: window.location.href,
        };
        // @ts-ignore
        window.logClickToTerminal(data);
      },
      true,
    ); // O 'true' aqui é o segredo: captura o clique antes do jogo bloquear
  });

  // --- FLUXO DE LOGIN ---
  await page.goto(CONFIG.gameUrl);
  console.log("👉 Logue na sua conta agora.");
  console.log("👉 Quando o jogo abrir, CLIQUE no CASA, VISITANTE e FICHA.");
  console.log("👉 As coordenadas aparecerão aqui AUTOMATICAMENTE.");

  // Mantém o processo aberto
  page.on("close", () => process.exit());
}

runNuclearScanner();
