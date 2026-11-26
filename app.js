
(() => {
  "use strict";

  // ==========================================
  // KINETIC — INDICADOR + POLEGAR
  // Comunicação: indicador,polegar\n
  // ==========================================

  const CONFIG = {
    detectorUrl:
      "https://cdn.jsdelivr.net/npm/@svenflow/micro-handpose@0.3.0/dist/index.js",

    baudRate: 9600,

    cameraWidth: 480,
    cameraHeight: 360,
    cameraFps: 30,

    smoothingTimeMs: 75,
    serialIntervalMs: 35,
    minimumServoChange: 1,

    initialOpenAngle: 70,
    minOpenAngle: 10,
    maxOpenAngle: 180,

    historySize: 15,

    calibrationKey: "kinetic-hand-calibration-v4"
  };


  // ==========================================
  // CONFIGURAÇÃO DOS CANAIS
  // ==========================================

  const FINGERS = {
    index: {
      key: "index",
      label: "Indicador",
      type: "angle",
      minimumCalibrationRange: 12
    },

    thumb: {
      key: "thumb",
      label: "Polegar",
      type: "thumb-distance",
      minimumCalibrationRange: 0.05
    }
  };

  const FINGER_KEYS = Object.keys(FINGERS);


  // ==========================================
  // CONEXÕES DOS 21 PONTOS
  // ==========================================

  const CONNECTIONS = [
    [0,1], [1,2], [2,3], [3,4],
    [0,5], [5,6], [6,7], [7,8],
    [5,9], [9,10], [10,11], [11,12],
    [9,13], [13,14], [14,15], [15,16],
    [13,17], [17,18], [18,19], [19,20],
    [0,17]
  ];


  // ==========================================
  // ELEMENTOS HTML
  // ==========================================

  const $ = (id) => document.getElementById(id);

  const ui = {
    clock: $("clock"),

    systemState: $("systemState"),
    systemStateText: $("systemStateText"),

    video: $("cameraVideo"),
    canvas: $("overlayCanvas"),
    placeholder: $("cameraPlaceholder"),

    cameraButton: $("cameraButton"),
    cameraStatus: $("cameraStatus"),
    cameraStatusText: $("cameraStatusText"),

    trackingText: $("trackingText"),
    fpsText: $("fpsText"),
    pointsValue: $("pointsValue"),

    indexServoMetric: $("indexServoMetric"),
    thumbServoMetric: $("thumbServoMetric"),

    connectButton: $("connectButton"),
    disconnectButton: $("disconnectButton"),

    usbStatus: $("usbStatus"),
    usbLabel: $("usbLabel"),
    usbIndicator: $("usbIndicator"),

    indexState: $("indexState"),
    indexBar: $("indexBar"),
    indexOpening: $("indexOpening"),
    indexServo: $("indexServo"),

    thumbState: $("thumbState"),
    thumbBar: $("thumbBar"),
    thumbOpening: $("thumbOpening"),
    thumbServo: $("thumbServo"),

    calibrationStatus: $("calibrationStatus"),

    captureClosed: $("captureClosedButton"),
    captureOpen: $("captureOpenButton"),

    closedText: $("closedText"),
    openText: $("openText"),

    closedMark: $("closedMark"),
    openMark: $("openMark"),

    resetCalibration: $("resetCalibrationButton"),

    slider: $("maxAngleSlider"),
    maxAngleLabel: $("maxAngleLabel"),

    toast: $("toast")
  };


  // ==========================================
  // ESTADO DO SISTEMA
  // ==========================================

  function createFingerObject(factory) {
    return Object.fromEntries(
      FINGER_KEYS.map(key => [key, factory(key)])
    );
  }

  const state = {
    detector: null,

    stream: null,
    cameraRunning: false,
    inferenceBusy: false,

    frameCallbackId: null,
    fallbackFrameId: null,
    lastFallbackVideoTime: -1,

    fpsSamples: [],

    latestRaw: null,

    history: createFingerObject(() => []),

    filteredOpening: createFingerObject(() => null),

    targets: createFingerObject(() => 0),

    calibration: loadCalibration(),

    maxOpenAngle: CONFIG.initialOpenAngle,

    lastFilterTime: null,

    port: null,
    writer: null,
    serialBusy: false,
    serialPending: false,
    serialTimer: null,

    lastSentValues: null,
    lastSerialTime: 0,

    toastTimer: null
  };


  // ==========================================
  // CALIBRAÇÃO
  // ==========================================

  function emptyCalibration() {
    return {
      closed: {
        index: null,
        thumb: null
      },

      open: {
        index: null,
        thumb: null
      }
    };
  }


  function loadCalibration() {

    try {

      const saved = JSON.parse(
        localStorage.getItem(CONFIG.calibrationKey)
      );

      if (!saved?.closed || !saved?.open) {
        return emptyCalibration();
      }

      const valid = FINGER_KEYS.every(key =>
        Number.isFinite(saved.closed[key]) &&
        Number.isFinite(saved.open[key])
      );

      return valid ? saved : emptyCalibration();

    } catch (error) {

      console.warn("Calibração indisponível:", error);

      return emptyCalibration();

    }
  }


  function saveCalibration() {

    try {

      localStorage.setItem(
        CONFIG.calibrationKey,
        JSON.stringify(state.calibration)
      );

    } catch (error) {

      console.warn("Falha ao salvar calibração:", error);

    }
  }


  function isCalibrated() {

    return FINGER_KEYS.every(key => {

      const closed = state.calibration.closed[key];
      const opened = state.calibration.open[key];

      if (
        !Number.isFinite(closed) ||
        !Number.isFinite(opened)
      ) {
        return false;
      }

      const range = Math.abs(opened - closed);

      return range >=
        FINGERS[key].minimumCalibrationRange;

    });

  }


  function median(values) {

    if (!values.length) return null;

    const sorted = [...values].sort((a, b) => a - b);

    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;

  }


  function capturePose(which) {

    if (!state.latestRaw) {

      toast("A câmera precisa reconhecer sua mão primeiro.");

      return;

    }

    const captured = {};

    for (const key of FINGER_KEYS) {

      captured[key] = median(state.history[key]);

      if (!Number.isFinite(captured[key])) {

        toast("Ainda não há amostras suficientes.");

        return;

      }

    }

    state.calibration[which] = captured;

    saveCalibration();

    state.filteredOpening = createFingerObject(() => null);

    state.lastFilterTime = null;

    updateCalibrationUI();

    if (
      state.calibration.closed.index !== null &&
      state.calibration.open.index !== null &&
      !isCalibrated()
    ) {

      toast(
        "Algum dedo mudou pouco entre as capturas. Repita com a mão bem fechada e depois bem aberta.",
        5500
      );

    } else {

      toast(
        which === "closed"
          ? "Referência de mão fechada registrada para os dois dedos."
          : "Referência de mão aberta registrada para os dois dedos."
      );

    }

  }


  function resetCalibration() {

    state.calibration = emptyCalibration();

    state.history = createFingerObject(() => []);

    state.filteredOpening = createFingerObject(() => null);

    state.lastFilterTime = null;

    localStorage.removeItem(CONFIG.calibrationKey);

    updateCalibrationUI();

    toast("Calibração dos dois dedos redefinida.");

  }


  function updateCalibrationUI() {

    const closedReady = FINGER_KEYS.every(
      key => Number.isFinite(state.calibration.closed[key])
    );

    const openReady = FINGER_KEYS.every(
      key => Number.isFinite(state.calibration.open[key])
    );

    const ready = isCalibrated();

    ui.closedText.textContent =
      closedReady ? "Dois dedos registrados" : "Aguardando captura";

    ui.openText.textContent =
      openReady ? "Dois dedos registrados" : "Aguardando captura";

    ui.closedMark.textContent = closedReady ? "✓" : "○";
    ui.openMark.textContent = openReady ? "✓" : "○";

    ui.captureClosed.classList.toggle("done", closedReady);
    ui.captureOpen.classList.toggle("done", openReady);

    ui.calibrationStatus.textContent =
      ready ? "CONCLUÍDA" :
      (closedReady && openReady ? "REFAZER" : "PENDENTE");

    ui.calibrationStatus.dataset.ready = String(ready);

    ui.captureClosed.disabled = !state.latestRaw;
    ui.captureOpen.disabled = !state.latestRaw;

    updateSystem();

  }


  // ==========================================
  // INTERFACE
  // ==========================================

  function toast(message, duration = 3500) {

    ui.toast.textContent = message;
    ui.toast.classList.add("show");

    clearTimeout(state.toastTimer);

    state.toastTimer = setTimeout(() => {
      ui.toast.classList.remove("show");
    }, duration);

  }


  function setSystem(kind, message) {

    ui.systemState.dataset.state = kind;
    ui.systemStateText.textContent = message;

  }


  function updateSystem() {

    if (
      state.cameraRunning &&
      state.writer &&
      isCalibrated()
    ) {

      setSystem("active", "CONTROLE ATIVO");

    } else if (
      state.cameraRunning ||
      state.writer
    ) {

      setSystem("ready", "SISTEMA PARCIALMENTE PRONTO");

    } else {

      setSystem("idle", "AGUARDANDO");

    }

  }


  function setCameraStatus(active, message) {

    ui.cameraStatus.dataset.active = String(active);

    ui.cameraStatusText.textContent = message;

  }


  function setUsbStatus(connected, message) {

    ui.usbStatus.textContent = message;

    ui.usbLabel.textContent =
      connected ? "ONLINE" : "OFFLINE";

    ui.usbLabel.dataset.connected = String(connected);

    ui.usbIndicator.dataset.connected = String(connected);

    ui.connectButton.classList.toggle("hidden", connected);
    ui.disconnectButton.classList.toggle("hidden", !connected);

    updateSystem();

  }


  function clamp(value, min, max) {

    return Math.max(min, Math.min(max, value));

  }


  // ==========================================
  // CÁLCULOS GEOMÉTRICOS
  // ==========================================

  function point(landmarks, index) {

    const p = landmarks[index];

    if (!p) {
      throw new Error(`Ponto ${index} ausente.`);
    }

    if (Array.isArray(p)) {

      return {
        x: Number(p[0]),
        y: Number(p[1])
      };

    }

    return {
      x: Number(p.x),
      y: Number(p.y)
    };

  }


  function distance(a, b) {

    return Math.hypot(
      a.x - b.x,
      a.y - b.y
    );

  }


  function angleAt(a, b, c) {

    const bax = a.x - b.x;
    const bay = a.y - b.y;

    const bcx = c.x - b.x;
    const bcy = c.y - b.y;

    const denominator =
      Math.hypot(bax, bay) *
      Math.hypot(bcx, bcy);

    if (!denominator) return 180;

    const cosine = clamp(
      (bax * bcx + bay * bcy) / denominator,
      -1,
      1
    );

    return Math.acos(cosine) * 180 / Math.PI;

  }


  // ==========================================
  // MEDIR INDICADOR
  // ==========================================

  function calculateIndex(landmarks) {

    const mcp = point(landmarks, 5);
    const pip = point(landmarks, 6);
    const dip = point(landmarks, 7);
    const tip = point(landmarks, 8);

    const pipAngle = angleAt(mcp, pip, dip);

    const dipAngle = angleAt(pip, dip, tip);

    return pipAngle * 0.72 + dipAngle * 0.28;

  }


  // ==========================================
  // MEDIR POLEGAR
  // ==========================================

  function calculateThumb(landmarks) {

    const thumbTip = point(landmarks, 4);

    const indexBase = point(landmarks, 5);

    const wrist = point(landmarks, 0);

    const middleBase = point(landmarks, 9);

    // Normaliza pela dimensão da palma.
    // Isso reduz a influência da distância da mão à câmera.

    const palmSize = distance(wrist, middleBase);

    if (palmSize < 0.0001) return 0;

    const thumbSpread = distance(
      thumbTip,
      indexBase
    );

    return thumbSpread / palmSize;

  }


  function calculateMetrics(landmarks) {

    if (
      !Array.isArray(landmarks) ||
      landmarks.length < 21
    ) {

      throw new Error("O detector não retornou os 21 pontos.");

    }

    return {
      index: calculateIndex(landmarks),
      thumb: calculateThumb(landmarks)
    };

  }


  // ==========================================
  // CALCULAR ABERTURA DOS DOIS DEDOS
  // ==========================================

  function calculateOpening(key, rawValue) {

    const closed = state.calibration.closed[key];

    const opened = state.calibration.open[key];

    const range = opened - closed;

    if (Math.abs(range) < 0.000001) return 0;

    return clamp(
      (rawValue - closed) / range,
      0,
      1
    );

  }


  function processMetrics(raw, timestamp) {

    state.latestRaw = raw;

    // Mantém uma pequena janela de amostras para calibração.
    for (const key of FINGER_KEYS) {

      const history = state.history[key];

      history.push(raw[key]);

      if (history.length > CONFIG.historySize) {
        history.shift();
      }

    }


    const calibrated = isCalibrated();

    const dt = state.lastFilterTime === null
      ? 0.04
      : clamp(
          (timestamp - state.lastFilterTime) / 1000,
          0.001,
          0.15
        );

    state.lastFilterTime = timestamp;

    const alpha = 1 - Math.exp(-dt / 0.075);


    for (const key of FINGER_KEYS) {

      let opening = 0;

      if (calibrated) {

        const measured = calculateOpening(key, raw[key]);

        const previous = state.filteredOpening[key];

        state.filteredOpening[key] =
          previous === null
            ? measured
            : previous + alpha * (measured - previous);

        opening = state.filteredOpening[key];

      } else {

        state.filteredOpening[key] = null;

      }


      const servoAngle = Math.round(
        clamp(opening, 0, 1) *
        state.maxOpenAngle
      );

      state.targets[key] = servoAngle;

      updateFinger(key, opening, servoAngle);

    }


    ui.pointsValue.innerHTML =
      `21 <em>/ 21</em>`;

    ui.indexServoMetric.innerHTML =
      `${state.targets.index}<em>°</em>`;

    ui.thumbServoMetric.innerHTML =
      `${state.targets.thumb}<em>°</em>`;

    updateCalibrationUI();

    if (calibrated) {
      scheduleSerialWrite();
    }

  }


  function updateFinger(key, opening, servoAngle) {

    const percent = Math.round(opening * 100);

    if (key === "index") {

      ui.indexBar.style.width = `${percent}%`;
      ui.indexOpening.textContent = `${percent}%`;
      ui.indexServo.textContent = `${servoAngle}°`;

      ui.indexState.textContent =
        percent >= 92 ? "ABERTO" :
        percent <= 8 ? "FECHADO" :
        "EM MOVIMENTO";

    } else {

      ui.thumbBar.style.width = `${percent}%`;
      ui.thumbOpening.textContent = `${percent}%`;
      ui.thumbServo.textContent = `${servoAngle}°`;

      ui.thumbState.textContent =
        percent >= 92 ? "ABERTO" :
        percent <= 8 ? "FECHADO" :
        "EM MOVIMENTO";

    }

  }


  // ==========================================
  // DESENHAR LANDMARKS
  // ==========================================

  function drawHand(landmarks) {

    const ctx = ui.canvas.getContext("2d");

    const width = ui.video.videoWidth;
    const height = ui.video.videoHeight;

    if (!width || !height) return;

    if (
      ui.canvas.width !== width ||
      ui.canvas.height !== height
    ) {

      ui.canvas.width = width;
      ui.canvas.height = height;

    }

    ctx.clearRect(0, 0, width, height);

    ctx.lineWidth = Math.max(2, width / 320);
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(195,241,120,.88)";

    for (const [from, to] of CONNECTIONS) {

      const a = point(landmarks, from);
      const b = point(landmarks, to);

      ctx.beginPath();

      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b.x * width, b.y * height);

      ctx.stroke();

    }

    const important = new Set([0, 4, 5, 6, 7, 8, 17]);

    for (let i = 0; i < 21; i++) {

      const p = point(landmarks, i);

      ctx.beginPath();

      ctx.arc(
        p.x * width,
        p.y * height,
        important.has(i) ? 4 : 2.7,
        0,
        Math.PI * 2
      );

      ctx.fillStyle = important.has(i)
        ? "#edffc4"
        : "#c3f178";

      ctx.fill();

    }

  }


  function clearCanvas() {

    const ctx = ui.canvas.getContext("2d");

    ctx.clearRect(
      0,
      0,
      ui.canvas.width,
      ui.canvas.height
    );

  }


  // ==========================================
  // DETECTOR WEBGPU
  // ==========================================

  async function loadDetector() {

    if (state.detector) return state.detector;

    if (!navigator.gpu) {

      throw new Error(
        "WebGPU não está disponível neste Chromebook. Verifique chrome://gpu."
      );

    }

    toast("Carregando rastreador WebGPU...", 6000);

    const module = await import(
      CONFIG.detectorUrl
    );

    if (typeof module.createHandpose !== "function") {

      throw new Error(
        "A função createHandpose não foi encontrada."
      );

    }

    state.detector = await module.createHandpose({
      maxHands: 1,
      scoreThreshold: 0.55,
      palmScoreThreshold: 0.55
    });

    return state.detector;

  }


  // ==========================================
  // TRANSMISSÃO USB — DOIS VALORES
  // ==========================================

  function currentPacketValues() {

    return [
      state.targets.index,
      state.targets.thumb
    ];

  }


  function valuesChanged(a, b) {

    if (!a || !b) return true;

    return a.some(
      (value, index) =>
        Math.abs(value - b[index]) >= CONFIG.minimumServoChange
    );

  }


  function scheduleSerialWrite() {

    if (
      !state.writer ||
      !isCalibrated()
    ) {
      return;
    }


    if (state.serialBusy) {

      state.serialPending = true;

      return;

    }


    const now = performance.now();

    const remaining =
      CONFIG.serialIntervalMs -
      (now - state.lastSerialTime);


    if (remaining > 0) {

      if (state.serialTimer === null) {

        state.serialTimer = setTimeout(() => {

          state.serialTimer = null;

          scheduleSerialWrite();

        }, remaining);

      }

      return;

    }


    const values = currentPacketValues();

    if (!valuesChanged(values, state.lastSentValues)) {
      return;
    }


    const writer = state.writer;

    const packet =
      `${values[0]},${values[1]}\n`;


    state.serialBusy = true;

    state.serialPending = false;

    state.lastSerialTime = now;


    writer.write(
      new TextEncoder().encode(packet)
    )

    .then(() => {

      if (state.writer === writer) {

        state.lastSentValues = [...values];

      }

    })

    .catch(async (error) => {

      console.error("Erro USB:", error);

      toast(`Falha na transmissão USB: ${error.message}`);

      await disconnectSerial();

    })

    .finally(() => {

      state.serialBusy = false;

      if (!state.writer) return;

      const latestValues = currentPacketValues();

      if (
        state.serialPending ||
        valuesChanged(latestValues, state.lastSentValues)
      ) {

        state.serialPending = false;

        scheduleSerialWrite();

      }

    });

  }


  // ==========================================
  // CONEXÃO ARDUINO
  // ==========================================

  async function connectSerial() {

    if (!("serial" in navigator)) {

      toast(
        "Web Serial não está disponível. Use Chrome em localhost.",
        5000
      );

      return;

    }

    ui.connectButton.disabled = true;

    let port = null;
    let writer = null;

    try {

      port = await navigator.serial.requestPort();

      await port.open({
        baudRate: CONFIG.baudRate
      });

      writer = port.writable.getWriter();

      await new Promise(resolve => setTimeout(resolve, 1200));

      state.port = port;
      state.writer = writer;

      state.lastSentValues = null;
      state.lastSerialTime = 0;

      setUsbStatus(
        true,
        "Arduino conectado · aguardando calibração"
      );

      toast(
        "Arduino conectado. Os dois dedos serão controlados após a calibração."
      );

      if (isCalibrated() && state.latestRaw) {
        scheduleSerialWrite();
      }

    } catch (error) {

      console.error("Conexão USB:", error);

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

      setUsbStatus(
        false,
        error.name === "NotFoundError"
          ? "Nenhuma porta selecionada"
          : "Falha na conexão USB"
      );

      if (error.name !== "NotFoundError") {
        toast(`Não foi possível conectar: ${error.message}`);
      }

    } finally {

      ui.connectButton.disabled = false;

    }

  }


  async function disconnectSerial() {

    if (state.serialTimer !== null) {
      clearTimeout(state.serialTimer);
      state.serialTimer = null;
    }

    const writer = state.writer;
    const port = state.port;

    state.writer = null;
    state.port = null;
    state.lastSentValues = null;

    state.serialPending = false;

    try {

      if (writer) {

        try {
          await writer.close();
        } catch (_) {

          try {
            writer.releaseLock();
          } catch (_) {}

        }

      }

      if (port) {

        try {
          await port.close();
        } catch (_) {}

      }

    } finally {

      setUsbStatus(
        false,
        "Nenhum dispositivo conectado"
      );

    }

  }


  // ==========================================
  // CÂMERA
  // ==========================================

  function requestNextFrame() {

    if (!state.cameraRunning) return;

    if (
      typeof ui.video.requestVideoFrameCallback === "function"
    ) {

      state.frameCallbackId =
        ui.video.requestVideoFrameCallback(onVideoFrame);

    } else {

      state.fallbackFrameId =
        requestAnimationFrame(onFallbackFrame);

    }

  }


  async function processFrame(timestamp) {

    if (
      !state.cameraRunning ||
      state.inferenceBusy ||
      ui.video.readyState < 2
    ) {
      return;
    }

    state.inferenceBusy = true;

    try {

      const hands = await state.detector.detect(ui.video);

      const hand = Array.isArray(hands) && hands.length
        ? hands.reduce(
            (best, current) =>
              (current.score ?? 0) > (best.score ?? 0)
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

        const raw = calculateMetrics(hand.landmarks);

        processMetrics(raw, performance.now());

        ui.trackingText.textContent = "HAND DETECTED";

        setCameraStatus(true, "MÃO DETECTADA");

      } else {

        clearCanvas();

        state.latestRaw = null;

        ui.trackingText.textContent = "HAND NOT FOUND";

        setCameraStatus(true, "CÂMERA ATIVA · SEM MÃO");

        ui.pointsValue.innerHTML = `— <em>/ 21</em>`;

        ui.indexState.textContent = "SEM DETECÇÃO";
        ui.thumbState.textContent = "SEM DETECÇÃO";

        updateCalibrationUI();

        // Sem mão: mantém os últimos comandos, não manda zero.
      }


      const now = performance.now();

      state.fpsSamples.push(now);

      state.fpsSamples = state.fpsSamples.filter(
        time => now - time < 1000
      );

      ui.fpsText.textContent =
        `${state.fpsSamples.length} FPS`;

    } catch (error) {

      console.error("Erro no rastreamento:", error);

      toast(`Erro no detector: ${error.message}`, 6000);

      stopCamera();

      return;

    } finally {

      state.inferenceBusy = false;

    }

    requestNextFrame();

  }


  function onVideoFrame(now) {
    processFrame(now);
  }


  function onFallbackFrame(now) {

    if (!state.cameraRunning) return;

    if (
      ui.video.currentTime !== state.lastFallbackVideoTime
    ) {

      state.lastFallbackVideoTime = ui.video.currentTime;

      processFrame(now);

    } else {

      requestNextFrame();

    }

  }


  async function startCamera() {

    if (state.cameraRunning) {

      stopCamera();

      return;

    }

    if (!navigator.mediaDevices?.getUserMedia) {

      toast("A câmera exige localhost ou HTTPS.");

      return;

    }

    ui.cameraButton.disabled = true;

    ui.cameraButton.textContent = "INICIALIZANDO...";

    try {

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

      await loadDetector();

      state.cameraRunning = true;

      state.fpsSamples = [];

      state.latestRaw = null;

      state.filteredOpening = createFingerObject(() => null);

      state.lastFilterTime = null;

      ui.placeholder.classList.add("hidden");

      ui.cameraButton.textContent = "PARAR CÂMERA";

      setCameraStatus(true, "CÂMERA ATIVA · PROCURANDO MÃO");

      updateCalibrationUI();

      requestNextFrame();

    } catch (error) {

      console.error(error);

      stopCamera();

      toast(
        `Não foi possível iniciar: ${error.message}`,
        6000
      );

    } finally {

      ui.cameraButton.disabled = false;

      if (!state.cameraRunning) {
        ui.cameraButton.textContent = "INICIAR CÂMERA";
      }

    }

  }


  function stopCamera() {

    state.cameraRunning = false;

    if (
      state.frameCallbackId !== null &&
      typeof ui.video.cancelVideoFrameCallback === "function"
    ) {

      ui.video.cancelVideoFrameCallback(state.frameCallbackId);

    }

    if (state.fallbackFrameId !== null) {

      cancelAnimationFrame(state.fallbackFrameId);

    }

    state.frameCallbackId = null;
    state.fallbackFrameId = null;

    if (state.stream) {

      state.stream.getTracks().forEach(track => track.stop());

      state.stream = null;

    }

    ui.video.srcObject = null;

    ui.placeholder.classList.remove("hidden");

    ui.cameraButton.textContent = "INICIAR CÂMERA";

    ui.fpsText.textContent = "— FPS";

    ui.pointsValue.innerHTML = `— <em>/ 21</em>`;

    ui.indexState.textContent = "AGUARDANDO DETECÇÃO";
    ui.thumbState.textContent = "AGUARDANDO DETECÇÃO";

    ui.indexBar.style.width = "0%";
    ui.thumbBar.style.width = "0%";

    setCameraStatus(false, "CÂMERA DESLIGADA");

    ui.trackingText.textContent = "NO TRACKING";

    state.latestRaw = null;

    clearCanvas();

    updateCalibrationUI();

  }


  // ==========================================
  // CONTROLE DO SLIDER
  // ==========================================

  function updateSlider() {

    state.maxOpenAngle = Number(ui.slider.value);

    ui.maxAngleLabel.textContent =
      `${state.maxOpenAngle}°`;

    const percent =
      (state.maxOpenAngle / CONFIG.maxOpenAngle) * 100;

    ui.slider.style.background =
      `linear-gradient(
        90deg,
        var(--accent) 0 ${percent}%,
        rgba(226,239,225,.13) ${percent}% 100%
      )`;


    if (
      isCalibrated() &&
      state.filteredOpening.index !== null
    ) {

      for (const key of FINGER_KEYS) {

        state.targets[key] = Math.round(
          state.filteredOpening[key] *
          state.maxOpenAngle
        );

      }

      ui.indexServo.textContent = `${state.targets.index}°`;
      ui.thumbServo.textContent = `${state.targets.thumb}°`;

      ui.indexServoMetric.innerHTML =
        `${state.targets.index}<em>°</em>`;

      ui.thumbServoMetric.innerHTML =
        `${state.targets.thumb}<em>°</em>`;

      scheduleSerialWrite();

    }

  }


  // ==========================================
  // RELÓGIO
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
  // EVENTOS
  // ==========================================

  function bindEvents() {

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

    ui.captureClosed.addEventListener(
      "click",
      () => capturePose("closed")
    );

    ui.captureOpen.addEventListener(
      "click",
      () => capturePose("open")
    );

    ui.resetCalibration.addEventListener(
      "click",
      resetCalibration
    );

    ui.slider.addEventListener(
      "input",
      updateSlider
    );

    window.addEventListener("beforeunload", () => {

      if (state.stream) {
        state.stream.getTracks().forEach(track => track.stop());
      }

    });

  }


  // ==========================================
  // INICIALIZAÇÃO
  // ==========================================

  function init() {

    const missing = Object.entries(ui)
      .filter(([, element]) => !element)
      .map(([id]) => id);

    if (missing.length) {

      console.error("IDs ausentes:", missing);

      toast(
        `Elementos ausentes no HTML: ${missing.join(", ")}`,
        7000
      );

      return;

    }

    bindEvents();

    updateClock();

    setInterval(updateClock, 1000);

    ui.slider.value = String(state.maxOpenAngle);

    updateSlider();

    setUsbStatus(false, "Nenhum dispositivo conectado");

    setCameraStatus(false, "CÂMERA DESLIGADA");

    updateCalibrationUI();

    console.info("KINETIC inicializado: indicador e polegar.");

  }


  function setUsbStatus(connected, message) {

    ui.usbStatus.textContent = message;

    ui.usbLabel.textContent =
      connected ? "ONLINE" : "OFFLINE";

    ui.usbLabel.dataset.connected = String(connected);

    ui.usbIndicator.dataset.connected = String(connected);

    ui.connectButton.classList.toggle("hidden", connected);

    ui.disconnectButton.classList.toggle("hidden", !connected);

    updateSystem();

  }


  init();

})();
