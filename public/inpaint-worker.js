/*
 * Local browser inpainting worker.
 * No API, no CDN, no external dependency.
 * Fills the masked area from neighboring pixels, then smooths only the mask.
 */

self.onmessage = function (event) {
  const { width, height, srcBuffer, maskBuffer, radius, algorithm } = event.data;

  try {
    const src = new Uint8ClampedArray(srcBuffer);
    const mask = new Uint8ClampedArray(maskBuffer);
    const count = width * height;
    const result = new Uint8ClampedArray(src);
    const masked = new Uint8Array(count);
    const known = new Uint8Array(count);
    const queued = new Uint8Array(count);
    const queue = new Int32Array(count);
    let head = 0;
    let tail = 0;
    let maskedCount = 0;

    const isMaskPixel = (i) => {
      const p = i * 4;
      return mask[p + 3] > 10 || mask[p] > 10 || mask[p + 1] > 10 || mask[p + 2] > 10;
    };

    for (let i = 0; i < count; i++) {
      if (isMaskPixel(i)) {
        masked[i] = 1;
        maskedCount++;
      } else {
        known[i] = 1;
      }
    }

    if (!maskedCount) {
      self.postMessage({ type: "done", resultBuffer: result.buffer }, [result.buffer]);
      return;
    }

    const neighbors8 = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0],           [1, 0],
      [-1, 1],  [0, 1],  [1, 1],
    ];

    function hasKnownNeighbor(x, y) {
      for (let k = 0; k < neighbors8.length; k++) {
        const nx = x + neighbors8[k][0];
        const ny = y + neighbors8[k][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (known[ny * width + nx]) return true;
      }
      return false;
    }

    // Seed the queue with the current mask boundary.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (masked[i] && hasKnownNeighbor(x, y)) {
          queued[i] = 1;
          queue[tail++] = i;
        }
      }
    }

    const sampleRadius = Math.max(1, Math.min(6, Math.round(Number(radius) || 3)));
    let filled = 0;
    let lastProgress = -1;

    function fillPixel(i) {
      const x = i % width;
      const y = Math.floor(i / width);
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let aa = 0;
      let totalWeight = 0;

      for (let dy = -sampleRadius; dy <= sampleRadius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -sampleRadius; dx <= sampleRadius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
          const ni = ny * width + nx;
          if (!known[ni]) continue;

          const dist2 = dx * dx + dy * dy;
          if (!dist2 || dist2 > sampleRadius * sampleRadius) continue;

          // Favor the closest known pixels. The exponent is slightly different
          // for the smoother NS-like mode.
          const weight = algorithm === "ns" ? 1 / Math.sqrt(dist2) : 1 / dist2;
          const p = ni * 4;
          rr += result[p] * weight;
          gg += result[p + 1] * weight;
          bb += result[p + 2] * weight;
          aa += result[p + 3] * weight;
          totalWeight += weight;
        }
      }

      if (!totalWeight) return false;
      const p = i * 4;
      result[p] = Math.round(rr / totalWeight);
      result[p + 1] = Math.round(gg / totalWeight);
      result[p + 2] = Math.round(bb / totalWeight);
      result[p + 3] = Math.max(1, Math.round(aa / totalWeight));
      known[i] = 1;
      return true;
    }

    while (head < tail) {
      const i = queue[head++];
      if (known[i] || !masked[i]) continue;

      if (!fillPixel(i)) {
        // Extremely unusual (e.g. the entire image is masked). Try again later.
        queued[i] = 0;
        continue;
      }

      filled++;
      const x = i % width;
      const y = Math.floor(i / width);

      for (let k = 0; k < neighbors8.length; k++) {
        const nx = x + neighbors8[k][0];
        const ny = y + neighbors8[k][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (masked[ni] && !known[ni] && !queued[ni]) {
          queued[ni] = 1;
          queue[tail++] = ni;
        }
      }

      const progress = Math.floor((filled / maskedCount) * 90);
      if (progress >= lastProgress + 5) {
        lastProgress = progress;
        self.postMessage({ type: "progress", progress: Math.min(90, progress) });
      }
    }

    // If the mask covers the entire image there is no source information.
    if (filled < maskedCount) {
      throw new Error("Vùng mask quá lớn hoặc không còn pixel lân cận để phục hồi.");
    }

    // Smooth only the reconstructed pixels to reduce visible propagation bands.
    const passes = algorithm === "ns" ? 3 : 1;
    const blend = algorithm === "ns" ? 0.38 : 0.22;

    for (let pass = 0; pass < passes; pass++) {
      const before = new Uint8ClampedArray(result);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (!masked[i]) continue;
          let rr = 0, gg = 0, bb = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
              const p2 = (ny * width + nx) * 4;
              rr += before[p2];
              gg += before[p2 + 1];
              bb += before[p2 + 2];
              n++;
            }
          }
          if (!n) continue;
          const p = i * 4;
          result[p] = Math.round(before[p] * (1 - blend) + (rr / n) * blend);
          result[p + 1] = Math.round(before[p + 1] * (1 - blend) + (gg / n) * blend);
          result[p + 2] = Math.round(before[p + 2] * (1 - blend) + (bb / n) * blend);
        }
      }
      self.postMessage({ type: "progress", progress: 92 + Math.round(((pass + 1) / passes) * 8) });
    }

    self.postMessage({ type: "done", resultBuffer: result.buffer }, [result.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
