
import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs";

/*
 * KINETIC — HAND CONTROL
 *
 * Protocolo serial desta primeira etapa:
 *   indicador,polegar\n
 * Exemplo:
 *   0,70\n
 * Ordem dos canais ativos: serialPosition em FINGER_CHANNELS.
 * Para adicionar um dedo, basta ativar seu canal em FINGER_CHANNELS.
 */

const CONFIG = {
  serialBaudRate: 9600,
  cameraWidth: 640,
  cameraHeight: 480,
  cameraFps: 24,
  serialRateHz: 20,
  smoothing: 0.28,
  minimumServoChange: 1,
  initialOpenServoAngle: 70,
  minOpenServoAngle: 10,
  maxOpenServoAngle: 120,
  modelUrl: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  wasmUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
};

// Configuração por dedo. Os dedos futuros já ficam mapeados, mas desativados.
// type "angle": mede a abertura pelas articulações PIP e DIP.
// type "thumb-distance": mede a distância do polegar à lateral da palma.
const FINGER_CHANNELS = {
  index: {
    key: "index",
    label: "Indicador",
    active: true,
    type: "angle",
    joints: { base: 5, pip: 6, dip: 7, tip: 8 },
    serialPosition: 0
  },
  thumb: {
    key: "thumb",
    label: "Polegar",
    active: true,
    type: "thumb-distance",
    tip: 4,
    palmSide: 17,
    palmBaseA: 5,
    palmBaseB: 17,
    serialPosition: 1
  },
  middle: {
    key: "middle",
    label: "Médio",
    active: false,
    type: "angle",
    joints: { base: 9, pip: 10, dip: 11, tip: 12 },
    serialPosition: 2
  },
  ring: {
    key: "ring",
    label: "Anelar",
    active: false,
    type: "angle",
    joints: { base: 13, pip: 14, dip: 15, tip: 16 },
    serialPosition: 3
  },
  pinky: {
    key: "pinky",
    label: "Mindinho",
    active: false,
    type: "angle",
    joints: { base: 17, pip: 18, dip: 19, tip: 20 },
    serialPosition: 4
  }
};

const ACTIVE_FINGERS = Object.values(FINGER_CHANNELS)
  .filter((finger) => finger.active)
  .sort((a, b) => a.serialPosition - b.serialPosition);

const LANDMARK_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

const $ = (id) => document.getElementById(id);

const createChannelMap = (factory) => Object.fromEntries(
  ACTIVE_FINGERS.map((finger) => [finger.key, factory(finger)])
);

const ui = {
  video: $("cameraVideo"),
  canvas: $("overlayCanvas"),
  cameraPlaceholder: $("cameraPlaceholder"),
  cameraButton: $("cameraButton"),
  cameraBadge: $("cameraBadge"),
  cameraStatusText: $("cameraStatusText"),
  trackingReadout: $("trackingReadout"),
  fpsReadout: $("fpsReadout"),
  landmarkCount: $("landmarkCount"),
  confidenceValue: $("confidenceValue"),
  packetValue: $("packetValue"),
  connectButton: $("connectButton"),
  disconnectButton: $("disconnectButton"),
  serialStatus: $("serialStatus"),
  serialTag: $("serialTag"),
  serialIndicator: $("serialIndicator"),
  systemState: $("systemState"),
  systemStateText: $("systemStateText"),
  calibrationState: $("calibrationState"),
  captureClosedButton: $("captureClosedButton"),
  captureOpenButton: $("captureOpenButton"),
  closedCalibrationText: $("closedCalibrationText"),
  openCalibrationText: $("openCalibrationText"),
  closedMark: $("closedMark"),
  openMark: $("openMark"),
  resetCalibrationButton: $("resetCalibrationButton"),
  maxAngleSlider: $("maxAngleSlider"),
  maxAngleLabel: $("maxAngleLabel"),
  fingerList: $("fingerList"),
  channelCountValue: $("channelCountValue"),
  bottomTracking: $("bottomTracking"),
  bottomUsb: $("bottomUsb"),
  bottomCalibration: $("bottomCalibration"),
  toast: $("toast"),
  clock: $("clock")
};

const state = {
  landmarker: null,
  stream: null,
  cameraRunning: false,
  serialPort: null,
  serialWriter: null,
  serialReader: null,
  serialReadTask: null,
  serialConnected: false,
  lastVideoTime: -1,
  lastDetectionAt: 0,
  lastSerialAt: 0,
  lastSentValues: null,
  latestRaw: null,
  metricHistory: createChannelMap(() => []),
  latestServo: createChannelMap(() => 0),
  smoothed: createChannelMap(() => null),
  calibration: loadCalibration(),
  maxOpenAngle: CONFIG.initialOpenServoAngle,
  fpsCounter: 0,
  fpsWindowStart: performance.now(),
  currentFps: 0,
  toastTimer: null
};

function loadCalibration() {
  try {
    const saved = JSON.parse(localStorage.getItem("kinetic.hand.calibration.v1"));

    if (saved && ACTIVE_FINGERS.every((finger) =>
      Number.isFinite(saved.closed?.[finger.key]) &&
      Number.isFinite(saved.open?.[finger.key])
    )) {
      return saved;
    }
  } catch (error) {
    console.warn("Não foi possível ler a calibração salva:", error);
  }

  return { closed: null, open: null };
}

function saveCalibration() {
  localStorage.setItem(
    "kinetic.hand.calibration.v1",
    JSON.stringify(state.calibration)
  );
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");

  clearTimeout(state.toastTimer);

  state.toastTimer = setTimeout(() => {
    ui.toast.classList.remove("show");
  }, 3400);
}

function setSystemState(kind, message) {
  ui.systemState.dataset.state = kind;
  ui.systemStateText.textContent = message;
}

function setCameraStatus(active, message) {
  ui.cameraBadge.dataset.active = String(active);
  ui.cameraStatusText.textContent = message;
  ui.bottomTracking.textContent = active ? "ATIVO" : "INATIVO";
}

function setSerialStatus(connected, message) {
  state.serialConnected = connected;

  ui.serialStatus.textContent = message;
  ui.serialTag.textContent = connected ? "ONLINE" : "OFFLINE";
  ui.serialTag.dataset.connected = String(connected);
  ui.serialIndicator.dataset.connected = String(connected);

  ui.connectButton.classList.toggle("hidden", connected);
  ui.disconnectButton.classList.toggle("hidden", !connected);

  ui.bottomUsb.textContent = connected ? "CONECTADO" : "DESCONECTADO";

  updateSystemState();
}

function hasBothCalibrationPoses() {
  return Boolean(state.calibration.closed && state.calibration.open);
}

function isCalibrated() {
  if (!hasBothCalibrationPoses()) return false;

  // Evita considerar duas capturas quase iguais como uma calibração válida.
  return ACTIVE_FINGERS.every((finger) => {
    const range = Math.abs(
      state.calibration.open[finger.key] -
      state.calibration.closed[finger.key]
    );

    const minimumRange = finger.type === "thumb-distance" ? 0.08 : 15;

    return range >= minimumRange;
  });
}

function updateSystemState() {
  if (state.cameraRunning && state.serialConnected && isCalibrated()) {
    setSystemState("active", "RASTREAMENTO E CONTROLE ATIVOS");
  } else if (state.cameraRunning || state.serialConnected) {
    setSystemState("ready", "SISTEMA PARCIALMENTE PRONTO");
  } else {
    setSystemState("", "AGUARDANDO INICIALIZAÇÃO");
  }
}

function updateCalibrationUI() {
  const closedReady = Boolean(state.calibration.closed);
  const openReady = Boolean(state.calibration.open);
  const bothCaptured = closedReady && openReady;
  const ready = isCalibrated();

  ui.closedCalibrationText.textContent = closedReady
    ? "Captura registrada"
    : "Aguardando captura";

  ui.openCalibrationText.textContent = openReady
    ? "Captura registrada"
    : "Aguardando captura";

  ui.closedMark.textContent = closedReady ? "✓" : "○";
  ui.openMark.textContent = openReady ? "✓" : "○";

  ui.captureClosedButton.classList.toggle("is-done", closedReady);
  ui.captureOpenButton.classList.toggle("is-done", openReady);

  ui.calibrationState.textContent = ready
    ? "CONCLUÍDA"
    : (bothCaptured ? "AJUSTAR CAPTURA" : "PENDENTE");

  ui.calibrationState.dataset.ready = String(ready);
  ui.bottomCalibration.textContent = ready ? "CONCLUÍDA" : "PENDENTE";

  ui.captureClosedButton.disabled = !state.latestRaw;
  ui.captureOpenButton.disabled = !state.latestRaw;

  updateSystemState();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function point3(point) {
  return [point.x, point.y, point.z ?? 0];
}

function distance3(a, b) {
  const pa = point3(a);
  const pb = point3(b);

  return Math.hypot(
    pa[0] - pb[0],
    pa[1] - pb[1],
    pa[2] - pb[2]
  );
}

function angle3(a, b, c) {
  const A = point3(a);
  const B = point3(b);
  const C = point3(c);

  const BA = [
    A[0] - B[0],
    A[1] - B[1],
    A[2] - B[2]
  ];

  const BC = [
    C[0] - B[0],
    C[1] - B[1],
    C[2] - B[2]
  ];

  const dot =
    BA[0] * BC[0] +
    BA[1] * BC[1] +
    BA[2] * BC[2];

  const magBA = Math.hypot(...BA);
  const magBC = Math.hypot(...BC);

  if (!magBA || !magBC) return 180;

  return Math.acos(
    clamp(dot / (magBA * magBC), -1, 1)
  ) * 180 / Math.PI;
}

function readFingerMetric(finger, landmarks) {
  if (finger.type === "angle") {
    const j = finger.joints;

    const pipAngle = angle3(
      landmarks[j.base],
      landmarks[j.pip],
      landmarks[j.dip]
    );

    const dipAngle = angle3(
      landmarks[j.pip],
      landmarks[j.dip],
      landmarks[j.tip]
    );

    return pipAngle * 0.7 + dipAngle * 0.3;
  }

  if (finger.type === "thumb-distance") {
    const thumbToPinky = distance3(
      landmarks[finger.tip],
      landmarks[finger.palmSide]
    );

    const palmWidth = distance3(
      landmarks[finger.palmBaseA],
      landmarks[finger.palmBaseB]
    );

    return palmWidth > 0 ? thumbToPinky / palmWidth : 0;
  }

  return 0;
}

function calculateRawMetrics(landmarks) {
  const result = {};

  for (const finger of ACTIVE_FINGERS) {
    result[finger.key] = readFingerMetric(finger, landmarks);
  }

  return result;
}

function normalizeOpening(key, rawValue) {
  if (!isCalibrated()) return 0;

  const closedValue = state.calibration.closed[key];
  const openValue = state.calibration.open[key];
  const range = openValue - closedValue;

  if (!Number.isFinite(range) || Math.abs(range) < 0.0001) {
    return 0;
  }

  return clamp((rawValue - closedValue) / range, 0, 1);
}

function smoothValue(key, value) {
  const previous = state.smoothed[key];

  state.smoothed[key] = previous === null
    ? value
    : previous + (value - previous) * CONFIG.smoothing;

  return state.smoothed[key];
}

function openingToServo(opening) {
  // Mão fechada -> 0° (corda tensionada).
  // Mão aberta -> limite ajustável (corda aliviada).
  return Math.round(clamp(opening, 0, 1) * state.maxOpenAngle);
}

function drawLandmarks(landmarks) {
  const canvas = ui.canvas;
  const video = ui.video;
  const ctx = canvas.getContext("2d");

  const width = video.videoWidth;
  const height = video.videoHeight;

  if (!width || !height) return;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, width / 320);
  ctx.strokeStyle = "rgba(195, 241, 120, .82)";

  for (const [start, end] of LANDMARK_CONNECTIONS) {
    ctx.beginPath();

    ctx.moveTo(
      landmarks[start].x * width,
      landmarks[start].y * height
    );

    ctx.lineTo(
      landmarks[end].x * width,
      landmarks[end].y * height
    );

    ctx.stroke();
  }

  const important = new Set([4, 5, 6, 7, 8, 17]);

  landmarks.forEach((point, index) => {
    const radius = important.has(index) ? 4.2 : 2.7;

    ctx.beginPath();

    ctx.arc(
      point.x * width,
      point.y * height,
      radius,
      0,
      Math.PI * 2
    );

    ctx.fillStyle = important.has(index)
      ? "#e7ffb5"
      : "#c3f178";

    ctx.fill();

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(8, 18, 12, .8)";
    ctx.stroke();
  });
}

function clearOverlay() {
  const ctx = ui.canvas.getContext("2d");

  ctx.clearRect(
    0,
    0,
    ui.canvas.width,
    ui.canvas.height
  );
}

function updateFingerUI(key, opening, servoAngle) {
  const percent = Math.round(opening * 100);

  const progress = $(`${key}Progress`);
  const openValue = $(`${key}OpenValue`);
  const servoValue = $(`${key}ServoValue`);
  const status = $(`${key}State`);

  if (!progress || !openValue || !servoValue || !status) return;

  progress.style.width = `${percent}%`;
  openValue.textContent = `${percent}%`;
  servoValue.textContent = `${servoAngle}°`;

  status.textContent = percent > 92
    ? "ABERTO"
    : percent < 8
      ? "FECHADO"
      : "EM MOVIMENTO";

  status.dataset.active = "true";
}

function updateReadouts(raw, confidence = null) {
  const servoValues = {};

  for (const finger of ACTIVE_FINGERS) {
    const key = finger.key;

    state.metricHistory[key].push(raw[key]);

    if (state.metricHistory[key].length > 10) {
      state.metricHistory[key].shift();
    }

    const filtered = smoothValue(key, raw[key]);
    const opening = normalizeOpening(key, filtered);
    const servo = openingToServo(opening);

    servoValues[key] = servo;

    updateFingerUI(key, opening, servo);
  }

  state.latestRaw = raw;
  state.latestServo = servoValues;

  ui.landmarkCount.innerHTML = `21<small>/ 21</small>`;

  ui.confidenceValue.innerHTML =
    `${confidence === null ? "—" : Math.round(confidence * 100)}<small>%</small>`;

  updateCalibrationUI();
  maybeSendServoValues(servoValues);
}

function captureCalibration(which) {
  if (!state.latestRaw) {
    showToast("A câmera ainda não identificou uma mão.");
    return;
  }

  const captured = {};

  for (const finger of ACTIVE_FINGERS) {
    const samples = state.metricHistory[finger.key];

    captured[finger.key] = samples.length
      ? samples.reduce((sum, value) => sum + value, 0) / samples.length
      : state.latestRaw[finger.key];
  }

  state.calibration[which] = captured;

  saveCalibration();
  updateCalibrationUI();

  const label = which === "closed"
    ? "mão fechada"
    : "mão aberta";

  if (hasBothCalibrationPoses() && !isCalibrated()) {
    showToast(
      "As duas poses foram capturadas, mas a diferença ficou pequena. Repita as capturas com a mão bem fechada e depois bem aberta, mantendo a palma voltada para a câmera."
    );
  } else {
    showToast(`Calibração da ${label} registrada.`);
  }
}

function resetCalibration() {
  state.calibration = { closed: null, open: null };
  state.smoothed = createChannelMap(() => null);
  state.metricHistory = createChannelMap(() => []);

  localStorage.removeItem("kinetic.hand.calibration.v1");

  updateCalibrationUI();

  showToast("Calibração apagada. Capture novamente a mão fechada e aberta.");
}

function makeSerialPacket(servoValues) {
  // A ordem deste array é a mesma do protocolo que o Arduino receberá.
  return `${ACTIVE_FINGERS.map(
    (finger) => servoValues[finger.key] ?? 0
  ).join(",")}\n`;
}

async function maybeSendServoValues(servoValues) {
  if (
    !state.serialConnected ||
    !state.serialWriter ||
    !isCalibrated()
  ) {
    return;
  }

  const now = performance.now();

  if (now - state.lastSerialAt < 1000 / CONFIG.serialRateHz) {
    return;
  }

  const values = ACTIVE_FINGERS.map(
    (finger) => servoValues[finger.key] ?? 0
  );

  if (
    state.lastSentValues &&
    values.every((value, i) =>
      Math.abs(value - state.lastSentValues[i]) < CONFIG.minimumServoChange
    )
  ) {
    return;
  }

  state.lastSerialAt = now;
  state.lastSentValues = [...values];

  const packet = makeSerialPacket(servoValues);

  try {
    await state.serialWriter.write(
      new TextEncoder().encode(packet)
    );

    ui.packetValue.textContent = packet.trim();

  } catch (error) {
    console.error("Falha ao enviar pela serial:", error);

    showToast(`Falha na comunicação USB: ${error.message}`);

    await disconnectSerial();
  }
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    showToast(
      "Web Serial não está disponível. Abra o site no Google Chrome atualizado."
    );
    return;
  }

  try {
    ui.connectButton.disabled = true;
    ui.serialStatus.textContent = "Selecione a porta USB...";

    state.serialPort = await navigator.serial.requestPort();

    await state.serialPort.open({
      baudRate: CONFIG.serialBaudRate
    });

    state.serialWriter =
      state.serialPort.writable.getWriter();

    state.serialReader =
      state.serialPort.readable.getReader();

    // Muitas placas Arduino reiniciam quando a porta USB é aberta.
    // Aguarda a inicialização antes de permitir o primeiro pacote.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    setSerialStatus(
      true,
      "Arduino conectado · aguardando dados"
    );

    state.lastSentValues = null;
    state.serialReadTask = readSerialResponses();

    showToast(
      "Arduino conectado. A transmissão começa após a calibração."
    );

  } catch (error) {
    console.error("Erro ao conectar Arduino:", error);

    setSerialStatus(false, "Conexão não estabelecida");

    if (error.name !== "NotFoundError") {
      showToast(`Não foi possível conectar: ${error.message}`);
    }

  } finally {
    ui.connectButton.disabled = false;
  }
}

async function readSerialResponses() {
  const decoder = new TextDecoder();

  try {
    while (state.serialReader) {
      const { value, done } =
        await state.serialReader.read();

      if (done) break;

      if (value) {
        const line = decoder.decode(
          value,
          { stream: true }
        ).trim();

        if (line) {
          ui.serialStatus.textContent =
            `Arduino conectado · ${line.slice(0, 34)}`;
        }
      }
    }

  } catch (error) {
    if (state.serialConnected) {
      console.warn("Leitura serial encerrada:", error);
    }
  }
}

async function disconnectSerial() {
  const port = state.serialPort;
  const reader = state.serialReader;
  const writer = state.serialWriter;

  state.serialPort = null;
  state.serialReader = null;
  state.serialWriter = null;
  state.lastSentValues = null;

  try {
    if (reader) {
      try {
        await reader.cancel();
      } catch (_) {}

      try {
        reader.releaseLock();
      } catch (_) {}
    }

    if (writer) {
      try {
        writer.releaseLock();
      } catch (_) {}
    }

    if (port) {
      try {
        await port.close();
      } catch (_) {}
    }

  } finally {
    setSerialStatus(
      false,
      "Nenhum dispositivo conectado"
    );

    ui.packetValue.textContent = "—";
  }
}

async function initializeLandmarker() {
  if (state.landmarker) {
    return state.landmarker;
  }

  showToast(
    "Carregando o modelo de visão pela primeira vez..."
  );

  const vision = await FilesetResolver.forVisionTasks(
    CONFIG.wasmUrl
  );

  state.landmarker = await HandLandmarker.createFromOptions(
    vision,
    {
      baseOptions: {
        modelAssetPath: CONFIG.modelUrl,
        delegate: "CPU"
      },

      runningMode: "VIDEO",
      numHands: 1,

      minHandDetectionConfidence: 0.65,
      minHandPresenceConfidence: 0.60,
      minTrackingConfidence: 0.60
    }
  );

  return state.landmarker;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast(
      "A câmera exige localhost ou HTTPS e permissão do navegador."
    );
    return;
  }

  try {
    ui.cameraButton.disabled = true;

    ui.cameraButton.querySelector("span").textContent =
      "INICIALIZANDO...";

    await initializeLandmarker();

    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,

      video: {
        width: { ideal: CONFIG.cameraWidth },
        height: { ideal: CONFIG.cameraHeight },
        frameRate: {
          ideal: CONFIG.cameraFps,
          max: CONFIG.cameraFps
        },
        facingMode: "user"
      }
    });

    ui.video.srcObject = state.stream;

    await ui.video.play();

    state.cameraRunning = true;

    ui.cameraPlaceholder.classList.add("hidden");

    ui.cameraButton.querySelector("span").textContent =
      "PARAR CÂMERA";

    ui.cameraButton.disabled = false;

    setCameraStatus(true, "CÂMERA ATIVA");

    ui.trackingReadout.textContent = "SCANNING HAND";

    updateCalibrationUI();
    updateSystemState();

    requestAnimationFrame(processVideoFrame);

  } catch (error) {
    console.error("Erro ao iniciar câmera:", error);

    stopCamera();

    ui.cameraButton.disabled = false;

    ui.cameraButton.querySelector("span").textContent =
      "INICIAR CÂMERA";

    showToast(`Não foi possível iniciar a câmera: ${error.message}`);
  }
}

function stopCamera() {
  state.cameraRunning = false;

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  ui.video.srcObject = null;
  state.latestRaw = null;

  clearOverlay();

  ui.cameraPlaceholder.classList.remove("hidden");

  ui.cameraButton.querySelector("span").textContent =
    "INICIAR CÂMERA";

  setCameraStatus(false, "CÂMERA DESLIGADA");

  ui.trackingReadout.textContent = "NO TRACKING";

  ui.landmarkCount.innerHTML = `—<small>/ 21</small>`;
  ui.confidenceValue.innerHTML = `—<small>%</small>`;

  for (const finger of ACTIVE_FINGERS) {
    const status = $(`${finger.key}State`);

    if (status) {
      status.textContent = "SEM LEITURA";
      status.dataset.active = "false";
    }
  }

  updateSystemState();
}

function processVideoFrame(timestamp) {
  if (!state.cameraRunning || !state.landmarker) {
    return;
  }

  const now = performance.now();
  const minFrameInterval = 1000 / CONFIG.cameraFps;

  if (
    now - state.lastDetectionAt >= minFrameInterval &&
    ui.video.readyState >= 2 &&
    ui.video.currentTime !== state.lastVideoTime
  ) {
    state.lastDetectionAt = now;
    state.lastVideoTime = ui.video.currentTime;

    const result = state.landmarker.detectForVideo(
      ui.video,
      timestamp
    );

    const landmarks = result.landmarks?.[0];

    const worldLandmarks =
      result.worldLandmarks?.[0] || landmarks;

    if (landmarks && worldLandmarks) {
      drawLandmarks(landmarks);

      const raw = calculateRawMetrics(worldLandmarks);

      const confidence =
        result.handednesses?.[0]?.[0]?.score ?? null;

      updateReadouts(raw, confidence);

      ui.trackingReadout.textContent = "HAND DETECTED";

      setCameraStatus(true, "MÃO DETECTADA");

      state.fpsCounter += 1;

    } else {
      clearOverlay();

      ui.trackingReadout.textContent = "HAND NOT FOUND";

      setCameraStatus(true, "CÂMERA ATIVA · SEM MÃO");

      state.latestRaw = null;

      updateCalibrationUI();

      ui.landmarkCount.innerHTML = `—<small>/ 21</small>`;
      ui.confidenceValue.innerHTML = `—<small>%</small>`;

      for (const finger of ACTIVE_FINGERS) {
        const status = $(`${finger.key}State`);

        if (status) {
          status.textContent = "SEM MÃO";
          status.dataset.active = "false";
        }
      }

      // Sem detecção: mantém a última posição dos servos.
      // Não manda comando zero automaticamente.
    }
  }

  if (now - state.fpsWindowStart >= 1000) {
    state.currentFps = state.fpsCounter;

    ui.fpsReadout.textContent =
      `${state.currentFps} FPS`;

    state.fpsCounter = 0;
    state.fpsWindowStart = now;
  }

  requestAnimationFrame(processVideoFrame);
}

function updateClock() {
  ui.clock.textContent = new Intl.DateTimeFormat(
    "pt-BR",
    {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }
  ).format(new Date());
}

function renderFingerChannels() {
  ui.channelCountValue.textContent =
    String(ACTIVE_FINGERS.length).padStart(2, "0");

  ui.fingerList.innerHTML = ACTIVE_FINGERS.map((finger) => {
    const symbolClass =
      finger.key === "thumb"
        ? "thumb-symbol"
        : "index-symbol";

    return `
      <div class="finger-channel" data-finger="${finger.key}">
        <div class="finger-head">
          <div class="finger-title">
            <span class="finger-symbol ${symbolClass}"></span>
            <strong>${finger.label}</strong>
          </div>

          <span class="finger-state" id="${finger.key}State">
            SEM LEITURA
          </span>
        </div>

        <div class="progress-track">
          <div class="progress-fill" id="${finger.key}Progress"></div>
        </div>

        <div class="finger-values">
          <span>ABERTURA <b id="${finger.key}OpenValue">—%</b></span>
          <span>SERVO <b id="${finger.key}ServoValue">0°</b></span>
        </div>
      </div>
    `;
  }).join("");
}

function bindEvents() {
  ui.cameraButton.addEventListener("click", () => {
    if (state.cameraRunning) {
      stopCamera();
    } else {
      startCamera();
    }
  });

  ui.connectButton.addEventListener(
    "click",
    connectSerial
  );

  ui.disconnectButton.addEventListener(
    "click",
    disconnectSerial
  );

  ui.captureClosedButton.addEventListener(
    "click",
    () => captureCalibration("closed")
  );

  ui.captureOpenButton.addEventListener(
    "click",
    () => captureCalibration("open")
  );

  ui.resetCalibrationButton.addEventListener(
    "click",
    resetCalibration
  );

  ui.maxAngleSlider.addEventListener("input", (event) => {
    state.maxOpenAngle = Number(event.target.value);

    ui.maxAngleLabel.textContent =
      `${state.maxOpenAngle}°`;

    const percent = (
      (state.maxOpenAngle - CONFIG.minOpenServoAngle) /
      (CONFIG.maxOpenServoAngle - CONFIG.minOpenServoAngle)
    ) * 100;

    event.target.style.background =
      `linear-gradient(90deg, var(--accent) 0 ${percent}%, rgba(226,239,225,.13) ${percent}% 100%)`;

    if (state.latestRaw) {
      updateReadouts(state.latestRaw);
    }
  });

  window.addEventListener("beforeunload", () => {
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
    }
  });
}

function init() {
  renderFingerChannels();

  bindEvents();

  updateCalibrationUI();
  updateClock();

  setInterval(updateClock, 1000);

  setSerialStatus(
    false,
    "Nenhum dispositivo conectado"
  );

  setCameraStatus(
    false,
    "CÂMERA DESLIGADA"
  );

  const sliderPercent = (
    (state.maxOpenAngle - CONFIG.minOpenServoAngle) /
    (CONFIG.maxOpenServoAngle - CONFIG.minOpenServoAngle)
  ) * 100;

  ui.maxAngleSlider.style.background =
    `linear-gradient(90deg, var(--accent) 0 ${sliderPercent}%, rgba(226,239,225,.13) ${sliderPercent}% 100%)`;

  updateSystemState();
}

init();
