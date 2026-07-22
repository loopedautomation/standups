import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import { LoopedTtyClient, type TtyServerFrame } from "./looped-tty.js"

let server: WebSocketServer
let port: number
let receivedProtocols: string[] = []

function frames(reply: string): TtyServerFrame[] {
  return [
    { type: "step", n: 1 },
    { type: "tool_call", name: "http", arguments: '{"url":"x"}' },
    { type: "tool_result", name: "http", content: "ok", durationMs: 12 },
    { type: "assistant", content: reply },
    { type: "result", status: "ok", reply, steps: 1 },
  ]
}

beforeEach(async () => {
  server = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  port = (server.address() as { port: number }).port
  receivedProtocols = []
  server.on("connection", (socket, request) => {
    receivedProtocols.push(request.headers["sec-websocket-protocol"] ?? "")
    socket.send(
      JSON.stringify({
        type: "hello",
        handle: "mock",
        conversation_id: "c1",
      } satisfies TtyServerFrame),
    )
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { type: string; text: string }
      if (frame.type !== "input") {
        socket.send(JSON.stringify({ type: "error", error: "bad frame" }))
        return
      }
      for (const f of frames(`you said: ${frame.text}`)) {
        socket.send(JSON.stringify(f))
      }
    })
  })
})

afterEach(() => {
  server.close()
})

describe("LoopedTtyClient", () => {
  it("streams a full turn of frames and terminates on result", async () => {
    const client = new LoopedTtyClient({
      url: `ws://127.0.0.1:${port}/tty`,
      token: "secret",
      conversationId: "room-scout",
    })
    const seen: TtyServerFrame[] = []
    for await (const frame of client.runTurn("Alice: hello")) {
      seen.push(frame)
    }
    client.close()

    expect(seen.map((f) => f.type)).toEqual([
      "step",
      "tool_call",
      "tool_result",
      "assistant",
      "result",
    ])
    const assistant = seen.find((f) => f.type === "assistant")
    expect(assistant).toMatchObject({ content: "you said: Alice: hello" })
    expect(receivedProtocols[0]).toBe("bearer.secret")
  })

  it("sends images along with the input frame", async () => {
    let received: unknown
    server.removeAllListeners("connection")
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        received = JSON.parse(String(data))
        socket.send(
          JSON.stringify({
            type: "result",
            status: "ok",
            reply: "seen",
            steps: 1,
          }),
        )
      })
    })
    const client = new LoopedTtyClient({
      url: `ws://127.0.0.1:${port}/tty`,
      token: "secret",
      conversationId: "room-scout",
    })
    const types: string[] = []
    for await (const frame of client.runTurn("look at this", [
      { mediaType: "image/jpeg", data: "aGVsbG8=" },
    ])) {
      types.push(frame.type)
    }
    client.close()
    expect(types).toEqual(["result"])
    expect(received).toMatchObject({
      type: "input",
      text: "look at this",
      images: [{ mediaType: "image/jpeg", data: "aGVsbG8=" }],
    })
  })

  it("supports sequential turns on one connection", async () => {
    const client = new LoopedTtyClient({
      url: `ws://127.0.0.1:${port}/tty`,
      token: "secret",
      conversationId: "room-scout",
    })
    for (const input of ["one", "two"]) {
      const types: string[] = []
      for await (const frame of client.runTurn(input)) types.push(frame.type)
      expect(types.at(-1)).toBe("result")
    }
    client.close()
    expect(receivedProtocols).toHaveLength(1)
  })

  it("queues a turn started while another is in flight", async () => {
    const client = new LoopedTtyClient({
      url: `ws://127.0.0.1:${port}/tty`,
      token: "secret",
      conversationId: "room-scout",
    })
    const first = client.runTurn("a")
    await first.next()
    const secondTypes: string[] = []
    const second = (async () => {
      for await (const frame of client.runTurn("b")) {
        secondTypes.push(frame.type)
      }
    })()
    // The queued turn only starts once the first finishes.
    expect(secondTypes).toHaveLength(0)
    for await (const _ of first) {
      // drain
    }
    await second
    expect(secondTypes.at(-1)).toBe("result")
    client.close()
  })

  it("abortTurn cancels the in-flight turn; the next turn reconnects", async () => {
    server.removeAllListeners("connection")
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data)) as { text: string }
        if (frame.text === "hang") return // a run that never finishes
        for (const f of frames(`you said: ${frame.text}`)) {
          socket.send(JSON.stringify(f))
        }
      })
    })
    const client = new LoopedTtyClient({
      url: `ws://127.0.0.1:${port}/tty`,
      token: "secret",
      conversationId: "room-scout",
    })
    const hung = (async () => {
      for await (const _ of client.runTurn("hang")) {
        // no frames expected
      }
    })()
    setTimeout(() => client.abortTurn(), 50)
    await expect(hung).rejects.toThrow(/cancelled/)

    const types: string[] = []
    for await (const frame of client.runTurn("ok")) types.push(frame.type)
    expect(types.at(-1)).toBe("result")
    client.close()
  })

  it("retries once when a reused socket dies before any frame", async () => {
    let dropNext = false
    server.removeAllListeners("connection")
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data)) as { text: string }
        if (dropNext) {
          dropNext = false
          socket.close()
          return
        }
        for (const f of frames(`you said: ${frame.text}`)) {
          socket.send(JSON.stringify(f))
        }
      })
    })
    const client = new LoopedTtyClient({
      url: `ws://127.0.0.1:${port}/tty`,
      token: "secret",
      conversationId: "room-scout",
    })
    // First turn establishes the connection the second will reuse.
    for await (const _ of client.runTurn("one")) {
      // drain
    }
    // The server drops the reused socket on the next input — the turn
    // reconnects fresh and succeeds instead of surfacing the dead socket.
    dropNext = true
    const types: string[] = []
    for await (const frame of client.runTurn("two")) types.push(frame.type)
    expect(types.at(-1)).toBe("result")
    client.close()
  })

  it("errors when the connection closes mid-turn", async () => {
    const client = new LoopedTtyClient({
      url: `ws://127.0.0.1:${port}/tty`,
      token: "secret",
      conversationId: "room-scout",
      turnTimeoutMs: 2000,
    })
    // Server that closes immediately after input.
    server.removeAllListeners("connection")
    server.on("connection", (socket) => {
      socket.on("message", () => socket.close())
    })
    await expect(async () => {
      for await (const _ of client.runTurn("boom")) {
        // no frames expected
      }
    }).rejects.toThrow(/closed/)
    client.close()
  })
})
