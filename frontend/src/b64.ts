// UTF-8 安全的 base64：终端 I/O 是原始字节流（可能含多字节转义序列与
// 中文输出），不能走 atob/btoa 的 latin1 路径。

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function encodeText(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

export function decodeText(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64))
}

// createStreamDecoder 返回跨响应块保持状态的 UTF-8 解码器：
// 终端输出按字节分块传输，多字节字符（中文/emoji）可能被切在两块之间，
// 逐块独立 decode 会把它们解成 U+FFFD 乱码。
export function createStreamDecoder(): (base64Chunk: string) => string {
  const decoder = new TextDecoder()
  return (base64Chunk: string) => decoder.decode(base64ToBytes(base64Chunk), { stream: true })
}
