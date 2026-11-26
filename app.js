
(() => {
  "use strict";

  // KINETIC — um canal ativo: indicador.
  // Serial: um inteiro seguido de newline. Exemplo: 63\n.

  const CONFIG = {
    detectorUrl:
      "https://cdn.jsdelivr.net/npm/@svenflow/micro-handpose@0.3.0/dist/index.js",

    baudRate: 9600,

    cameraWidth: 480,
    cameraHeight: 360,
    cameraFps: 30,

    // Filtro temporal de resposta.
    smoothingTimeMs: 75,

    // Intervalo mínimo entre transmissões.
    serialIntervalMs: 35,

    minimumServoChange: 1,

    maxOpenAngle: 180,
    minOpenAngle: 10,
    maxAllowedAngle: 180,

    historySize: 15,

    calibrationKey: "kinetic-indicator-calibration-v3"
  };


  // ==========================================
  // ELEMENTOS DA INTERFACE
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
  // ESTADO DO SISTEMA
  // ==========================================

  const state = {
    detector: null,

    stream: null,

    cameraRunning: false,
    inferenceBusy: false,

    frameCallbackId: null,
    fallbackFrameId: null,

    lastFallbackVideoTime: -1,
    lastInferenceTime: 0,

    fpsIntervals: [],
    lastFrameTimestamp: null,

    history: [],

    latestRawAngle: null,
    filteredOpening: null,
    latestServoTarget: 0,

    maxOpenAngle: CONFIG.maxOpenAngle,

    calibration: loadCalibration(),

    port: null,
    writer: null,

    serialBusy: false,
    lastSentAngle: null,
    lastSerialTime: 0,

    toastTimer: null
  };


  // ==========================================
  // CALIBRAÇÃO
  // ==========================================

  function loadCalibration() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(CONFIG.calibrationKey)
      );

      if (
        Number.isFinite(saved?.closed) &&
        Number.isFinite(saved?.open)
      ) {
        return saved;
      }

    } catch (error) {
      console.warn("Calibração local indisponível:", error);
    }

    return {
      closed: null,
      open: null
    };
  }


  function saveCalibration() {
    try {
      localStorage.setItem(
        CONFIG.calibrationKey,
        JSON.stringify(state.calibration)
      );

    } catch (error) {
      console.warn(
        "Não foi possível salvar a calibração:",
        error
      );
    }
  }


  function isCalibrated() {
    return (
      Number.isFinite(state.calibration.closed) &&
      Number.isFinite(state.calibration.open) &&
      Math.abs(
        state.calibration.open -
        state.calibration.closed
      ) >= 12
    );
  }


  function updateCalibrationUI() {
    const closed = Number.isFinite(
      state.calibration.closed
    );

    const opened = Number.isFinite(
      state.calibration.open
    );

    const ready = isCalibrated();


    ui.closedText.textContent = closed
      ? "Captura registrada"
      : "Aguardando captura";

    ui.openText.textContent = opened
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


    ui.calibrationStatus.textContent = ready
      ? "CONCLUÍDA"
      : (closed && opened ? "REFAZER" : "PENDENTE");


    ui.calibrationStatus.dataset.ready =
      String(ready);


    ui.captureClosed.disabled =
      state.latestRawAngle === null;

    ui.captureOpen.disabled =
      state.latestRawAngle === null;


    updateSystem();
  }


  function capturePose(which) {

    if (state.latestRawAngle === null) {
      toast(
        "Mantenha o indicador visível para registrar a posição."
      );
      return;
    }

    const value = median(state.history);

    if (!Number.isFinite(value)) {
      toast(
        "Aguarde a câmera detectar o indicador."
      );
      return;
    }

    state.calibration[which] = value;

    saveCalibration();

    updateCalibrationUI();


    if (
      state.calibration.closed !== null &&
      state.calibration.open !== null &&
      !isCalibrated()
    ) {

      toast(
        "As capturas ficaram muito próximas. Repita com o dedo bem fechado e depois bem estendido.",
        5000
      );

    } else {

      toast(
        which === "closed"
          ? "Referência de dedo fechado salva."
          : "Referência de dedo estendido salva."
      );

    }


    state.filteredOpening = null;

    updateServoTarget(
      state.latestRawAngle,
      performance.now()
    );

  }


  function resetCalibration() {

    state.calibration = {
      closed: null,
      open: null
    };

    state.history = [];

    state.filteredOpening = null;

    localStorage.removeItem(
      CONFIG.calibrationKey
    );

    updateCalibrationUI();

    toast("Calibração redefinida.");

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
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }


  // ==========================================
  // INTERFACE E STATUS
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


  function setSystem(kind, text) {

    ui.systemState.dataset.state = kind;

    ui.systemStateText.textContent = text;

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


  function setCameraStatus(active, text) {

    ui.cameraStatus.dataset.active =
      String(active);

    ui.cameraStatusText.textContent = text;

  }


  function setUsbStatus(connected, text) {

    ui.usbStatus.textContent = text;

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
  // CÁLCULO DOS ÂNGULOS
  // ==========================================

  function point(landmarks, index) {

    const p = landmarks[index];

    if (!p) {
      throw new Error(
        `Ponto ${index} ausente no detector.`
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


  function calculateIndexAngle(landmarks) {

    if (
      !Array.isArray(landmarks) ||
      landmarks.length < 21
    ) {

      throw new Error(
        "O detector não retornou os 21 pontos da mão."
      );

    }

    // Pontos do indicador:
    // 5 = base
    // 6 = articulação central
    // 7 = articulação distal
    // 8 = ponta

    const mcp = point(landmarks, 5);
    const pip = point(landmarks, 6);
    const dip = point(landmarks, 7);
    const tip = point(landmarks, 8);

    const pipAngle = angleAt(
      mcp,
      pip,
      dip
    );

    const dipAngle = angleAt(
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
  // SUAVIZAÇÃO E CONVERSÃO
  // ==========================================

  function updateServoTarget(rawAngle, now) {

    state.latestRawAngle = rawAngle;

    state.history.push(rawAngle);

    if (
      state.history.length > CONFIG.historySize
    ) {
      state.history.shift();
    }


    if (!isCalibrated()) {

      state.latestServoTarget = 0;

      updateReadouts(0, 0);

      updateCalibrationUI();

      return;

    }


    const closed =
      state.calibration.closed;

    const open =
      state.calibration.open;

    const span = open - closed;


    // Conversão linear da leitura para 0–100%.
    const opening = clamp(
      (rawAngle - closed) / span,
      0,
      1
    );


    // Filtro temporal:
    // o comportamento não depende de uma quantidade fixa de quadros.
    const dt = state.lastInferenceTime
      ? clamp(
          (now - state.lastInferenceTime) / 1000,
          0.001,
          0.15
        )
      : 0.04;


    const alpha =
      1 - Math.exp(
        -dt / (CONFIG.smoothingTimeMs / 1000)
      );


    state.filteredOpening =
      state.filteredOpening === null
        ? opening
        : state.filteredOpening +
          alpha * (opening - state.filteredOpening);


    state.lastInferenceTime = now;


    // Mão fechada = 0°.
    // Mão aberta = limite escolhido no site.
    const target = Math.round(
      state.filteredOpening *
      state.maxOpenAngle
    );


    state.latestServoTarget = clamp(
      target,
      0,
      CONFIG.maxAllowedAngle
    );


    updateReadouts(
      state.filteredOpening,
      state.latestServoTarget
    );


    scheduleSerialWrite();

    updateCalibrationUI();

  }


  function updateReadouts(opening, servoAngle) {

    const percent = Math.round(
      opening * 100
    );

    ui.openingValue.innerHTML =
      `${percent}<em>%</em>`;

    ui.servoValue.innerHTML =
      `${servoAngle}<em>°</em>`;

    ui.openingBar.style.width =
      `${percent}%`;

    ui.fingerState.textContent =
      percent >= 92
        ? "ABERTO"
        : percent <= 8
          ? "FECHADO"
          : "EM MOVIMENTO";

  }


  // ==========================================
  // DESENHO DOS 21 LANDMARKS
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

    ctx.lineWidth = Math.max(
      2,
      width / 320
    );

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


    for (let i = 0; i < 21; i++) {

      const p = point(landmarks, i);

      const important =
        [0, 5, 6, 7, 8, 17].includes(i);

      ctx.beginPath();

      ctx.arc(
        p.x * width,
        p.y * height,
        important ? 4 : 2.7,
        0,
        Math.PI * 2
      );

      ctx.fillStyle = important
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
  // DETECTOR WEBGPU
  // ==========================================

  async function loadDetector() {

    if (state.detector) {
      return state.detector;
    }


    if (!navigator.gpu) {

      throw new Error(
        "WebGPU não está disponível neste Chromebook/Chrome. Confira chrome://gpu."
      );

    }


    toast(
      "Carregando detector WebGPU pela primeira vez…",
      6000
    );


    const mod = await import(
      CONFIG.detectorUrl
    );


    if (
      typeof mod.createHandpose !== "function"
    ) {

      throw new Error(
        "A biblioteca carregou, mas createHandpose não foi encontrado."
      );

    }


    state.detector =
      await mod.createHandpose({

        maxHands: 1,

        scoreThreshold: 0.55,

        palmScoreThreshold: 0.55

      });


    return state.detector;

  }


  // ==========================================
  // PROCESSAR DETECÇÃO
  // ==========================================

  function processDetection(hands, timestamp) {

    const hand =
      Array.isArray(hands) && hands.length

        ? hands.reduce(
            (best, current) =>
              current.score > best.score
                ? current
                : best
          )

        : null;


    if (
      !hand ||
      !Array.isArray(hand.landmarks) ||
      hand.landmarks.length < 21
    ) {

      clearCanvas();

      ui.trackingText.textContent =
        "HAND NOT FOUND";

      setCameraStatus(
        true,
        "CÂMERA ATIVA · SEM MÃO"
      );

      ui.pointsValue.innerHTML =
        `— <em>/ 21</em>`;

      ui.fingerState.textContent =
        "SEM DETECÇÃO";

      state.latestRawAngle = null;

      updateCalibrationUI();

      return;

    }


    drawHand(hand.landmarks);


    const rawAngle =
      calculateIndexAngle(hand.landmarks);


    ui.pointsValue.innerHTML =
      `21 <em>/ 21</em>`;

    ui.trackingText.textContent =
      "HAND DETECTED";

    setCameraStatus(
      true,
      "MÃO DETECTADA"
    );


    updateServoTarget(
      rawAngle,
      timestamp
    );

  }


  // ==========================================
  // SINCRONIZAÇÃO COM A CÂMERA
  // ==========================================

  // Solicitamos o próximo quadro somente depois de terminar
  // o processamento atual. Assim não acumulamos quadros atrasados.

  function requestNextFrame() {

    if (!state.cameraRunning) return;


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


  async function runInference(timestamp) {

    if (
      !state.cameraRunning ||
      state.inferenceBusy ||
      ui.video.readyState < 2
    ) {
      return;
    }


    state.inferenceBusy = true;


    try {

      // Uma única inferência em execução por vez.
      const hands =
        await state.detector.detect(
          ui.video
        );


      const end = performance.now();


      processDetection(
        hands,
        end
      );


      // FPS real entre quadros processados.
      if (state.lastFrameTimestamp !== null) {

        const interval =
          timestamp - state.lastFrameTimestamp;

        if (
          interval > 0 &&
          interval < 1000
        ) {

          state.fpsIntervals.push(interval);

          if (state.fpsIntervals.length > 12) {
            state.fpsIntervals.shift();
          }

        }

      }


      state.lastFrameTimestamp =
        timestamp;


      if (state.fpsIntervals.length) {

        const avgInterval =
          state.fpsIntervals.reduce(
            (sum, ms) => sum + ms,
            0
          ) / state.fpsIntervals.length;


        ui.fpsText.textContent =
          `${Math.round(1000 / avgInterval)} FPS`;

      }


    } catch (error) {

      console.error(
        "Erro de inferência:",
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


  function onVideoFrame(now) {

    runInference(now);

  }


  function onFallbackFrame(now) {

    if (!state.cameraRunning) return;


    if (
      ui.video.currentTime !==
      state.lastFallbackVideoTime
    ) {

      state.lastFallbackVideoTime =
        ui.video.currentTime;

      runInference(now);

    } else {

      state.fallbackFrameId =
        requestAnimationFrame(
          onFallbackFrame
        );

    }

  }


  // ==========================================
  // INICIAR E PARAR CÂMERA
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
        "A câmera exige localhost ou HTTPS.",
        5000
      );

      return;

    }


    ui.cameraButton.disabled = true;

    ui.cameraButton.textContent =
      "INICIALIZANDO…";


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


      state.cameraRunning = true;

      state.fpsIntervals = [];

      state.lastFrameTimestamp = null;

      state.lastInferenceTime = 0;

      state.filteredOpening = null;


      ui.placeholder.classList.add(
        "hidden"
      );


      ui.cameraButton.textContent =
        "PARAR CÂMERA";


      setCameraStatus(
        true,
        "CÂMERA ATIVA · PROCURANDO MÃO"
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
        `Não foi possível iniciar a câmera: ${error.message}`,
        6500
      );


    } finally {

      ui.cameraButton.disabled = false;

      if (!state.cameraRunning) {

        ui.cameraButton.textContent =
          "INICIAR CÂMERA";

      }

    }

  }


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


    if (state.fallbackFrameId !== null) {

      cancelAnimationFrame(
        state.fallbackFrameId
      );

    }


    state.frameCallbackId = null;
    state.fallbackFrameId = null;


    if (state.stream) {

      state.stream
        .getTracks()
        .forEach((track) => track.stop());

      state.stream = null;

    }


    ui.video.srcObject = null;


    ui.placeholder.classList.remove(
      "hidden"
    );


    ui.cameraButton.textContent =
      "INICIAR CÂMERA";


    ui.fpsText.textContent = "— FPS";

    ui.pointsValue.innerHTML =
      `— <em>/ 21</em>`;

    ui.openingValue.innerHTML =
      `—<em>%</em>`;

    ui.servoValue.innerHTML =
      `—<em>°</em>`;

    ui.openingBar.style.width = "0%";

    ui.fingerState.textContent =
      "AGUARDANDO DETECÇÃO";

    ui.trackingText.textContent =
      "NO TRACKING";


    setCameraStatus(
      false,
      "CÂMERA DESLIGADA"
    );


    clearCanvas();

    updateCalibrationUI();

  }


  // ==========================================
  // ENVIO SERIAL SEM FILA DE COMANDOS ANTIGOS
  // ==========================================

  function scheduleSerialWrite() {

    if (
      !state.writer ||
      !isCalibrated() ||
      state.serialBusy
    ) {
      return;
    }


    const now = performance.now();


    if (
      now - state.lastSerialTime <
      CONFIG.serialIntervalMs
    ) {
      return;
    }


    if (
      state.lastSentAngle !== null &&
      Math.abs(
        state.latestServoTarget -
        state.lastSentAngle
      ) < CONFIG.minimumServoChange
    ) {
      return;
    }


    // Somente uma escrita pode ficar em andamento.
    // Se houver atraso, usamos o ângulo mais recente,
    // sem enviar os comandos antigos acumulados.

    state.serialBusy = true;

    state.lastSerialTime = now;


    const angleToSend =
      state.latestServoTarget;

    const writerAtStart =
      state.writer;


    writerAtStart.write(
      new TextEncoder().encode(
        `${angleToSend}\n`
      )
    )

    .then(() => {

      if (
        state.writer === writerAtStart
      ) {

        state.lastSentAngle =
          angleToSend;

        ui.servoValue.innerHTML =
          `${angleToSend}<em>°</em>`;

      }

    })

    .catch(async (error) => {

      console.error(
        "Erro na transmissão USB:",
        error
      );

      toast(
        `Falha USB: ${error.message}`
      );

      await disconnectSerial();

    })

    .finally(() => {

      state.serialBusy = false;


      // Caso o alvo tenha mudado enquanto a escrita estava ocupada,
      // agenda somente o valor atual.

      if (
        state.writer &&
        state.latestServoTarget !==
        state.lastSentAngle
      ) {

        setTimeout(
          scheduleSerialWrite,
          CONFIG.serialIntervalMs
        );

      }

    });

  }


  // ==========================================
  // CONEXÃO USB
  // ==========================================

  async function connectSerial() {

    if (!navigator.serial) {

      toast(
        "Web Serial não disponível. Use Google Chrome em localhost.",
        5500
      );

      return;

    }


    ui.connectButton.disabled = true;


    try {

      const port =
        await navigator.serial.requestPort();


      await port.open({
        baudRate: CONFIG.baudRate
      });


      const writer =
        port.writable.getWriter();


      state.port = port;

      state.writer = writer;

      state.lastSentAngle = null;

      state.lastSerialTime = 0;


      setUsbStatus(
        true,
        "Arduino conectado · aguardando calibração"
      );


      toast(
        "Arduino conectado. O indicador começa a receber comandos após a calibração."
      );


      if (
        state.latestRawAngle !== null &&
        isCalibrated()
      ) {

        scheduleSerialWrite();

      }


    } catch (error) {

      console.error(
        "Erro ao conectar Arduino:",
        error
      );


      setUsbStatus(
        false,
        error.name === "NotFoundError"
          ? "Nenhuma porta selecionada"
          : "Falha na conexão USB"
      );


      if (error.name !== "NotFoundError") {

        toast(
          `Não foi possível conectar: ${error.message}`
        );

      }

    } finally {

      ui.connectButton.disabled = false;

    }

  }


  async function disconnectSerial() {

    const writer = state.writer;

    const port = state.port;


    state.writer = null;

    state.port = null;

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


  // ==========================================
  // SLIDER DE ABERTURA
  // ==========================================

  function updateSlider() {

    state.maxOpenAngle =
      Number(ui.slider.value);


    ui.maxAngleLabel.textContent =
      `${state.maxOpenAngle}°`;


    const percent =
      (state.maxOpenAngle - CONFIG.minOpenAngle) /
      (CONFIG.maxAllowedAngle - CONFIG.minOpenAngle) * 100;


    ui.slider.style.background =
      `linear-gradient(
        90deg,
        var(--accent) 0 ${percent}%,
        rgba(226,239,225,.13) ${percent}% 100%
      )`;


    if (state.filteredOpening !== null) {

      state.latestServoTarget =
        Math.round(
          state.filteredOpening *
          state.maxOpenAngle
        );


      updateReadouts(
        state.filteredOpening,
        state.latestServoTarget
      );


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


    window.addEventListener(
      "beforeunload",
      () => {

        if (state.stream) {

          state.stream
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
  // INICIALIZAÇÃO
  // ==========================================

  function init() {

    const missing = Object.entries(ui)
      .filter(([, element]) => !element)
      .map(([id]) => id);


    if (missing.length) {

      console.error(
        "IDs ausentes no HTML:",
        missing
      );

      toast(
        `Erro na interface: elementos ausentes (${missing.join(", ")}).`,
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
      "KINETIC pronto: apenas indicador ativo."
    );

  }


  init();

})();
