// src/infrastructure/automation/ExecutionEngine.ts
import { Page } from "playwright";

export class ExecutionEngine {
  public async login(page: Page) {
    console.log("🔐 Iniciando processo de login na Betfast...");
    await page.goto("https://betfast.io/casino/double", {
      waitUntil: "networkidle",
    });

    // Simulação de comportamento humano para clicar no login
    await page.click('button:has-text("Entrar")');

    // Substitua pelos seletores reais da Betfast
    await page.fill('input[type="text"]', process.env.BET_USER || "");
    await page.fill('input[type="password"]', process.env.BET_PASS || "");

    await page.click('button[type="submit"]');
    console.log("✅ Login realizado. Aguardando estabilização da conta...");
    await page.waitForTimeout(5000); // Delay humano para carregar banca
  }

  public async placeBet(
    page: Page,
    amount: number,
    side: "red" | "black" | "white",
  ) {
    try {
      // Seletores dinâmicos da Betfast
      const selectors = {
        input: ".bet-input-value",
        redBtn: ".btn-bet-red",
        blackBtn: ".btn-bet-black",
        whiteBtn: ".btn-bet-white",
      };

      await page.fill(selectors.input, amount.toString());

      const btn =
        side === "red"
          ? selectors.redBtn
          : side === "black"
            ? selectors.blackBtn
            : selectors.whiteBtn;

      await page.click(btn);
      console.log(`💰 Aposta Real de ${amount} no ${side} enviada!`);
    } catch (error) {
      console.error("❌ Falha ao clicar no botão de aposta:", error);
    }
  }
}
