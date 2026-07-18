"use client"

import {
  ToastContainer as ReactToastifyContainer,
  type ToastContainerProps,
} from "react-toastify"
import "react-toastify/dist/ReactToastify.css"
import {
  BadgeCheck,
  CircleCheck,
  CircleX,
  Info,
  TriangleAlert,
} from "lucide-react"

export type { ToastContainerProps }

/**
 * Shared toast container component with consistent styling across all apps.
 * Uses react-toastify with DaisyUI/Tailwind styling.
 */
export function ToastContainer(props: Partial<ToastContainerProps>) {
  return (
    <ReactToastifyContainer
      position="top-center"
      hideProgressBar={true}
      closeOnClick={true}
      autoClose={3000}
      closeButton={false}
      draggable={true}
      icon={({ type }) => {
        switch (type) {
          case "info":
            return <Info className="stroke-info" />
          case "error":
            return <CircleX className="stroke-error" />
          case "success":
            return <CircleCheck className="stroke-success" />
          case "warning":
            return <TriangleAlert className="stroke-warning" />
          default:
            return <BadgeCheck className="stroke-primary" />
        }
      }}
      toastClassName={() =>
        `bg-base-200 shadow-md border border-base-300 text-base-content text-sm font-normal mb-2 relative flex flex-row px-4 py-3 min-h-10 rounded-field justify-start items-center overflow-hidden cursor-pointer`
      }
      {...props}
    />
  )
}
