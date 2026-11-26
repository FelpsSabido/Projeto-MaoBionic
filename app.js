
(() => {

  "use strict";

  // ==========================================
  // KINETIC — INDICATOR ONLY
  // ==========================================

  const CONFIG = {

    detectorUrl:
      "https://cdn.jsdelivr.net/npm/@svenflow/micro-handpose@0.3.0/dist/index.js",

    baudRate: 9600,

    cameraWidth: 480,
    cameraHeight: 360,
    cameraFps: 30,

    // Suavização temporal em milissegundos.
    smoothingTimeMs: 85,

    // Frequência máxima de envio ao Arduino.
    serialIntervalMs: 45,

    // Ignora alterações muito pequenas.
    sendThreshold: 1.5,

    // Limite inicial e máximo.
    initialOpenAngle: 180,
    maxOpenAngle: 180,

    historySize: 15,

    calibrationKey: "kinetic-index-v5"

  };


  // ==========================================
  // ELEMENTOS
  // ==========================================

  const $ = (id) =>
    document.getElementById(id);


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

    openingValue: $("openingValue"),
    servoValue: $("servoValue"),

    connectButton: $("connectButton"),
    disconnectButton: $("disconnectButton"),

    usbStatus: $("usbStatus"),
    usbLabel: $("usbLabel"),
    usbIndicator: $("usbIndicator"),

    fingerState: $("fingerState"),
    openingBar: $("openingBar"),

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
  // CONEXÕES DA MÃO
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
  // ESTADO
  // ==========================================

  const state = {

    detector: null,

    stream: null,

    cameraRunning: false,
    inferenceBusy: false,

    frameCallbackId: null,
    fallbackFrameId: null,

    lastFallbackVideoTime: -1,

    fpsSamples: [],

    history: [],

    latestRawAngle: null,

    filteredOpening: null,

    latestServoTarget: 0,

    lastFilterTime: null,

    maxOpenAngle:
      CONFIG.initialOpenAngle,

    calibration:
      loadCalibration(),

    port: null,
    writer: null,

    serialBusy: false,
    serialPending: false,
    serialTimer: null,

    lastSentAngle: null,
    lastSerialTime: 0,

    toastTimer: null

  };


  // ==========================================
  // CALIBRAÇÃO
  // ==========================================

  function emptyCalibration() {

    return {
      closed: null,
      open: null
    };

  }


  function loadCalibration() {

    try {

      const saved = JSON.parse(
        localStorage.getItem(
          CONFIG.calibrationKey
        )
      );

      if (

        Number.isFinite(saved?.closed) &&
        Number.isFinite(saved?.open)

      ) {

        return saved;

      }

    } catch (error) {

      console.warn(
        "Não foi possível recuperar a calibração:",
        error
      );

    }

    return emptyCalibration();

  }


  function saveCalibration() {

    localStorage.setItem(
      CONFIG.calibrationKey,
      JSON.stringify(state.calibration)
    );

  }


  function isCalibrated() {

    if (

      !Number.isFinite(
        state.calibration.closed
      ) ||

      !Number.isFinite(
        state.calibration.open
      )

    ) {

      return false;

    }

    return Math.abs(
      state.calibration.open -
      state.calibration.closed
    ) >= 12;

  }


  function median(values) {

    if (!values.length) return null;

    const sorted = [...values].sort(
      (a, b) => a - b
    );

    const middle = Math.floor(
      sorted.length / 2
    );

    return sorted.length % 2
      ? sorted[middle]
      : (
          sorted[middle - 1] +
          sorted[middle]
        ) / 2;

  }


  function capturePose(which) {

    if (state.latestRawAngle === null) {

      toast(
        "Mantenha o indicador visível para capturar."
      );

      return;

    }


    const captured = median(
      state.history
    );


    if (!Number.isFinite(captured)) {

      toast(
        "Não há amostras suficientes."
      );

      return;

    }


    state.calibration[which] =
      captured;

    saveCalibration();


    state.filteredOpening = null;

    state.lastFilterTime = null;


    updateCalibrationUI();


    if (

      state.calibration.closed !== null &&
      state.calibration.open !== null &&
      !isCalibrated()

    ) {

      toast(
        "As posições estão muito próximas. Feche mais o dedo e tente novamente.",
        5000
      );

    } else {

      toast(
        which === "closed"
          ? "Posição fechada registrada."
          : "Posição aberta registrada."
      );

    }

  }


  function resetCalibration() {

    state.calibration =
      emptyCalibration();

    state.history = [];

    state.filteredOpening = null;

    state.lastFilterTime = null;

    localStorage.removeItem(
      CONFIG.calibrationKey
    );


    updateCalibrationUI();

    toast("Calibração redefinida.");

  }


  function updateCalibrationUI() {

    const closed =
      Number.isFinite(
        state.calibration.closed
      );

    const opened =
      Number.isFinite(
        state.calibration.open
      );

    const ready = isCalibrated();


    ui.closedText.textContent =
      closed
        ? "Captura registrada"
        : "Aguardando captura";


    ui.openText.textContent =
      opened
        ? "Captura registrada"
        : "Aguardando captura";


    ui.closedMark.textContent =
      closed ? "✓" : "○";

    ui.openMark.textContent =
      opened ? "✓" : "○";


    ui.captureClosed.classList.toggle(
      "done",
      closed
    );

    ui.captureOpen.classList.toggle(
      "done",
      opened
    );


    ui.calibrationStatus.textContent =
      ready
        ? "CONCLUÍDA"
        : (
            closed && opened
              ? "REFAZER"
              : "PENDENTE"
          );


    ui.calibrationStatus.dataset.ready =
      String(ready);


    ui.captureClosed.disabled =
      state.latestRawAngle === null;

    ui.captureOpen.disabled =
      state.latestRawAngle === null;


    updateSystem();

  }


  // ==========================================
  // INTERFACE
  // ==========================================

  function toast(message, duration = 3500) {

    ui.toast.textContent = message;

    ui.toast.classList.add("show");

    clearTimeout(state.toastTimer);

    state.toastTimer = setTimeout(
      () => ui.toast.classList.remove("show"),
      duration
    );

  }


  function setSystem(kind, message) {

    ui.systemState.dataset.state =
      kind;

    ui.systemStateText.textContent =
      message;

  }


  function updateSystem() {

    if (

      state.cameraRunning &&
      state.writer &&
      isCalibrated()

    ) {

      setSystem(
        "active",
        "CONTROLE ATIVO"
      );

    } else if (

      state.cameraRunning ||
      state.writer

    ) {

      setSystem(
        "ready",
        "SISTEMA PARCIALMENTE PRONTO"
      );

    } else {

      setSystem(
        "idle",
        "AGUARDANDO"
      );

    }

  }


  function setCameraStatus(active, message) {

    ui.cameraStatus.dataset.active =
      String(active);

    ui.cameraStatusText.textContent =
      message;

  }


  function setUsbStatus(connected, message) {

    ui.usbStatus.textContent =
      message;

    ui.usbLabel.textContent =
      connected ? "ONLINE" : "OFFLINE";

    ui.usbLabel.dataset.connected =
      String(connected);

    ui.usbIndicator.dataset.connected =
      String(connected);


    ui.connectButton.classList.toggle(
      "hidden",
      connected
    );

    ui.disconnectButton.classList.toggle(
      "hidden",
      !connected
    );


    updateSystem();

  }


  function clamp(value, min, max) {

    return Math.max(
      min,
      Math.min(max, value)
    );

  }


  // ==========================================
  // CÁLCULO DO INDICADOR
  // ==========================================

  function point(landmarks, index) {

    const p = landmarks[index];

    if (!p) {

      throw new Error(
        `Ponto ${index} ausente.`
      );

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


  function calculateAngle(a, b, c) {

    const bax = a.x - b.x;
    const bay = a.y - b.y;

    const bcx = c.x - b.x;
    const bcy = c.y - b.y;


    const denominator =

      Math.hypot(bax, bay) *
      Math.hypot(bcx, bcy);


    if (!denominator) return 180;


    const cosine = clamp(

      (
        bax * bcx +
        bay * bcy
      ) / denominator,

      -1,
      1

    );


    return Math.acos(cosine) *
      180 / Math.PI;

  }


  function calculateIndexAngle(landmarks) {

    if (
      !Array.isArray(landmarks) ||
      landmarks.length < 21
    ) {

      throw new Error(
        "O detector não retornou os 21 pontos."
      );

    }


    // 5 = base do indicador
    // 6 = articulação central
    // 7 = articulação distal
    // 8 = ponta do indicador

    const mcp = point(landmarks, 5);
    const pip = point(landmarks, 6);
    const dip = point(landmarks, 7);
    const tip = point(landmarks, 8);


    const pipAngle = calculateAngle(
      mcp,
      pip,
      dip
    );


    const dipAngle = calculateAngle(
      pip,
      dip,
      tip
    );


    return (
      pipAngle * 0.72 +
      dipAngle * 0.28
    );

  }


  // ==========================================
  // CONVERTER ABERTURA EM ÂNGULO
  // ==========================================

  function calculateOpening(rawAngle) {

    const closed =
      state.calibration.closed;

    const opened =
      state.calibration.open;

    const range =
      opened - closed;


    if (!isCalibrated()) return 0;


    return clamp(
      (rawAngle - closed) / range,
      0,
      1
    );

  }


  function calculateServoTarget(opening) {

    return Math.round(
      clamp(opening, 0, 1) *
      state.maxOpenAngle
    );

  }


  // ==========================================
  // FILTRO TEMPORAL
  // ==========================================

  function processMovement(rawAngle, timestamp) {

    state.latestRawAngle =
      rawAngle;


    // Mantém uma janela curta de leituras
    // para que a calibração use valores estáveis.

    state.history.push(rawAngle);

    if (
      state.history.length >
      CONFIG.historySize
    ) {

      state.history.shift();

    }


    if (!isCalibrated()) {

      ui.openingValue.innerHTML =
        `0<em>%</em>`;

      ui.servoValue.innerHTML =
        `0<em>°</em>`;

      ui.openingBar.style.width =
        "0%";

      updateCalibrationUI();

      return;

    }


    const opening =
      calculateOpening(rawAngle);


    // Delta de tempo real entre inferências.

    const dt = state.lastFilterTime === null

      ? 0.04

      : clamp(
          (timestamp - state.lastFilterTime) / 1000,
          0.005,
          0.20
        );


    state.lastFilterTime =
      timestamp;


    // Filtro exponencial independente do FPS.
    // 85 ms oferece resposta rápida com redução de ruído.

    const alpha =

      1 - Math.exp(
        -dt /
        (CONFIG.smoothingTimeMs / 1000)
      );


    if (state.filteredOpening === null) {

      state.filteredOpening =
        opening;

    } else {

      state.filteredOpening +=
        alpha *
        (opening - state.filteredOpening);

    }


    const servoTarget =
      calculateServoTarget(
        state.filteredOpening
      );


    state.latestServoTarget =
      servoTarget;


    updateReadouts(
      state.filteredOpening,
      servoTarget
    );


    scheduleSerialSend();

  }


  // ==========================================
  // ATUALIZAR INTERFACE
  // ==========================================

  function updateReadouts(opening, servoAngle) {

    const percentage =
      Math.round(opening * 100);


    ui.openingValue.innerHTML =
      `${percentage}<em>%</em>`;

    ui.servoValue.innerHTML =
      `${servoAngle}<em>°</em>`;


    ui.openingBar.style.width =
      `${percentage}%`;


    ui.fingerState.textContent =

      percentage >= 92
        ? "ABERTO"
        : percentage <= 8
          ? "FECHADO"
          : "EM MOVIMENTO";

  }


  // ==========================================
  // DESENHAR LANDMARKS
  // ==========================================

  function drawHand(landmarks) {

    const ctx =
      ui.canvas.getContext("2d");

    const width =
      ui.video.videoWidth;

    const height =
      ui.video.videoHeight;


    if (!width || !height) return;


    if (

      ui.canvas.width !== width ||
      ui.canvas.height !== height

    ) {

      ui.canvas.width = width;
      ui.canvas.height = height;

    }


    ctx.clearRect(
      0,
      0,
      width,
      height
    );


    ctx.lineWidth =
      Math.max(2, width / 320);

    ctx.lineCap = "round";

    ctx.strokeStyle =
      "rgba(195,241,120,.88)";


    for (const [from, to] of CONNECTIONS) {

      const a = point(landmarks, from);
      const b = point(landmarks, to);


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


    const important =
      new Set([0, 5, 6, 7, 8, 17]);


    for (let i = 0; i < 21; i++) {

      const p =
        point(landmarks, i);


      ctx.beginPath();

      ctx.arc(
        p.x * width,
        p.y * height,
        important.has(i) ? 4 : 2.7,
        0,
        Math.PI * 2
      );


      ctx.fillStyle =
        important.has(i)
          ? "#edffc4"
          : "#c3f178";


      ctx.fill();

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
  // CARREGAR DETECTOR
  // ==========================================

  async function loadDetector() {

    if (state.detector) {
      return state.detector;
    }


    if (!navigator.gpu) {

      throw new Error(
        "WebGPU não está disponível. Verifique chrome://gpu."
      );

    }


    toast(
      "Carregando detector de mão...",
      6000
    );


    const module = await import(
      CONFIG.detectorUrl
    );


    if (
      typeof module.createHandpose !== "function"
    ) {

      throw new Error(
        "Não foi possível localizar createHandpose."
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
  // TRANSMISSÃO SERIAL
  // ==========================================

  function scheduleSerialSend() {

    if (
      !state.writer ||
      !isCalibrated()
    ) {

      return;

    }


    // Atualiza o destino pendente para o valor mais recente.

    state.serialPending = true;


    if (
      state.serialBusy ||
      state.serialTimer !== null
    ) {

      return;

    }


    const elapsed =
      performance.now() -
      state.lastSerialTime;


    const delay = Math.max(
      0,
      CONFIG.serialIntervalMs - elapsed
    );


    state.serialTimer = setTimeout(
      flushSerial,
      delay
    );

  }


  async function flushSerial() {

    state.serialTimer = null;


    if (
      !state.writer ||
      !state.serialPending ||
      state.serialBusy
    ) {

      return;

    }


    state.serialPending = false;


    const angle =
      state.latestServoTarget;


    // Evita enviar alterações muito pequenas.
    if (

      state.lastSentAngle !== null &&
      Math.abs(
        angle - state.lastSentAngle
      ) < CONFIG.sendThreshold

    ) {

      return;

    }


    const writerAtStart =
      state.writer;


    state.serialBusy = true;

    state.lastSerialTime =
      performance.now();


    try {

      // Somente um valor.
      // Exemplo: 85\n

      await writerAtStart.write(
        new TextEncoder().encode(
          `${angle}\n`
        )
      );


      if (
        state.writer === writerAtStart
      ) {

        state.lastSentAngle =
          angle;

      }


    } catch (error) {

      console.error(
        "Erro na transmissão USB:",
        error
      );


      toast(
        `Erro na comunicação USB: ${error.message}`
      );


      await disconnectSerial();


    } finally {

      state.serialBusy = false;


      // Se o movimento mudou durante a transmissão,
      // envia o último valor, não todos os antigos.

      if (
        state.serialPending &&
        state.writer
      ) {

        scheduleSerialSend();

      }

    }

  }


  // ==========================================
  // CONECTAR ARDUINO
  // ==========================================

  async function connectSerial() {

    if (!navigator.serial) {

      toast(
        "Web Serial não disponível. Abra pelo Chrome em localhost.",
        5500
      );

      return;

    }


    ui.connectButton.disabled =
      true;


    let port = null;
    let writer = null;


    try {

      port =
        await navigator.serial.requestPort();


      await port.open({
        baudRate: CONFIG.baudRate
      });


      writer =
        port.writable.getWriter();


      // Permite que o Arduino reinicie.

      await new Promise(
        resolve => setTimeout(resolve, 1200)
      );


      state.port = port;

      state.writer = writer;

      state.lastSentAngle = null;

      state.lastSerialTime = 0;


      setUsbStatus(
        true,
        "Arduino conectado"
      );


      toast(
        "Arduino conectado. Aguardando comandos de movimento."
      );


      if (
        isCalibrated() &&
        state.latestRawAngle !== null
      ) {

        scheduleSerialSend();

      }


    } catch (error) {

      console.error(
        "Erro USB:",
        error
      );


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
        "Falha ao conectar"
      );


      if (
        error.name !== "NotFoundError"
      ) {

        toast(
          `Não foi possível conectar: ${error.message}`
        );

      }

    } finally {

      ui.connectButton.disabled =
        false;

    }

  }


  // ==========================================
  // DESCONECTAR ARDUINO
  // ==========================================

  async function disconnectSerial() {

    if (state.serialTimer !== null) {

      clearTimeout(state.serialTimer);

      state.serialTimer = null;

    }


    const writer =
      state.writer;

    const port =
      state.port;


    state.writer = null;

    state.port = null;

    state.serialPending = false;

    state.lastSentAngle = null;


    try {

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

      setUsbStatus(
        false,
        "Nenhum dispositivo conectado"
      );

    }

  }


  function setUsbStatus(connected, message) {

    ui.usbStatus.textContent =
      message;

    ui.usbLabel.textContent =
      connected ? "ONLINE" : "OFFLINE";

    ui.usbLabel.dataset.connected =
      String(connected);

    ui.usbIndicator.dataset.connected =
      String(connected);


    ui.connectButton.classList.toggle(
      "hidden",
      connected
    );

    ui.disconnectButton.classList.toggle(
      "hidden",
      !connected
    );


    updateSystem();

  }


  // ==========================================
  // LOOP DE CÂMERA
  // ==========================================

  function requestNextFrame() {

    if (!state.cameraRunning) {
      return;
    }


    if (
      typeof ui.video.requestVideoFrameCallback === "function"
    ) {

      state.frameCallbackId =
        ui.video.requestVideoFrameCallback(
          onVideoFrame
        );

    } else {

      state.fallbackFrameId =
        requestAnimationFrame(
          onFallbackFrame
        );

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

        drawHand(
          hand.landmarks
        );


        const rawAngle =
          calculateIndexAngle(
            hand.landmarks
          );


        processMovement(
          rawAngle,
          performance.now()
        );


        ui.pointsValue.innerHTML =
          `21 <em>/ 21</em>`;


        ui.trackingText.textContent =
          "HAND DETECTED";


        setCameraStatus(
          true,
          "MÃO DETECTADA"
        );


      } else {

        clearCanvas();

        state.latestRawAngle = null;

        ui.pointsValue.innerHTML =
          `— <em>/ 21</em>`;

        ui.fingerState.textContent =
          "SEM DETECÇÃO";

        ui.trackingText.textContent =
          "HAND NOT FOUND";


        setCameraStatus(
          true,
          "CÂMERA ATIVA · SEM MÃO"
        );


        updateCalibrationUI();

        // Mantém o último comando do servo.
        // Não envia zero apenas por perder a mão.

      }


      // FPS real de inferência.
      const now = performance.now();

      state.fpsSamples.push(now);

      state.fpsSamples =
        state.fpsSamples.filter(
          time => now - time < 1000
        );


      ui.fpsText.textContent =
        `${state.fpsSamples.length} FPS`;


    } catch (error) {

      console.error(
        "Erro no detector:",
        error
      );


      toast(
        `Falha no rastreamento: ${error.message}`,
        6000
      );


      stopCamera();

      return;

    } finally {

      state.inferenceBusy = false;

    }


    requestNextFrame();

  }


  function onVideoFrame(timestamp) {

    processFrame(timestamp);

  }


  function onFallbackFrame(timestamp) {

    if (!state.cameraRunning) {
      return;
    }


    if (
      ui.video.currentTime !==
      state.lastFallbackVideoTime
    ) {

      state.lastFallbackVideoTime =
        ui.video.currentTime;

      processFrame(timestamp);

    } else {

      requestNextFrame();

    }

  }


  // ==========================================
  // INICIAR CÂMERA
  // ==========================================

  async function startCamera() {

    if (state.cameraRunning) {

      stopCamera();

      return;

    }


    if (
      !navigator.mediaDevices?.getUserMedia
    ) {

      toast(
        "A câmera exige localhost ou HTTPS."
      );

      return;

    }


    ui.cameraButton.disabled =
      true;

    ui.cameraButton.textContent =
      "INICIALIZANDO...";


    try {

      state.stream =
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
              ideal: CONFIG.cameraFps,
              max: CONFIG.cameraFps
            },

            facingMode: "user"

          }

        });


      ui.video.srcObject =
        state.stream;


      await ui.video.play();


      await loadDetector();


      state.cameraRunning =
        true;


      state.history = [];

      state.filteredOpening = null;

      state.lastFilterTime = null;

      state.fpsSamples = [];


      ui.placeholder.classList.add(
        "hidden"
      );


      ui.cameraButton.textContent =
        "PARAR CÂMERA";


      setCameraStatus(
        true,
        "CÂMERA ATIVA"
      );


      updateCalibrationUI();

      requestNextFrame();


    } catch (error) {

      console.error(
        "Erro ao iniciar câmera:",
        error
      );


      stopCamera();


      toast(
        `Não foi possível iniciar: ${error.message}`,
        6000
      );


    } finally {

      ui.cameraButton.disabled =
        false;


      if (!state.cameraRunning) {

        ui.cameraButton.textContent =
          "INICIAR CÂMERA";

      }

    }

  }


  // ==========================================
  // PARAR CÂMERA
  // ==========================================

  function stopCamera() {

    state.cameraRunning = false;


    if (

      state.frameCallbackId !== null &&
      typeof ui.video.cancelVideoFrameCallback === "function"

    ) {

      ui.video.cancelVideoFrameCallback(
        state.frameCallbackId
      );

    }


    if (
      state.fallbackFrameId !== null
    ) {

      cancelAnimationFrame(
        state.fallbackFrameId
      );

    }


    state.frameCallbackId = null;

    state.fallbackFrameId = null;


    if (state.stream) {

      state.stream
        .getTracks()
        .forEach(track => track.stop());

      state.stream = null;

    }


    ui.video.srcObject = null;


    ui.placeholder.classList.remove(
      "hidden"
    );


    ui.cameraButton.textContent =
      "INICIAR CÂMERA";


    ui.fpsText.textContent =
      "— FPS";

    ui.pointsValue.innerHTML =
      `— <em>/ 21</em>`;

    ui.openingValue.innerHTML =
      `—<em>%</em>`;

    ui.servoValue.innerHTML =
      `—<em>°</em>`;

    ui.openingBar.style.width =
      "0%";

    ui.fingerState.textContent =
      "AGUARDANDO DETECÇÃO";

    ui.trackingText.textContent =
      "NO TRACKING";


    setCameraStatus(
      false,
      "CÂMERA DESLIGADA"
    );


    state.latestRawAngle = null;

    clearCanvas();

    updateCalibrationUI();

  }


  // ==========================================
  // SLIDER
  // ==========================================

  function updateSlider() {

    state.maxOpenAngle =
      Number(ui.slider.value);


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
      state.filteredOpening !== null &&
      isCalibrated()
    ) {

      state.latestServoTarget =
        Math.round(
          state.filteredOpening *
          state.maxOpenAngle
        );


      updateReadouts(
        state.filteredOpening,
        state.latestServoTarget
      );


      scheduleSerialSend();

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


    window.addEventListener(
      "beforeunload",
      () => {

        if (state.stream) {

          state.stream
            .getTracks()
            .forEach(track => track.stop());

        }

      }
    );

  }


  // ==========================================
  // INICIALIZAÇÃO
  // ==========================================

  function init() {

    const missing =
      Object.entries(ui)
        .filter(([, element]) => !element)
        .map(([id]) => id);


    if (missing.length) {

      console.error(
        "Elementos ausentes:",
        missing
      );

      toast(
        `Erro na interface: ${missing.join(", ")}`,
        7000
      );

      return;

    }


    bindEvents();

    updateClock();

    setInterval(
      updateClock,
      1000
    );


    ui.slider.value =
      String(state.maxOpenAngle);


    updateSlider();


    setUsbStatus(
      false,
      "Nenhum dispositivo conectado"
    );


    setCameraStatus(
      false,
      "CÂMERA DESLIGADA"
    );


    updateCalibrationUI();


    console.info(
      "KINETIC iniciado: somente indicador."
    );

  }


  // ==========================================
  // STATUS USB
  // ==========================================

  function setUsbStatus(connected, message) {

    ui.usbStatus.textContent = message;

    ui.usbLabel.textContent =
      connected ? "ONLINE" : "OFFLINE";

    ui.usbLabel.dataset.connected =
      String(connected);

    ui.usbIndicator.dataset.connected =
      String(connected);


    ui.connectButton.classList.toggle(
      "hidden",
      connected
    );

    ui.disconnectButton.classList.toggle(
      "hidden",
      !connected
    );


    updateSystem();

  }


  init();

})();
