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

  // Iterative butterfly passes.
  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const angleStep = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let offset = 0; offset < halfSize; offset += 1) {
        const angle = angleStep * offset;
        const wReal = Math.cos(angle);
        const wImag = Math.sin(angle);

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
