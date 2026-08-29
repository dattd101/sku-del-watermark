"use client";

import Script from "next/script";
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

const OPENCV_URL = "https://docs.opencv.org/4.13.0/opencv.js";
const MAX_DIMENSION = 4096;
const MAX_FILE_MB = 4;
const HISTORY_LIMIT = 12;

function fitInside(width: number, height: number, maxDimension: number) {
  const largest = Math.max(width, height);
  if (largest <= maxDimension) return { width, height };
  const scale = maxDimension / largest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export default function ImageCleaner() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const originalCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const resultCanvasRef = useRef<HTMLCanvasElement>(null);

  const drawingRef = useRef(false);
  const lastPointRef = useRef<Point | null>(null);
  const historyRef = useRef<ImageData[]>([]);

  const [cvReady, setCvReady] = useState(false);
  const [cvError, setCvError] = useState(false);
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

  const canProcess = Boolean(cvReady && imageMeta && !processing);

  const statusText = useMemo(() => {
    if (cvError) return "Không tải được OpenCV.js";
    if (!cvReady) return "Đang tải OpenCV.js...";
    return "OpenCV.js đã sẵn sàng";
  }, [cvError, cvReady]);

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

    // Tô đỏ vùng mask bằng alpha của mask, không đọc toàn bộ pixel ở mỗi pointermove.
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    overlayCtx.save();
    overlayCtx.fillStyle = "rgba(239, 68, 68, 0.45)";
    overlayCtx.fillRect(0, 0, overlay.width, overlay.height);
    overlayCtx.globalCompositeOperation = "destination-in";
    overlayCtx.drawImage(mask, 0, 0);
    overlayCtx.restore();

    ctx.drawImage(overlay, 0, 0);
  }, []);

  const pushHistory = useCallback(() => {
    const mask = maskCanvasRef.current;
    const ctx = mask?.getContext("2d");
    if (!mask || !ctx || !mask.width) return;

    historyRef.current.push(ctx.getImageData(0, 0, mask.width, mask.height));
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
    setHistoryCount(historyRef.current.length);
  }, []);

  const initializeCanvas = useCallback(
    (image: HTMLImageElement, fileName: string) => {
      const original = originalCanvasRef.current;
      const mask = maskCanvasRef.current;
      const result = resultCanvasRef.current;
      if (!original || !mask || !result) return;

      const size = fitInside(image.naturalWidth, image.naturalHeight, MAX_DIMENSION);
      original.width = size.width;
      original.height = size.height;
      mask.width = size.width;
      mask.height = size.height;
      result.width = size.width;
      result.height = size.height;

      const originalCtx = original.getContext("2d", { willReadFrequently: true });
      const maskCtx = mask.getContext("2d", { willReadFrequently: true });
      const resultCtx = result.getContext("2d");
      if (!originalCtx || !maskCtx || !resultCtx) return;

      originalCtx.clearRect(0, 0, size.width, size.height);
      originalCtx.drawImage(image, 0, 0, size.width, size.height);

      // Mask trong suốt = không chọn; nét trắng = vùng cần inpaint.
      maskCtx.clearRect(0, 0, size.width, size.height);
      resultCtx.clearRect(0, 0, size.width, size.height);

      historyRef.current = [];
      setHistoryCount(0);
      setHasResult(false);
      setImageMeta({
        name: fileName,
        width: size.width,
        height: size.height,
        originalWidth: image.naturalWidth,
        originalHeight: image.naturalHeight,
      });
      setMessage(
        size.width !== image.naturalWidth || size.height !== image.naturalHeight
          ? `Ảnh được thu về ${size.width}×${size.height}px để tránh tràn bộ nhớ trình duyệt.`
          : "Hãy tô vùng cần phục hồi bằng brush."
      );

      requestAnimationFrame(refreshDisplay);
    },
    [refreshDisplay]
  );

  const loadFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        setMessage("File không phải hình ảnh hợp lệ.");
        return;
      }
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        setMessage(`Ảnh vượt quá ${MAX_FILE_MB} MB.`);
        return;
      }

      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        initializeCanvas(image, file.name);
        URL.revokeObjectURL(objectUrl);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        setMessage("Không đọc được ảnh này.");
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
    if (mode === "erase") {
      maskCtx.globalCompositeOperation = "destination-out";
    }
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
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function undo() {
    const previous = historyRef.current.pop();
    const mask = maskCanvasRef.current;
    const ctx = mask?.getContext("2d");
    if (!previous || !ctx) return;
    ctx.putImageData(previous, 0, 0);
    setHistoryCount(historyRef.current.length);
    refreshDisplay();
  }

  function clearMask() {
    const mask = maskCanvasRef.current;
    const ctx = mask?.getContext("2d");
    if (!mask || !ctx) return;
    pushHistory();
    ctx.clearRect(0, 0, mask.width, mask.height);
    refreshDisplay();
  }

  function hasSelectedPixels() {
    const mask = maskCanvasRef.current;
    const ctx = mask?.getContext("2d");
    if (!mask || !ctx) return false;
    const pixels = ctx.getImageData(0, 0, mask.width, mask.height).data;
    for (let i = 0; i < pixels.length; i += 4) {
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

    const cvValue = window.cv;
    if (!cvValue) {
      setMessage("OpenCV.js chưa sẵn sàng.");
      return;
    }

    setProcessing(true);
    setMessage("Đang inpaint trực tiếp trên thiết bị...");

    // Cho React một frame để render trạng thái trước khi tác vụ CPU nặng bắt đầu.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    let srcRgba: any;
    let srcRgb: any;
    let maskRgba: any;
    let maskGray: any;
    let binaryMask: any;
    let dstRgb: any;
    let dstRgba: any;

    try {
      const cv = cvValue instanceof Promise ? await cvValue : cvValue;
      const original = originalCanvasRef.current;
      const mask = maskCanvasRef.current;
      const result = resultCanvasRef.current;
      if (!original || !mask || !result) throw new Error("Canvas chưa sẵn sàng");

      if (typeof cv.inpaint !== "function") {
        throw new Error("Bản OpenCV.js hiện tại không có module photo/inpaint.");
      }

      srcRgba = cv.imread(original);
      srcRgb = new cv.Mat();
      cv.cvtColor(srcRgba, srcRgb, cv.COLOR_RGBA2RGB);

      maskRgba = cv.imread(mask);
      maskGray = new cv.Mat();
      binaryMask = new cv.Mat();
      cv.cvtColor(maskRgba, maskGray, cv.COLOR_RGBA2GRAY);
      cv.threshold(maskGray, binaryMask, 10, 255, cv.THRESH_BINARY);

      dstRgb = new cv.Mat();
      const flag = algorithm === "telea" ? cv.INPAINT_TELEA : cv.INPAINT_NS;
      cv.inpaint(srcRgb, binaryMask, dstRgb, radius, flag);

      dstRgba = new cv.Mat();
      cv.cvtColor(dstRgb, dstRgba, cv.COLOR_RGB2RGBA);
      result.width = original.width;
      result.height = original.height;
      cv.imshow(result, dstRgba);

      setHasResult(true);
      setMessage("Xử lý xong. Có thể tải ảnh PNG ở bên dưới.");
    } catch (error) {
      console.error(error);
      const reason = error instanceof Error ? error.message : String(error);
      setMessage(`Xử lý thất bại: ${reason}`);
    } finally {
      srcRgba?.delete?.();
      srcRgb?.delete?.();
      maskRgba?.delete?.();
      maskGray?.delete?.();
      binaryMask?.delete?.();
      dstRgb?.delete?.();
      dstRgba?.delete?.();
      setProcessing(false);
    }
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

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("image-cleaner-theme");
    const initialTheme: Theme = savedTheme === "light" || savedTheme === "dark" ? savedTheme : "dark";
    setTheme(initialTheme);
    document.documentElement.dataset.theme = initialTheme;

    return () => {
      historyRef.current = [];
    };
  }, []);

  function changeTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    window.localStorage.setItem("image-cleaner-theme", nextTheme);
  }

  return (
    <main className="shell">
      <Script
        id="opencv-js"
        src={OPENCV_URL}
        strategy="afterInteractive"
        onLoad={async () => {
          try {
            const raw = window.cv;
            if (!raw) throw new Error("cv chưa được tạo");
            const cv = raw instanceof Promise ? await raw : raw;
            window.cv = cv;
            setCvReady(true);
            setCvError(false);
          } catch (error) {
            console.error(error);
            setCvError(true);
          }
        }}
        onError={() => setCvError(true)}
      />

      <section className="hero">
        <div className="heroCopy">
          <div className="brandLine">
            <img className="brandLogo" src="/logo.svg" alt="" width="64" height="64" />
            <span className="eyebrow">NEXT.JS 15 · OPENCV.JS · CLIENT-SIDE</span>
          </div>
          <h1>Image Cleaner</h1>
          <p>
            Tô vùng cần chỉnh sửa rồi dùng inpainting để tái tạo từ các pixel lân cận. Ảnh được xử lý
            trong trình duyệt, không gửi lên API.
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
          <div className={`status ${cvReady ? "ok" : cvError ? "bad" : "loading"}`}>
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
                  <label htmlFor="radius">Inpaint radius <b>{radius}px</b></label>
                  <input id="radius" type="range" min="1" max="12" value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
                  <small>3–5px thường tốt cho vùng nhỏ.</small>
                </div>

                <div className="controlGroup">
                  <label>Thuật toán</label>
                  <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as Algorithm)}>
                    <option value="telea">Telea — nhanh, mặc định</option>
                    <option value="ns">Navier–Stokes — thử với đường nét</option>
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
        <h3>Lưu ý</h3>
        <p>
          Inpainting cổ điển phù hợp với vùng nhỏ trên nền tương đối đều. Với vùng lớn hoặc nội dung phức tạp,
          kết quả có thể bị nhòe vì phiên bản này không dùng generative AI. Chỉ dùng với ảnh mà bạn có quyền chỉnh sửa.
        </p>
      </section>
    </main>
  );
}
