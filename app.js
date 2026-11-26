
/*
 * KINETIC — HAND CONTROL
 *
 * Visão: micro-handpose (WebGPU), sem SDK/runtime MediaPipe.
 * Interface, desenho, cálculos, calibração e comunicação serial: código próprio.
 *
 * PROTOCOLO:
 * indicador,polegar\n
 *
 * Exemplo:
 * 0,70\n
 *
 * 0° = corda tensionada (mão robótica fechada).
 * Ângulo máximo = corda aliviada (elástico abre os dedos).
 */

(() => {
  "use strict";

  // ==========================================
  // 1. CONFIGURAÇÕES GERAIS
  // ==========================================

  const CONFIG = {
    detectorModuleUrl:
      "https://cdn.jsdelivr.net/npm/@svenflow/micro-handpose@0.3.0/dist/index.js",

    baudRate: 9600,

    cameraWidth: 640,
    cameraHeight: 480,

    targetInferenceFps: 25,

    serialRateHz: 25,

    smoothing: 0.45,

    minimumServoChange: 1,

    defaultOpenAngle: 70,

    minOpenAngle: 10,
    maxOpenAngle: 120,

    historySize: 18,

    calibrationStorageKey:
      "kinetic-hand-calibration-v2"
  };


  // ==========================================
  // 2. CONFIGURAÇÃO DOS DEDOS
  // ==========================================

  // Os cinco canais já estão organizados.
  // Por enquanto, somente indicador e polegar estão ativos.

  const FINGER_CHANNELS = {

    index: {
      key: "index",
      label: "Indicador",
      active: true,
      type: "joint-angle",

      landmarks: {
        mcp: 5,
        pip: 6,
        dip: 7,
        tip: 8
      },

      serialPosition: 0
    },

    thumb: {
      key: "thumb",
      label: "Polegar",
      active: false,
      type: "thumb-distance",

      landmarks: {
        tip: 4,
        indexMcp: 5,
        wrist: 0,
        middleMcp: 9
      },

      serialPosition: 1
    },

    middle: {
      key: "middle",
      label: "Médio",
      active: false,
      type: "joint-angle",

      landmarks: {
        mcp: 9,
        pip: 10,
        dip: 11,
        tip: 12
      },

      serialPosition: 2
    },

    ring: {
      key: "ring",
      label: "Anelar",
      active: false,
      type: "joint-angle",

      landmarks: {
        mcp: 13,
        pip: 14,
        dip: 15,
        tip: 16
      },

      serialPosition: 3
    },

    pinky: {
      key: "pinky",
      label: "Mindinho",
      active: false,
      type: "joint-angle",

      landmarks: {
        mcp: 17,
        pip: 18,
        dip: 19,
        tip: 20
      },

      serialPosition: 4
    }

  };


  const ACTIVE_FINGERS = Object.values(FINGER_CHANNELS)
    .filter((finger) => finger.active)
    .sort((a, b) => a.serialPosition - b.serialPosition);


  // ==========================================
  // 3. CONEXÕES DOS 21 PONTOS
  // ==========================================

  const CONNECTIONS = [

    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],

    [0, 5],
    [5, 6],
    [6, 7],
    [7, 8],

    [5, 9],
    [9, 10],
    [10, 11],
    [11, 12],

    [9, 13],
    [13, 14],
    [14, 15],
    [15, 16],

    [13, 17],
    [17, 18],
    [18, 19],
    [19, 20],

    [0, 17]

  ];


  // ==========================================
  // 4. ELEMENTOS DA INTERFACE
  // ==========================================

  const $ = (id) => document.getElementById(id);

  const mapByActiveFinger = (factory) =>
    Object.fromEntries(
      ACTIVE_FINGERS.map((finger) => [
        finger.key,
        factory(finger)
      ])
    );


  const ui = {

    clock: $("clock"),

    systemState: $("systemState"),
    systemStateText: $("systemStateText"),

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

    fingerList: $("fingerList"),
    channelCountValue: $("channelCountValue"),

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

    bottomTracking: $("bottomTracking"),
    bottomUsb: $("bottomUsb"),
    bottomCalibration: $("bottomCalibration"),

    toast: $("toast")

  };


  // ==========================================
  // 5. ESTADO DO SISTEMA
  // ==========================================

  const state = {

    detector: null,

    cameraStream: null,
    cameraRunning: false,
    inferenceBusy: false,

    lastInferenceAt: 0,

    fpsFrames: 0,
    fpsStartedAt: performance.now(),
    currentFps: 0,

    latestRaw: null,

    history: mapByActiveFinger(() => []),

    smoothed: mapByActiveFinger(() => null),

    latestServo: mapByActiveFinger(() => 0),

    calibration: loadCalibration(),

    maxOpenAngle: CONFIG.defaultOpenAngle,

    serialPort: null,
    serialWriter: null,

    serialConnected: false,

    serialQueue: Promise.resolve(),

    lastSerialAt: 0,
    lastSentValues: null,

    toastTimer: null,

    animationFrame: null

  };


  // ==========================================
  // 6. CALIBRAÇÃO SALVA
  // ==========================================

  function loadCalibration() {

    try {

      const saved = JSON.parse(
        localStorage.getItem(CONFIG.calibrationStorageKey)
      );

      if (
        !saved ||
        !saved.closed ||
        !saved.open
      ) {
        return {
          closed: null,
          open: null
        };
      }

      const valid = ACTIVE_FINGERS.every((finger) =>

        Number.isFinite(saved.closed[finger.key]) &&
        Number.isFinite(saved.open[finger.key])

      );

      return valid
        ? saved
        : { closed: null, open: null };

    } catch (error) {

      console.warn(
        "Calibração salva indisponível:",
        error
      );

      return {
        closed: null,
        open: null
      };

    }

  }


  function saveCalibration() {

    try {

      localStorage.setItem(
        CONFIG.calibrationStorageKey,
        JSON.stringify(state.calibration)
      );

    } catch (error) {

      console.warn(
        "Não foi possível salvar a calibração:",
        error
      );

      showToast(
        "Calibração usada nesta sessão, mas não pôde ser salva no navegador."
      );

    }

  }


  // ==========================================
  // 7. INTERFACE E NOTIFICAÇÕES
  // ==========================================

  function showToast(message, duration = 3600) {

    if (!ui.toast) return;

    ui.toast.textContent = message;

    ui.toast.classList.add("show");

    clearTimeout(state.toastTimer);

    state.toastTimer = setTimeout(() => {

      ui.toast.classList.remove("show");

    }, duration);

  }


  function setSystemState(kind, message) {

    ui.systemState.dataset.state = kind || "idle";

    ui.systemStateText.textContent = message;

  }


  function updateSystemState() {

    if (
      state.cameraRunning &&
      state.serialConnected &&
      isCalibrated()
    ) {

      setSystemState(
        "active",
        "RASTREAMENTO E CONTROLE ATIVOS"
      );

    } else if (
      state.cameraRunning ||
      state.serialConnected
    ) {

      setSystemState(
        "ready",
        "SISTEMA PARCIALMENTE PRONTO"
      );

    } else {

      setSystemState(
        "idle",
        "AGUARDANDO INICIALIZAÇÃO"
      );

    }

  }


  function setCameraStatus(active, message) {

    ui.cameraBadge.dataset.active = String(active);

    ui.cameraStatusText.textContent = message;

    ui.bottomTracking.textContent =
      active ? "ATIVO" : "INATIVO";

  }


  function setSerialStatus(connected, message) {

    state.serialConnected = connected;

    ui.serialStatus.textContent = message;

    ui.serialTag.textContent =
      connected ? "ONLINE" : "OFFLINE";

    ui.serialTag.dataset.connected =
      String(connected);

    ui.serialIndicator.dataset.connected =
      String(connected);

    ui.connectButton.classList.toggle(
      "hidden",
      connected
    );

    ui.disconnectButton.classList.toggle(
      "hidden",
      !connected
    );

    ui.bottomUsb.textContent =
      connected ? "CONECTADO" : "DESCONECTADO";

    updateSystemState();

  }


  // ==========================================
  // 8. VERIFICAR CALIBRAÇÃO
  // ==========================================

  function isCalibrated() {

    if (
      !state.calibration.closed ||
      !state.calibration.open
    ) {
      return false;
    }

    return ACTIVE_FINGERS.every((finger) => {

      const closedValue =
        state.calibration.closed[finger.key];

      const openValue =
        state.calibration.open[finger.key];

      const range = Math.abs(
        openValue - closedValue
      );

      const minimumRange =
        finger.type === "thumb-distance"
          ? 0.06
          : 12;

      return range >= minimumRange;

    });

  }


  function updateCalibrationUI() {

    const closedReady =
      Boolean(state.calibration.closed);

    const openReady =
      Boolean(state.calibration.open);

    const ready = isCalibrated();


    ui.closedCalibrationText.textContent =
      closedReady
        ? "Captura registrada"
        : "Aguardando captura";


    ui.openCalibrationText.textContent =
      openReady
        ? "Captura registrada"
        : "Aguardando captura";


    ui.closedMark.textContent =
      closedReady ? "✓" : "○";

    ui.openMark.textContent =
      openReady ? "✓" : "○";


    ui.captureClosedButton.classList.toggle(
      "is-done",
      closedReady
    );

    ui.captureOpenButton.classList.toggle(
      "is-done",
      openReady
    );


    ui.calibrationState.textContent = ready
      ? "CONCLUÍDA"
      : (
          closedReady && openReady
            ? "REFAZER CAPTURA"
            : "PENDENTE"
        );


    ui.calibrationState.dataset.ready =
      String(ready);


    ui.bottomCalibration.textContent =
      ready ? "CONCLUÍDA" : "PENDENTE";


    // Os botões só ficam disponíveis quando uma mão é detectada.

    ui.captureClosedButton.disabled =
      !state.latestRaw;

    ui.captureOpenButton.disabled =
      !state.latestRaw;


    updateSystemState();

  }


  // ==========================================
  // 9. FUNÇÕES MATEMÁTICAS
  // ==========================================

  function clamp(value, min, max) {

    return Math.max(
      min,
      Math.min(max, value)
    );

  }


  function pointAt(landmarks, index) {

    const point = landmarks[index];

    if (!point) {

      throw new Error(
        `Landmark ${index} não encontrado.`
      );

    }

    if (Array.isArray(point)) {

      return {
        x: Number(point[0]),
        y: Number(point[1]),
        z: Number(point[2] ?? 0)
      };

    }

    return {
      x: Number(point.x),
      y: Number(point.y),
      z: Number(point.z ?? 0)
    };

  }


  function distance3(a, b) {

    return Math.hypot(
      a.x - b.x,
      a.y - b.y,
      a.z - b.z
    );

  }


  function angle3(a, b, c) {

    const ba = {
      x: a.x - b.x,
      y: a.y - b.y,
      z: a.z - b.z
    };

    const bc = {
      x: c.x - b.x,
      y: c.y - b.y,
      z: c.z - b.z
    };


    const dot =
      ba.x * bc.x +
      ba.y * bc.y +
      ba.z * bc.z;


    const magBA = Math.hypot(
      ba.x,
      ba.y,
      ba.z
    );

    const magBC = Math.hypot(
      bc.x,
      bc.y,
      bc.z
    );


    if (
      magBA === 0 ||
      magBC === 0
    ) {
      return 180;
    }


    return Math.acos(

      clamp(
        dot / (magBA * magBC),
        -1,
        1
      )

    ) * 180 / Math.PI;

  }


  // ==========================================
  // 10. MEDIR CADA DEDO
  // ==========================================

  function measureFinger(finger, landmarks) {

    const p = (index) =>
      pointAt(landmarks, index);


    // INDICADOR E FUTUROS DEDOS
    // Quanto mais estendido, mais próximo de 180°.

    if (finger.type === "joint-angle") {

      const j = finger.landmarks;

      const pipAngle = angle3(
        p(j.mcp),
        p(j.pip),
        p(j.dip)
      );

      const dipAngle = angle3(
        p(j.pip),
        p(j.dip),
        p(j.tip)
      );

      return (
        pipAngle * 0.72 +
        dipAngle * 0.28
      );

    }


    // POLEGAR
    // Mede a distância da ponta em relação à base do indicador,
    // dividida pelo tamanho da palma.

    if (finger.type === "thumb-distance") {

      const j = finger.landmarks;

      const thumbTip = p(j.tip);

      const indexMcp = p(j.indexMcp);

      const wrist = p(j.wrist);

      const middleMcp = p(j.middleMcp);


      const palmScale = distance3(
        wrist,
        middleMcp
      );


      if (palmScale < 0.0001) {
        return 0;
      }


      return (
        distance3(thumbTip, indexMcp) /
        palmScale
      );

    }


    return 0;

  }


  function collectRawMetrics(landmarks) {

    if (
      !Array.isArray(landmarks) ||
      landmarks.length < 21
    ) {

      throw new Error(
        "O detector não retornou os 21 pontos da mão."
      );

    }


    const values = {};

    for (const finger of ACTIVE_FINGERS) {

      values[finger.key] =
        measureFinger(finger, landmarks);

    }

    return values;

  }


  // ==========================================
  // 11. SUAVIZAÇÃO
  // ==========================================

  function smoothMetric(key, value) {

    const previous =
      state.smoothed[key];


    state.smoothed[key] =
      previous === null
        ? value
        : previous +
          (value - previous) * CONFIG.smoothing;


    return state.smoothed[key];

  }


  // ==========================================
  // 12. CALCULAR ABERTURA
  // ==========================================

  function normalizedOpening(key, rawValue) {

    if (!isCalibrated()) {
      return 0;
    }


    const closedValue =
      state.calibration.closed[key];

    const openValue =
      state.calibration.open[key];


    const range =
      openValue - closedValue;


    if (Math.abs(range) < 0.000001) {
      return 0;
    }


    return clamp(
      (rawValue - closedValue) / range,
      0,
      1
    );

  }


  function servoAngleFromOpening(opening) {

    // Mão fechada = 0°
    // Mão aberta = limite escolhido no site.

    return Math.round(
      clamp(opening, 0, 1) *
      state.maxOpenAngle
    );

  }


  // ==========================================
  // 13. DESENHAR A MÃO
  // ==========================================

  function drawHand(landmarks) {

    const canvas = ui.canvas;

    const video = ui.video;

    const ctx = canvas.getContext("2d");


    const width = video.videoWidth;

    const height = video.videoHeight;


    if (!width || !height) {
      return;
    }


    if (
      canvas.width !== width ||
      canvas.height !== height
    ) {

      canvas.width = width;

      canvas.height = height;

    }


    ctx.clearRect(
      0,
      0,
      width,
      height
    );


    ctx.lineWidth = Math.max(
      2,
      width / 320
    );

    ctx.lineCap = "round";

    ctx.lineJoin = "round";

    ctx.strokeStyle =
      "rgba(195, 241, 120, .88)";


    // DESENHA AS CONEXÕES

    for (const [from, to] of CONNECTIONS) {

      const a = pointAt(landmarks, from);

      const b = pointAt(landmarks, to);


      ctx.beginPath();

      ctx.moveTo(
        a.x * width,
        a.y * height
      );

      ctx.lineTo(
        b.x * width,
        b.y * height
      );

      ctx.stroke();

    }


    // DESENHA OS 21 PONTOS

    const emphasized = new Set([
      0, 4, 5, 6, 7, 8, 17
    ]);


    for (
      let index = 0;
      index < 21;
      index += 1
    ) {

      const point = pointAt(
        landmarks,
        index
      );


      ctx.beginPath();

      ctx.arc(
        point.x * width,
        point.y * height,
        emphasized.has(index) ? 4.1 : 2.8,
        0,
        Math.PI * 2
      );


      ctx.fillStyle =
        emphasized.has(index)
          ? "#edffc4"
          : "#c3f178";

      ctx.fill();


      ctx.lineWidth = 1;

      ctx.strokeStyle =
        "rgba(8, 18, 12, .85)";

      ctx.stroke();

    }

  }


  function clearCanvas() {

    const ctx =
      ui.canvas.getContext("2d");

    ctx.clearRect(
      0,
      0,
      ui.canvas.width,
      ui.canvas.height
    );

  }


  // ==========================================
  // 14. ATUALIZAR CARTÕES DOS DEDOS
  // ==========================================

  function updateFingerCard(
    key,
    opening,
    servoAngle
  ) {

    const percent =
      Math.round(opening * 100);


    const progress =
      $(`${key}Progress`);

    const openValue =
      $(`${key}OpenValue`);

    const servoValue =
      $(`${key}ServoValue`);

    const status =
      $(`${key}State`);


    if (
      !progress ||
      !openValue ||
      !servoValue ||
      !status
    ) {
      return;
    }


    progress.style.width =
      `${percent}%`;

    openValue.textContent =
      `${percent}%`;

    servoValue.textContent =
      `${servoAngle}°`;


    status.textContent =
      percent >= 92
        ? "ABERTO"
        : percent <= 8
          ? "FECHADO"
          : "EM MOVIMENTO";


    status.dataset.active = "true";

  }


  // ==========================================
  // 15. CONSTRUIR OS COMANDOS DOS SERVOS
  // ==========================================

  function buildServoValues(rawValues) {

    const values = {};


    for (const finger of ACTIVE_FINGERS) {

      const filtered = smoothMetric(
        finger.key,
        rawValues[finger.key]
      );


      const opening = normalizedOpening(
        finger.key,
        filtered
      );


      values[finger.key] =
        servoAngleFromOpening(opening);


      updateFingerCard(
        finger.key,
        opening,
        values[finger.key]
      );

    }


    return values;

  }


  function updateTelemetry(hand, rawValues) {

    state.latestRaw = rawValues;


    // Guarda as últimas leituras para a calibração.

    for (const finger of ACTIVE_FINGERS) {

      const list =
        state.history[finger.key];

      list.push(
        rawValues[finger.key]
      );

      if (
        list.length > CONFIG.historySize
      ) {
        list.shift();
      }

    }


    state.latestServo =
      buildServoValues(rawValues);


    ui.landmarkCount.innerHTML =
      `21<small>/ 21</small>`;


    ui.confidenceValue.innerHTML =
      `${Math.round((hand.score ?? 0) * 100)}<small>%</small>`;


    updateCalibrationUI();

    maybeSendServoValues(
      state.latestServo
    );

  }


  // ==========================================
  // 16. CAPTURAR MÃO ABERTA OU FECHADA
  // ==========================================

  function capturePose(which) {

    if (!state.latestRaw) {

      showToast(
        "A câmera ainda não detectou uma mão."
      );

      return;

    }


    const captured = {};


    for (const finger of ACTIVE_FINGERS) {

      const samples =
        state.history[finger.key];


      if (!samples.length) {

        showToast(
          "Ainda não há amostras suficientes. Mantenha a mão visível por um instante."
        );

        return;

      }


      captured[finger.key] =
        samples.reduce(
          (sum, value) => sum + value,
          0
        ) / samples.length;

    }


    state.calibration[which] =
      captured;


    saveCalibration();

    updateCalibrationUI();


    if (
      state.calibration.closed &&
      state.calibration.open &&
      !isCalibrated()
    ) {

      showToast(
        "As poses ficaram muito parecidas. Refaça: primeiro feche bem a mão, depois abra completamente.",
        5200
      );

    } else {

      showToast(
        which === "closed"
          ? "Referência de mão fechada registrada."
          : "Referência de mão aberta registrada."
      );

    }


    if (state.latestRaw) {

      state.smoothed =
        mapByActiveFinger(() => null);

      state.latestServo =
        buildServoValues(state.latestRaw);

    }

  }


  function resetCalibration() {

    state.calibration = {
      closed: null,
      open: null
    };


    state.smoothed =
      mapByActiveFinger(() => null);


    state.history =
      mapByActiveFinger(() => []);


    try {

      localStorage.removeItem(
        CONFIG.calibrationStorageKey
      );

    } catch (_) {}


    updateCalibrationUI();


    showToast(
      "Calibração apagada. Registre novamente a mão fechada e a mão aberta."
    );

  }


  // ==========================================
  // 17. COMUNICAÇÃO SERIAL
  // ==========================================

  function makeSerialPacket(servoValues) {

    // Ordem fixa desta primeira versão:
    // indicador,polegar

    return `${
      ACTIVE_FINGERS.map(
        (finger) =>
          Math.round(
            servoValues[finger.key] ?? 0
          )
      ).join(",")
    }\n`;

  }


  function maybeSendServoValues(servoValues) {

    if (
      !state.serialConnected ||
      !state.serialWriter ||
      !isCalibrated() ||
      !state.latestRaw
    ) {
      return;
    }


    const now = performance.now();


    if (
      now - state.lastSerialAt <
      1000 / CONFIG.serialRateHz
    ) {
      return;
    }


    const values = ACTIVE_FINGERS.map(
      (finger) =>
        Math.round(
          servoValues[finger.key] ?? 0
        )
    );


    if (
      state.lastSentValues &&
      values.every(
        (value, i) =>
          Math.abs(
            value - state.lastSentValues[i]
          ) < CONFIG.minimumServoChange
      )
    ) {
      return;
    }


    state.lastSerialAt = now;

    state.lastSentValues = [...values];


    const packet =
      makeSerialPacket(servoValues);


    // Fila para impedir escritas simultâneas na USB.

    state.serialQueue =
      state.serialQueue

        .then(async () => {

          if (
            !state.serialWriter ||
            !state.serialConnected
          ) {
            return;
          }


          await state.serialWriter.write(
            new TextEncoder().encode(packet)
          );


          ui.packetValue.textContent =
            packet.trim();

        })

        .catch((error) => {

          console.error(
            "Erro ao transmitir dados:",
            error
          );


          showToast(
            `Falha na comunicação USB: ${error.message}`
          );


          const failedWriter =
            state.serialWriter;

          const failedPort =
            state.serialPort;


          state.serialWriter = null;

          state.serialPort = null;


          setSerialStatus(
            false,
            "Falha na transmissão USB"
          );


          if (failedWriter) {

            try {
              failedWriter.releaseLock();
            } catch (_) {}

          }


          if (failedPort) {

            failedPort.close().catch(
              () => {}
            );

          }

        });

  }


  // ==========================================
  // 18. CONECTAR ARDUINO
  // ==========================================

  async function connectSerial() {

    if (!("serial" in navigator)) {

      showToast(
        "Web Serial não está disponível neste navegador. Use o Chrome atualizado em localhost ou HTTPS.",
        5200
      );

      ui.serialStatus.textContent =
        "Web Serial indisponível neste navegador";

      return;

    }


    ui.connectButton.disabled = true;

    ui.serialStatus.textContent =
      "Selecione a porta do Arduino...";


    let openedPort = null;

    let openedWriter = null;


    try {

      openedPort =
        await navigator.serial.requestPort();


      await openedPort.open({
        baudRate: CONFIG.baudRate
      });


      openedWriter =
        openedPort.writable.getWriter();


      // Algumas placas reiniciam ao abrir a porta serial.

      await new Promise(
        (resolve) => setTimeout(resolve, 1400)
      );


      state.serialPort = openedPort;

      state.serialWriter = openedWriter;

      state.lastSentValues = null;

      state.lastSerialAt = 0;


      setSerialStatus(
        true,
        "Arduino conectado · aguardando calibração"
      );


      showToast(
        "Arduino conectado. Os comandos serão enviados após a calibração."
      );


    } catch (error) {

      console.error(
        "Falha na conexão serial:",
        error
      );


      if (openedWriter) {

        try {
          openedWriter.releaseLock();
        } catch (_) {}

      }


      if (openedPort) {

        try {
          await openedPort.close();
        } catch (_) {}

      }


      ui.serialStatus.textContent =
        error.name === "NotFoundError"
          ? "Nenhuma porta selecionada"
          : "Falha na conexão USB";


      if (error.name !== "NotFoundError") {

        showToast(
          `Não foi possível conectar: ${error.message}`
        );

      }

    } finally {

      ui.connectButton.disabled = false;

    }

  }


  // ==========================================
  // 19. DESCONECTAR ARDUINO
  // ==========================================

  async function disconnectSerial() {

    const writer =
      state.serialWriter;

    const port =
      state.serialPort;


    state.serialWriter = null;

    state.serialPort = null;

    state.lastSentValues = null;


    try {

      await state.serialQueue;


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


  // ==========================================
  // 20. CARREGAR O DETECTOR WEBGPU
  // ==========================================

  async function loadDetector() {

    if (state.detector) {
      return state.detector;
    }


    if (!navigator.gpu) {

      throw new Error(
        "Este Chrome não disponibilizou WebGPU. Verifique a atualização do Chrome e a compatibilidade gráfica do Chromebook."
      );

    }


    const adapter =
      await navigator.gpu.requestAdapter();


    if (!adapter) {

      throw new Error(
        "O navegador tem a API WebGPU, mas não encontrou um adaptador gráfico compatível."
      );

    }


    showToast(
      "Carregando o rastreador de mão WebGPU (primeiro uso pode demorar)...",
      6000
    );


    // Importação dinâmica:
    // não impede os botões da interface de funcionarem.

    const module =
      await import(CONFIG.detectorModuleUrl);


    if (
      typeof module.createHandpose !== "function"
    ) {

      throw new Error(
        "A biblioteca de rastreamento carregou, mas createHandpose não foi encontrado."
      );

    }


    state.detector =
      await module.createHandpose({

        maxHands: 1,

        scoreThreshold: 0.55,

        palmScoreThreshold: 0.55

      });


    return state.detector;

  }


  // ==========================================
  // 21. INICIAR CÂMERA
  // ==========================================

  async function startCamera() {

    if (state.cameraRunning) {

      stopCamera();

      return;

    }


    if (
      !navigator.mediaDevices?.getUserMedia
    ) {

      showToast(
        "A câmera exige localhost ou HTTPS e permissão do navegador.",
        5200
      );

      return;

    }


    ui.cameraButton.disabled = true;

    ui.cameraButton.querySelector("span").textContent =
      "INICIALIZANDO...";


    setCameraStatus(
      false,
      "PREPARANDO RASTREADOR"
    );


    try {

      // Primeiro solicita a câmera.

      state.cameraStream =
        await navigator.mediaDevices.getUserMedia({

          audio: false,

          video: {

            width: {
              ideal: CONFIG.cameraWidth
            },

            height: {
              ideal: CONFIG.cameraHeight
            },

            frameRate: {
              ideal: CONFIG.targetInferenceFps,
              max: 30
            },

            facingMode: "user"

          }

        });


      ui.video.srcObject =
        state.cameraStream;


      await ui.video.play();


      // Depois carrega o detector.

      await loadDetector();


      state.cameraRunning = true;

      state.lastInferenceAt = 0;

      state.fpsFrames = 0;

      state.fpsStartedAt =
        performance.now();


      ui.cameraPlaceholder.classList.add(
        "hidden"
      );


      ui.cameraButton.querySelector("span").textContent =
        "PARAR CÂMERA";


      setCameraStatus(
        true,
        "CÂMERA ATIVA · PROCURANDO MÃO"
      );


      ui.trackingReadout.textContent =
        "SCANNING HAND";


      updateCalibrationUI();


      cameraLoop();


    } catch (error) {

      console.error(
        "Falha ao iniciar rastreamento:",
        error
      );


      stopCamera();


      showToast(
        `Não foi possível iniciar: ${error.message}`,
        6500
      );

    } finally {

      ui.cameraButton.disabled = false;


      ui.cameraButton.querySelector("span").textContent =
        state.cameraRunning
          ? "PARAR CÂMERA"
          : "INICIAR CÂMERA";

    }

  }


  // ==========================================
  // 22. LOOP DA CÂMERA
  // ==========================================

  async function cameraLoop() {

    if (!state.cameraRunning) {
      return;
    }


    const now = performance.now();


    const interval =
      1000 / CONFIG.targetInferenceFps;


    if (

      !state.inferenceBusy &&

      ui.video.readyState >= 2 &&

      now - state.lastInferenceAt >= interval

    ) {

      state.inferenceBusy = true;

      state.lastInferenceAt = now;


      try {

        const hands =
          await state.detector.detect(
            ui.video
          );


        const hand =
          Array.isArray(hands) && hands.length

            ? hands.reduce(
                (best, current) =>
                  (current.score ?? 0) >
                  (best.score ?? 0)
                    ? current
                    : best
              )

            : null;


        if (

          hand &&

          Array.isArray(hand.landmarks) &&

          hand.landmarks.length >= 21

        ) {

          drawHand(hand.landmarks);


          const raw =
            collectRawMetrics(
              hand.landmarks
            );


          updateTelemetry(
            hand,
            raw
          );


          ui.trackingReadout.textContent =
            "HAND DETECTED";


          setCameraStatus(
            true,
            "MÃO DETECTADA"
          );


          state.fpsFrames += 1;


        } else {

          clearCanvas();


          ui.trackingReadout.textContent =
            "HAND NOT FOUND";


          setCameraStatus(
            true,
            "CÂMERA ATIVA · SEM MÃO"
          );


          state.latestRaw = null;


          ui.landmarkCount.innerHTML =
            `—<small>/ 21</small>`;


          ui.confidenceValue.innerHTML =
            `—<small>%</small>`;


          updateCalibrationUI();


          for (const finger of ACTIVE_FINGERS) {

            const status =
              $(`${finger.key}State`);


            if (status) {

              status.textContent =
                "SEM MÃO";

              status.dataset.active =
                "false";

            }

          }


          // Sem mão detectada, não envia zero.
          // Os servos mantêm o último comando recebido.

        }


      } catch (error) {

        console.error(
          "Erro ao detectar landmarks:",
          error
        );


        showToast(
          `Erro no rastreamento: ${error.message}`,
          5000
        );


        stopCamera();

        return;

      } finally {

        state.inferenceBusy = false;

      }

    }


    if (
      now - state.fpsStartedAt >= 1000
    ) {

      state.currentFps =
        state.fpsFrames;


      ui.fpsReadout.textContent =
        `${state.currentFps} FPS`;


      state.fpsFrames = 0;

      state.fpsStartedAt = now;

    }


    state.animationFrame =
      requestAnimationFrame(cameraLoop);

  }


  // ==========================================
  // 23. PARAR CÂMERA
  // ==========================================

  function stopCamera() {

    state.cameraRunning = false;


    if (state.animationFrame) {

      cancelAnimationFrame(
        state.animationFrame
      );

    }


    state.animationFrame = null;


    if (state.cameraStream) {

      state.cameraStream
        .getTracks()
        .forEach((track) => track.stop());

      state.cameraStream = null;

    }


    ui.video.srcObject = null;

    state.latestRaw = null;


    ui.cameraPlaceholder.classList.remove(
      "hidden"
    );


    ui.cameraButton.querySelector("span").textContent =
      "INICIAR CÂMERA";


    setCameraStatus(
      false,
      "CÂMERA DESLIGADA"
    );


    ui.trackingReadout.textContent =
      "NO TRACKING";


    ui.fpsReadout.textContent =
      "-- FPS";


    ui.landmarkCount.innerHTML =
      `—<small>/ 21</small>`;


    ui.confidenceValue.innerHTML =
      `—<small>%</small>`;


    clearCanvas();


    for (const finger of ACTIVE_FINGERS) {

      const status =
        $(`${finger.key}State`);


      if (status) {

        status.textContent =
          "SEM LEITURA";

        status.dataset.active =
          "false";

      }

    }


    updateCalibrationUI();

    updateSystemState();

  }


  // ==========================================
  // 24. CRIAR OS CARTÕES DOS DEDOS
  // ==========================================

  function renderFingerCards() {

    ui.channelCountValue.textContent =
      String(ACTIVE_FINGERS.length).padStart(2, "0");


    ui.fingerList.innerHTML =
      ACTIVE_FINGERS.map((finger) => {

        const symbolClass =
          finger.key === "thumb"
            ? "thumb-symbol"
            : "index-symbol";


        return `

          <div
            class="finger-channel"
            data-finger="${finger.key}"
          >

            <div class="finger-head">

              <div class="finger-title">

                <span class="finger-symbol ${symbolClass}"></span>

                <strong>${finger.label}</strong>

              </div>


              <span
                class="finger-state"
                id="${finger.key}State"
              >
                SEM LEITURA
              </span>

            </div>


            <div class="progress-track">

              <div
                class="progress-fill"
                id="${finger.key}Progress"
              ></div>

            </div>


            <div class="finger-values">

              <span>
                ABERTURA
                <b id="${finger.key}OpenValue">—%</b>
              </span>

              <span>
                SERVO
                <b id="${finger.key}ServoValue">0°</b>
              </span>

            </div>

          </div>

        `;

      }).join("");

  }


  // ==========================================
  // 25. RELÓGIO
  // ==========================================

  function updateClock() {

    ui.clock.textContent =
      new Intl.DateTimeFormat(
        "pt-BR",
        {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        }
      ).format(new Date());

  }


  // ==========================================
  // 26. EVENTOS DOS BOTÕES
  // ==========================================

  function bindEvents() {

    // Os eventos são registrados antes de qualquer
    // carregamento de biblioteca externa.

    ui.cameraButton.addEventListener(
      "click",
      startCamera
    );


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
      () => capturePose("closed")
    );


    ui.captureOpenButton.addEventListener(
      "click",
      () => capturePose("open")
    );


    ui.resetCalibrationButton.addEventListener(
      "click",
      resetCalibration
    );


    ui.maxAngleSlider.addEventListener(
      "input",
      (event) => {

        state.maxOpenAngle =
          Number(event.target.value);


        ui.maxAngleLabel.textContent =
          `${state.maxOpenAngle}°`;


        updateSliderFill();


        if (state.latestRaw) {

          state.latestServo =
            buildServoValues(
              state.latestRaw
            );


          maybeSendServoValues(
            state.latestServo
          );

        }

      }
    );


    window.addEventListener(
      "beforeunload",
      () => {

        if (state.cameraStream) {

          state.cameraStream
            .getTracks()
            .forEach((track) => track.stop());

        }


        if (state.detector?.dispose) {

          state.detector.dispose();

        }

      }
    );

  }


  // ==========================================
  // 27. ATUALIZAR SLIDER
  // ==========================================

  function updateSliderFill() {

    const percent = (

      (
        state.maxOpenAngle -
        CONFIG.minOpenAngle
      ) /

      (
        CONFIG.maxOpenAngle -
        CONFIG.minOpenAngle
      )

    ) * 100;


    ui.maxAngleSlider.style.background =

      `linear-gradient(
        90deg,
        var(--accent) 0 ${percent}%,
        rgba(226,239,225,.13) ${percent}% 100%
      )`;

  }


  // ==========================================
  // 28. INICIALIZAÇÃO
  // ==========================================

  function init() {

    // Verifica se todos os IDs necessários existem no HTML.

    const missing =

      Object.entries(ui)

        .filter(([, element]) => !element)

        .map(([key]) => key);


    if (missing.length) {

      console.error(
        "Elementos ausentes no HTML:",
        missing
      );

      return;

    }


    renderFingerCards();


    // Primeiro registra todos os eventos.

    bindEvents();


    updateClock();

    setInterval(
      updateClock,
      1000
    );


    ui.disconnectButton.classList.add(
      "hidden"
    );


    ui.captureClosedButton.disabled = true;

    ui.captureOpenButton.disabled = true;


    ui.cameraButton.disabled = false;

    ui.connectButton.disabled = false;


    ui.maxAngleSlider.value =
      String(state.maxOpenAngle);


    ui.maxAngleLabel.textContent =
      `${state.maxOpenAngle}°`;


    updateSliderFill();


    setCameraStatus(
      false,
      "CÂMERA DESLIGADA"
    );


    setSerialStatus(
      false,
      "Nenhum dispositivo conectado"
    );


    updateCalibrationUI();

    updateSystemState();


    console.info(
      "KINETIC inicializado. Botões ativos; detector será carregado ao iniciar a câmera."
    );

  }


  // ==========================================
  // 29. EXECUTAR
  // ==========================================

  try {

    init();

  } catch (error) {

    console.error(
      "Erro ao inicializar a interface KINETIC:",
      error
    );


    showToast(
      `Erro ao iniciar a interface: ${error.message}`,
      8000
    );

  }

})();
