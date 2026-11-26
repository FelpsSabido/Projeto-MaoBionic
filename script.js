
// ==========================================
// MAO ROBOTICA - POLEGAR, INDICADOR E MEDIO
// MediaPipe + Arduino Uno
// ==========================================

// ELEMENTOS HTML
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const status = document.getElementById("status");
const statusArduino = document.getElementById("statusArduino");
const placeholder = document.getElementById("cameraPlaceholder");

const flexaoTexto = document.getElementById("flexao");
const anguloTexto = document.getElementById("angulo");
const pontosTexto = document.getElementById("pontos");

const botaoConectar = document.getElementById("conectarArduino");
const botaoDesconectar = document.getElementById("desconectarArduino");

const botaoTeste30 = document.getElementById("teste30");
const botaoTeste90 = document.getElementById("teste90");
const botaoTeste150 = document.getElementById("teste150");


// ==========================================
// CONFIGURACOES
// ==========================================

const LIMITES = {
  indicador: { minimo: 0, maximo: 180 },
  dedao: { minimo: 0, maximo: 180 },
  medio: { minimo: 0, maximo: 180 }
};

const INTERVALO_ENVIO = 100;
const MUDANCA_MINIMA = 2;
const FLEXAO_MAXIMA = 110;


// ==========================================
// CONEXOES VISUAIS DA MAO
// ==========================================

const conexoes = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17]
];


// ==========================================
// VARIAVEIS
// ==========================================

let portaSerial = null;
let escritorSerial = null;
let hands = null;

let conectado = false;
let enviando = false;
let mensagemPendente = null;

let ultimaMensagem = "";
let ultimoEnvio = 0;
let ultimosAngulos = null;

let modoTeste = false;
let temporizadorTeste = null;


// ==========================================
// FUNCOES AUXILIARES
// ==========================================

function limitar(valor, minimo, maximo) {
  return Math.max(minimo, Math.min(maximo, valor));
}

function atualizarBotoes() {
  botaoConectar.disabled = conectado;
  botaoDesconectar.disabled = !conectado;

  [botaoTeste30, botaoTeste90, botaoTeste150].forEach(botao => {
    if (botao) botao.disabled = !conectado;
  });
}


// ==========================================
// DESENHO DA MAO
// ==========================================

function desenharMao(mao) {
  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = 3;

  for (const [indiceA, indiceB] of conexoes) {
    const a = mao[indiceA];
    const b = mao[indiceB];

    ctx.beginPath();
    ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
    ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
    ctx.stroke();
  }

  mao.forEach((ponto, indice) => {
    ctx.beginPath();

    ctx.arc(
      ponto.x * canvas.width,
      ponto.y * canvas.height,
      indice === 0 ? 8 : 5,
      0,
      Math.PI * 2
    );

    ctx.fillStyle = indice === 0 ? "#ffcc00" : "#ffffff";
    ctx.fill();
  });
}


// ==========================================
// CALCULO DO ANGULO
// ==========================================

function calcularAngulo(a, b, c) {
  const abx = a.x - b.x;
  const aby = a.y - b.y;

  const cbx = c.x - b.x;
  const cby = c.y - b.y;

  const denominador =
    Math.hypot(abx, aby) * Math.hypot(cbx, cby);

  if (denominador === 0) return 180;

  const cos = limitar(
    (abx * cbx + aby * cby) / denominador,
    -1,
    1
  );

  return Math.acos(cos) * 180 / Math.PI;
}


// ==========================================
// CONVERTE FLEXAO EM ANGULO DO SERVO
// ==========================================

function mapearParaServo(flexao, nome) {
  const limites = LIMITES[nome];

  const flexaoNormalizada = limitar(
    (180 - flexao) / FLEXAO_MAXIMA,
    0,
    1
  );

  return Math.round(
    limites.minimo +
    flexaoNormalizada * (limites.maximo - limites.minimo)
  );
}


// ==========================================
// CALCULA OS TRES DEDOS
// ==========================================

function calcularAngulos(mao) {

  // INDICADOR: pontos 5, 6 e 7
  const articulacaoIndicador =
    calcularAngulo(mao[5], mao[6], mao[7]);

  // POLEGAR: pontos 2, 3 e 4
  const articulacaoDedao =
    calcularAngulo(mao[2], mao[3], mao[4]);

  // MEDIO: pontos 9, 10 e 11
  const articulacaoMedio =
    calcularAngulo(mao[9], mao[10], mao[11]);

  return {
    indicador: mapearParaServo(articulacaoIndicador, "indicador"),
    dedao: mapearParaServo(articulacaoDedao, "dedao"),
    medio: mapearParaServo(articulacaoMedio, "medio"),

    flexaoIndicador: Math.round(180 - articulacaoIndicador),
    flexaoDedao: Math.round(180 - articulacaoDedao),
    flexaoMedio: Math.round(180 - articulacaoMedio)
  };
}


// ==========================================
// VERIFICA SE OS ANGULOS MUDARAM
// ==========================================

function angulosMudaram(novos, antigos) {
  if (!antigos) return true;

  return (
    Math.abs(novos.indicador - antigos.indicador) >= MUDANCA_MINIMA ||
    Math.abs(novos.dedao - antigos.dedao) >= MUDANCA_MINIMA ||
    Math.abs(novos.medio - antigos.medio) >= MUDANCA_MINIMA
  );
}


// ==========================================
// FILA DE ENVIO SERIAL
// ==========================================

async function processarFilaSerial() {
  if (enviando || !escritorSerial || !conectado) return;

  enviando = true;

  try {
    while (
      mensagemPendente !== null &&
      escritorSerial &&
      conectado
    ) {
      const mensagem = mensagemPendente;
      mensagemPendente = null;

      await escritorSerial.write(
        new TextEncoder().encode(mensagem + "\n")
      );
    }
  } catch (erro) {
    console.error("Falha ao enviar para o Arduino:", erro);

    statusArduino.textContent =
      "Falha no envio. Confira a conexão USB.";
  } finally {
    enviando = false;
  }
}


// ==========================================
// ENVIA ANGULOS PARA O ARDUINO
// Formato: indicador,dedao,medio
// ==========================================

function enviarAngulos(angulos, forcar = false) {
  if (!conectado || !escritorSerial) return;

  const agora = Date.now();

  if (!forcar && agora - ultimoEnvio < INTERVALO_ENVIO) return;

  if (!forcar && !angulosMudaram(angulos, ultimosAngulos)) return;

  const mensagem =
    `${angulos.indicador},${angulos.dedao},${angulos.medio}`;

  if (!forcar && mensagem === ultimaMensagem) return;

  ultimaMensagem = mensagem;
  ultimoEnvio = agora;
  ultimosAngulos = { ...angulos };

  mensagemPendente = mensagem;

  processarFilaSerial();
}


// ==========================================
// TESTES DOS SERVOS
// ==========================================

function testarServos(angulo) {
  if (!conectado) return;

  modoTeste = true;

  clearTimeout(temporizadorTeste);

  enviarAngulos({
    indicador: angulo,
    dedao: angulo,
    medio: angulo
  }, true);

  statusArduino.textContent =
    `Teste ativo: os três servos em ${angulo} graus.`;

  temporizadorTeste = setTimeout(() => {
    modoTeste = false;

    ultimaMensagem = "";
    ultimosAngulos = null;

    statusArduino.textContent =
      "Teste encerrado. Controle pela câmera reativado.";
  }, 1500);
}

botaoTeste30.addEventListener("click", () => testarServos(30));
botaoTeste90.addEventListener("click", () => testarServos(90));
botaoTeste150.addEventListener("click", () => testarServos(150));


// ==========================================
// CONECTAR ARDUINO
// ==========================================

botaoConectar.addEventListener("click", async () => {
  if (!("serial" in navigator)) {
    statusArduino.textContent =
      "Este navegador não oferece acesso serial. Use Chrome ou Edge.";
    return;
  }

  botaoConectar.disabled = true;

  try {
    statusArduino.textContent =
      "Selecione o Arduino na janela...";

    portaSerial = await navigator.serial.requestPort();

    await portaSerial.open({ baudRate: 9600 });

    if (!portaSerial.writable) {
      throw new Error("A porta serial não permite escrita.");
    }

    escritorSerial = portaSerial.writable.getWriter();

    conectado = true;
    ultimaMensagem = "";
    ultimosAngulos = null;

    statusArduino.textContent =
      "Arduino conectado — polegar, indicador e médio ativos.";

    atualizarBotoes();

  } catch (erro) {
    console.error(erro);

    statusArduino.textContent =
      "Não foi possível conectar: " + erro.message;

    conectado = false;
    atualizarBotoes();
  }
});


// ==========================================
// DESCONECTAR ARDUINO
// ==========================================

botaoDesconectar.addEventListener("click", async () => {
  conectado = false;
  mensagemPendente = null;

  clearTimeout(temporizadorTeste);
  modoTeste = false;

  try {
    if (escritorSerial) {
      escritorSerial.releaseLock();
      escritorSerial = null;
    }

    if (portaSerial) {
      await portaSerial.close();
      portaSerial = null;
    }

    statusArduino.textContent = "Arduino desconectado.";

  } catch (erro) {
    console.error(erro);

    statusArduino.textContent =
      "Erro ao desconectar: " + erro.message;

  } finally {
    atualizarBotoes();
  }
});


// ==========================================
// PROCESSAMENTO DA CAMERA
// ==========================================

function aoDetectar(resultado) {
  const largura = video.videoWidth;
  const altura = video.videoHeight;

  if (!largura || !altura) return;

  if (canvas.width !== largura || canvas.height !== altura) {
    canvas.width = largura;
    canvas.height = altura;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const maos = resultado.multiHandLandmarks;

  if (!maos || maos.length === 0) {
    status.textContent = "Mostre sua mão para a câmera.";

    flexaoTexto.textContent = "--° / --° / --°";
    anguloTexto.textContent = "--° / --° / --°";
    pontosTexto.textContent = "0 / 21";

    return;
  }

  const mao = maos[0];

  desenharMao(mao);

  pontosTexto.textContent = `${mao.length} / 21`;

  const angulos = calcularAngulos(mao);

  flexaoTexto.textContent =
    `${angulos.flexaoDedao}° / ${angulos.flexaoIndicador}° / ${angulos.flexaoMedio}°`;

  anguloTexto.textContent =
    `${angulos.dedao}° / ${angulos.indicador}° / ${angulos.medio}°`;

  status.textContent = conectado
    ? `Controle ativo — polegar ${angulos.dedao}°, indicador ${angulos.indicador}°, médio ${angulos.medio}°.`
    : "Mão detectada — conecte o Arduino.";

  if (!modoTeste) {
    enviarAngulos(angulos);
  }
}


// ==========================================
// INICIALIZAR MEDIAPIPE
// ==========================================

async function iniciarMediaPipe() {
  try {
    if (typeof Hands === "undefined") {
      throw new Error("A biblioteca MediaPipe não foi carregada.");
    }

    hands = new Hands({
      locateFile: arquivo =>
        "https://cdn.jsdelivr.net/npm/@mediapipe/hands/" + arquivo
    });

    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6
    });

    hands.onResults(aoDetectar);

    status.textContent =
      "MediaPipe carregado. Detectando mão...";

    async function analisar() {
      if (video.readyState >= 2 && hands) {
        try {
          await hands.send({ image: video });
        } catch (erro) {
          console.error("Erro no reconhecimento:", erro);
        }
      }

      requestAnimationFrame(analisar);
    }

    analisar();

  } catch (erro) {
    console.error(erro);

    status.textContent =
      "Erro no MediaPipe: " + erro.message;
  }
}


// ==========================================
// INICIALIZAR CAMERA
// ==========================================

async function iniciarCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "A câmera exige uma página em contexto seguro, como HTTPS."
      );
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: "user"
      },
      audio: false
    });

    video.srcObject = stream;

    await video.play();

    if (placeholder) {
      placeholder.classList.add("hidden");
    }

    status.textContent =
      "Carregando reconhecimento da mão...";

    iniciarMediaPipe();

  } catch (erro) {
    console.error(erro);

    status.textContent =
      "Erro ao iniciar câmera: " + erro.message;

    if (placeholder) {
      placeholder.textContent =
        "Não foi possível iniciar a câmera.";
    }
  }
}


// ==========================================
// INICIALIZACAO
// ==========================================

atualizarBotoes();
iniciarCamera();
