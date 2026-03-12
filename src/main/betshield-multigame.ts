import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { BrowserContext, chromium, Page } from "playwright";
import { MultigamePatternDetector } from "../core/engine/PatternDetector.js";
import { RouletteLogic } from "../core/engine/RouletteLogic.js";

dotenv.config();

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
  baseStake: 5.0,
  maxMartingale: 12,
  stopWin: 200.0,
  stopLoss: -500.0,
};

// ==========================================
// 🛑 ADIÇÃO: ESTADO DE OPERAÇÃO EM TEMPO REAL
// ==========================================
const BotState = {
  killSwitch: false,
  activeGames: {
    FOOTBALL_STUDIO: true,
    BACCARAT_HACKSAW: true,
    ROULETTE_PLAYTECH: true,
  },
  profit: 0,
};

// Função para sincronizar as pausas do Dashboard em tempo real
async function syncWithDashboard() {
  console.log("📡 Conectando Sincronizador Realtime com Dashboard...");

  // 1. Busca estado inicial do banco
  const { data: config } = await supabase
    .from("CONFIGURACOES_BOT")
    .select("*")
    .eq("cd_configuracao", 1)
    .single();
  const { data: games } = await supabase.from("CONTROLE_JOGOS").select("*");

  if (config) BotState.killSwitch = config.sn_kill_switch_global;
  games?.forEach((g) => {
    const key =
      g.tp_jogo === "ROULETTE"
        ? "ROULETTE_PLAYTECH"
        : g.tp_jogo === "BACCARAT"
          ? "BACCARAT_HACKSAW"
          : "FOOTBALL_STUDIO";
    BotState.activeGames[key] = g.sn_ativo;
  });

  // 2. Escuta mudanças (cliques no Pausar/Play do Dashboard)
  supabase
    .channel("db_sync")
    .on(
      "postgres_changes",
      { event: "UPDATE", table: "CONFIGURACOES_BOT" },
      (payload) => {
        BotState.killSwitch = payload.new.sn_kill_switch_global;
        console.log(
          `⚠️ [DASHBOARD] Kill Switch Global: ${BotState.killSwitch ? "ATIVADO" : "DESATIVADO"}`,
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
        console.log(
          `🔄 [DASHBOARD] Módulo ${key}: ${payload.new.sn_ativo ? "PLAY ▶️" : "PAUSE ⏸️"}`,
        );
      },
    )
    .subscribe();
}

// Gerenciador de Sessão Global (Soma os resultados das 3 abas)
const SessionManager = {
  profit: 0,
  isActive: true,
  checkStops: async (browserInstance: any) => {
    if (SessionManager.profit >= CONFIG.stopWin) {
      console.log(
        `\n🏆 [META BATIDA] Stop Win atingido: R$ ${SessionManager.profit.toFixed(2)}! Encerrando robô.`,
      );
      SessionManager.isActive = false;
      await browserInstance.close();
      process.exit(0);
    }
    if (SessionManager.profit <= CONFIG.stopLoss) {
      console.log(
        `\n🛑 [STOP LOSS] Limite de perda atingido: R$ ${SessionManager.profit.toFixed(2)}. Encerrando robô.`,
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

  acquireLock: async (targetPage: Page, gameName: string) => {
    while (WindowManager.isMouseBusy) {
      await new Promise((r) => setTimeout(r, 200));
    }
    WindowManager.isMouseBusy = true;
    await targetPage.bringToFront();
    await targetPage.waitForTimeout(500);
  },

  releaseLock: async () => {
    WindowManager.isMouseBusy = false;
    if (WindowManager.baccaratPage) {
      await WindowManager.baccaratPage.bringToFront();
    }
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
type EvoGameType = keyof typeof EVOLUTION_TARGETS;

const HACKSAW_CANVAS_COORDS = {
  intro: { x: 741, y: 693 },
  player: { x: 643, y: 570 },
  tie: { x: 818, y: 566 },
  banker: { x: 1034, y: 570 },
  confirmBet: { x: 194, y: 644 },
  clear: { x: 884, y: 673 }, // <--- O NOVO BOTÃO DE LIMPEZA AQUI
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
  console.log(`🎮 [EVOLUTION] Inicializando Football Studio (Gatilho 6x)...`);
  const page = await context.newPage();
  const detector = new MultigamePatternDetector();
  const gameConfig = EVOLUTION_TARGETS.FOOTBALL_STUDIO;

  let isBetting = false;
  let apostaAtiva: any = null;
  let lastProcessedRound = "";
  let martingaleStep = 0;

  async function executeAction(side: "home" | "away", valor: number) {
    isBetting = true;
    try {
      await WindowManager.acquireLock(page, "EVOLUTION");

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
        `✅ [EVOLUTION] Aposta de R$${valor} injetada no ${side.toUpperCase()}.`,
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
        // 🛑 TRAVA DE PAUSA: Se pausado ou kill switch ativo, ignora a rodada
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
                  SessionManager.profit += resultValue;

                  await supabase.from("HISTORICO_APOSTAS").insert({
                    tp_jogo: "FOOTBALL_STUDIO",
                    ds_resultado_mesa: mapped === "home" ? "C" : "V",
                    ds_lado_aposta: apostaAtiva.lado === "home" ? "C" : "V",
                    vl_aposta: apostaAtiva.valor,
                    tp_status: isWin ? "WIN" : "LOSS",
                    vl_lucro_perda: resultValue,
                  });
                  console.log(
                    `💰 [EVOLUTION] ${isWin ? "WIN ✅" : "LOSS ❌"} | Lucro Global: R$ ${SessionManager.profit.toFixed(2)}`,
                  );

                  await SessionManager.checkStops(browser);

                  if (isWin) {
                    martingaleStep = 0;
                    apostaAtiva = null;
                  } else {
                    martingaleStep++;
                    if (martingaleStep > CONFIG.maxMartingale) {
                      martingaleStep = 0;
                      apostaAtiva = null;
                    } else {
                      const novoValor =
                        CONFIG.baseStake * Math.pow(2, martingaleStep);
                      apostaAtiva.valor = novoValor;
                      await executeAction(apostaAtiva.lado, novoValor);
                      return;
                    }
                  }
                }

                detector.addToHistory(mapped);
                console.log(
                  `🎰 [EVOLUTION] Vencedor: ${mapped.toUpperCase()} | Histórico: [ ${detector.getHistory().join(" -> ")} ]`,
                );

                const trigger = detector.checkTrigger(6);

                if (trigger.isMatch && !isBetting && !apostaAtiva) {
                  console.log(
                    `🎯 [EVOLUTION] GATILHO DETECTADO (6x)! Preparando ataque...`,
                  );
                  apostaAtiva = {
                    lado: trigger.target,
                    valor: CONFIG.baseStake,
                  };
                  await executeAction(trigger.target as any, CONFIG.baseStake);
                }
              }
            }
          } catch (e) {}
        }
      });
    }
  });

  await page.goto(gameConfig.url);
  await page.waitForTimeout(15000);

  await WindowManager.acquireLock(page, "EVO_CLEANUP");
  await page.mouse.click(1307, 59, { delay: 150 });
  await WindowManager.releaseLock();

  return page;
}

// ==========================================
// MOTOR 2: HACKSAW (Baccarat - TELA MESTRE)
// ==========================================
async function setupHacksawBaccarat(context: BrowserContext, browser: any) {
  console.log("🛡️ [HACKSAW] Baccarat: Inicializando motor Mestre...");
  const page = await context.newPage();
  WindowManager.baccaratPage = page;

  const detector = new MultigamePatternDetector();
  const gameUrl = "https://betfast.bet.br/br/casino/gamepage?gameid=25383";

  let gameFrame: any = null;
  let apostaAtiva: any = null;
  let martingaleStep = 0;

  page.on("response", async (res) => {
    if (res.url().includes("api/play/bet") && res.status() === 200) {
      // 🛑 TRAVA DE PAUSA: Interrompe o scouting ou aposta real se pausado
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

        if (apostaAtiva && apostaAtiva.isScouting === false) {
          const isWin = apostaAtiva.lado === winner;
          const resultValue = isWin
            ? apostaAtiva.valor
            : apostaAtiva.valor * -1;
          SessionManager.profit += resultValue;

          await supabase.from("HISTORICO_APOSTAS").insert({
            tp_jogo: "BACCARAT_HACKSAW",
            ds_resultado_mesa: winner === "home" ? "P" : "B",
            ds_lado_aposta: apostaAtiva.lado === "home" ? "P" : "B",
            vl_aposta: apostaAtiva.valor,
            tp_status: isWin ? "WIN" : "LOSS",
            vl_lucro_perda: resultValue,
          });
          console.log(
            `💰 [HACKSAW] ${isWin ? "WIN ✅" : "LOSS ❌"} | Lucro Global: R$ ${SessionManager.profit.toFixed(2)}`,
          );

          await SessionManager.checkStops(browser);

          if (isWin) {
            martingaleStep = 0;
            apostaAtiva = null;
          } else {
            martingaleStep++;
            if (martingaleStep > CONFIG.maxMartingale) {
              martingaleStep = 0;
              apostaAtiva = null;
            } else {
              const novoValor = CONFIG.baseStake * Math.pow(2, martingaleStep);
              apostaAtiva.valor = novoValor;
              console.log(
                `🔁 [HACKSAW] Iniciando Gale ${martingaleStep} de R$${novoValor}`,
              );
              await page.waitForTimeout(3000);
              await executeHacksawAction(
                gameFrame,
                apostaAtiva.lado,
                novoValor.toFixed(2),
              );
              return;
            }
          }
        }

        detector.addToHistory(winner);
        console.log(
          `🎰 [HACKSAW] RESULTADO: ${winner.toUpperCase()} | Histórico: [ ${detector.getHistory().join(" -> ")} ]`,
        );

        const trigger = detector.checkTrigger(5);

        if (trigger.isMatch && !apostaAtiva) {
          console.log(
            `🎯 [HACKSAW] GATILHO DETECTADO (5x)! Atacando com R$ ${CONFIG.baseStake}`,
          );
          apostaAtiva = {
            lado: trigger.target,
            valor: CONFIG.baseStake,
            isScouting: false,
          };
          await executeHacksawAction(
            gameFrame,
            trigger.target as any,
            CONFIG.baseStake.toFixed(2),
          );
        } else if (!apostaAtiva) {
          apostaAtiva = { isScouting: true };
          await page.waitForTimeout(3000);
          await executeHacksawAction(gameFrame, "home", "0.60");
        }
      } catch (err) {}
    }
  });

  async function executeHacksawAction(
    frame: any,
    side: "home" | "away",
    amount: string,
  ) {
    if (!frame) return;
    try {
      await WindowManager.acquireLock(page, "HACKSAW");

      await frame
        .click("#webgl", { position: HACKSAW_CANVAS_COORDS.clear, force: true })
        .catch(() => {});
      await page.waitForTimeout(300);

      const valSpan = frame.locator("#BetAmountValue");
      const decBtn = frame.locator("#BetAmountDecrease");
      const incBtn = frame.locator("#BetAmountIncrease");

      let current = (await valSpan.innerText()).replace("R$ ", "");
      let safety = 0;

      while (current !== amount && safety < 40) {
        if (parseFloat(current) > parseFloat(amount)) {
          await decBtn.click({ force: true });
        } else {
          await incBtn.click({ force: true });
        }
        await page.waitForTimeout(50);
        current = (await valSpan.innerText()).replace("R$ ", "");
        safety++;
      }

      const pos =
        side === "home"
          ? HACKSAW_CANVAS_COORDS.player
          : HACKSAW_CANVAS_COORDS.banker;
      await frame.click("#webgl", { position: pos, force: true });
      await page.waitForTimeout(300);
      await frame.click("#PlaceBetBtn", { force: true });
    } catch (e: any) {
      console.error("❌ [HACKSAW] Erro ao injetar aposta:", e.message);
    } finally {
      await WindowManager.releaseLock();
    }
  }

  await page.goto(gameUrl);
  console.log("⏳ [HACKSAW] Aguardando motor WebGL...");

  const checkFrameInterval = setInterval(async () => {
    if (!gameFrame) {
      gameFrame = page.frames().find((f) => f.url().includes("hacksawgaming"));
      if (gameFrame) {
        clearInterval(checkFrameInterval);
        console.log("✅ [HACKSAW] Jogo pronto. Clicando na Intro...");

        await WindowManager.acquireLock(page, "HACKSAW_INTRO");
        await gameFrame
          .click("#webgl", {
            position: HACKSAW_CANVAS_COORDS.intro,
            force: true,
          })
          .catch(() => {});
        await page.waitForTimeout(2000);
        await WindowManager.releaseLock();

        apostaAtiva = { isScouting: true };
        await executeHacksawAction(gameFrame, "home", "0.60");
      }
    }
  }, 5000);

  setInterval(async () => {
    if (apostaAtiva && apostaAtiva.isScouting) {
      await executeHacksawAction(gameFrame, "home", "0.60");
    }
  }, 25000);

  return page;
}

// ==========================================
// MOTOR 3: PLAYTECH (Roulette)
// ==========================================
async function setupPlaytechRoulette(context: BrowserContext, browser: any) {
  console.log("🛡️ [PLAYTECH] Roleta: Inicializando motor (Gatilho 8x)...");
  const page = await context.newPage();
  const colorDetector = new MultigamePatternDetector();
  const parityDetector = new MultigamePatternDetector();

  let isGameReady = false;
  let isBetting = false;
  let apostaAtiva: any = null;
  let lastFoundNumber: string | null = null;
  let martingaleStep = 0;

  async function executeRouletteStrike(
    target: keyof typeof PLAYTECH_COORDS.spots,
    valor: number,
  ) {
    isBetting = true;
    try {
      await WindowManager.acquireLock(page, "PLAYTECH");

      const chip =
        PLAYTECH_COORDS.chipCoords[
          valor as keyof typeof PLAYTECH_COORDS.chipCoords
        ] || PLAYTECH_COORDS.chipCoords[5];
      const cliques = PLAYTECH_COORDS.chipCoords[
        valor as keyof typeof PLAYTECH_COORDS.chipCoords
      ]
        ? 1
        : Math.ceil(valor / 5);

      await page.mouse.click(chip.x, chip.y, { delay: 120 });
      await page.waitForTimeout(500);

      const pos = PLAYTECH_COORDS.spots[target];
      for (let i = 0; i < cliques; i++) {
        await page.mouse.click(pos.x, pos.y, { delay: 150 });
        await page.waitForTimeout(100);
      }
      console.log(`✅ [PLAYTECH] Aposta cravada no ${target.toUpperCase()}`);
    } catch (e: any) {
      console.error(`❌ [PLAYTECH] Erro no ataque:`, e.message);
    } finally {
      await WindowManager.releaseLock();
      setTimeout(() => {
        isBetting = false;
      }, 20000);
    }
  }

  async function startMonitoring() {
    setInterval(async () => {
      // 🛑 TRAVA DE PAUSA: Para a leitura de DOM se pausado
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
          try {
            const historyItem = f
              .locator('[data-automation-locator="field.lastHistoryItem"]')
              .first();
            if ((await historyItem.count()) > 0) {
              currentText = await historyItem.innerText({ timeout: 500 });
              break;
            }
          } catch (innerErr) {}
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
            const isWinColor =
              apostaAtiva.tipo === "color" && apostaAtiva.lado === props.color;
            const isWinParity =
              apostaAtiva.tipo === "parity" &&
              apostaAtiva.lado === props.parity;
            const isWin = isWinColor || isWinParity;
            const resultValue = isWin
              ? apostaAtiva.valor
              : apostaAtiva.valor * -1;
            SessionManager.profit += resultValue;

            await supabase.from("HISTORICO_APOSTAS").insert({
              tp_jogo: "ROULETTE_PLAYTECH",
              ds_resultado_mesa: `NUM:${num}`,
              ds_lado_aposta: apostaAtiva.lado.toUpperCase(),
              vl_aposta: apostaAtiva.valor,
              tp_status: isWin ? "WIN" : "LOSS",
              vl_lucro_perda: resultValue,
            });
            console.log(
              `💰 [PLAYTECH] ${isWin ? "WIN ✅" : "LOSS ❌"} | Lucro Global: R$ ${SessionManager.profit.toFixed(2)}`,
            );

            await SessionManager.checkStops(browser);

            if (isWin) {
              martingaleStep = 0;
              apostaAtiva = null;
            } else {
              martingaleStep++;
              if (martingaleStep > CONFIG.maxMartingale) {
                martingaleStep = 0;
                apostaAtiva = null;
              } else {
                const novoValor =
                  CONFIG.baseStake * Math.pow(2, martingaleStep);
                apostaAtiva.valor = novoValor;
                await executeRouletteStrike(apostaAtiva.lado, novoValor);
                return;
              }
            }
          }

          console.log(
            `\n🎰 [PLAYTECH] NÚMERO: ${num} | ${props.color.toUpperCase()} | ${props.parity.toUpperCase()}`,
          );

          if (props.color !== "zero") {
            colorDetector.addToHistory(props.color as any);
            console.log(
              `📊 [PLAYTECH] Cor: [ ${colorDetector.getHistory().join(" -> ")} ]`,
            );

            const trigger = colorDetector.checkTrigger(8);
            if (trigger.isMatch && !isBetting && !apostaAtiva) {
              console.log(
                `🎯 [PLAYTECH] GATILHO COR (8x)! Atacando ${trigger.target}`,
              );
              apostaAtiva = {
                tipo: "color",
                lado: trigger.target,
                valor: CONFIG.baseStake,
              };
              await executeRouletteStrike(
                trigger.target as any,
                CONFIG.baseStake,
              );
              return;
            }
          }

          if (props.parity !== "zero") {
            parityDetector.addToHistory(props.parity as any);
            console.log(
              `📊 [PLAYTECH] Paridade: [ ${parityDetector.getHistory().join(" -> ")} ]`,
            );

            const trigger = parityDetector.checkTrigger(8);
            if (trigger.isMatch && !isBetting && !apostaAtiva) {
              console.log(
                `🎯 [PLAYTECH] GATILHO PARIDADE (8x)! Atacando ${trigger.target}`,
              );
              apostaAtiva = {
                tipo: "parity",
                lado: trigger.target,
                valor: CONFIG.baseStake,
              };
              await executeRouletteStrike(
                trigger.target as any,
                CONFIG.baseStake,
              );
            }
          }
        }
      } catch (e: any) {}
    }, 2000);
  }

  await page.goto(PLAYTECH_COORDS.url);
  await page.waitForTimeout(15000);

  try {
    await WindowManager.acquireLock(page, "PLAYTECH_LOBBY");
    await page.mouse.click(PLAYTECH_COORDS.banca.x, PLAYTECH_COORDS.banca.y, {
      delay: 150,
    });
    await page.waitForTimeout(2000);
    await page.mouse.click(PLAYTECH_COORDS.play.x, PLAYTECH_COORDS.play.y, {
      delay: 150,
    });
    await WindowManager.releaseLock();

    await page.waitForTimeout(5000);
    isGameReady = true;
    await startMonitoring();
  } catch (err) {
    await startMonitoring();
  }
  return page;
}

// ==========================================
// ORQUESTRADOR MESTRE E LOGIN
// ==========================================
async function runMultishield() {
  // Inicia o Sincronizador Realtime antes de tudo
  await syncWithDashboard();

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    permissions: ["geolocation"],
  });

  const mainPage = await context.newPage();

  console.log("🔐 Realizando login mestre forçado...");
  await mainPage.goto(EVOLUTION_TARGETS.FOOTBALL_STUDIO.url);

  try {
    await mainPage.click(".yes._button", { timeout: 5000 }).catch(() => {});
    await mainPage.waitForSelector('input[name="userName"]', {
      state: "visible",
      timeout: 15000,
    });

    await mainPage.fill('input[name="userName"]', CONFIG.user);
    await mainPage.fill('input[name="password"]', CONFIG.pass);
    await mainPage.click('button[type="submit"]');

    console.log("⏳ Autenticando e injetando cookies de sessão...");
    await mainPage.waitForTimeout(10000);
    await mainPage.close();

    console.log("🚀 Iniciando motores paralelos...");

    await setupEvolutionGame(context, browser);
    await new Promise((r) => setTimeout(r, 5000));

    await setupPlaytechRoulette(context, browser);
    await new Promise((r) => setTimeout(r, 5000));

    await setupHacksawBaccarat(context, browser);

    console.log("\n🛡️ BetShield MULTI-GAME ONLINE!");
    console.log(
      "📡 Sincronizado com Dashboard. Kill Switch e Pausas individuais ATIVOS.",
    );
  } catch (e: any) {
    console.error("❌ Erro crítico no login mestre:", e.message);
  }
}

runMultishield();
