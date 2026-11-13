// The full image of a message attachment, in a modal. The kit's attachment cards open only pasted text, so the chat
// catches clicks on attachment images (imageClicked) and shows them here.
import { Modal } from "slop-ui-components";
import type { MouseEvent } from "react";

export interface ViewedImage { src: string; alt: string }

/** The image of an attachment card that was clicked, else undefined. Images in links (markdown) keep the link. */
export function imageClicked(event: MouseEvent): ViewedImage | undefined {
  const target = event.target;
  if (!(target instanceof HTMLImageElement) || !target.src) return undefined;
  if (!target.closest("ul > li") || target.closest("a, button")) return undefined;
  return { src: target.currentSrc || target.src, alt: target.alt };
}

/** The modal that shows `image` large. It is closed while `image` is null. */
export function ImageViewer({ image, onClose }: { image: ViewedImage | null; onClose: () => void }) {
  return (
    <Modal isOpen={image !== null} onOpenChange={(open) => !open && onClose()} title={image?.alt || "Image"} size="xl" flush>
      {image && <img src={image.src} alt={image.alt} className="block max-h-[75dvh] max-w-full self-center object-contain" />}
    </Modal>
  );
}
