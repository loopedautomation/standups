"use client"

import type { CreateRoomResponse } from "@meet/shared"
import { ArrowRight, KeyRound, Video } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "react-toastify"
import { Modal } from "@/components/ui/Modal"

const PASSWORD_KEY = "managementPassword"

export function HomeActions() {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  // Deployments with a management password gate meeting creation; the
  // password is remembered locally after the first successful use.
  const [needsPassword, setNeedsPassword] = useState(false)
  const [password, setPassword] = useState("")

  const createRoom = async (pw: string) => {
    setCreating(true)
    setError(null)
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: pw ? { "x-management-password": pw } : {},
      })
      if (res.status === 401) {
        try {
          localStorage.removeItem(PASSWORD_KEY)
        } catch {}
        setNeedsPassword(true)
        if (pw) setError("Wrong management password.")
        setCreating(false)
        return
      }
      if (!res.ok) throw new Error(`room creation failed (${res.status})`)
      if (pw) {
        try {
          localStorage.setItem(PASSWORD_KEY, pw)
        } catch {}
      }
      const data = (await res.json()) as CreateRoomResponse
      router.push(`/r/${data.slug}`)
    } catch {
      toast.error("Could not create a meeting. Is the server configured?")
      setCreating(false)
    }
  }

  const handleNewMeeting = () => {
    let stored = ""
    try {
      stored = localStorage.getItem(PASSWORD_KEY) ?? ""
    } catch {}
    void createRoom(stored)
  }

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault()
    const slug = code.trim().split("/").pop()
    if (slug) router.push(`/r/${slug}`)
  }

  // Light up the Join button once the input looks like a meeting code or a
  // link containing one (generated codes are 10 digits).
  const codeLooksValid = /^\d{10}$/.test(code.trim().split("/").pop() ?? "")

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex w-full max-w-sm flex-col items-stretch sm:w-auto sm:max-w-none sm:flex-row sm:items-center">
        <button
          type="button"
          className="btn btn-primary btn-brutalist w-full sm:w-auto"
          onClick={handleNewMeeting}
          disabled={creating}
        >
          {creating ? (
            <span className="loading loading-spinner loading-sm" />
          ) : (
            <Video className="size-5" />
          )}
          New meeting
        </button>
        <div className="divider my-3 text-base-content/50 text-xs sm:divider-horizontal sm:mx-4 sm:my-0">
          or
        </div>
        <form onSubmit={handleJoin} className="flex items-center gap-3">
          <input
            className="input w-full text-xs sm:w-56"
            placeholder="Enter a code or link"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            type="submit"
            className={`btn ${codeLooksValid ? "btn-primary btn-brutalist" : ""}`}
            disabled={!code.trim()}
          >
            Join
            <ArrowRight className="size-4" />
          </button>
        </form>
      </div>
      <Modal isOpen={needsPassword} onClose={() => setNeedsPassword(false)}>
        <h3 className="font-semibold text-lg">Management password</h3>
        <p className="py-2 text-base-content/70 text-sm">
          Creating meetings on this server needs the management password. It's
          remembered on this device after the first use.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (password) void createRoom(password)
          }}
        >
          <label className="input w-full">
            <KeyRound className="size-4 text-base-content/50" />
            <input
              type="password"
              placeholder="Management password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              // biome-ignore lint/a11y/noAutofocus: the modal exists solely for this field
              autoFocus
            />
          </label>
          {error && <p className="pt-2 text-error text-sm">{error}</p>}
          <div className="modal-action">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setNeedsPassword(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-brutalist"
              disabled={!password || creating}
            >
              {creating && (
                <span className="loading loading-spinner loading-xs" />
              )}
              Create meeting
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
