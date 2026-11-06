(() => {
  const MAX_ANALYSIS_BYTES = 25 * 1024 * 1024;

  async function analyze(file, onStatus = () => {}) {
    if (!file) throw new Error("Choose an MP3 or M4A file first.");
    if (file.size > MAX_ANALYSIS_BYTES) {
      throw new Error("This browser analysis is limited to 25 MB per track to protect device memory. You can still edit and export files up to 50 MB.");
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !window.Worker) {
      throw new Error("Local audio analysis is not supported by this browser. Try a current desktop or mobile browser.");
    }

    let context;
    try {
      onStatus("Decoding audio locally…");
      context = new AudioContextClass();
      const encoded = await file.arrayBuffer();
      const buffer = await context.decodeAudioData(encoded);
      const channels = [];
      const transfer = [];
      for (let index = 0; index < buffer.numberOfChannels; index++) {
        const samples = buffer.getChannelData(index);
        const copy = new Float32Array(samples);
        channels.push(copy.buffer);
        transfer.push(copy.buffer);
      }
      onStatus("Measuring waveform, loudness, tempo, and key…");
      const result = await runWorker({
        channels,
        sampleRate: buffer.sampleRate,
        fileSize: file.size,
        format: file.name.split(".").pop().toUpperCase(),
      }, transfer);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("This browser")) throw error;
      throw new Error("This browser could not decode the track. Try a valid MP3 or M4A file in a current browser.");
    } finally {
      if (context && context.state !== "closed") {
        try { await context.close(); } catch (_) { /* browser may have closed it already */ }
      }
    }
  }

  function runWorker(payload, transfer) {
    return new Promise((resolve, reject) => {
      const worker = new Worker("/static/audio-analysis-worker.js");
      const timeout = window.setTimeout(() => {
        worker.terminate();
        reject(new Error("Analysis timed out. Try a shorter track."));
      }, 180000);
      worker.onmessage = ({ data }) => {
        window.clearTimeout(timeout);
        worker.terminate();
        if (data.ok) resolve(data.metrics);
        else reject(new Error(data.error || "Analysis failed."));
      };
      worker.onerror = () => {
        window.clearTimeout(timeout);
        worker.terminate();
        reject(new Error("Analysis failed in the background worker."));
      };
      worker.postMessage(payload, transfer);
    });
  }

  window.MetatuneAudioAnalysis = { analyze, maxFileBytes: MAX_ANALYSIS_BYTES };
})();
