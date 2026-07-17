import { RoomServiceClient } from "livekit-server-sdk"

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export function livekitEnv() {
  return {
    apiKey: required("LIVEKIT_API_KEY"),
    apiSecret: required("LIVEKIT_API_SECRET"),
    /** Server-to-server URL, e.g. http://livekit:7880 */
    url: required("LIVEKIT_URL"),
    /** Browser-facing WebSocket URL, e.g. ws://localhost:7880 */
    publicUrl: required("LIVEKIT_PUBLIC_URL"),
  }
}

let client: RoomServiceClient | null = null

export function roomService(): RoomServiceClient {
  if (!client) {
    const { url, apiKey, apiSecret } = livekitEnv()
    client = new RoomServiceClient(
      url.replace(/^ws/, "http"),
      apiKey,
      apiSecret,
    )
  }
  return client
}
