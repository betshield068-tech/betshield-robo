// src/infrastructure/automation/HacksawDriver.ts
import { Page } from "playwright";

export class HacksawDriver {
  constructor(private page: Page) {}

  public async placeBet(side: "player" | "banker", amount: number) {
    // 1. Localizar o iframe do jogo (Hacksaw sempre usa iframe)
    const gameFrame = this.page.frameLocator('iframe[src*="hacksawgaming"]');

    // 2. Seletores baseados no canvas/componentes do Dare2Win
    // Nota: Hacksaw costuma usar coordenadas ou botões com textos específicos
    const betButton = gameFrame.getByText("BET", { exact: true });
    const sideButton =
      side === "player"
        ? gameFrame.getByText("PLAYER")
        : gameFrame.getByText("BANKER");

    // 3. Simulação Humana
    await sideButton.click({ delay: Math.random() * 200 + 100 });
    await this.page.waitForTimeout(Math.random() * 500 + 300);
    await betButton.click();

    console.log(`🕹️ Bot clicou em ${side} com R$ ${amount}`);
  }
}
