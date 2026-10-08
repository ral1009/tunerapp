const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

// cos/sin of -2*pi*k/n for k < n/2, computed once per FFT size.
function twiddles(n: number): { cos: Float64Array; sin: Float64Array } {
  let table = twiddleCache.get(n);
  if (!table) {
    const half = n >> 1;
    table = { cos: new Float64Array(half), sin: new Float64Array(half) };
    for (let k = 0; k < half; k += 1) {
      const angle = (-2 * Math.PI * k) / n;
      table.cos[k] = Math.cos(angle);
      table.sin[k] = Math.sin(angle);
    }
    twiddleCache.set(n, table);
  }
  return table;
}

// Iterative radix-2 Cooley-Tukey FFT. real.length/imag.length must be a power of 2.
export function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  if (n !== imag.length) {
    throw new Error("fftInPlace: real and imag arrays must be the same length.");
  }
  if (n <= 1 || (n & (n - 1)) !== 0) {
    throw new Error("fftInPlace: length must be a power of 2 greater than 1.");
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tempReal = real[i];
      real[i] = real[j];
      real[j] = tempReal;
      const tempImag = imag[i];
      imag[i] = imag[j];
      imag[j] = tempImag;
    }
  }

  // Iterative butterfly passes. Twiddle factors come from a per-size table rather than a fresh
  // cos/sin per butterfly: that was most of the cost of the post-take scorer's large FFTs
  // (n log n trig calls -- ~half a million for one 32k-point spectrum).
  const { cos, sin } = twiddles(n);
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let offset = 0; offset < halfSize; offset += 1) {
        const wReal = cos[offset * stride];
        const wImag = sin[offset * stride];

        const evenIndex = start + offset;
        const oddIndex = start + offset + halfSize;

        const oddReal = real[oddIndex] * wReal - imag[oddIndex] * wImag;
        const oddImag = real[oddIndex] * wImag + imag[oddIndex] * wReal;

        real[oddIndex] = real[evenIndex] - oddReal;
        imag[oddIndex] = imag[evenIndex] - oddImag;
        real[evenIndex] += oddReal;
        imag[evenIndex] += oddImag;
      }
    }
  }
}

// Magnitude spectrum (first N/2 bins) of a real-valued, power-of-2-length input.
export function realFftMagnitudes(samples: Float32Array): Float32Array {
  const n = samples.length;
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  real.set(samples);

  fftInPlace(real, imag);

  const bins = n >> 1;
  const magnitudes = new Float32Array(bins);
  for (let i = 0; i < bins; i += 1) {
    magnitudes[i] = Math.hypot(real[i], imag[i]);
  }

  return magnitudes;
}
