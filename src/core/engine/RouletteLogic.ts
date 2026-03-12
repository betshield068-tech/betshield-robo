// src/core/engine/RouletteLogic.ts

export class RouletteLogic {
  private static RED_NUMBERS = [
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
  ];

  public static getProperties(n: number) {
    if (n === 0) return { color: "zero", parity: "zero" };

    const color = this.RED_NUMBERS.includes(n) ? "red" : "black";
    const parity = n % 2 === 0 ? "even" : "odd";

    return { color, parity };
  }
}
