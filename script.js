"use strict";

// Elementos já existentes no index.html
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const cameraPlaceholder = document.getElementById("cameraPlaceholder");
const statusCamera = document.getElementById("status");
const elementoFlexao = document.getElementById("flexao");
const elementoAngulo = document.getElementById("angulo");
const elementoPontos = document.getElementById("pontos");
const botaoConectar = document.getElementById("conectarArduino");
const botaoDesconectar = document.getElementById("desconectarArduino");
const statusArduino = document.getElementById("statusArduino");

// Calibracao inicial
const CALIBRACAO = {
  indicador: { aberto: 175, fechado: 65 },
  polegar: { aberto: 165, fechado: 65 }
};

// Configuracoes de movimento
const SUAVIZACAO = 0.28;
const INTERVALO_ENVIO_MS = 60;
const MUDANCA_MINIMA = 1;

// Filtros independentes
const angulosFiltrados = {
  indicador: null,
  polegar: null
};

let ultimoComando = {
  indicador: null,
  polegar: null
};

let ultimoEnvio = 0;
let pausarRastreamentoAte = 0;

// Camera / MediaPipe
let hands = null;
let cameraStream = null;
let cameraAtiva = false;
let processandoFrame = false;

// Comunicacao serial
let portaSerial = null;
let escritorSerial = null;
let leitorSerial = null;
let filaSerial = Promise.resolve();

// Conexoes da mao
const CONEXOES_MAO = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

// ===== ATUALIZAR INTERFACE =====

function atualizarTexto(elemento, texto) {
  if (elemento) {
    elemento.textContent = texto;
  }
}

function atualizarStatusCamera(texto) {
  atualizarTexto(statusCamera, texto);
}

function atualizarStatusArduino(texto) {
  atualizarTexto(statusArduino, texto);
}

function limitar(valor, minimo, maximo) {
  return Math.max(minimo, Math.min(maximo, valor));
}

// ===== CALCULAR ANGULOS =====

function calcularAngulo(a, b, c) {
  const abx = a.x - b.x;
  const aby = a.y - b.y;

  const cbx = c.x - b.x;
  const cby = c.y - b.y;

  const produto = abx * cbx + aby * cby;

  const moduloAB = Math.hypot(abx, aby);
  const moduloCB = Math.hypot(cbx, cby);

  if (moduloAB === 0 || moduloCB === 0) {
    return 180;
  }

  const cosseno = limitar(
    produto / (moduloAB * moduloCB),
    -1,
    1
  );

  return Math.acos(cosseno) * (180 / Math.PI);
}

function calcularAngulos(mao) {

  // INDICADOR
  const indicadorPIP = calcularAngulo(
    mao[5],
    mao[6],
    mao[7]
  );

  const indicadorDIP = calcularAngulo(
    mao[6],
    mao[7],
    mao[8]
  );

  const indicador =
    indicadorPIP * 0.75 +
    indicadorDIP * 0.25;

  // POLEGAR
  const polegarMCP = calcularAngulo(
    mao[1],
    mao[2],
    mao[3]
  );

  const polegarIP = calcularAngulo(
    mao[2],
    mao[3],
    mao[4]
  );

  const polegar =
    polegarIP * 0.75 +
    polegarMCP * 0.25;

  return {
    indicador,
    polegar
  };
}

// ===== SUAVIZAR MOVIMENTOS =====

function suavizarAngulo(nome, leitura) {
  const anterior = angulosFiltrados[nome];

  if (anterior === null) {
    angulosFiltrados[nome] = leitura;
  } else {
    angulosFiltrados[nome] =
      anterior + (leitura - anterior) * SUAVIZACAO;
  }

  return angulosFiltrados[nome];
}

// ===== CONVERTER ANGULO DA MAO EM ANGULO DO SERVO =====

function mapearParaServo(angulo, calibracao) {

  const amplitude =
    calibracao.aberto - calibracao.fechado;

  if (Math.abs(amplitude) < 1) {
    return 0;
  }

  // Mao aberta = servo em 0
  // Mao fechada = servo em 180

  const fracao =
    (calibracao.aberto - angulo) / amplitude;

  return Math.round(
    limitar(fracao, 0, 1) * 180
  );
}

// ===== ENVIAR DADOS PARA O ARDUINO =====

function enviarLinhaSerial(indicador, polegar) {

  if (!escritorSerial) {
    return;
  }

  const escritorAtual = escritorSerial;

  // IMPORTANTE:
  // Primeiro indicador, depois polegar.
  const linha =
    `${Math.round(indicador)},${Math.round(polegar)}\n`;

  filaSerial = filaSerial
    .then(async () => {

      if (escritorSerial !== escritorAtual) {
        return;
      }

      await escritorAtual.write(
        new TextEncoder().encode(linha)
      );

    })
    .catch((erro) => {
      atualizarStatusArduino(
        `Falha ao enviar: ${erro.message}`
      );
    });
}

// ===== ENVIO AUTOMATICO =====

function enviarAutomaticamente(indicador, polegar) {

  if (!escritorSerial) {
    return;
  }

  if (Date.now() < pausarRastreamentoAte) {
    return;
  }

  const agora = performance.now();

  if (agora - ultimoEnvio < INTERVALO_ENVIO_MS) {
    return;
  }

  const mudou =
    ultimoComando.indicador === null ||
    ultimoComando.polegar === null ||
    Math.abs(
      indicador - ultimoComando.indicador
    ) >= MUDANCA_MINIMA ||
    Math.abs(
      polegar - ultimoComando.polegar
    ) >= MUDANCA_MINIMA;

  if (!mudou) {
    return;
  }

  ultimoEnvio = agora;

  ultimoComando.indicador = indicador;
  ultimoComando.polegar = polegar;

  enviarLinhaSerial(indicador, polegar);
}

// ===== DESENHAR A MAO NA TELA =====

function desenharMao(mao, largura, altura) {

  if (!canvas) {
    return;
  }

  const contexto = canvas.getContext("2d");

  if (!contexto) {
    return;
  }

  if (canvas.width !== largura) {
    canvas.width = largura;
  }

  if (canvas.height !== altura) {
    canvas.height = altura;
  }

  contexto.clearRect(
    0,
    0,
    largura,
    altura
  );

  contexto.lineWidth = 3;
  contexto.strokeStyle = "#00e676";
  contexto.fillStyle = "#ffffff";

  for (const [inicio, fim] of CONEXOES_MAO) {

    contexto.beginPath();

    contexto.moveTo(
      mao[inicio].x * largura,
      mao[inicio].y * altura
    );

    contexto.lineTo(
      mao[fim].x * largura,
      mao[fim].y * altura
    );

    contexto.stroke();
  }

  for (const ponto of mao) {

    contexto.beginPath();

    contexto.arc(
      ponto.x * largura,
      ponto.y * altura,
      4,
      0,
      Math.PI * 2
    );

    contexto.fill();
  }
}

// ===== PROCESSAR RESULTADOS DO MEDIAPIPE =====

function processarResultados(resultados) {

  if (!video || !canvas) {
    return;
  }

  const largura = video.videoWidth || canvas.width || 640;
  const altura = video.videoHeight || canvas.height || 480;

  const mao =
    resultados.multiHandLandmarks &&
    resultados.multiHandLandmarks[0];

  if (!mao) {

    const contexto = canvas.getContext("2d");

    if (contexto) {
      contexto.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
      );
    }

    atualizarStatusCamera("Aguardando a mão...");
    atualizarTexto(elementoPontos, "0");

    return;
  }

  desenharMao(mao, largura, altura);

  atualizarStatusCamera("Mão detectada");
  atualizarTexto(elementoPontos, String(mao.length));

  const leituras = calcularAngulos(mao);

  const indicadorFiltrado = suavizarAngulo(
    "indicador",
    leituras.indicador
  );

  const polegarFiltrado = suavizarAngulo(
    "polegar",
    leituras.polegar
  );

  const servoIndicador = mapearParaServo(
    indicadorFiltrado,
    CALIBRACAO.indicador
  );

  const servoPolegar = mapearParaServo(
    polegarFiltrado,
    CALIBRACAO.polegar
  );

  atualizarTexto(
    elementoFlexao,
    `${Math.round(indicadorFiltrado)}°`
  );

  atualizarTexto(
    elementoAngulo,
    `${servoIndicador}°`
  );

  // Envia somente indicador e polegar.
  enviarAutomaticamente(
    servoIndicador,
    servoPolegar
  );
}

// ===== PROCESSAR CAMERA =====

async function processarCamera() {

  if (!cameraAtiva) {
    return;
  }

  if (
    !processandoFrame &&
    video &&
    video.readyState >= 2 &&
    hands
  ) {

    processandoFrame = true;

    try {
      await hands.send({
        image: video
      });

    } catch (erro) {

      console.error(
        "Erro ao processar imagem:",
        erro
      );

      atualizarStatusCamera(
        "Erro no processamento da câmera"
      );

    } finally {
      processandoFrame = false;
    }
  }

  if (cameraAtiva) {
    requestAnimationFrame(processarCamera);
  }
}

// ===== INICIAR CAMERA =====

async function iniciarCamera() {

  try {

    if (!video || !canvas) {
      throw new Error(
        "Não encontrei os elementos de vídeo e canvas no HTML."
      );
    }

    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      throw new Error(
        "Este navegador não disponibiliza acesso à câmera."
      );
    }

    if (typeof Hands === "undefined") {
      throw new Error(
        "A biblioteca MediaPipe Hands não foi carregada."
      );
    }

    atualizarStatusCamera(
      "Inicializando câmera..."
    );

    hands = new Hands({
      locateFile: (arquivo) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${arquivo}`
    });

    hands.setOptions({

      maxNumHands: 1,

      modelComplexity: 1,

      minDetectionConfidence: 0.6,

      minTrackingConfidence: 0.6

    });

    hands.onResults(processarResultados);

    cameraStream =
      await navigator.mediaDevices.getUserMedia({

        audio: false,

        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: "user"
        }

      });

    video.srcObject = cameraStream;
    video.muted = true;
    video.playsInline = true;

    await video.play();

    if (cameraPlaceholder) {
      cameraPlaceholder.style.display = "none";
    }

    cameraAtiva = true;

    atualizarStatusCamera(
      "Câmera ativa. Mostre sua mão."
    );

    requestAnimationFrame(processarCamera);

  } catch (erro) {

    console.error(erro);

    atualizarStatusCamera(
      `Erro na câmera: ${erro.message}`
    );
  }
}

// ===== LER RESPOSTAS DO ARDUINO =====

async function lerRetornoSerial(leitorAtual) {

  const decoder = new TextDecoder();

  try {

    while (true) {

      const { value, done } =
        await leitorAtual.read();

      if (done) {
        break;
      }

      if (value) {

        const resposta = decoder.decode(
          value,
          { stream: true }
        );

        if (resposta.includes("ARDUINO_PRONTO")) {

          atualizarStatusArduino(
            "Arduino conectado e pronto"
          );
        }
      }
    }

  } catch (erro) {

    if (leitorSerial === leitorAtual) {

      atualizarStatusArduino(
        `Leitura serial interrompida: ${erro.message}`
      );
    }
  }
}

// ===== CONECTAR ARDUINO =====

async function conectarArduino() {

  try {

    if (!navigator.serial) {
      throw new Error(
        "Web Serial não disponível. Use Chrome ou Edge em uma conexão segura."
      );
    }

    atualizarStatusArduino(
      "Selecione a porta do Arduino..."
    );

    portaSerial =
      await navigator.serial.requestPort();

    await portaSerial.open({
      baudRate: 9600
    });

    escritorSerial =
      portaSerial.writable.getWriter();

    leitorSerial =
      portaSerial.readable.getReader();

    lerRetornoSerial(leitorSerial);

    // O Arduino reinicia ao abrir a porta USB.
    await new Promise((resolver) =>
      setTimeout(resolver, 1500)
    );

    ultimoComando = {
      indicador: null,
      polegar: null
    };

    ultimoEnvio = 0;

    atualizarStatusArduino(
      "Arduino conectado"
    );

    if (botaoConectar) {
      botaoConectar.disabled = true;
    }

    if (botaoDesconectar) {
      botaoDesconectar.disabled = false;
    }

  } catch (erro) {

    console.error(erro);

    atualizarStatusArduino(
      `Não foi possível conectar: ${erro.message}`
    );

    if (portaSerial && !escritorSerial) {

      try {
        await portaSerial.close();
      } catch (_) {}

      portaSerial = null;
    }
  }
}

// ===== DESCONECTAR ARDUINO =====

async function desconectarArduino() {

  const portaAtual = portaSerial;
  const leitorAtual = leitorSerial;
  const escritorAtual = escritorSerial;

  portaSerial = null;
  leitorSerial = null;
  escritorSerial = null;

  try {

    await filaSerial;

    if (leitorAtual) {

      try {
        await leitorAtual.cancel();
      } catch (_) {}

      try {
        leitorAtual.releaseLock();
      } catch (_) {}
    }

    if (escritorAtual) {

      try {
        escritorAtual.releaseLock();
      } catch (_) {}
    }

    if (portaAtual) {

      try {
        await portaAtual.close();
      } catch (_) {}
    }

    atualizarStatusArduino(
      "Arduino desconectado"
    );

  } finally {

    if (botaoConectar) {
      botaoConectar.disabled = false;
    }

    if (botaoDesconectar) {
      botaoDesconectar.disabled = true;
    }
  }
}

// ===== TESTAR SERVOS =====

function testarServos(valor) {

  if (!escritorSerial) {

    atualizarStatusArduino(
      "Conecte o Arduino antes de testar os servos."
    );

    return;
  }

  // Pausa o rastreamento durante o teste.
  pausarRastreamentoAte =
    Date.now() + 1200;

  ultimoComando = {
    indicador: valor,
    polegar: valor
  };

  ultimoEnvio = performance.now();

  // Os dois servos recebem o mesmo angulo.
  enviarLinhaSerial(valor, valor);

  atualizarStatusArduino(
    `Teste enviado: ${valor}° nos dois servos`
  );
}

// ===== CONFIGURAR BOTOES =====

function configurarBotoes() {

  if (botaoConectar) {
    botaoConectar.addEventListener(
      "click",
      conectarArduino
    );
  }

  if (botaoDesconectar) {
    botaoDesconectar.addEventListener(
      "click",
      desconectarArduino
    );
  }

  // Identifica os botoes de teste existentes no HTML.
  document.querySelectorAll("button").forEach((botao) => {

    if (
      botao === botaoConectar ||
      botao === botaoDesconectar
    ) {
      return;
    }

    const identificacao =
      `${botao.id} ${botao.textContent || ""}`.toLowerCase();

    const corresponde =
      identificacao.match(/(30|90|150)\s*°?/);

    if (
      corresponde &&
      /(teste|°)/.test(identificacao)
    ) {

      const valor = Number(corresponde[1]);

      botao.addEventListener(
        "click",
        () => testarServos(valor)
      );
    }
  });

  if (botaoDesconectar) {
    botaoDesconectar.disabled = true;
  }
}

// ===== INICIALIZACAO =====

configurarBotoes();
iniciarCamera();