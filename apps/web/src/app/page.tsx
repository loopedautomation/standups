import { Bot, MessagesSquare, Wrench } from "lucide-react"
import { Wordmark } from "@/components/brand/BrandMark"
import { ThemeToggle } from "@/components/brand/ThemeToggle"
import { HomeActions } from "@/components/home/HomeActions"

const features = [
  {
    icon: Bot,
    title: "Agents in the room",
    body: "Invite a looped agent as a real participant — it listens, speaks, and can be interrupted like anyone else.",
  },
  {
    icon: Wrench,
    title: "Watch the work",
    body: "Tool calls stream live into the meeting while the agent researches, runs code, or files issues mid-call.",
  },
  {
    icon: MessagesSquare,
    title: "Yours to host",
    body: "One docker compose up. No accounts, no vendor lock-in — share a link and meet.",
  },
]

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <Wordmark />
        <ThemeToggle />
      </header>

      <section className="flex flex-1 flex-col items-center justify-center gap-8 py-16 text-center">
        <span className="badge badge-soft badge-primary">
          Open source · self-hosted
        </span>
        <h1 className="max-w-2xl text-balance font-semibold text-4xl tracking-tight sm:text-5xl">
          Give your agents a voice in your next meeting
        </h1>
        <p className="max-w-xl text-balance text-base-content/70 text-lg">
          And let them be part of the conversation. Open-source video calls with
          first-class AI participants, powered by the looped agent framework.
        </p>
        <HomeActions />
      </section>

      <section className="grid gap-6 pb-16 sm:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="card card-border bg-base-200/20">
            <div className="card-body">
              <f.icon className="size-6 text-primary" />
              <h2 className="card-title text-base">{f.title}</h2>
              <p className="text-base-content/70 text-sm">{f.body}</p>
            </div>
          </div>
        ))}
      </section>

      <footer className="border-base-300 border-t py-6 text-center text-base-content/50 text-sm">
        looped meet — open source, self-hosted.
      </footer>
    </main>
  )
}
