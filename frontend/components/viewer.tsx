"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, message, Ref } from "@/lib/api";
import { Busy, ErrorNote, Modal } from "./ui";

export type Preview = {
  title: string;
  version?: string;
  correctiveEvidence?: string;
  sample?: string;
  anchor?: Ref;
};
export function Viewer({
  item,
  token,
  close,
}: {
  item: Preview;
  token?: string;
  close: () => void;
}) {
  const [page, setPage] = useState(item.anchor?.page || 1);
  const [total, setTotal] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const url = useQuery({
    queryKey: ["source", item.version, item.sample, item.correctiveEvidence],
    queryFn: async () =>
      item.sample
        ? "/factory-documents/" + encodeURIComponent(item.sample)
        : (
            await api<{ url: string }>(
              item.correctiveEvidence
                ? "/v1/corrective-evidence/" +
                    item.correctiveEvidence +
                    "/source"
                : "/v1/document-versions/" + item.version + "/source",
              token,
            )
          ).url,
    staleTime: 180000,
  });
  useEffect(() => {
    if (!url.data) return;
    let active = true;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    async function draw() {
      setBusy(true);
      setError("");
      try {
        const pdfjs = await import("pdfjs-dist");
        if (!active) return;
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        task = pdfjs.getDocument({
          url: url.data,
          isEvalSupported: false,
          useSystemFonts: true,
        });
        const doc = await task.promise;
        if (!active) return;
        setTotal(doc.numPages);
        const p = await doc.getPage(page);
        if (!active || !canvas.current) return;
        const view = p.getViewport({ scale: 1.5 });
        const el = canvas.current;
        el.width = view.width;
        el.height = view.height;
        await p.render({ canvas: el, viewport: view }).promise;
        if (active) setBusy(false);
      } catch (e) {
        if (active) {
          setError(message(e));
          setBusy(false);
        }
      }
    }
    void draw();
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [page, url.data]);
  return (
    <Modal title={item.title} close={close} wide>
      <div className="viewer-tools">
        <button
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span>
          Page {page} of {total}
        </span>
        <button
          aria-label="Next page"
          disabled={page >= total}
          onClick={() => setPage((p) => p + 1)}
        >
          <ChevronRight size={16} />
        </button>
        {url.data && (
          <a
            className="text-button"
            href={url.data + "#page=" + page}
            target="_blank"
            rel="noreferrer"
          >
            Open PDF <ExternalLink size={14} />
          </a>
        )}
      </div>
      {(url.isLoading || busy) && <Busy text="Rendering source page…" />}
      {(error || url.error) && (
        <>
          <ErrorNote text={error || message(url.error)} />
          <button onClick={() => void url.refetch()}>
            Refresh source link
          </button>
        </>
      )}
      <div className="paper-wrap">
        <div className="paper-canvas">
          <canvas ref={canvas} aria-label={"Original PDF page " + page} />
          {!busy &&
            item.anchor?.page === page &&
            item.anchor.boxes.map(([x, y, r, b], i) => (
              <i
                className="highlight"
                key={i}
                style={{
                  left: 100 * x + "%",
                  top: 100 * y + "%",
                  width: 100 * (r - x) + "%",
                  height: 100 * (b - y) + "%",
                }}
              />
            ))}
        </div>
      </div>
      {item.anchor && (
        <blockquote className="citation">{item.anchor.quote}</blockquote>
      )}
    </Modal>
  );
}
