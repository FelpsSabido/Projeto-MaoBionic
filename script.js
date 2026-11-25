
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const status = document.getElementById("status");
const statusArduino = document.getElementById("statusArduino");
const cameraPlaceholder = document.getElementById("cameraPlaceholder");

const flexao = document.getElementById("flexao");
const angulo = document.getElementById("angulo");
const pontos = document.getElementById("pontos");

const conectarArduino = document.getElementById("conectarArduino");
const desconectarArduino = document.getElementById("desconectarArduino");

const teste30 = document.getElementById("teste30");
const teste90 = document.getElementById("teste90");
const teste150 = document.getElementById("teste150");

let portaSerial = null;
let escritorSerial = null;
let conectado = false;
let enviando = false;
let mensagemPendente = null;
let ultimoEnvio = 0;
let ultimoAngulo = [-100, -100, -100];
let modoTeste = false;

const INTERVALO_ENVIO = 100;
const LIMITE_MUDANCA = 2;

function atualizarStatus(elemento, mensagem) {
  if (elemento) elemento.textContent = mensagem;
}

function limitar(valor, minimo, maximo) {
  return Math.max(minimo, Math.min(maximo, valor));
}

// Calcula o ângulo formado por três pontos.
function calcularAngulo(a, b, c) {
  const radianos =
    Math.atan2(c.y - b.y, c.x - b.x) -
    Math.atan2(a.y - b.y, a.x - b.x);

  let graus = Math.abs(radianos * 180 / Math.PI);

  if (graus > 180) graus = 360 - graus;

  return graus;
}

// Converte a flexão do dedo em posição do servo.
// Dedo esticado -> perto de 0°.
// Dedo dobrado -> perto de 180°.
function converterParaServo(anguloDedo) {
  const anguloEsticado = 175;
  const anguloDobrado = 75;

  const proporcao =
    (anguloEsticado - anguloDedo) /
    (anguloEsticado - anguloDobrado);

  return Math.round(limitar(proporcao * 180, 0, 180));
}

function pontoValido(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function desenharPontos(landmarks) {
  const largura = video.videoWidth;
  const altura = video.videoHeight;

  if (!largura || !altura) return;

  if (canvas.width !== largura || canvas.height !== altura) {
    canvas.width = largura;
    canvas.height = altura;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // O vídeo e o canvas devem ter o mesmo espelhamento no CSS.
  if (typeof drawConnectors === "function" &&
      typeof HAND_CONNECTIONS !== "undefined") {
    drawConnectors(ctx, landmarks, HAND_CONNECTIONS, {
      color: "#00FF88",
      lineWidth: 3
    });
  }

  if (typeof drawLandmarks === "function") {
    drawLandmarks(ctx, landmarks, {
      color: "#FF3344",
      lineWidth: 1,
      radius: 3
    });
  }
}

async function enviarMensagem(mensagem) {
  if (!conectado || !escritorSerial) {
    atualizarStatus(statusArduino, "Arduino desconectado");
    return;
  }

  mensagemPendente = mensagem;

  if (enviando) return;

  enviando = true;

  try {
    while (mensagemPendente !== null && conectado) {
      const atual = mensagemPendente;
      mensagemPendente = null;

      await escritorSerial.write(
        new TextEncoder().encode(atual + "\n")
      );
    }
  } catch (erro) {
    console.error("Erro ao enviar para o Arduino:", erro);
    atualizarStatus(statusArduino, "Erro na comunicação USB");
  } finally {
    enviando = false;
  }
}

async function enviarAngulos(indicador, dedao, medio, forcar = false) {
  indicador = Math.round(limitar(indicador, 0, 180));
  dedao = Math.round(limitar(dedao, 0, 180));
  medio = Math.round(limitar(medio, 0, 180));

  const agora = Date.now();

  const mudou =
    Math.abs(indicador - ultimoAngulo[0]) >= LIMITE_MUDANCA ||
    Math.abs(dedao - ultimoAngulo[1]) >= LIMITE_MUDANCA ||
    Math.abs(medio - ultimoAngulo[2]) >= LIMITE_MUDANCA;

  if (!forcar && (!mudou || agora - ultimoEnvio < INTERVALO_ENVIO)) {
    return;
  }

  ultimoAngulo = [indicador, dedao, medio];
  ultimoEnvio = agora;

  if (angulo) {
    angulo.textContent =
      `Indicador: ${indicador}° | Dedão: ${dedao}° | Médio: ${medio}°`;
  }

  await enviarMensagem(`${indicador},${dedao},${medio}`);
}

async function conectar() {
  if (!("serial" in navigator)) {
    atualizarStatus(
      statusArduino,
      "Web Serial indisponível. Use Chrome ou Edge em HTTPS."
    );
    return;
  }

  try {
    portaSerial = await navigator.serial.requestPort();
    await portaSerial.open({ baudRate: 9600 });

    escritorSerial = portaSerial.writable.getWriter();
    conectado = true;

    atualizarStatus(statusArduino, "Arduino conectado");
    await enviarAngulos(0, 0, 0, true);
  } catch (erro) {
    console.error("Erro ao conectar:", erro);
    atualizarStatus(statusArduino, "Não foi possível conectar");
  }
}

async function desconectar() {
  try {
    conectado = false;
    mensagemPendente = null;

    if (escritorSerial) {
      escritorSerial.releaseLock();
      escritorSerial = null;
    }

    if (portaSerial) {
      await portaSerial.close();
      portaSerial = null;
    }

    atualizarStatus(statusArduino, "Arduino desconectado");
  } catch (erro) {
    console.error("Erro ao desconectar:", erro);
    atualizarStatus(statusArduino, "Erro ao desconectar");
  }
}

// Botões manuais: movimentam os três servos para a mesma posição.
async function testarServos(valor) {
  if (!conectado) {
    atualizarStatus(statusArduino, "Conecte o Arduino primeiro");
    return;
  }

  modoTeste = true;
  await enviarAngulos(valor, valor, valor, true);

  // Libera o controle pela câmera após o teste.
  setTimeout(() => {
    modoTeste = false;
  }, 700);
}

if (conectarArduino) {
  conectarArduino.addEventListener("click", conectar);
}

if (desconectarArduino) {
  desconectarArduino.addEventListener("click", desconectar);
}

if (teste30) teste30.addEventListener("click", () => testarServos(30));
if (teste90) teste90.addEventListener("click", () => testarServos(90));
if (teste150) teste150.addEventListener("click", () => testarServos(150));

// MediaPipe Hands
const hands = new Hands({
  locateFile: (arquivo) =>
    `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${arquivo}`
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6
});

hands.onResults(async (resultado) => {
  if (resultado.image) {
    if (video.videoWidth && video.videoHeight) {
      if (
        canvas.width !== video.videoWidth ||
        canvas.height !== video.videoHeight
      ) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
    }
  }

  const maos = resultado.multiHandLandmarks;

  if (!maos || maos.length === 0) {
    atualizarStatus(status, "Mostre sua mão para a câmera");
    atualizarStatus(pontos, "Pontos detectados: 0");
    return;
  }

  const mao = maos[0];

  desenharPontos(mao);
  atualizarStatus(status, "Mão detectada");
  atualizarStatus(pontos, `Pontos detectados: ${mao.length}`);

  // Não deixa a câmera interferir durante o teste manual.
  if (modoTeste) return;

  // Indicador: MCP/PIP/DIP.
  const anguloIndicador = calcularAngulo(
    mao[5], mao[6], mao[7]
  );

  // Dedão: articulações do polegar.
  const anguloDedao = calcularAngulo(
    mao[2], mao[3], mao[4]
  );

  // Médio: MCP/PIP/DIP.
  const anguloMedio = calcularAngulo(
    mao[9], mao[10], mao[11]
  );

  const servoIndicador = converterParaServo(anguloIndicador);
  const servoDedao = converterParaServo(anguloDedao);
  const servoMedio = converterParaServo(anguloMedio);

  if (flexao) {
    flexao.textContent =
      `Indicador: ${Math.round(anguloIndicador)}° | ` +
      `Dedão: ${Math.round(anguloDedao)}° | ` +
      `Médio: ${Math.round(anguloMedio)}°`;
  }

  await enviarAngulos(
    servoIndicador,
    servoDedao,
    servoMedio
  );
});

// Inicializa a câmera.
async function iniciarCamera() {
  try {
    const camera = new Camera(video, {
      onFrame: async () => {
        await hands.send({ image: video });
      },
      width: 640,
      height: 480
    });

    await camera.start();

    if (cameraPlaceholder) {
      cameraPlaceholder.style.display = "none";
    }

    atualizarStatus(status, "Câmera iniciada. Mostre sua mão.");
  } catch (erro) {
    console.error("Erro ao iniciar a câmera:", erro);
    atualizarStatus(status, "Erro ao iniciar a câmera");
  }
}

iniciarCamera();
