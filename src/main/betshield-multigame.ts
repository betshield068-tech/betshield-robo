import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { BrowserContext, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { MultigamePatternDetector } from "../core/engine/PatternDetector.js";
import { RouletteLogic } from "../core/engine/RouletteLogic.js";

dotenv.config();
chromium.use(StealthPlugin());

// ==========================================
// 1. CONFIGURAÇÕES GLOBAIS E REGRAS
// ==========================================
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!,
);

const CONFIG = {
  user: process.env.BETFAST_USER || "",
  pass: process.env.BETFAST_PASS || "",
  homeUrl: "https://betfast.bet.br/",
  maxMartingale: 12,
  stopLoss: -500.0,
};

// ==========================================
// ESTADO DE OPERAÇÃO EM TEMPO REAL (DINÂMICO)
// ==========================================
const BotState = {
  killSwitch: false,
  activeGames: {
    FOOTBALL_STUDIO: true,
    BACCARAT_HACKSAW: true,
    ROULETTE_PLAYTECH: true,
  },
  specs: {
    FOOTBALL_STUDIO: { stake: 5.0, target: 6 },
    BACCARAT_HACKSAW: { stake: 5.0, target: 5 },
    ROULETTE_PLAYTECH: { stake: 5.0, target: 8 },
  },
  profit: 0,
  stopWin: 200.0,
};

// Função para sincronizar Pausas, Kill Switch e Especificações em tempo real
async function syncWithDashboard() {
  console.log("📡 Conectando Sincronizador Realtime com Dashboard...");

  const { data: config } = await supabase
    .from("CONFIGURACOES_BOT")
    .select("*")
    .eq("cd_configuracao", 1)
    .single();
  const { data: games } = await supabase.from("CONTROLE_JOGOS").select("*");

  if (config) {
    BotState.killSwitch = config.sn_kill_switch_global;
    BotState.stopWin = Number(config.vl_stop_win || 0); // Corrigido de vl_stop_gain para vl_stop_win
  }

  games?.forEach((g) => {
    const key =
      g.tp_jogo === "ROULETTE"
        ? "ROULETTE_PLAYTECH"
        : g.tp_jogo === "BACCARAT"
          ? "BACCARAT_HACKSAW"
          : "FOOTBALL_STUDIO";
    BotState.activeGames[key] = g.sn_ativo;
    BotState.specs[key] = {
      stake: Number(g.vl_aposta_base),
      target: Number(g.nr_sequencia_alvo),
    };
  });

  // --- LOG DE CONFIRMAÇÃO DE LEITURA DO BANCO ---
  console.log("\n📊 [STATUS DO BANCO DE DADOS CARREGADO]");
  console.log(
    `   ⚙️  GLOBAL: Stop Win: R$ ${BotState.stopWin} | Kill Switch: ${BotState.killSwitch ? "🔴 ATIVADO" : "🟢 OFF"}`,
  );
  console.log(
    `   ⚽ EVOLUTION : ${BotState.activeGames.FOOTBALL_STUDIO ? "ON" : "OFF"} | Base: R$ ${BotState.specs.FOOTBALL_STUDIO.stake} | Gatilho: ${BotState.specs.FOOTBALL_STUDIO.target}x`,
  );
  console.log(
    `   🃏 HACKSAW   : ${BotState.activeGames.BACCARAT_HACKSAW ? "ON" : "OFF"} | Base: R$ ${BotState.specs.BACCARAT_HACKSAW.stake} | Gatilho: ${BotState.specs.BACCARAT_HACKSAW.target}x`,
  );
  console.log(
    `   🎰 PLAYTECH  : ${BotState.activeGames.ROULETTE_PLAYTECH ? "ON" : "OFF"} | Base: R$ ${BotState.specs.ROULETTE_PLAYTECH.stake} | Gatilho: ${BotState.specs.ROULETTE_PLAYTECH.target}x\n`,
  );

  supabase
    .channel("db_sync")
    .on(
      "postgres_changes",
      { event: "UPDATE", table: "CONFIGURACOES_BOT" },
      (payload) => {
        BotState.killSwitch = payload.new.sn_kill_switch_global;
        BotState.stopWin = Number(payload.new.vl_stop_win);
        console.log(
          `⚠️ [DASHBOARD] Configurações Globais Atualizadas. Stop Win: R$ ${BotState.stopWin}`,
        );
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", table: "CONTROLE_JOGOS" },
      (payload) => {
        const key =
          payload.new.tp_jogo === "ROULETTE"
            ? "ROULETTE_PLAYTECH"
            : payload.new.tp_jogo === "BACCARAT"
              ? "BACCARAT_HACKSAW"
              : "FOOTBALL_STUDIO";
        BotState.activeGames[key] = payload.new.sn_ativo;
        BotState.specs[key] = {
          stake: Number(payload.new.vl_aposta_base),
          target: Number(payload.new.nr_sequencia_alvo),
        };
        console.log(
          `🔄 [DASHBOARD] ${key} Atualizado -> Ativo: ${payload.new.sn_ativo} | Base: R$ ${payload.new.vl_aposta_base} | Gatilho: ${payload.new.nr_sequencia_alvo}x`,
        );
      },
    )
    .subscribe();
}

// Gerenciador de Sessão Global
const SessionManager = {
  isActive: true,
  checkStops: async (browserInstance: any) => {
    if (BotState.profit >= BotState.stopWin) {
      console.log(
        `\n🏆 [META BATIDA] Stop Win atingido: R$ ${BotState.profit.toFixed(2)}!`,
      );
      SessionManager.isActive = false;
      await browserInstance.close();
      process.exit(0);
    }
  },
};

// ==========================================
// GERENCIADOR DE FOCO DA TELA (SEMÁFORO)
// ==========================================
const WindowManager = {
  baccaratPage: null as Page | null,
  isMouseBusy: false,
  acquireLock: async (targetPage: Page) => {
    while (WindowManager.isMouseBusy)
      await new Promise((r) => setTimeout(r, 200));
    WindowManager.isMouseBusy = true;
    await targetPage.bringToFront();
    await targetPage.waitForTimeout(500);
  },
  releaseLock: async () => {
    WindowManager.isMouseBusy = false;
    if (WindowManager.baccaratPage)
      await WindowManager.baccaratPage.bringToFront();
  },
};

// ==========================================
// 2. MAPEAMENTOS DE ALVOS (COORDENADAS)
// ==========================================
const EVOLUTION_TARGETS = {
  FOOTBALL_STUDIO: {
    url: "https://betfast.bet.br/br/casino/gamepage?gameid=5769",
    casa: { x: 568, y: 608 },
    visitante: { x: 797, y: 615 },
    chipCoords: {
      2.5: { x: 572, y: 670 },
      5: { x: 608, y: 670 },
      10: { x: 658, y: 675 },
      25: { x: 697, y: 669 },
      125: { x: 754, y: 674 },
      500: { x: 789, y: 671 },
    },
  },
};

const HACKSAW_CANVAS_COORDS = {
  intro: { x: 717, y: 682 }, // Centro inferior (Splash screen)
  player: { x: 643, y: 570 }, // Botão PLAYER azul
  banker: { x: 1034, y: 570 }, // Botão BANKER vermelho
  confirm: { x: 194, y: 644 }, // Botão Verde "BET"
  clear: { x: 884, y: 673 },
  decrease: { x: 26, y: 643 }, // Seta esquerda (diminuir)
  increase: { x: 240, y: 641 }, // Seta direita (aumentar)
};

class BaccaratLogic {
  static getVal(card: string): number {
    const v = parseInt(card.substring(1));
    return v >= 10 ? 0 : v;
  }
  static getWinner(p: string[], b: string[]): "home" | "away" | "tie" {
    const pS = p.reduce((a, c) => (a + BaccaratLogic.getVal(c)) % 10, 0);
    const bS = b.reduce((a, c) => (a + BaccaratLogic.getVal(c)) % 10, 0);
    return pS > bS ? "home" : bS > pS ? "away" : "tie";
  }
}

const PLAYTECH_COORDS = {
  url: "https://betfast.bet.br/br/casino/gamepage?gameid=20640",
  banca: { x: 144, y: 293 },
  play: { x: 565, y: 598 },
  chipCoords: {
    0.5: { x: 996, y: 668 },
    1: { x: 1035, y: 665 },
    2.5: { x: 1074, y: 674 },
    5: { x: 1114, y: 670 },
    20: { x: 1153, y: 675 },
  },
  spots: {
    red: { x: 705, y: 659 },
    black: { x: 780, y: 655 },
    even: { x: 626, y: 656 },
    odd: { x: 846, y: 659 },
  },
};

// ==========================================
// MOTOR 1: EVOLUTION (Football Studio)
// ==========================================
async function setupEvolutionGame(context: BrowserContext, browser: any) {
  console.log(`🎮 [EVOLUTION] Inicializando motor...`);
  const page = await context.newPage();
  const detector = new MultigamePatternDetector();
  const gameConfig = EVOLUTION_TARGETS.FOOTBALL_STUDIO;
  let isBetting = false,
    apostaAtiva: any = null,
    lastProcessedRound = "",
    martingaleStep = 0;

  async function executeAction(side: "home" | "away", valor: number) {
    isBetting = true;
    try {
      await WindowManager.acquireLock(page);
      const numValor = parseFloat(valor.toString());
      const chip =
        gameConfig.chipCoords[numValor as keyof typeof gameConfig.chipCoords] ||
        gameConfig.chipCoords[5];
      const cliques = gameConfig.chipCoords[
        numValor as keyof typeof gameConfig.chipCoords
      ]
        ? 1
        : Math.ceil(numValor / 5);

      await page.mouse.click(chip.x, chip.y, { delay: 120 });
      await page.waitForTimeout(500);
      const pos = side === "home" ? gameConfig.casa : gameConfig.visitante;
      for (let i = 0; i < cliques; i++) {
        await page.mouse.click(pos.x, pos.y, { delay: 150 });
        await page.waitForTimeout(100);
      }
      console.log(
        `✅ [EVOLUTION] Aposta INJETADA: R$ ${valor} no ${side.toUpperCase()}`,
      );
    } catch (e: any) {
      console.error(`❌ [EVOLUTION] Erro no ataque:`, e.message);
    } finally {
      await WindowManager.releaseLock();
      setTimeout(() => {
        isBetting = false;
      }, 20000);
    }
  }

  page.on("websocket", (ws) => {
    if (ws.url().includes("evo-games")) {
      ws.on("framereceived", async (payload) => {
        if (
          !SessionManager.isActive ||
          BotState.killSwitch ||
          !BotState.activeGames.FOOTBALL_STUDIO
        )
          return;
        const data = payload.payload.toString();
        if (data.includes("resolved")) {
          try {
            const cleanJson = data.substring(data.indexOf("{"));
            const msg = JSON.parse(cleanJson);
            const roundId = msg.args?.gameId || msg.id;
            if (!roundId || roundId === lastProcessedRound) return;
            lastProcessedRound = roundId;
            const rawWinner = msg.args?.result?.winner;
            if (rawWinner) {
              const mapped =
                rawWinner === "Dragon"
                  ? "home"
                  : rawWinner === "Tiger"
                    ? "away"
                    : "tie";
              if (mapped !== "tie") {
                if (apostaAtiva) {
                  const isWin = apostaAtiva.lado === mapped;
                  const resultValue = isWin
                    ? apostaAtiva.valor
                    : apostaAtiva.valor * -1;
                  BotState.profit += resultValue;
                  await supabase.from("HISTORICO_APOSTAS").insert({
                    tp_jogo: "FOOTBALL_STUDIO",
                    ds_resultado_mesa: mapped === "home" ? "C" : "V",
                    ds_lado_aposta: apostaAtiva.lado === "home" ? "C" : "V",
                    vl_aposta: apostaAtiva.valor,
                    tp_status: isWin ? "WIN" : "LOSS",
                    vl_lucro_perda: resultValue,
                  });
                  await SessionManager.checkStops(browser);
                  if (isWin) {
                    martingaleStep = 0;
                    apostaAtiva = null;
                  } else {
                    martingaleStep++;
                    if (martingaleStep <= CONFIG.maxMartingale) {
                      const novoValor =
                        BotState.specs.FOOTBALL_STUDIO.stake *
                        Math.pow(2, martingaleStep);
                      apostaAtiva.valor = novoValor;
                      console.log(
                        `🔁 [EVOLUTION] Gale ${martingaleStep}: Apostando R$ ${novoValor}`,
                      );
                      await executeAction(apostaAtiva.lado, novoValor);
                      return;
                    } else {
                      martingaleStep = 0;
                      apostaAtiva = null;
                    }
                  }
                }
                detector.addToHistory(mapped);
                console.log(
                  `🎰 [EVOLUTION] Vencedor: ${mapped.toUpperCase()} | Histórico: [ ${detector.getHistory().join(" -> ")} ]`,
                );
                const alvo = BotState.specs.FOOTBALL_STUDIO.target;
                const trigger = detector.checkTrigger(alvo);
                if (trigger.isMatch && !apostaAtiva) {
                  const base = BotState.specs.FOOTBALL_STUDIO.stake;
                  console.log(
                    `🎯 [EVOLUTION] GATILHO ${alvo}X! Preparando tiro de R$ ${base} no oposto.`,
                  );
                  apostaAtiva = { lado: trigger.target, valor: base };
                  await executeAction(trigger.target as any, base);
                }
              }
            }
          } catch (e) {}
        }
      });
    }
  });
  await page.goto(EVOLUTION_TARGETS.FOOTBALL_STUDIO.url);
  return page;
}

// ==========================================
// MOTOR 2: HACKSAW (Baccarat) - Versão de Produção Blindada
// ==========================================
async function setupHacksawBaccarat(context: BrowserContext, browser: any) {
  console.log("🛡️ [HACKSAW] Baccarat: Inicializando motor Mestre...");
  const page = await context.newPage();
  WindowManager.baccaratPage = page;
  const detector = new MultigamePatternDetector();
  let apostaAtiva: any = null,
    martingaleStep = 0;

  // --- ESCUTA RESPOSTAS DA PLATAFORMA ---
  page.on("response", async (res) => {
    if (res.url().includes("api/play/bet") && res.status() === 200) {
      if (
        !SessionManager.isActive ||
        BotState.killSwitch ||
        !BotState.activeGames.BACCARAT_HACKSAW
      )
        return;

      try {
        const json = await res.json();
        const event = json.round?.events?.[0]?.c;
        if (!event) return;

        const winner = BaccaratLogic.getWinner(
          event.playerHand,
          event.bankerHand,
        );

        // 1. GESTÃO DA APOSTA REAL (SE HOUVER)
        if (apostaAtiva && apostaAtiva.isScouting === false) {
          if (winner === "tie") {
            console.log(
              `🤝 [HACKSAW] EMPATE! Repetindo tiro real de R$ ${apostaAtiva.valor}...`,
            );
            await page.waitForTimeout(3000);
            await executeHacksawAction(
              apostaAtiva.lado,
              apostaAtiva.valor.toFixed(2),
            );
            return;
          }

          const isWin = apostaAtiva.lado === winner;
          const resultValue = isWin
            ? apostaAtiva.valor
            : apostaAtiva.valor * -1;
          BotState.profit += resultValue;

          await supabase.from("HISTORICO_APOSTAS").insert({
            tp_jogo: "BACCARAT",
            ds_resultado_mesa: winner === "player" ? "P" : "B",
            ds_lado_aposta: apostaAtiva.lado === "home" ? "P" : "B",
            vl_aposta: apostaAtiva.valor,
            tp_status: isWin ? "WIN" : "LOSS",
            vl_lucro_perda: resultValue,
          });

          await SessionManager.checkStops(browser);

          if (isWin) {
            martingaleStep = 0;
            apostaAtiva = null;
          } else {
            martingaleStep++;
            if (martingaleStep <= CONFIG.maxMartingale) {
              const novoValor =
                BotState.specs.BACCARAT_HACKSAW.stake *
                Math.pow(2, martingaleStep);
              apostaAtiva = {
                lado: apostaAtiva.lado,
                valor: novoValor,
                isScouting: false,
              };
              console.log(
                `🔁 [HACKSAW] GALE ${martingaleStep}: Alvo R$ ${novoValor}`,
              );
              await page.waitForTimeout(3000);
              await executeHacksawAction(
                apostaAtiva.lado,
                novoValor.toFixed(2),
              );
              return;
            } else {
              martingaleStep = 0;
              apostaAtiva = null;
            }
          }
        }

        // 2. GESTÃO DO PADRÃO (CONSTRUÇÃO DE HISTÓRICO)
        if (winner !== "tie") {
          detector.addToHistory(winner === "player" ? "home" : "away");
          console.log(
            `🎰 [HACKSAW] ${winner.toUpperCase()} | Histórico: [ ${detector.getHistory().join(" -> ")} ]`,
          );

          const target = BotState.specs.BACCARAT_HACKSAW.target;
          const trigger = detector.checkTrigger(target);

          if (trigger.isMatch && !apostaAtiva) {
            const stake = BotState.specs.BACCARAT_HACKSAW.stake;
            console.log(
              `🎯 [GATILHO] Atacando no ${trigger.target!.toUpperCase()} com R$ ${stake}`,
            );
            apostaAtiva = {
              lado: trigger.target,
              valor: stake,
              isScouting: false,
            };
            await executeHacksawAction(trigger.target as any, stake.toFixed(2));
          } else if (!apostaAtiva) {
            apostaAtiva = { isScouting: true };
            await page.waitForTimeout(3000);
            const baseStake = BotState.specs.BACCARAT_HACKSAW.stake.toFixed(2);
            await executeHacksawAction("home", baseStake);
          }
        } else {
          if (!apostaAtiva) {
            apostaAtiva = { isScouting: true };
            const baseStake = BotState.specs.BACCARAT_HACKSAW.stake.toFixed(2);
            await executeHacksawAction("home", baseStake);
          }
        }
      } catch (err) {}
    }
  });

  // =================================================================
  // FUNÇÃO DE INJEÇÃO MECÂNICA COPIADA DO CÓDIGO FUNCIONAL
  // =================================================================
  async function executeHacksawAction(side: "home" | "away", amount: string) {
    if (page.isClosed()) return;

    try {
      // OBRIGATÓRIO: Trava do mouse para não conflitar com a Roleta
      await WindowManager.acquireLock(page);
      await page.evaluate(() => window.scrollTo(0, 0));

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
      await page.mouse.click(
        HACKSAW_CANVAS_COORDS.clear.x,
        HACKSAW_CANVAS_COORDS.clear.y,
        { delay: 150 },
      );
      await frame
        .locator('button:has-text("CLEAR"), div:has-text("CLEAR")')
        .first()
        .click({ force: true, timeout: 500 })
        .catch(() => {});
      await frame
        .click("#webgl", { position: HACKSAW_CANVAS_COORDS.clear, force: true })
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
            .click("#webgl", {
              position: HACKSAW_CANVAS_COORDS.decrease,
              force: true,
            })
            .catch(() => {});
        } else {
          await frame
            .locator("#BetAmountIncrease")
            .click({ force: true, timeout: 500 })
            .catch(() => {});
          await frame
            .click("#webgl", {
              position: HACKSAW_CANVAS_COORDS.increase,
              force: true,
            })
            .catch(() => {});
        }

        await page.waitForTimeout(100);
        safety++;
      }

      if (safety >= 80) throw new Error("Ajuste falhou após 80 tentativas.");

      // 5. JOGA A FICHA NA MESA (UMA VEZ SÓ)
      const pos =
        side === "home"
          ? HACKSAW_CANVAS_COORDS.player
          : HACKSAW_CANVAS_COORDS.banker;
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
        await page.mouse.click(
          HACKSAW_CANVAS_COORDS.clear.x,
          HACKSAW_CANVAS_COORDS.clear.y,
          { delay: 150 },
        );
        await frame
          .locator('button:has-text("CLEAR"), div:has-text("CLEAR")')
          .first()
          .click({ force: true, timeout: 500 })
          .catch(() => {});
        await frame
          .click("#webgl", {
            position: HACKSAW_CANVAS_COORDS.clear,
            force: true,
          })
          .catch(() => {});

        await page.waitForTimeout(500); // Tempo pra limpar a tela
        throw new Error(
          `Total da mesa (R$${totalMesa}) não bateu com alvo (R$${targetVal}). Abortado e Limpo.`,
        );
      }
    } catch (err: any) {
      console.error("❌ Falha na injeção:", err.message);
    } finally {
      // OBRIGATÓRIO: Libera o mouse para as outras mesas voltarem a jogar
      await WindowManager.releaseLock();
    }
  }

  // --- INICIALIZAÇÃO DO JOGO ---
  await page.goto("https://betfast.bet.br/br/casino/gamepage?gameid=25383");

  const checkFrame = setInterval(async () => {
    const frame = page.frames().find((f) => f.url().includes("hacksawgaming"));
    if (frame && !apostaAtiva) {
      clearInterval(checkFrame);
      await page.waitForTimeout(20000); // Carregamento total

      await WindowManager.acquireLock(page);
      await frame
        .click("#webgl", { position: HACKSAW_CANVAS_COORDS.intro, force: true })
        .catch(() => {});
      await WindowManager.releaseLock();

      console.log("🚀 Motor Hacksaw Pronto.");
      apostaAtiva = { isScouting: true };

      // Busca o valor base diretamente do estado sincronizado com o DB
      const baseStake = BotState.specs.BACCARAT_HACKSAW.stake.toFixed(2);
      await executeHacksawAction("home", baseStake);
    }
  }, 5000);

  return page;
}

// ==========================================
// MOTOR 3: PLAYTECH (Roulette)
// ==========================================
async function setupPlaytechRoulette(context: BrowserContext, browser: any) {
  console.log("🛡️ [PLAYTECH] Roleta: Inicializando motor...");
  const page = await context.newPage();
  const colorDetector = new MultigamePatternDetector();
  const parityDetector = new MultigamePatternDetector();
  let isGameReady = false,
    isBetting = false,
    apostaAtiva: any = null,
    lastFoundNumber: string | null = null,
    martingaleStep = 0;

  async function executeRouletteStrike(
    target: keyof typeof PLAYTECH_COORDS.spots,
    valor: number,
  ) {
    isBetting = true;
    try {
      await WindowManager.acquireLock(page);
      const numValor = parseFloat(valor.toString());
      const chip =
        PLAYTECH_COORDS.chipCoords[
          numValor as keyof typeof PLAYTECH_COORDS.chipCoords
        ] || PLAYTECH_COORDS.chipCoords[5];
      const cliques = PLAYTECH_COORDS.chipCoords[
        numValor as keyof typeof PLAYTECH_COORDS.chipCoords
      ]
        ? 1
        : Math.ceil(numValor / 5);

      await page.mouse.click(chip.x, chip.y, { delay: 120 });
      await page.waitForTimeout(500);
      const pos = PLAYTECH_COORDS.spots[target];
      for (let i = 0; i < cliques; i++) {
        await page.mouse.click(pos.x, pos.y, { delay: 150 });
        await page.waitForTimeout(100);
      }
      console.log(
        `✅ [PLAYTECH] Aposta INJETADA: R$ ${valor} no ${target.toUpperCase()}`,
      );
    } catch (e: any) {
      console.error(`❌ [PLAYTECH] Erro:`, e.message);
    } finally {
      await WindowManager.releaseLock();
      setTimeout(() => {
        isBetting = false;
      }, 20000);
    }
  }

  async function startMonitoring() {
    setInterval(async () => {
      if (
        isBetting ||
        !SessionManager.isActive ||
        BotState.killSwitch ||
        !BotState.activeGames.ROULETTE_PLAYTECH
      )
        return;
      try {
        let currentText: string | null = null;
        const frames = page.frames();
        for (const f of frames) {
          const historyItem = f
            .locator('[data-automation-locator="field.lastHistoryItem"]')
            .first();
          if ((await historyItem.count()) > 0) {
            currentText = await historyItem.innerText({ timeout: 500 });
            break;
          }
        }
        const currentNumber = currentText?.trim();
        if (
          currentNumber &&
          currentNumber !== lastFoundNumber &&
          currentNumber !== ""
        ) {
          lastFoundNumber = currentNumber;
          const num = parseInt(currentNumber);
          if (isNaN(num)) return;
          const props = RouletteLogic.getProperties(num);

          if (apostaAtiva && isGameReady) {
            const isWin =
              (apostaAtiva.tipo === "color" &&
                apostaAtiva.lado === props.color) ||
              (apostaAtiva.tipo === "parity" &&
                apostaAtiva.lado === props.parity);
            const resultValue = isWin
              ? apostaAtiva.valor
              : apostaAtiva.valor * -1;
            BotState.profit += resultValue;
            await supabase.from("HISTORICO_APOSTAS").insert({
              tp_jogo: "ROULETTE_PLAYTECH",
              ds_resultado_mesa: `NUM:${num}`,
              ds_lado_aposta: apostaAtiva.lado.toUpperCase(),
              vl_aposta: apostaAtiva.valor,
              tp_status: isWin ? "WIN" : "LOSS",
              vl_lucro_perda: resultValue,
            });
            await SessionManager.checkStops(browser);
            if (isWin) {
              martingaleStep = 0;
              apostaAtiva = null;
            } else {
              martingaleStep++;
              if (martingaleStep <= CONFIG.maxMartingale) {
                const novoValor =
                  BotState.specs.ROULETTE_PLAYTECH.stake *
                  Math.pow(2, martingaleStep);
                apostaAtiva.valor = novoValor;
                console.log(
                  `🔁 [PLAYTECH] Gale ${martingaleStep}: Apostando R$ ${novoValor}`,
                );
                await executeRouletteStrike(apostaAtiva.lado, novoValor);
                return;
              } else {
                martingaleStep = 0;
                apostaAtiva = null;
              }
            }
          }

          console.log(
            `\n🎰 [PLAYTECH] NÚMERO: ${num} | ${props.color.toUpperCase()}`,
          );
          const alvo = BotState.specs.ROULETTE_PLAYTECH.target;
          const base = BotState.specs.ROULETTE_PLAYTECH.stake;

          if (props.color !== "zero") {
            colorDetector.addToHistory(props.color as any);
            const trigger = colorDetector.checkTrigger(alvo);
            if (trigger.isMatch && !isBetting && !apostaAtiva) {
              console.log(
                `🎯 [PLAYTECH] GATILHO COR ${alvo}X! Preparando tiro de R$ ${base} no oposto.`,
              );
              apostaAtiva = {
                tipo: "color",
                lado: trigger.target,
                valor: base,
              };
              await executeRouletteStrike(trigger.target as any, base);
              return;
            }
          }

          if (props.parity !== "zero") {
            parityDetector.addToHistory(props.parity as any);
            const trigger = parityDetector.checkTrigger(alvo);
            if (trigger.isMatch && !isBetting && !apostaAtiva) {
              console.log(
                `🎯 [PLAYTECH] GATILHO PARIDADE ${alvo}X! Preparando tiro de R$ ${base} no oposto.`,
              );
              apostaAtiva = {
                tipo: "parity",
                lado: trigger.target,
                valor: base,
              };
              await executeRouletteStrike(trigger.target as any, base);
            }
          }
        }
      } catch (e) {}
    }, 2000);
  }

  await page.goto(PLAYTECH_COORDS.url);
  await page.waitForTimeout(15000);
  try {
    await WindowManager.acquireLock(page);
    await page.mouse.click(PLAYTECH_COORDS.banca.x, PLAYTECH_COORDS.banca.y);
    await page.waitForTimeout(2000);
    await page.mouse.click(PLAYTECH_COORDS.play.x, PLAYTECH_COORDS.play.y);
    await WindowManager.releaseLock();
    isGameReady = true;
    await startMonitoring();
  } catch (err) {
    await startMonitoring();
  }
  return page;
}

// ==========================================
// ORQUESTRADOR MESTRE
// ==========================================
async function runMultishield() {
  await syncWithDashboard();

  // 1. BLINDAGEM DO BROWSER PARA CONTAINER
  const browser = await chromium.launch({
    headless: true, // No docker, geralmente precisa ser true se não houver display virtual configurado
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--window-position=0,0",
      "--ignore-certifcate-errors",
      "--ignore-certifcate-errors-spki-list",
      "--disable-blink-features=AutomationControlled", // Essencial para burlar Cloudflare
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    // Força um User-Agent de um navegador real de desktop
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const mainPage = await context.newPage();

  console.log("🔐 Realizando login mestre...");

  try {
    // 2. NAVEGAÇÃO HUMANA: Vai para a Home primeiro, não para o jogo direto
    await mainPage.goto(CONFIG.homeUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Fecha popup de maioridade/cookies se existir
    await mainPage
      .click(".yes._button, .btn-accept-cookies", { timeout: 5000 })
      .catch(() => {});

    // 3. FORÇA A ABERTURA DO MODAL DE LOGIN
    // Clica no botão "Entrar" do cabeçalho caso o input não esteja visível
    const isInputVisible = await mainPage.isVisible('input[name="userName"]');
    if (!isInputVisible) {
      console.log("🖱️ Clicando no botão de Login para abrir o modal...");
      // Procura botões comuns de login (ajuste o texto se na Betfast for diferente, ex: "LOGIN")
      const btnEntrar = mainPage
        .locator('button:has-text("Entrar"), a:has-text("Entrar"), .login-btn')
        .first();
      await btnEntrar.click({ timeout: 5000 }).catch(() => {});
    }

    // 4. AGUARDA E PREENCHE
    await mainPage.waitForSelector('input[name="userName"]', {
      state: "visible",
      timeout: 15000,
    });

    await mainPage.fill('input[name="userName"]', CONFIG.user);
    await mainPage.fill('input[name="password"]', CONFIG.pass);
    await mainPage.click('button[type="submit"]');

    // Aguarda desaparecer o form de login (indica sucesso)
    await mainPage.waitForSelector('input[name="userName"]', {
      state: "hidden",
      timeout: 15000,
    });
    console.log("✅ Autenticação concluída.");

    await mainPage.close();

    console.log("🚀 Motores ONLINE...");
    await setupEvolutionGame(context, browser);
    await new Promise((r) => setTimeout(r, 5000));
    await setupPlaytechRoulette(context, browser);
    await new Promise((r) => setTimeout(r, 5000));
    await setupHacksawBaccarat(context, browser);

    console.log("\n🛡️ BetShield MULTI-GAME SINCRONIZADO!");
  } catch (e: any) {
    console.error("❌ Erro crítico no login mestre:", e.message);
    await mainPage.screenshot({
      path: "erro_login_container.png",
      fullPage: true,
    });
    console.log(
      "📸 Novo print salvo como 'erro_login_container.png'. Verifique o arquivo!",
    );
    await browser.close();
    process.exit(1);
  }
}

runMultishield();
