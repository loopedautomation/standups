import type { Metadata } from "next"
import type { ReactNode } from "react"
import "@/styles/globals.css"

export const metadata: Metadata = {
  title: "Looped Standups",
  description:
    "Open-source meeting rooms with first-class AI agent participants",
}

const themeInit = `
try {
  const stored = localStorage.getItem("theme")
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches
  document.documentElement.dataset.theme =
    stored ?? (dark ? "looped-dark" : "looped-light")
} catch {}
`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="looped-light" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme bootstrap */}
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-dvh bg-base-100 text-base-content antialiased">
        {children}
      </body>
    </html>
  )
}
