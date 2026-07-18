"use client"

import type { ReactNode } from "react"
import { useEffect, useRef } from "react"

export interface ModalProps {
  /**
   * Whether the modal is open
   */
  isOpen: boolean
  /**
   * Callback when the modal should close
   */
  onClose: () => void
  /**
   * Modal content
   */
  children: ReactNode
  /**
   * Additional classes for the modal-box
   */
  className?: string
  /**
   * Position of the modal
   * @default "middle"
   */
  position?: "middle" | "bottom"
}

/**
 * Modal component using the native <dialog> element with showModal().
 *
 * Features:
 * - Uses native dialog element for proper accessibility
 * - Opens on top layer (no z-index management needed)
 * - ESC key to close (native behavior)
 * - Click outside to close (via form method="dialog" backdrop)
 * - Smooth open/close animations via DaisyUI CSS
 * - Respects prefers-reduced-motion automatically via CSS
 *
 * @example
 * ```tsx
 * <Modal isOpen={isOpen} onClose={() => setIsOpen(false)}>
 *   <h3 className="text-lg font-bold">Hello!</h3>
 *   <p className="py-4">Modal content here</p>
 *   <div className="modal-action">
 *     <button className="btn" onClick={() => setIsOpen(false)}>Close</button>
 *   </div>
 * </Modal>
 * ```
 */
export function Modal({
  isOpen,
  onClose,
  children,
  className = "",
  position = "middle",
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  // Sync isOpen state with dialog
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal()
      }
    } else {
      if (dialog.open) {
        dialog.close()
      }
    }
  }, [isOpen])

  // Handle native dialog close event (ESC key, form submission)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const handleClose = () => {
      onClose()
    }

    dialog.addEventListener("close", handleClose)
    return () => dialog.removeEventListener("close", handleClose)
  }, [onClose])

  const positionClass =
    position === "bottom" ? "modal-bottom sm:modal-middle" : "modal-middle"

  return (
    <dialog ref={dialogRef} className={`modal ${positionClass}`}>
      <div className={`modal-box modal-brutalist ${className}`}>{children}</div>
      <div
        className="modal-backdrop"
        onClick={() => dialogRef.current?.close()}
      ></div>
    </dialog>
  )
}
