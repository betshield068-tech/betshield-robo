// src/infrastructure/websocket/SocketListener.ts
import WebSocket from "ws";
import type { GameColor } from "../../core/engine/PatternDetector";

export class SocketListener {
  private ws: WebSocket | null = null;
  // Endpoint Betfast (Geralmente varia conforme o provedor do Double)
  private url: string =
    "wss://api.betfast.io/socket.io/?EIO=3&transport=websocket";

  constructor(private onNewResult: (color: GameColor, roll: number) => void) {}

  public connect() {
    console.log("📡 Conectando ao cluster Betfast...");
    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      console.log("✅ Conexão estabelecida com Betfast.");
      // O comando de subscrição pode variar.
      // Exemplo padrão para salas de Double:
      this.ws?.send('42["join-room", "double"]');
    });

    this.ws.on("message", (data) => {
      const msg = data.toString();

      // Lógica de extração para Betfast
      // Nota: Precisamos monitorar o log bruto para confirmar o formato do JSON deles
      if (msg.includes("last_results") || msg.includes("new_result")) {
        try {
          const payload = JSON.parse(msg.substring(2))[1];

          // Mapeamento Betfast (Exemplo: 1-Vermelho, 2-Preto, 0-Branco)
          const colorMap: Record<number, GameColor> = {
            1: "red",
            2: "black",
            0: "white",
          };

          this.onNewResult(colorMap[payload.color], payload.value);
        } catch (e) {
          // Silent catch para mensagens de batimento cardíaco
        }
      }
    });
  }
}
