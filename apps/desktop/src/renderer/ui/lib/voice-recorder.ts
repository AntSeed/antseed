const TARGET_SAMPLE_RATE = 16_000;

export type VoiceRecording = {
  audio: ArrayBuffer;
  durationMs: number;
};

type RecordingState = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  stream: MediaStream;
  chunks: Float32Array[];
  inputSampleRate: number;
  startedAt: number;
};

let active: RecordingState | null = null;

function flatten(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function downsample(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] || 0;
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function encodeWav(samples: Float32Array): ArrayBuffer {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return buffer;
}

export async function startVoiceRecording(): Promise<void> {
  if (active) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('Audio recording is not supported in this browser.');
  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];

  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(context.destination);

  active = { context, source, processor, stream, chunks, inputSampleRate: context.sampleRate, startedAt: Date.now() };
}

export async function stopVoiceRecording(): Promise<VoiceRecording | null> {
  const current = active;
  if (!current) return null;
  active = null;
  current.processor.disconnect();
  current.source.disconnect();
  current.stream.getTracks().forEach((track) => track.stop());
  await current.context.close();
  const samples = downsample(flatten(current.chunks), current.inputSampleRate);
  return { audio: encodeWav(samples), durationMs: Date.now() - current.startedAt };
}

export async function cancelVoiceRecording(): Promise<void> {
  await stopVoiceRecording();
}
