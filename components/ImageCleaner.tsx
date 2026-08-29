"use client";

import {
  ChangeEvent,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Point = { x: number; y: number };
type ToolMode = "paint" | "erase";
type Algorithm = "telea" | "ns";
type Theme = "dark" | "light";

type ImageMeta = {
  name: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
};

type SessionMeta = {
  version: 2;
  image: ImageMeta;
  brushSize: number;
  radius: number;
  mode: ToolMode;
  algorithm: Algorithm;
  hasResult: boolean;
  updatedAt: number;
};

const MAX_DIMENSION = 2048;
const MAX_FILE_MB = 4;
const HISTORY_LIMIT = 12;
const SESSION_META_KEY = "image-cleaner-session-meta-v2";
const SESSION_IMAGE_KEY = "image-cleaner-session-image-v2";
const SESSION_MASK_KEY = "image-cleaner-session-mask-v2";
const SESSION_RESULT_KEY = "image-cleaner-session-result-v2";

function fitInside(width: number, height: number, maxDimension: number) {
  const largest = Math.max(width, height);
  if (largest <= maxDimension) return { width, height };
  const scale = maxDimension / largest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function loadImageSource(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Không đọc được dữ liệu ảnh."));
    image.src = src;
  });
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

export default function ImageCleaner() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const originalCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const resultCanvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);

  const drawingRef = useRef(false);
  const lastPointRef = useRef<Point | null>(null);
  const historyRef = useRef<ImageData[]>([]);

  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const [brushSize, setBrushSize] = useState(42);
  const [radius, setRadius] = useState(3);
  const [mode, setMode] = useState<ToolMode>("paint");
  const [algorithm, setAlgorithm] = useState<Algorithm>("telea");
  const [processing, setProcessing] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [message, setMessage] = useState("Chưa chọn ảnh");
  const [isDragging, setIsDragging] = useState(false);
  const [historyCount, setHistoryCount] = useState(0);
  const [theme, setTheme] = useState<Theme>("dark");
  const [sessionStatus, setSessionStatus] = useState("Phiên cục bộ chưa có dữ liệu");

  const canProcess = Boolean(imageMeta && !processing);

  const statusText = useMemo(
    () => (processing ? "Bộ xử lý local đang chạy" : "Bộ xử lý local đã sẵn sàng"),
    [processing]
  );

  const safeSessionSet = useCallback((key: string, value: string) => {
    try {
      window.sessionStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.warn("Không thể lưu sessionStorage:", error);
      return false;
    }
  }, []);

  const saveMeta = useCallback(
    (override?: Partial<Pick<SessionMeta, "hasResult">>) => {
      if (!imageMeta) return;
      const payload: SessionMeta = {
        version: 2,
        image: imageMeta,
        brushSize,
        radius,
        mode,
        algorithm,
        hasResult: override?.hasResult ?? hasResult,
        updatedAt: Date.now(),
      };
      safeSessionSet(SESSION_META_KEY, JSON.stringify(payload));
    },
    [algorithm, brushSize, hasResult, imageMeta, mode, radius, safeSessionSet]
  );

  const refreshDisplay = useCallback(() => {
    const original = originalCanvasRef.current;
    const mask = maskCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    const display = displayCanvasRef.current;
    if (!original || !mask || !overlay || !display || !original.width) return;

    if (display.width !== original.width || display.height !== original.height) {
      display.width = original.width;
      display.height = original.height;
    }
    if (overlay.width !== original.width || overlay.height !== original.height) {
      overlay.width = original.width;
      overlay.height = original.height;
    }

    const ctx = display.getContext("2d");
    const overlayCtx = overlay.getContext("2d");
    if (!ctx || !overlayCtx) return;

    ctx.clearRect(0, 0, display.width, display.height);
    ctx.drawImage(original, 0, 0);

    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    overlayCtx.save();
    overlayCtx.fillStyle = "rgba(239, 68, 68, 0.45)";
    overlayCtx.fillRect(0, 0, overlay.width, overlay.height);
    overlayCtx.globalCompositeOperation = "destination-in";
    overlayCtx.drawImage(mask, 0, 0);
    overlayCtx.restore();

    ctx.drawImage(overlay, 0, 0);
  }, []);

  const persistMask = useCallback(() => {
    const mask = maskCanvasRef.current;
    if (!mask?.width) return;
    const ok = safeSessionSet(SESSION_MASK_KEY, mask.toDataURL("image/png"));
    if (ok) setSessionStatus("Phiên cục bộ đã tự động lưu");
    else setSessionStatus("Không đủ bộ nhớ để lưu toàn bộ phiên");
  }, [safeSessionSet]);

  const persistResult = useCallback(() => {
    const result = resultCanvasRef.current;
    if (!result?.width) return;
    const ok = safeSessionSet(SESSION_RESULT_KEY, result.toDataURL("image/webp", 0.78));
    if (ok) setSessionStatus("Ảnh, mask và kết quả đã lưu trong phiên");
    else setSessionStatus("Kết quả vẫn dùng được nhưng phiên không đủ bộ nhớ");
  }, [safeSessionSet]);

  const pushHistory = useCallback(() => {
    const mask = maskCanvasRef.current;
    const ctx = mask?.getContext("2d");
    if (!mask || !ctx || !mask.width) return;

    historyRef.current.push(ctx.getImageData(0, 0, mask.width, mask.height));
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
    setHistoryCount(historyRef.current.length);
  }, []);

  const initializeCanvas = useCallback(
    async (image: HTMLImageElement, fileName: string) => {
      const original = originalCanvasRef.current;
      const mask = maskCanvasRef.current;
      if (!original || !mask) return;

      workerRef.current?.terminate();
      workerRef.current = null;

      const size = fitInside(image.naturalWidth, image.naturalHeight, MAX_DIMENSION);
      original.width = size.width;
      original.height = size.height;
      mask.width = size.width;
      mask.height = size.height;

      const originalCtx = original.getContext("2d", { willReadFrequently: true });
      const maskCtx = mask.getContext("2d", { willReadFrequently: true });
      if (!originalCtx || !maskCtx) return;

      originalCtx.clearRect(0, 0, size.width, size.height);
      originalCtx.drawImage(image, 0, 0, size.width, size.height);
      maskCtx.clearRect(0, 0, size.width, size.height);

      // resultCanvas có thể chưa tồn tại ở lần load đầu tiên; không được chặn preview vì lý do này.
      const previousResult = resultCanvasRef.current;
      if (previousResult) {
        previousResult.width = size.width;
        previousResult.height = size.height;
        previousResult.getContext("2d")?.clearRect(0, 0, size.width, size.height);
      }

      historyRef.current = [];
      setHistoryCount(0);
      setHasResult(false);

      const meta: ImageMeta = {
        name: fileName,
        width: size.width,
        height: size.height,
        originalWidth: image.naturalWidth,
        originalHeight: image.naturalHeight,
      };
      setImageMeta(meta);

      try {
        window.sessionStorage.removeItem(SESSION_META_KEY);
        window.sessionStorage.removeItem(SESSION_IMAGE_KEY);
        window.sessionStorage.removeItem(SESSION_MASK_KEY);
        window.sessionStorage.removeItem(SESSION_RESULT_KEY);

        // WebP keeps the temporary browser session compact enough for most 4 MB uploads.
        const originalData = original.toDataURL("image/webp", 0.82);
        const imageSaved = safeSessionSet(SESSION_IMAGE_KEY, originalData);
        const maskSaved = safeSessionSet(SESSION_MASK_KEY, mask.toDataURL("image/png"));
        const sessionMeta: SessionMeta = {
          version: 2,
          image: meta,
          brushSize,
          radius,
          mode,
          algorithm,
          hasResult: false,
          updatedAt: Date.now(),
        };
        const metaSaved = safeSessionSet(SESSION_META_KEY, JSON.stringify(sessionMeta));
        setSessionStatus(
          imageSaved && maskSaved && metaSaved
            ? "Ảnh đã lưu tạm trong phiên trình duyệt"
            : "Ảnh đang xử lý local; bộ nhớ phiên không đủ để lưu khi refresh"
        );
      } catch {
        setSessionStatus("Ảnh đang xử lý local; không thể lưu phiên trên trình duyệt này");
      }

      setMessage(
        size.width !== image.naturalWidth || size.height !== image.naturalHeight
          ? `Ảnh được thu về ${size.width}×${size.height}px để xử lý ổn định và lưu phiên.`
          : "Ảnh đã tải. Hãy tô vùng cần phục hồi bằng brush."
      );

      await nextFrame();
      refreshDisplay();
    },
    [algorithm, brushSize, mode, radius, refreshDisplay, safeSessionSet]
  );

  const loadFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        setMessage("File không phải hình ảnh hợp lệ.");
        return;
      }
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        setMessage(`Ảnh vượt quá ${MAX_FILE_MB} MB. Vui lòng chọn file nhỏ hơn.`);
        return;
      }

      setMessage("Đang đọc ảnh...");
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = async () => {
        try {
          await initializeCanvas(image, file.name);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        setMessage("Không đọc được ảnh này. Hãy thử PNG, JPEG hoặc WebP khác.");
      };
      image.src = objectUrl;
    },
    [initializeCanvas]
  );

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) loadFile(file);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) loadFile(file);
  }

  function getCanvasPoint(event: ReactPointerEvent<HTMLCanvasElement>): Point | null {
    const canvas = displayCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function drawSegment(from: Point, to: Point) {
    const mask = maskCanvasRef.current;
    const display = displayCanvasRef.current;
    if (!mask || !display) return;
    const maskCtx = mask.getContext("2d");
    if (!maskCtx) return;

    const rect = display.getBoundingClientRect();
    const scale = display.width / Math.max(1, rect.width);
    const width = Math.max(1, brushSize * scale);

    maskCtx.save();
    if (mode === "erase") maskCtx.globalCompositeOperation = "destination-out";
    maskCtx.strokeStyle = "white";
    maskCtx.fillStyle = "white";
    maskCtx.lineWidth = width;
    maskCtx.lineCap = "round";
    maskCtx.lineJoin = "round";
    maskCtx.beginPath();
    maskCtx.moveTo(from.x, from.y);
    maskCtx.lineTo(to.x, to.y);
    maskCtx.stroke();
    maskCtx.beginPath();
    maskCtx.arc(to.x, to.y, width / 2, 0, Math.PI * 2);
    maskCtx.fill();
    maskCtx.restore();

    refreshDisplay();
  }

  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!imageMeta || processing) return;
    const point = getCanvasPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pushHistory();
    drawingRef.current = true;
    lastPointRef.current = point;
    drawSegment(point, point);
  }

  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || processing) return;
    const point = getCanvasPoint(event);
    const previous = lastPointRef.current;
    if (!point || !previous) return;
    drawSegment(previous, point);
    lastPointRef.current = point;
  }

  function pointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (drawingRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const didDraw = drawingRef.current;
    drawingRef.current = false;
    lastPointRef.current = null;
    if (didDraw) {
      persistMask();
      saveMeta();
    }
  }

  function undo() {
    const previous = historyRef.current.pop();
    const mask = maskCanvasRef.current;
    const ctx = mask?.getContext("2d");
    if (!previous || !ctx) return;
    ctx.putImageData(previous, 0, 0);
    setHistoryCount(historyRef.current.length);
    refreshDisplay();
    persistMask();
  }

  function clearMask() {
    const mask = maskCanvasRef.current;
    const ctx = mask?.getContext("2d");
    if (!mask || !ctx) return;
    pushHistory();
    ctx.clearRect(0, 0, mask.width, mask.height);
    refreshDisplay();
    persistMask();
    setMessage("Đã xóa mask.");
  }

  function hasSelectedPixels() {
    const mask = maskCanvasRef.current;
    const ctx = mask?.getContext("2d");
    if (!mask || !ctx) return false;
    const pixels = ctx.getImageData(0, 0, mask.width, mask.height).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] > 10) return true;
    }
    return false;
  }

  async function processImage() {
    if (!canProcess) return;
    if (!hasSelectedPixels()) {
      setMessage("Bạn chưa tô vùng cần phục hồi.");
      return;
    }

    const original = originalCanvasRef.current;
    const mask = maskCanvasRef.current;
    const result = resultCanvasRef.current;
    if (!original || !mask || !result) {
      setMessage("Canvas chưa sẵn sàng. Hãy thử chọn ảnh lại.");
      return;
    }

    const originalCtx = original.getContext("2d", { willReadFrequently: true });
    const maskCtx = mask.getContext("2d", { willReadFrequently: true });
    const resultCtx = result.getContext("2d");
    if (!originalCtx || !maskCtx || !resultCtx) return;

    workerRef.current?.terminate();
    const worker = new Worker("/inpaint-worker.js");
    workerRef.current = worker;
    setProcessing(true);
    setMessage("Đang xử lý 0% — toàn bộ diễn ra trong trình duyệt...");

    await nextFrame();

    const sourceData = originalCtx.getImageData(0, 0, original.width, original.height);
    const maskData = maskCtx.getImageData(0, 0, mask.width, mask.height);

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { type: "progress"; progress: number }
        | { type: "done"; resultBuffer: ArrayBuffer }
        | { type: "error"; message: string };

      if (data.type === "progress") {
        setMessage(`Đang xử lý ${Math.max(0, Math.min(100, data.progress))}% — dữ liệu không rời khỏi trình duyệt.`);
        return;
      }

      if (data.type === "error") {
        setProcessing(false);
        setMessage(`Xử lý thất bại: ${data.message}`);
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
        return;
      }

      result.width = original.width;
      result.height = original.height;
      const output = new Uint8ClampedArray(data.resultBuffer);
      resultCtx.putImageData(new ImageData(output, original.width, original.height), 0, 0);
      setHasResult(true);
      setProcessing(false);
      setMessage("Xử lý xong. Kết quả được tạo hoàn toàn trên thiết bị của bạn.");
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;

      requestAnimationFrame(() => {
        persistResult();
        saveMeta({ hasResult: true });
      });
    };

    worker.onerror = (event) => {
      console.error(event);
      setProcessing(false);
      setMessage("Worker xử lý ảnh gặp lỗi. Hãy thử ảnh nhỏ hơn hoặc refresh trang.");
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };

    worker.postMessage(
      {
        width: original.width,
        height: original.height,
        srcBuffer: sourceData.data.buffer,
        maskBuffer: maskData.data.buffer,
        radius,
        algorithm,
      },
      [sourceData.data.buffer, maskData.data.buffer]
    );
  }

  function downloadResult() {
    const canvas = resultCanvasRef.current;
    if (!canvas || !hasResult) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const base = imageMeta?.name.replace(/\.[^.]+$/, "") || "image";
      link.href = url;
      link.download = `${base}-cleaned.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }

  const clearSession = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    try {
      window.sessionStorage.removeItem(SESSION_META_KEY);
      window.sessionStorage.removeItem(SESSION_IMAGE_KEY);
      window.sessionStorage.removeItem(SESSION_MASK_KEY);
      window.sessionStorage.removeItem(SESSION_RESULT_KEY);
    } catch {
      // Ignore browsers that disable storage.
    }

    [originalCanvasRef, maskCanvasRef, overlayCanvasRef].forEach((ref) => {
      const canvas = ref.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    });
    const result = resultCanvasRef.current;
    if (result) {
      result.width = 0;
      result.height = 0;
    }

    historyRef.current = [];
    setHistoryCount(0);
    setImageMeta(null);
    setHasResult(false);
    setProcessing(false);
    setMessage("Phiên đã được xóa. Chọn ảnh mới để bắt đầu.");
    setSessionStatus("Phiên cục bộ chưa có dữ liệu");
  }, []);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("image-cleaner-theme");
    const initialTheme: Theme = savedTheme === "light" || savedTheme === "dark" ? savedTheme : "dark";
    setTheme(initialTheme);
    document.documentElement.dataset.theme = initialTheme;

    let cancelled = false;

    async function restoreSession() {
      try {
        const rawMeta = window.sessionStorage.getItem(SESSION_META_KEY);
        const imageDataUrl = window.sessionStorage.getItem(SESSION_IMAGE_KEY);
        if (!rawMeta || !imageDataUrl) return;

        const saved = JSON.parse(rawMeta) as SessionMeta;
        if (saved.version !== 2 || !saved.image) return;

        setSessionStatus("Đang khôi phục phiên trình duyệt...");
        const image = await loadImageSource(imageDataUrl);
        if (cancelled) return;

        const original = originalCanvasRef.current;
        const mask = maskCanvasRef.current;
        if (!original || !mask) return;

        original.width = saved.image.width;
        original.height = saved.image.height;
        mask.width = saved.image.width;
        mask.height = saved.image.height;

        const originalCtx = original.getContext("2d", { willReadFrequently: true });
        const maskCtx = mask.getContext("2d", { willReadFrequently: true });
        if (!originalCtx || !maskCtx) return;
        originalCtx.drawImage(image, 0, 0, saved.image.width, saved.image.height);
        maskCtx.clearRect(0, 0, mask.width, mask.height);

        const maskDataUrl = window.sessionStorage.getItem(SESSION_MASK_KEY);
        if (maskDataUrl) {
          try {
            const maskImage = await loadImageSource(maskDataUrl);
            if (!cancelled) maskCtx.drawImage(maskImage, 0, 0, mask.width, mask.height);
          } catch {
            // A missing/corrupt mask should not prevent restoring the image.
          }
        }

        setBrushSize(saved.brushSize || 42);
        setRadius(saved.radius || 3);
        setMode(saved.mode === "erase" ? "erase" : "paint");
        setAlgorithm(saved.algorithm === "ns" ? "ns" : "telea");
        setImageMeta(saved.image);
        setHasResult(Boolean(saved.hasResult));
        setMessage("Đã khôi phục ảnh và mask từ phiên của tab này.");
        setSessionStatus("Đã khôi phục phiên cục bộ");

        await nextFrame();
        await nextFrame();
        if (cancelled) return;
        refreshDisplay();

        const resultDataUrl = window.sessionStorage.getItem(SESSION_RESULT_KEY);
        const result = resultCanvasRef.current;
        if (saved.hasResult && resultDataUrl && result) {
          try {
            const resultImage = await loadImageSource(resultDataUrl);
            if (cancelled) return;
            result.width = saved.image.width;
            result.height = saved.image.height;
            const resultCtx = result.getContext("2d");
            resultCtx?.drawImage(resultImage, 0, 0, result.width, result.height);
          } catch {
            setHasResult(false);
          }
        } else if (saved.hasResult) {
          setHasResult(false);
        }
      } catch (error) {
        console.warn("Không thể khôi phục phiên:", error);
        setSessionStatus("Không thể khôi phục phiên cũ");
      }
    }

    restoreSession();

    return () => {
      cancelled = true;
      workerRef.current?.terminate();
      workerRef.current = null;
      historyRef.current = [];
    };
  }, [refreshDisplay]);

  useEffect(() => {
    if (!imageMeta) return;
    requestAnimationFrame(refreshDisplay);
  }, [imageMeta, refreshDisplay]);

  useEffect(() => {
    if (!imageMeta) return;
    saveMeta();
  }, [algorithm, brushSize, imageMeta, mode, radius, saveMeta]);

  function changeTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("image-cleaner-theme", nextTheme);
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="heroCopy">
          <div className="brandLine">
            <img className="brandLogo" src="/logo.svg" alt="" width="64" height="64" />
            <span className="eyebrow">NEXT.JS 15 · LOCAL WORKER · CLIENT-SIDE</span>
          </div>
          <h1>Image Cleaner</h1>
          <p>
            Tô vùng cần chỉnh sửa rồi phục hồi từ các pixel lân cận. Ảnh được xử lý ngay trong trình duyệt,
            không upload lên API hay máy chủ xử lý ảnh.
          </p>
        </div>
        <div className="heroActions">
          <div className="themePicker" role="group" aria-label="Chọn giao diện sáng hoặc tối">
            <button
              type="button"
              className={theme === "light" ? "active" : ""}
              onClick={() => changeTheme("light")}
              aria-pressed={theme === "light"}
            >
              ☀ Sáng
            </button>
            <button
              type="button"
              className={theme === "dark" ? "active" : ""}
              onClick={() => changeTheme("dark")}
              aria-pressed={theme === "dark"}
            >
              ◐ Tối
            </button>
          </div>
          <div className={`status ${processing ? "loading" : "ok"}`}>
            <span className="dot" /> {statusText}
          </div>
        </div>
      </section>

      <section className="panel">
        <div
          className={`dropZone ${isDragging ? "dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") fileInputRef.current?.click();
          }}
        >
          <input
            ref={fileInputRef}
            className="hiddenInput"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleFileChange}
          />
          <strong>{imageMeta ? "Đổi ảnh" : "Chọn hoặc kéo ảnh vào đây"}</strong>
          <span>PNG · JPEG · WebP · tối đa {MAX_FILE_MB} MB</span>
        </div>

        <div className="sessionBar">
          <div>
            <strong>Phiên xử lý trên trình duyệt</strong>
            <span>{sessionStatus}. Refresh trong cùng tab sẽ tự khôi phục khi bộ nhớ cho phép.</span>
          </div>
          <button type="button" className="secondary sessionClear" onClick={clearSession} disabled={!imageMeta}>
            Xóa phiên
          </button>
        </div>

        {imageMeta && (
          <>
            <div className="metaRow">
              <div>
                <span>Tệp</span>
                <strong>{imageMeta.name}</strong>
              </div>
              <div>
                <span>Kích thước xử lý</span>
                <strong>{imageMeta.width} × {imageMeta.height}</strong>
              </div>
              <div>
                <span>Ảnh gốc</span>
                <strong>{imageMeta.originalWidth} × {imageMeta.originalHeight}</strong>
              </div>
            </div>

            <div className="workspace">
              <aside className="controls">
                <div className="controlGroup">
                  <label>Công cụ</label>
                  <div className="segmented">
                    <button className={mode === "paint" ? "active" : ""} onClick={() => setMode("paint")}>Tô mask</button>
                    <button className={mode === "erase" ? "active" : ""} onClick={() => setMode("erase")}>Tẩy mask</button>
                  </div>
                </div>

                <div className="controlGroup">
                  <label htmlFor="brush">Brush <b>{brushSize}px</b></label>
                  <input id="brush" type="range" min="5" max="180" value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
                </div>

                <div className="controlGroup">
                  <label htmlFor="radius">Bán kính lấy mẫu <b>{radius}px</b></label>
                  <input id="radius" type="range" min="1" max="10" value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
                  <small>3–5px thường phù hợp với watermark/vùng nhỏ.</small>
                </div>

                <div className="controlGroup">
                  <label>Chế độ phục hồi</label>
                  <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as Algorithm)}>
                    <option value="telea">Nhanh — ưu tiên pixel gần</option>
                    <option value="ns">Mượt — thêm làm mịn vùng phục hồi</option>
                  </select>
                </div>

                <div className="actionGrid">
                  <button className="secondary" onClick={undo} disabled={!historyCount}>Undo</button>
                  <button className="secondary" onClick={clearMask}>Xóa mask</button>
                </div>

                <button className="primary" onClick={processImage} disabled={!canProcess}>
                  {processing ? "Đang xử lý..." : "Phục hồi vùng đã chọn"}
                </button>
              </aside>

              <div className="canvasArea">
                <div className="canvasHeader">
                  <strong>Ảnh & mask</strong>
                  <span>Màu đỏ = vùng sẽ được tái tạo</span>
                </div>
                <div className="canvasFrame">
                  <canvas
                    ref={displayCanvasRef}
                    className="editorCanvas"
                    onPointerDown={pointerDown}
                    onPointerMove={pointerMove}
                    onPointerUp={pointerUp}
                    onPointerCancel={pointerUp}
                    onPointerLeave={(event) => {
                      if (drawingRef.current) pointerUp(event);
                    }}
                  />
                </div>
              </div>
            </div>
          </>
        )}

        <div className="message">{message}</div>
      </section>

      <canvas ref={originalCanvasRef} className="hiddenCanvas" />
      <canvas ref={maskCanvasRef} className="hiddenCanvas" />
      <canvas ref={overlayCanvasRef} className="hiddenCanvas" />

      {imageMeta && (
        <section className={`resultPanel ${hasResult ? "visible" : ""}`}>
          <div className="resultHeader">
            <div>
              <span className="eyebrow">OUTPUT</span>
              <h2>Kết quả</h2>
            </div>
            <button className="download" onClick={downloadResult} disabled={!hasResult}>Tải PNG</button>
          </div>
          <div className="resultFrame">
            <canvas ref={resultCanvasRef} className="resultCanvas" />
            {!hasResult && <div className="resultPlaceholder">Kết quả sẽ xuất hiện ở đây sau khi xử lý.</div>}
          </div>
        </section>
      )}

      <section className="notes">
        <h3>Riêng tư & phiên xử lý</h3>
        <p>
          Ảnh và mask được xử lý bằng Web Worker ngay trên thiết bị. Không có API xử lý ảnh. Dữ liệu phiên được lưu tạm
          bằng sessionStorage để có thể refresh trong cùng tab; bạn có thể bấm “Xóa phiên” bất kỳ lúc nào. Inpainting local
          phù hợp nhất với vùng nhỏ trên nền tương đối đều. Chỉ dùng với ảnh mà bạn có quyền chỉnh sửa.
        </p>
      </section>
    </main>
  );
}
