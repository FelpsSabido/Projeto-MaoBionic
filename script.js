
// ============================================
// MÃO ROBÓTICA
// MEDIAPIPE + ARDUINO UNO
// INDICADOR + POLEGAR
// ============================================


// ============================================
// ELEMENTOS DO SITE
// ============================================

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


// ============================================
// CONEXÕES DA MÃO
// ============================================

const conexoes = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17]
];


// ============================================
// CONFIGURAÇÕES DE MOVIMENTO
// ============================================

// Quanto menor, mais suave e menos sensível.
const SUAVIZACAO = 0.12;

// Velocidade máxima de mudança por quadro.
const VELOCIDADE_MAXIMA = 1.5;

// Pequenas oscilações são ignoradas.
const ZONA_MORTA = 1.5;

// Intervalo entre envios ao Arduino.
const INTERVALO_ENVIO = 60;

// Mudança mínima para enviar outro comando.
const MUDANCA_MINIMA = 1.5;


// ============================================
// CALIBRAÇÃO DOS DEDOS
// ============================================

// Os ângulos são referências iniciais.
// Reta = ângulo maior.
// Dobrada = ângulo menor.

const CALIBRACAO = {

  indicador: {
    aberto: 175,
    fechado: 65,
    servoMinimo: 0,
    servoMaximo: 180
  },

  dedao: {
    aberto: 165,
    fechado: 65,
    servoMinimo: 0,
    servoMaximo: 180
  },

  medio: {
    aberto: 175,
    fechado: 65,
    servoMinimo: 0,
    servoMaximo: 180
  }

};


// ============================================
// VARIÁVEIS DO SISTEMA
// ============================================

let portaSerial = null;
let escritorSerial = null;
let leitorSerial = null;

let hands = null;

let conectado = false;
let lendoSerial = false;
let modoTeste = false;

let ultimaMensagem = "";
let ultimoEnvio = 0;

let filaEnvio = Promise.resolve();

let angulosSuavizados = {
  indicador: null,
  dedao: null,
  medio: null
};

let angulosEnviados = null;

let ultimoAnguloCalculado = null;


// ============================================
// FUNÇÕES MATEMÁTICAS
// ============================================

function limitar(valor, minimo, maximo) {
  return Math.max(minimo, Math.min(maximo, valor));
}


function aproximar(atual, destino, velocidade) {

  const diferenca = destino - atual;

  if (Math.abs(diferenca) <= velocidade) {
    return destino;
  }

  return atual + Math.sign(diferenca) * velocidade;
}


// ============================================
// DESENHO DA MÃO
// ============================================

function desenharMao(mao) {

  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = 3;

  for (const [i, j] of conexoes) {

    ctx.beginPath();

    ctx.moveTo(
      mao[i].x * canvas.width,
      mao[i].y * canvas.height
    );

    ctx.lineTo(
      mao[j].x * canvas.width,
      mao[j].y * canvas.height
    );

    ctx.stroke();
  }

  mao.forEach((ponto, i) => {

    ctx.beginPath();

    ctx.arc(
      ponto.x * canvas.width,
      ponto.y * canvas.height,
      i === 0 ? 8 : 5,
      0,
      Math.PI * 2
    );

    ctx.fillStyle = i === 0 ? "#ffcc00" : "#ffffff";

    ctx.fill();

  });

}


// ============================================
// CÁLCULO DE ÂNGULO
// ============================================

function calcularAngulo(a, b, c) {

  const abx = a.x - b.x;
  const aby = a.y - b.y;

  const cbx = c.x - b.x;
  const cby = c.y - b.y;

  const denominador =
    Math.hypot(abx, aby) *
    Math.hypot(cbx, cby);

  if (denominador === 0) return 180;

  const cos = limitar(
    (abx * cbx + aby * cby) / denominador,
    -1,
    1
  );

  return Math.acos(cos) * 180 / Math.PI;

}


// ============================================
// CÁLCULO DO INDICADOR
// ============================================

function calcularIndicador(mao) {

  // Articulação PIP do indicador.
  // Pontos 6, 7 e 8.

  const anguloPIP = calcularAngulo(
    mao[6],
    mao[7],
    mao[8]
  );

  // Articulação MCP do indicador.
  // Pontos 5, 6 e 7.

  const anguloMCP = calcularAngulo(
    mao[5],
    mao[6],
    mao[7]
  );

  // Combinação das duas articulações.
  // A PIP tem maior influência na flexão.

  return (
    anguloPIP * 0.75 +
    anguloMCP * 0.25
  );

}


// ============================================
// CÁLCULO DO POLEGAR
// ============================================

function calcularDedao(mao) {

  // Articulação IP do polegar.
  // Pontos 2, 3 e 4.

  const anguloIP = calcularAngulo(
    mao[2],
    mao[3],
    mao[4]
  );

  // Articulação MCP do polegar.
  // Pontos 1, 2 e 3.

  const anguloMCP = calcularAngulo(
    mao[1],
    mao[2],
    mao[3]
  );

  // Combinação das articulações.

  return (
    anguloIP * 0.75 +
    anguloMCP * 0.25
  );

}


// ============================================
// CÁLCULO DO DEDO MÉDIO
// MANTIDO PARA COMPATIBILIDADE
// ============================================

function calcularMedio(mao) {

  return calcularAngulo(
    mao[9],
    mao[10],
    mao[11]
  );

}


// ============================================
// CONVERSÃO LINEAR PARA O SERVO
// ============================================

function mapearParaServo(angulo, nome) {

  const config = CALIBRACAO[nome];

  // Normalização da flexão.
  const proporcao = limitar(
    (config.aberto - angulo) /
    (config.aberto - config.fechado),
    0,
    1
  );

  // Conversão proporcional.
  const destino =
    config.servoMinimo +
    proporcao *
    (config.servoMaximo - config.servoMinimo);

  return destino;

}


// ============================================
// FILTRO DE SUAVIZAÇÃO
// ============================================

function suavizarAngulo(valor, nome) {

  const atual = angulosSuavizados[nome];

  // Primeira leitura.
  if (atual === null) {

    angulosSuavizados[nome] = valor;

    return valor;
  }

  // Filtro exponencial.
  const novo =
    atual + (valor - atual) * SUAVIZACAO;

  // Zona morta para pequenas oscilações.
  if (Math.abs(novo - atual) < ZONA_MORTA) {

    return atual;
  }

  angulosSuavizados[nome] = novo;

  return novo;

}


// ============================================
// CONTROLE DA VELOCIDADE DO SERVO
// ============================================

function controlarVelocidade(destino, nome) {

  const atual = angulosSuavizados[nome + "Servo"];

  if (atual === null) {

    angulosSuavizados[nome + "Servo"] = destino;

    return destino;
  }

  const novo = aproximar(
    atual,
    destino,
    VELOCIDADE_MAXIMA
  );

  angulosSuavizados[nome + "Servo"] = novo;

  return Math.round(novo);

}


// ============================================
// CÁLCULO DOS TRÊS SERVOS
// ============================================

function calcularAngulos(mao) {

  // Detecta as articulações.
  const flexaoIndicador = calcularIndicador(mao);
  const flexaoDedao = calcularDedao(mao);
  const flexaoMedio = calcularMedio(mao);

  // Converte para posições desejadas.
  const destinoIndicador =
    mapearParaServo(flexaoIndicador, "indicador");

  const destinoDedao =
    mapearParaServo(flexaoDedao, "dedao");

  const destinoMedio =
    mapearParaServo(flexaoMedio, "medio");

  // Suaviza as leituras angulares.
  const indicadorFiltrado =
    suavizarAngulo(destinoIndicador, "indicador");

  const dedaoFiltrado =
    suavizarAngulo(destinoDedao, "dedao");

  const medioFiltrado =
    suavizarAngulo(destinoMedio, "medio");

  // Limita a velocidade de movimentação.
  const indicador =
    controlarVelocidade(indicadorFiltrado, "indicador");

  const dedao =
    controlarVelocidade(dedaoFiltrado, "dedao");

  const medio =
    controlarVelocidade(medioFiltrado, "medio");

  return {

    indicador,
    dedao,
    medio,

    flexaoIndicador: Math.round(
      180 - flexaoIndicador
    )

  };

}


// ============================================
// VERIFICAÇÃO DE MUDANÇA
// ============================================

function angulosMudaram(novos, antigos) {

  if (!antigos) return true;

  return (

    Math.abs(novos.indicador - antigos.indicador) >=
    MUDANCA_MINIMA ||

    Math.abs(novos.dedao - antigos.dedao) >=
    MUDANCA_MINIMA ||

    Math.abs(novos.medio - antigos.medio) >=
    MUDANCA_MINIMA

  );

}


// ============================================
// ENVIO SERIAL
// ============================================

async function enviarMensagem(mensagem) {

  if (!conectado || !escritorSerial) {

    if (statusArduino) {
      statusArduino.textContent =
        "Conecte o Arduino primeiro.";
    }

    return false;
  }

  try {

    await escritorSerial.write(
      new TextEncoder().encode(mensagem + "\n")
    );

    console.log("Enviado ao Arduino:", mensagem);

    if (statusArduino) {
      statusArduino.textContent =
        "Comando enviado: " + mensagem;
    }

    return true;

  } catch (erro) {

    console.error("Erro ao enviar:", erro);

    if (statusArduino) {
      statusArduino.textContent =
        "Erro no envio: " + erro.message;
    }

    return false;

  }

}


// ============================================
// ENVIO DOS ÂNGULOS
// ============================================

async function enviarAngulos(angulos, forcar = false) {

  if (!conectado || !escritorSerial) return;

  if (modoTeste && !forcar) return;

  const agora = Date.now();

  if (
    !forcar &&
    agora - ultimoEnvio < INTERVALO_ENVIO
  ) {
    return;
  }

  if (
    !forcar &&
    !angulosMudaram(angulos, angulosEnviados)
  ) {
    return;
  }

  const mensagem =
    `${angulos.indicador},${angulos.dedao},${angulos.medio}`;

  if (!forcar && mensagem === ultimaMensagem) return;

  filaEnvio = filaEnvio.then(async () => {

    const enviado = await enviarMensagem(mensagem);

    if (enviado) {

      ultimaMensagem = mensagem;

      ultimoEnvio = Date.now();

      angulosEnviados = { ...angulos };

    }

  });

  return filaEnvio;

}


// ============================================
// TESTE MANUAL DOS SERVOS
// ============================================

async function testarServos(angulo) {

  if (!conectado) return;

  modoTeste = true;

  const enviado = await enviarAngulos({

    indicador: angulo,
    dedao: angulo,
    medio: angulo

  }, true);

  if (enviado) {

    statusArduino.textContent =
      `Teste enviado: ${angulo}°`;

    setTimeout(() => {

      modoTeste = false;

      // Faz o controle voltar gradualmente
      // para a posição detectada pela câmera.

      angulosEnviados = null;

    }, 1200);

  } else {

    modoTeste = false;

  }

}


if (botaoTeste30) {
  botaoTeste30.addEventListener(
    "click",
    () => testarServos(30)
  );
}

if (botaoTeste90) {
  botaoTeste90.addEventListener(
    "click",
    () => testarServos(90)
  );
}

if (botaoTeste150) {
  botaoTeste150.addEventListener(
    "click",
    () => testarServos(150)
  );
}


// ============================================
// LEITURA DAS RESPOSTAS DO ARDUINO
// ============================================

async function lerRespostasArduino() {

  if (
    !portaSerial ||
    !portaSerial.readable ||
    lendoSerial
  ) {
    return;
  }

  lendoSerial = true;

  try {

    leitorSerial = portaSerial.readable.getReader();

    let buffer = "";

    while (conectado) {

      const { value, done } = await leitorSerial.read();

      if (done) break;

      if (!value) continue;

      buffer += new TextDecoder().decode(value);

      const linhas = buffer.split(/\r?\n/);

      buffer = linhas.pop() || "";

      for (const linha of linhas) {

        const resposta = linha.trim();

        if (!resposta) continue;

        console.log("Arduino respondeu:", resposta);

        if (statusArduino) {
          statusArduino.textContent =
            "Arduino: " + resposta;
        }

      }

    }

  } catch (erro) {

    if (conectado) {
      console.error("Erro lendo Arduino:", erro);
    }

  } finally {

    if (leitorSerial) {

      try {
        leitorSerial.releaseLock();
      } catch (_) {}

      leitorSerial = null;

    }

    lendoSerial = false;

  }

}


// ============================================
// BOTÕES DE CONEXÃO
// ============================================

function atualizarBotoes() {

  if (botaoConectar) {
    botaoConectar.disabled = conectado;
  }

  if (botaoDesconectar) {
    botaoDesconectar.disabled = !conectado;
  }

  [
    botaoTeste30,
    botaoTeste90,
    botaoTeste150

  ].forEach(botao => {

    if (botao) {
      botao.disabled = !conectado;
    }

  });

}


// ============================================
// CONECTAR ARDUINO
// ============================================

if (botaoConectar) {

  botaoConectar.addEventListener("click", async () => {

    if (!("serial" in navigator)) {

      statusArduino.textContent =
        "Use um navegador compatível com Web Serial.";

      return;
    }

    botaoConectar.disabled = true;

    try {

      statusArduino.textContent =
        "Selecione o Arduino...";

      portaSerial = await navigator.serial.requestPort();

      await portaSerial.open({
        baudRate: 9600
      });

      escritorSerial = portaSerial.writable.getWriter();

      conectado = true;

      ultimaMensagem = "";

      angulosEnviados = null;

      atualizarBotoes();

      statusArduino.textContent =
        "Arduino conectado.";

      lerRespostasArduino();

    } catch (erro) {

      console.error(erro);

      statusArduino.textContent =
        "Erro ao conectar: " + erro.message;

      conectado = false;

      atualizarBotoes();

    }

  });

}


// ============================================
// DESCONECTAR ARDUINO
// ============================================

if (botaoDesconectar) {

  botaoDesconectar.addEventListener("click", async () => {

    conectado = false;

    modoTeste = false;

    try {

      if (leitorSerial) {

        try {
          await leitorSerial.cancel();
        } catch (_) {}

      }

      await filaEnvio;

      if (escritorSerial) {

        escritorSerial.releaseLock();

        escritorSerial = null;

      }

      if (portaSerial) {

        await portaSerial.close();

        portaSerial = null;

      }

      statusArduino.textContent =
        "Arduino desconectado.";

    } catch (erro) {

      console.error(erro);

      statusArduino.textContent =
        "Erro ao desconectar: " + erro.message;

    } finally {

      atualizarBotoes();

    }

  });

}


// ============================================
// RECONHECIMENTO DA MÃO
// ============================================

function aoDetectar(resultado) {

  const largura = video.videoWidth;
  const altura = video.videoHeight;

  if (!largura || !altura) return;

  if (
    canvas.width !== largura ||
    canvas.height !== altura
  ) {

    canvas.width = largura;
    canvas.height = altura;

  }

  ctx.clearRect(
    0,
    0,
    canvas.width,
    canvas.height
  );

  const maos = resultado.multiHandLandmarks;

  if (!maos || maos.length === 0) {

    status.textContent =
      "Mostre sua mão para a câmera.";

    flexaoTexto.textContent = "--°";

    anguloTexto.textContent = "--°";

    pontosTexto.textContent = "0 / 21";

    return;

  }

  const mao = maos[0];

  desenharMao(mao);

  pontosTexto.textContent =
    `${mao.length} / 21`;

  const angulos = calcularAngulos(mao);

  ultimoAnguloCalculado = angulos;

  flexaoTexto.textContent =
    `${angulos.flexaoIndicador}°`;

  anguloTexto.textContent =
    `${angulos.indicador}°`;

  status.textContent = conectado
    ? `Controle ativo — indicador ${angulos.indicador}°, polegar ${angulos.dedao}°.`
    : "Mão detectada — conecte o Arduino.";

  enviarAngulos(angulos);

}


// ============================================
// MEDIAPIPE
// ============================================

async function iniciarMediaPipe() {

  try {

    if (typeof Hands === "undefined") {

      throw new Error(
        "A biblioteca MediaPipe não foi carregada."
      );

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
      "Reconhecimento carregado. Mostre sua mão.";

    async function analisar() {

      if (video.readyState >= 2 && hands) {

        try {

          await hands.send({
            image: video
          });

        } catch (erro) {

          console.error(
            "Erro no reconhecimento:",
            erro
          );

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


// ============================================
// CÂMERA
// ============================================

async function iniciarCamera() {

  try {

    if (!navigator.mediaDevices?.getUserMedia) {

      throw new Error(
        "A câmera exige HTTPS ou contexto seguro."
      );

    }

    const stream =
      await navigator.mediaDevices.getUserMedia({

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
      "Carregando reconhecimento...";

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


// ============================================
// INICIALIZAÇÃO
// ============================================

atualizarBotoes();

iniciarCamera();
