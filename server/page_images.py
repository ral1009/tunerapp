"""Turns whatever the user uploaded into page images HOMR can read.

No FastAPI imports, same convention as homr_runner.py. HOMR opens images with OpenCV, which reads
JPEG, PNG, BMP, TIFF and WebP but not:

- PDF (a printed part from IMSLP, a scan from the printer) -- every page is rendered to PNG with
  pdfium at ~300 dpi, capped so the long edge stays near what HOMR reads well.
- HEIC/HEIF (iPhone photos) and AVIF -- decoded with pillow-heif / Pillow.
- DNG (a Pixel, or any phone, in RAW mode) -- developed with rawpy (LibRaw) using the camera's
  white balance.

Google Pixel's ordinary photos are "Ultra HDR" JPEGs: a normal JPEG with a gain map tucked in
after it, so every JPEG decoder (OpenCV included) reads the base picture. They pass straight
through, like any other JPEG or PNG, so those uploads reach HOMR byte-for-byte as before.

The type is sniffed from the file's first bytes, not trusted from its name: phones send HEIC
under a .jpg name more often than you'd think.
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("page_images")

# Long edge for converted pages. The phone app shrinks photos to 2200 px; a printed PDF page at
# 300 dpi is ~3500 px, which only makes HOMR slower without reading more.
MAX_EDGE = 2600
PDF_DPI = 300
MAX_PDF_PAGES = 20


class UnsupportedUpload(Exception):
    """The upload isn't a format we can turn into a page; the message is for the user."""


def sniff(head: bytes, name: str) -> str:
    """Best guess at the upload's real type from its leading bytes."""
    if head.startswith(b"%PDF"):
        return "pdf"
    if head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if head.startswith(b"\x89PNG"):
        return "png"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"avif", b"avis"):
            return "avif"
        return "heif"  # heic, heix, mif1, msf1, hevc...
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        # DNG is a TIFF underneath; the extension is the cheap way to tell them apart.
        return "dng" if name.lower().endswith(".dng") else "tiff"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:2] == b"BM":
        return "bmp"
    return "unknown"


def _save(image, path: Path) -> Path:
    from PIL import Image

    if max(image.size) > MAX_EDGE:
        image.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    image.save(path, format="PNG")
    return path


def _open_with_pillow(path: Path):
    from PIL import Image, ImageOps

    image = Image.open(path)
    image.load()
    # Phones store "rotate this" in EXIF rather than rotating the pixels; OpenCV only honours that
    # for JPEG, so anything converted here has to be turned the right way up first.
    return ImageOps.exif_transpose(image)


def to_pages(upload: Path) -> list[Path]:
    """Page images for HOMR, in order. JPEG/PNG come back unchanged (the same file)."""
    head = upload.read_bytes()[:32]
    kind = sniff(head, upload.name)
    out_dir = upload.parent

    if kind in ("jpeg", "png"):
        return [upload]

    if kind == "pdf":
        import pypdfium2 as pdfium

        try:
            pdf = pdfium.PdfDocument(str(upload))
        except pdfium.PdfiumError as error:
            raise UnsupportedUpload("That PDF couldn't be opened (is it password-protected?).") from error
        try:
            count = len(pdf)
            if count == 0:
                raise UnsupportedUpload("That PDF has no pages.")
            if count > MAX_PDF_PAGES:
                raise UnsupportedUpload(f"That PDF has {count} pages; send at most {MAX_PDF_PAGES} at a time.")
            pages = []
            for index in range(count):
                page = pdf[index]
                width, height = page.get_size()  # points, 1/72 inch
                scale = min(PDF_DPI / 72, MAX_EDGE / max(width, height))
                image = page.render(scale=scale, grayscale=True).to_pil()
                pages.append(_save(image, out_dir / f"converted-page-{index + 1:02d}.png"))
            return pages
        finally:
            pdf.close()

    if kind in ("heif", "avif"):
        import pillow_heif

        pillow_heif.register_heif_opener()  # Pillow reads AVIF itself; HEIC needs this
        return [_save(_open_with_pillow(upload), out_dir / "converted-page.png")]

    if kind == "dng":
        import rawpy
        from PIL import Image

        with rawpy.imread(str(upload)) as raw:
            rgb = raw.postprocess(use_camera_wb=True, output_bps=8)
        # LibRaw has already applied the sensor's orientation flag.
        return [_save(Image.fromarray(rgb), out_dir / "converted-page.png")]

    if kind in ("tiff", "webp", "bmp", "unknown"):
        try:
            image = _open_with_pillow(upload)
        except Exception as error:  # noqa: BLE001
            raise UnsupportedUpload(
                "That file isn't a picture or PDF we can read. Send a photo (JPEG, PNG, HEIC, DNG) or a PDF."
            ) from error
        if getattr(image, "n_frames", 1) > 1:
            # A multi-page TIFF from a scanner: one page each.
            pages = []
            for index in range(min(image.n_frames, MAX_PDF_PAGES)):
                image.seek(index)
                pages.append(_save(image.copy(), out_dir / f"converted-page-{index + 1:02d}.png"))
            return pages
        return [_save(image, out_dir / "converted-page.png")]

    raise UnsupportedUpload("That file type isn't supported.")
