// The full image of a message attachment, in a modal. The kit's attachment cards open only pasted text, so the chat
// catches clicks on attachment images (imageClicked) and shows them here.
import { Modal } from "agentic-ui-kit";
import type { MouseEvent } from "react";

export interface ViewedImage { src: string; alt: string }

/** The image of an attachment card that was clicked, else undefined. Images in links (markdown) keep the link. */
export function imageClicked(event: MouseEvent): ViewedImage | undefined {
  const target = event.target;
  if (!(target instanceof HTMLImageElement) || !target.src) return undefined;
  if (!target.closest("ul > li") || target.closest("a, button")) return undefined;
  return { src: target.currentSrc || target.src, alt: target.alt };
}

export function ImageViewer({ image, onClose }: { image: ViewedImage | null; onClose: () => void }) {
  return (
    <Modal isOpen={image !== null} onOpenChange={(open) => !open && onClose()} aria-label={image?.alt || "Image"}
      className="w-auto! max-w-[min(1200px,calc(100vw-2rem))]! overflow-hidden p-0">
      {image && <img src={image.src} alt={image.alt} className="block max-h-[85dvh] max-w-full object-contain" />}
    </Modal>
  );
}
