export function floatTo16BitPCM(float32Array: Float32Array): Int16Array {
  const int16Array = new Int16Array(float32Array.length)
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16Array
}

export function float32ToBase64PCM(float32Array: Float32Array): string {
  const int16Array = floatTo16BitPCM(float32Array)
  const uint8Array = new Uint8Array(int16Array.buffer)
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, uint8Array.subarray(i, i + chunkSize) as any)
  }
  return btoa(binary)
}

export function base64ToFloat32(base64String: string): Float32Array {
  if (!base64String) return new Float32Array(0)

  let binaryString: string
  try {
    binaryString = atob(base64String)
  } catch {
    // Malformed base64 — return silence rather than throwing.
    return new Float32Array(0)
  }

  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  // Int16Array requires an even byte length; drop a trailing odd byte so a
  // truncated/corrupt chunk can't throw a RangeError on construction.
  const sampleCount = Math.floor(bytes.byteLength / 2)
  if (sampleCount === 0) return new Float32Array(0)

  const int16Array = new Int16Array(bytes.buffer, 0, sampleCount)
  const float32Array = new Float32Array(int16Array.length)
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0
  }
  return float32Array
}

export function downsampleTo16000(
  float32Array: Float32Array,
  inputSampleRate: number
): Float32Array {
  if (inputSampleRate === 16000) return float32Array

  const compression = inputSampleRate / 16000
  const length = Math.floor(float32Array.length / compression)
  const result = new Float32Array(length)

  let index = 0
  let inputIndex = 0

  while (index < length) {
    result[index] = float32Array[Math.floor(inputIndex)]
    inputIndex += compression
    index++
  }
  return result
}

/**
 * Encode mono Float32 PCM into a base64 16-bit WAV (RIFF) container.
 * Used to POST microphone audio to the Brain Node's /asr endpoint, which
 * expects a WAV file. Defaults to 16 kHz (Whisper's native rate).
 */
export function float32ToWavBase64(samples: Float32Array, sampleRate = 16000): string {
  const numSamples = samples.length
  const dataBytes = numSamples * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const writeStr = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  // RIFF header
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeStr(8, 'WAVE')
  // fmt chunk
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // audio format = PCM
  view.setUint16(22, 1, true) // channels = mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate = sampleRate * blockAlign
  view.setUint16(32, 2, true) // block align = channels * bytesPerSample
  view.setUint16(34, 16, true) // bits per sample
  // data chunk
  writeStr(36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as any)
  }
  return btoa(binary)
}
