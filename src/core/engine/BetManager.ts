// src/core/engine/BetManager.ts

interface RiskConfig {
  baseStake: number;
  maxGales: number;
  multiplier: number;
  stopLoss: number;
  stopGain: number;
}

export class BetManager {
  private currentGale = 0;
  private totalProfit = 0;

  constructor(private config: RiskConfig) {}

  public getNextStake(lastResultWasWin: boolean | null): number {
    if (lastResultWasWin === true) {
      this.currentGale = 0;
      return this.config.baseStake;
    }

    if (lastResultWasWin === false) {
      this.currentGale++;
      if (this.currentGale > this.config.maxGales) {
        this.currentGale = 0; // Reset após estourar gales
        return this.config.baseStake;
      }
      return (
        this.config.baseStake *
        Math.pow(this.config.multiplier, this.currentGale)
      );
    }

    return this.config.baseStake; // Primeira aposta do ciclo
  }

  public canOperate(currentBalance: number): {
    allowed: boolean;
    reason?: string;
  } {
    if (this.totalProfit <= -this.config.stopLoss)
      return { allowed: false, reason: "STOP_LOSS" };
    if (this.totalProfit >= this.config.stopGain)
      return { allowed: false, reason: "STOP_GAIN" };
    return { allowed: true };
  }

  public registerResult(amount: number) {
    this.totalProfit += amount;
  }

  public getCurrentGale() {
    return this.currentGale;
  }
}
