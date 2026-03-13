import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { MultigamePatternDetector } from "../core/engine/PatternDetector.js";

dotenv.config();
// @ts-ignore
chromium.use(StealthPlugin());

// --- CONFIGURAÇÃO BANCO ---
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!,
);

// --- COORDENADAS CANVAS HACKSAW (1366x768) ---
const COORDS = {
  intro: { x: 717, y: 682 }, // Centro inferior (Splash screen)
  player: { x: 643, y: 570 }, // Botão PLAYER azul
  banker: { x: 1034, y: 570 }, // Botão BANKER vermelho
  confirm: { x: 194, y: 644 }, // Botão Verde "BET"
  clear: { x: 884, y: 673 },
  decrease: { x: 26, y: 643 }, // Seta esquerda (diminuir)
  increase: { x: 240, y: 641 }, // Seta direita (aumentar)
};

// --- TRADUTOR DE CARTAS (API HACKSAW) ---
class BaccaratLogic {
  static getVal(card: string): number {
    const v = parseInt(card.substring(1));
    return v >= 10 ? 0 : v;
  }
  static getWinner(p: string[], b: string[]): "player" | "banker" | "tie" {
    const pS = p.reduce((a, c) => (a + this.getVal(c)) % 10, 0);
    const bS = b.reduce((a, c) => (a + this.getVal(c)) % 10, 0);
    return pS > bS ? "player" : bS > pS ? "banker" : "tie";
  }
}

async function startBaccarat() {
  const detector = new MultigamePatternDetector();
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  let apostaAtiva: { lado: string; valor: number; isScouting: boolean } | null =
    null;
  let isInitialized = false;

  console.log("🛡️ [KADMOS] BACCARAT HACKSAW: Engine Individual Ativada");

  // --- MONITORAMENTO DE RESULTADOS (Onde o robô aprende) ---
  page.on("response", async (res) => {
    if (res.url().includes("api/play/bet") && res.status() === 200) {
      try {
        const json = await res.json();
        const event = json.round?.events?.[0]?.c;
        if (!event) return;

        const winner = BaccaratLogic.getWinner(
          event.playerHand,
          event.bankerHand,
        );

        // 1. GESTÃO FINANCEIRA: Consulta Dashboard a cada rodada
        const { data: db } = await supabase
          .from("CONTROLE_JOGOS")
          .select("*")
          .eq("tp_jogo", "BACCARAT")
          .single();
        if (!db?.sn_ativo) {
          console.log("⏸️ [BACCARAT] Pausado via Dashboard.");
          return;
        }

        // 2. REGISTRA RESULTADO NO BANCO (se for aposta real)
        if (apostaAtiva && !apostaAtiva.isScouting) {
          const isWin =
            apostaAtiva.lado === (winner === "player" ? "home" : "away");
          const lucro = isWin ? apostaAtiva.valor : -apostaAtiva.valor;

          await supabase.from("HISTORICO_APOSTAS").insert({
            tp_jogo: "BACCARAT",
            ds_resultado_mesa: winner === "player" ? "P" : "B",
            ds_lado_aposta: apostaAtiva.lado === "home" ? "P" : "B",
            vl_aposta: apostaAtiva.valor,
            tp_status: isWin ? "WIN" : "LOSS",
            vl_lucro_perda: winner === "tie" ? 0 : lucro,
          });
          apostaAtiva = null;
          console.log(`💰 [BACCARAT] ${isWin ? "WIN" : "LOSS"} registrado.`);
        }

        // 3. ANÁLISE DE PADRÃO (IGNORA TIE)
        if (winner !== "tie") {
          detector.addToHistory(winner === "player" ? "home" : "away");
          console.log(
            `🎰 [RESULTADO]: ${winner.toUpperCase()} | Histórico: [ ${detector.getHistory().join("->")} ]`,
          );

          const trigger = detector.checkTrigger(db.nr_sequencia_alvo); // Regra 5x do Dashboard

          if (trigger.isMatch && !apostaAtiva) {
            const base = Number(db.vl_aposta_base);
            console.log(`🎯 GATILHO! Atacando Oposto com R$ ${base}`);
            apostaAtiva = {
              lado: trigger.target as string,
              valor: base,
              isScouting: false,
            };
            await executeAction(trigger.target as any, base.toString());
          } else if (!apostaAtiva) {
            // SCOUTING (Mantém girando cartas)
            console.log("🔭 Scouting... (0.60)");
            apostaAtiva = { lado: "home", valor: 0.6, isScouting: true };
            await page.waitForTimeout(3000);
            await executeAction("home", "0.60");
          }
        } else {
          console.log("⚖️ EMPATE detectado, repetindo Scouting...");
          apostaAtiva = { lado: "home", valor: 0.6, isScouting: true };
          await executeAction("home", "0.60");
        }
      } catch (e) {}
    }
  });

  // --- FUNÇÃO DE INJEÇÃO MECÂNICA (AJUSTE POR SELETOR + COORDENADA) ---
  async function executeAction(side: "home" | "away", amount: string) {
    try {
      const frame = page.frame({ url: /hacksawgaming/ });
      if (!frame) return;

      const targetVal = parseFloat(amount);

      // 1. LER VALOR DA FICHA (No painel inferior)
      const readBetAmount = async () => {
        return await frame.evaluate(() => {
          const el = document.querySelector("#BetAmountValue");
          return el ? el.textContent?.replace(/[^\d.]/g, "") : "0";
        });
      };

      // 2. LER TOTAL DA MESA (Fichas reais jogadas)
      const readTotalAmount = async () => {
        return await frame.evaluate(() => {
          const el = document.querySelector("#TotalBetAmountValue");
          return el ? el.textContent?.replace(/[^\d.]/g, "") : "0";
        });
      };

      // 3. LIMPA MESA INICIAL (Garante que começa do zero)
      console.log("🧹 [HACKSAW] Executando Limpeza da Mesa...");
      // Tática de Clique Triplo no CLEAR (Mouse físico + Texto HTML + Canvas)
      await page.mouse.click(COORDS.clear.x, COORDS.clear.y, { delay: 150 });
      await frame
        .locator('button:has-text("CLEAR"), div:has-text("CLEAR")')
        .first()
        .click({ force: true, timeout: 500 })
        .catch(() => {});
      await frame
        .click("#webgl", { position: COORDS.clear, force: true })
        .catch(() => {});

      await page.waitForTimeout(800); // 🕒 Tempo longo para animação das fichas sumindo

      console.log(`💰 [AJUSTE] Buscando valor alvo: R$ ${targetVal}`);

      let safety = 0;
      // 4. AJUSTA APENAS A FICHA NO PAINEL (Sem jogar na mesa)
      while (safety < 80) {
        const currentFicha = parseFloat((await readBetAmount()) || "0");

        if (Math.abs(currentFicha - targetVal) < 0.01) {
          console.log(`   ✅ Ficha ajustada: R$ ${currentFicha}`);
          break;
        }

        // --- TÁTICA DE CLIQUE DUPLO ---
        if (currentFicha > targetVal) {
          await frame
            .locator("#BetAmountDecrease")
            .click({ force: true, timeout: 500 })
            .catch(() => {});
          await frame
            .click("#webgl", { position: COORDS.decrease, force: true })
            .catch(() => {});
        } else {
          await frame
            .locator("#BetAmountIncrease")
            .click({ force: true, timeout: 500 })
            .catch(() => {});
          await frame
            .click("#webgl", { position: COORDS.increase, force: true })
            .catch(() => {});
        }

        await page.waitForTimeout(100);
        safety++;
      }

      if (safety >= 80) throw new Error("Ajuste falhou após 80 tentativas.");

      // 5. JOGA A FICHA NA MESA (UMA VEZ SÓ)
      const pos = side === "home" ? COORDS.player : COORDS.banker;
      await frame.click("#webgl", { position: pos, force: true });
      await page.waitForTimeout(400); // Dá tempo do TotalBetAmount atualizar

      // 6. COMPARA O TOTAL DA MESA COM O ALVO ANTES DE CONFIRMAR
      const totalMesa = parseFloat((await readTotalAmount()) || "0");

      if (Math.abs(totalMesa - targetVal) < 0.01) {
        console.log(`   ✅ Total da mesa validado: R$ ${totalMesa}`);
        await frame.click("#PlaceBetBtn", { force: true });
        console.log(
          `🚀 [EXECUÇÃO] Aposta de R$ ${amount} no ${side.toUpperCase()} realizada.`,
        );
      } else {
        // SE DER ABORTADO: CLICA NO BOTAO DE CLEAR USANDO O MOUSE FÍSICO
        console.log("🧹 [HACKSAW] Abortando e limpando fichas acumuladas...");
        await page.mouse.click(COORDS.clear.x, COORDS.clear.y, { delay: 150 });
        await frame
          .locator('button:has-text("CLEAR"), div:has-text("CLEAR")')
          .first()
          .click({ force: true, timeout: 500 })
          .catch(() => {});
        await frame
          .click("#webgl", { position: COORDS.clear, force: true })
          .catch(() => {});

        await page.waitForTimeout(500); // Tempo pra limpar a tela
        throw new Error(
          `Total da mesa (R$${totalMesa}) não bateu com alvo (R$${targetVal}). Abortado e Limpo.`,
        );
      }
    } catch (err: any) {
      console.error("❌ Falha na injeção:", err.message);
    }
  }

  // --- FLUXO DE LOGIN AUTOMÁTICO ---
  await page.goto("https://betfast.bet.br/");
  try {
    await page.click(".yes._button", { timeout: 5000 }).catch(() => {});
    await page.goto("https://betfast.bet.br/br/casino/gamepage?gameid=25383");
    await page.waitForSelector('input[name="userName"]', { timeout: 15000 });
    await page.fill('input[name="userName"]', process.env.BETFAST_USER!);
    await page.fill('input[name="password"]', process.env.BETFAST_PASS!);
    await page.click('button[type="submit"]');
    console.log("✅ Login Realizado.");
  } catch (e) {}

  // Início forçado após renderização do Iframe
  setInterval(async () => {
    if (!isInitialized) {
      const frame = page
        .frames()
        .find((f) => f.url().includes("hacksawgaming"));
      if (frame) {
        console.log("⏳ Aguardando renderização do WebGL...");
        await page.waitForTimeout(20000);
        await frame
          .click("#webgl", { position: COORDS.intro, force: true })
          .catch(() => {});
        console.log("🚀 Injetando Scouting Inicial.");
        apostaAtiva = { lado: "home", valor: 0.6, isScouting: true };
        await executeAction("home", "270");
        isInitialized = true;
      }
    }
  }, 5000);
}

startBaccarat();
