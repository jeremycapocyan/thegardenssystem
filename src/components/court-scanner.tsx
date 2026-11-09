"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
export function CourtScanner({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;
    let stop: (() => void) | undefined;
    void import("@zxing/browser")
      .then(async ({ BrowserQRCodeReader }) => {
        const reader = new BrowserQRCodeReader();
        const controls = await reader.decodeFromVideoDevice(
          undefined,
          video.current!,
          (result, _error, controls) => {
            if (!result || !alive) return;
            try {
              const url = new URL(result.getText());
              if (
                url.origin !== window.location.origin ||
                url.pathname !== "/employee/scan/" ||
                !url.searchParams.get("court")
              )
                throw Error("Scan The Gardens court QR.");
              alive = false;
              controls.stop();
              window.location.assign(url.toString());
            } catch {
              setError(
                "This is not a valid Gardens attendance QR. Scan the printed code at the court.",
              );
            }
          },
        );
        stop = () => controls.stop();
        if (!alive) stop();
      })
      .catch(() => {
        if (alive)
          setError(
            "Camera could not start. Allow camera access, or scan the printed QR using your phone’s Camera app.",
          );
      });
    return () => {
      alive = false;
      stop?.();
    };
  }, []);
  return (
    <dialog
      className="record-dialog"
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="scanner-title"
    >
      <div className="dialog-heading">
        <h2 id="scanner-title">Scan the court QR</h2>
        <button
          className="icon-button"
          aria-label="Close scanner"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="scanner-body">
        <video ref={video} muted playsInline />
        <p>
          Point your camera at the printed court QR. You’ll choose Time In, Time
          Out, or a request next.
        </p>
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
