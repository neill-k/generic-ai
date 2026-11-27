---
"@generic-ai/tools": minor
---

The read tool now resizes and converts images the way pi does. Images are scaled to fit 2000x2000 and 4.5 MB of base64 (trying PNG and JPEG, then lower JPEG quality, then smaller sizes) with a note that maps coordinates back to the original, EXIF orientation is applied, and formats such as BMP are converted to PNG instead of being omitted. Uses Photon (`@silvia-odwyer/photon-node`, WASM). `processImage`, `resizeImage`, `convertImageBytesToPng` and `formatDimensionNote` are exported.
