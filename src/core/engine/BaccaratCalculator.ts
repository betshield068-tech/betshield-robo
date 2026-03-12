// src/core/engine/BaccaratCalculator.ts

export class BaccaratCalculator {
  // Converte a string da carta (ex: "S12", "H3") em valor de Baccarat
  private static getCardValue(card: string): number {
    const valStr = card.substring(1); // Remove o naipe (S, C, H, D)
    const val = parseInt(valStr);
    if (val >= 10) return 0; // 10, J, Q, K valem 0
    return val;
  }

  public static calculateWinner(
    playerHand: string[],
    bankerHand: string[],
  ): "player" | "banker" | "tie" {
    const pScore = playerHand.reduce(
      (acc, card) => (acc + this.getCardValue(card)) % 10,
      0,
    );
    const bScore = bankerHand.reduce(
      (acc, card) => (acc + this.getCardValue(card)) % 10,
      0,
    );

    if (pScore > bScore) return "player";
    if (bScore > pScore) return "banker";
    return "tie";
  }
}
