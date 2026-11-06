/* Analysis runs off the UI thread. It only receives audio selected in this browser. */
self.onmessage = ({ data }) => {
  try {
    const channels = data.channels.map((buffer) => new Float32Array(buffer));
    const sampleRate = data.sampleRate;
    const metrics = analyze(channels, sampleRate, data.fileSize, data.format);
    const transfers = [metrics.waveform.buffer, metrics.spectrum.buffer, metrics.spectrogram.buffer];
    self.postMessage({ ok: true, metrics }, transfers);
  } catch (error) {
    self.postMessage({ ok: false, error: "The selected audio could not be analyzed." });
  }
};

function analyze(channels, sampleRate, fileSize, format) {
  if (!channels.length || !channels[0].length) throw new Error("Empty audio buffer");
  const sampleCount = channels[0].length;
  const duration = sampleCount / sampleRate;
  const waveform = buildWaveform(channels, 1400);
  const raw = measureRawAudio(channels, sampleRate);
  const loudness = measureLoudness(channels, sampleRate);
  const tempo = detectTempo(channels, sampleRate);
  const tonal = analyzeSpectrum(channels, sampleRate);
  const bitrate = duration > 0 ? Math.round((fileSize * 8) / duration) : 0;
  const lra = loudness.shortTerm.length > 1
    ? percentile(loudness.shortTerm, 0.95) - percentile(loudness.shortTerm, 0.10)
    : 0;
  const score = qualityScore({ bitrate, sampleRate, peakDb: raw.samplePeakDb, clipped: raw.clipped,
    samples: raw.samples, loudness: loudness.integrated, lra });
  const grade = score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 55 ? "Needs Attention" : "Poor";
  const recommendations = [];
  if (raw.clipped) recommendations.push(`${raw.clipped.toLocaleString()} clipped samples detected; reduce gain and re-export.`);
  if (raw.samplePeakDb > -1) recommendations.push("The sample peak is close to 0 dBFS; leave at least 1 dB of headroom.");
  if (loudness.integrated > -7) recommendations.push("The integrated loudness is very high; check for over-compression before release.");
  if (lra > 0 && lra < 3) recommendations.push("The measured loudness range is narrow; check that the master has the dynamics you want.");
  if (bitrate > 0 && bitrate < 192000) recommendations.push("This lossy file has an average bitrate below 192 kbps. Re-export from the lossless master if available.");
  if (!recommendations.length) recommendations.push("No clipping or severe level issues were detected in this browser analysis.");

  return {
    format, duration, fileSize, bitrate, sampleRate, channels: channels.length,
    waveform, spectrum: tonal.spectrum, spectrogram: tonal.spectrogram,
    bpm: tempo.bpm, bpmConfidence: tempo.confidence, key: tonal.key, keyConfidence: tonal.keyConfidence,
    integratedLufs: loudness.integrated, shortTermLufs: loudness.shortTerm.length ? Math.max(...loudness.shortTerm) : null,
    loudnessRange: lra, samplePeakDb: raw.samplePeakDb, interSamplePeakDb: raw.interSamplePeakDb,
    rmsDb: raw.rmsDb, crestFactorDb: raw.crestFactorDb, silenceSeconds: raw.silenceSeconds,
    clippedSamples: raw.clipped, score, grade, recommendations,
  };
}

function buildWaveform(channels, columns) {
  const length = channels[0].length;
  const waveform = new Float32Array(columns * 2);
  for (let col = 0; col < columns; col++) {
    const start = Math.floor((col * length) / columns);
    const end = Math.max(start + 1, Math.floor(((col + 1) * length) / columns));
    let low = 1, high = -1;
    for (let i = start; i < end; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      sample /= channels.length;
      if (sample < low) low = sample;
      if (sample > high) high = sample;
    }
    waveform[col * 2] = low;
    waveform[col * 2 + 1] = high;
  }
  return waveform;
}

function measureRawAudio(channels, sampleRate) {
  let sumSquares = 0, peak = 0, interSamplePeak = 0, clipped = 0, samples = 0;
  let silenceRun = 0, silenceSeconds = 0;
  const silenceWindow = Math.max(1, Math.floor(sampleRate / 10));
  for (const channel of channels) {
    let channelSilence = 0;
    for (let i = 0; i < channel.length; i++) {
      const value = channel[i];
      const abs = Math.abs(value);
      sumSquares += value * value;
      if (abs > peak) peak = abs;
      if (abs >= 0.999) clipped++;
      samples++;
      if (i > 0) {
        const previous = channel[i - 1];
        for (let j = 1; j < 4; j++) {
          const interpolated = Math.abs(previous + ((value - previous) * j) / 4);
          if (interpolated > interSamplePeak) interSamplePeak = interpolated;
        }
      }
      if ((i + 1) % silenceWindow === 0 || i === channel.length - 1) {
        const start = Math.max(0, i - silenceWindow + 1);
        let energy = 0;
        for (let k = start; k <= i; k++) energy += channel[k] * channel[k];
        const count = i - start + 1;
        if (Math.sqrt(energy / count) < 0.001) channelSilence += count / sampleRate;
      }
    }
    silenceSeconds = Math.max(silenceSeconds, channelSilence);
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples));
  const samplePeakDb = toDb(peak);
  const rmsDb = toDb(rms);
  return {
    peak, samplePeakDb, interSamplePeakDb: toDb(interSamplePeak), rmsDb,
    crestFactorDb: samplePeakDb - rmsDb, clipped, samples, silenceSeconds,
  };
}

function makeHighPass(sampleRate, frequency, q) {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const c = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
  return { b0: ((1 + c) / 2) / a0, b1: (-(1 + c)) / a0,
    b2: ((1 + c) / 2) / a0, a1: (-2 * c) / a0, a2: (1 - alpha) / a0 };
}

function makeHighShelf(sampleRate, frequency, gainDb, q) {
  const A = Math.pow(10, gainDb / 40), w = (2 * Math.PI * frequency) / sampleRate;
  const c = Math.cos(w), s = Math.sin(w), alpha = s / (2 * q), root = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * c + root;
  return {
    b0: (A * ((A + 1) + (A - 1) * c + root)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * c)) / a0,
    b2: (A * ((A + 1) + (A - 1) * c - root)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * c)) / a0,
    a2: ((A + 1) - (A - 1) * c - root) / a0,
  };
}

function filterSample(sample, coefficients, state) {
  const output = coefficients.b0 * sample + coefficients.b1 * state.x1 + coefficients.b2 * state.x2
    - coefficients.a1 * state.y1 - coefficients.a2 * state.y2;
  state.x2 = state.x1; state.x1 = sample; state.y2 = state.y1; state.y1 = output;
  return output;
}

function measureLoudness(channels, sampleRate) {
  const blockSize = Math.max(1, Math.floor(sampleRate * 0.4));
  const blocks = new Float64Array(Math.ceil(channels[0].length / blockSize));
  const counts = new Uint32Array(blocks.length);
  const highPass = makeHighPass(sampleRate, 38.135470876, 0.500327);
  const shelf = makeHighShelf(sampleRate, 1681.97445, 3.99984, 0.707175);
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    const input = channels[channelIndex];
    const hpState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    const shelfState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    const weight = channels.length > 2 && channelIndex >= 4 ? 1.41 : 1;
    for (let i = 0; i < input.length; i++) {
      const weighted = filterSample(filterSample(input[i], highPass, hpState), shelf, shelfState);
      const block = Math.floor(i / blockSize);
      blocks[block] += weighted * weighted * weight;
      counts[block] += weight;
    }
  }
  const energies = Array.from(blocks, (sum, i) => sum / Math.max(1, counts[i]));
  const blockLufs = energies.map(energyToLufs);
  const absoluteGated = energies.filter((energy, i) => energyToLufs(energy) >= -70);
  if (!absoluteGated.length) return { integrated: null, shortTerm: [] };
  const relativeGate = energyToLufs(average(absoluteGated)) - 10;
  const gated = energies.filter((energy, i) => blockLufs[i] >= Math.max(-70, relativeGate));
  const integrated = energyToLufs(average(gated));
  const windowBlocks = Math.max(1, Math.round(3 / 0.4));
  const shortTerm = [];
  for (let start = 0; start + windowBlocks <= energies.length; start += 2) {
    const energy = average(energies.slice(start, start + windowBlocks));
    const lufs = energyToLufs(energy);
    if (lufs >= -70) shortTerm.push(lufs);
  }
  return { integrated, shortTerm };
}

function detectTempo(channels, sampleRate) {
  const hop = Math.max(1, Math.floor(sampleRate * 0.05));
  const frames = Math.min(Math.floor(channels[0].length / hop), 3600);
  if (frames < 40) return { bpm: null, confidence: 0 };
  const energy = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * hop, end = Math.min(start + hop, channels[0].length);
    let sum = 0, count = 0;
    for (const channel of channels) for (let i = start; i < end; i += 4) { sum += channel[i] * channel[i]; count++; }
    energy[frame] = Math.sqrt(sum / Math.max(1, count));
  }
  const onset = new Float32Array(frames);
  for (let i = 1; i < frames; i++) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
  const scores = [];
  for (let lag = 7; lag <= 40; lag++) {
    let dot = 0, a2 = 0, b2 = 0;
    for (let i = lag; i < frames; i++) { dot += onset[i] * onset[i - lag]; a2 += onset[i] ** 2; b2 += onset[i - lag] ** 2; }
    scores.push({ lag, score: dot / Math.sqrt(Math.max(1e-15, a2 * b2)) });
  }
  scores.sort((a, b) => b.score - a.score);
  if (!scores.length || scores[0].score < 0.08) return { bpm: null, confidence: 0 };
  let bpm = 60 / (scores[0].lag * 0.05);
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const runnerUp = scores.find((item) => Math.abs(item.lag - scores[0].lag) > 2)?.score || 0;
  return { bpm: Math.round(bpm), confidence: Math.max(0, Math.min(1, (scores[0].score - runnerUp) * 4)) };
}

function fft(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, angle = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let j = 0; j < half; j++) {
        const wr = Math.cos(angle * j), wi = Math.sin(angle * j), even = start + j, odd = even + half;
        const tr = wr * real[odd] - wi * imag[odd], ti = wr * imag[odd] + wi * real[odd];
        real[odd] = real[even] - tr; imag[odd] = imag[even] - ti;
        real[even] += tr; imag[even] += ti;
      }
    }
  }
}

function fftFrame(channels, start, size, sampleRate) {
  const real = new Float64Array(size), imag = new Float64Array(size);
  const length = channels[0].length;
  for (let i = 0; i < size; i++) {
    const position = Math.min(length - 1, start + i);
    let sample = 0;
    for (const channel of channels) sample += channel[position] || 0;
    real[i] = (sample / channels.length) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  fft(real, imag);
  const mags = new Float32Array(size >> 1);
  for (let i = 0; i < mags.length; i++) mags[i] = Math.hypot(real[i], imag[i]) / size;
  return mags;
}

function analyzeSpectrum(channels, sampleRate) {
  const size = 4096, length = channels[0].length, frames = 72;
  const averageMagnitude = new Float64Array(size >> 1), chroma = new Float64Array(12);
  const specColumns = 72, specRows = 72, spectrogram = new Uint8Array(specColumns * specRows);
  for (let frame = 0; frame < frames; frame++) {
    const center = Math.floor((frame / Math.max(1, frames - 1)) * Math.max(0, length - size));
    const mags = fftFrame(channels, center, size, sampleRate);
    for (let bin = 1; bin < mags.length; bin++) {
      averageMagnitude[bin] += mags[bin];
      const hz = (bin * sampleRate) / size;
      if (hz >= 55 && hz <= 5000) {
        const midi = Math.round(69 + 12 * Math.log2(hz / 440));
        if (midi >= 0) chroma[midi % 12] += mags[bin] * mags[bin];
      }
    }
    const col = Math.floor((frame / frames) * specColumns);
    for (let row = 0; row < specRows; row++) {
      const hz = 40 * Math.pow(2, (row / (specRows - 1)) * Math.log2(16000 / 40));
      const bin = Math.max(1, Math.min(mags.length - 1, Math.round((hz * size) / sampleRate)));
      spectrogram[(specRows - row - 1) * specColumns + col] = Math.min(255, Math.max(0, Math.round((toDb(mags[bin]) + 85) * 3)));
    }
  }
  const spectrum = new Float32Array(256);
  for (let i = 0; i < spectrum.length; i++) {
    const bin = Math.max(1, Math.min(averageMagnitude.length - 1, Math.round(Math.pow(i / 255, 2) * (averageMagnitude.length - 1))));
    spectrum[i] = toDb(averageMagnitude[bin] / frames);
  }
  const detected = detectKey(chroma);
  return { spectrum, spectrogram, ...detected };
}

function detectKey(chroma) {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const profiles = [
    [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],
    [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17],
  ];
  const mean = average(Array.from(chroma));
  const centered = Array.from(chroma, (v) => v - mean);
  const candidates = [];
  for (let tonic = 0; tonic < 12; tonic++) for (let mode = 0; mode < 2; mode++) {
    let dot = 0, a2 = 0, b2 = 0;
    for (let i = 0; i < 12; i++) {
      const p = profiles[mode][(i - tonic + 12) % 12], pc = p - average(profiles[mode]);
      dot += centered[i] * pc; a2 += centered[i] ** 2; b2 += pc ** 2;
    }
    candidates.push({ score: dot / Math.sqrt(Math.max(1e-15, a2 * b2)), label: `${names[tonic]} ${mode ? "minor" : "major"}` });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length || !Number.isFinite(candidates[0].score)) return { key: "Not detected", keyConfidence: 0 };
  return { key: candidates[0].label, keyConfidence: Math.max(0, Math.min(1, candidates[0].score - (candidates[1]?.score || 0))) };
}

function qualityScore({ bitrate, sampleRate, peakDb, clipped, samples, loudness, lra }) {
  let score = 100;
  if (bitrate && bitrate < 128000) score -= 22;
  else if (bitrate && bitrate < 192000) score -= 14;
  else if (bitrate && bitrate < 256000) score -= 7;
  if (sampleRate < 32000) score -= 14;
  else if (sampleRate < 44100) score -= 7;
  const clipRatio = clipped / Math.max(1, samples);
  if (clipRatio > 0.0001) score -= 25;
  else if (clipped) score -= 8;
  if (peakDb > -0.1) score -= 8;
  if (lra > 0 && lra < 2) score -= 8;
  if (loudness !== null && loudness > -7) score -= 6;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] || 0;
}
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function toDb(value) { return value > 0 ? 20 * Math.log10(value) : -120; }
function energyToLufs(value) { return value > 0 ? -0.691 + 10 * Math.log10(value) : -120; }
