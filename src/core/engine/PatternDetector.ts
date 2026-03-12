// src/core/engine/PatternDetector.ts

export type GameResult =
  | "player"
  | "banker"
  | "home"
  | "away"
  | "red"
  | "black"
  | "tie"
  | "draw"
  | "even"
  | "odd";

export class MultigamePatternDetector {
  private history: GameResult[] = [];
  private readonly MAX_BUFFER = 20;

  public addToHistory(result: GameResult): void {
    // Regra Universal: Ignora empates (tie/draw) para não quebrar a contagem de sequências
    const cleanResult = result.toLowerCase() as GameResult;
    if (cleanResult === "tie" || cleanResult === "draw") return;

    this.history.push(cleanResult);
    if (this.history.length > this.MAX_BUFFER) this.history.shift();
  }

  public checkTrigger(sequenceLength: number): {
    isMatch: boolean;
    target?: GameResult;
  } {
    if (this.history.length < sequenceLength) return { isMatch: false };

    const lastN = this.history.slice(-sequenceLength);
    const allSame = lastN.every((res) => res === lastN[0]);

    if (allSame) {
      const last = lastN[lastN.length - 1];

      // Tabela de Reversão (Apostar no oposto)
      const reverseMap: Partial<Record<GameResult, GameResult>> = {
        player: "banker",
        banker: "player",
        home: "away",
        away: "home",
        red: "black",
        black: "red",
        even: "odd",
        odd: "even",
      };

      return { isMatch: true, target: reverseMap[last] };
    }
    return { isMatch: false };
  }

  public getHistory(): GameResult[] {
    return [...this.history];
  }
}
