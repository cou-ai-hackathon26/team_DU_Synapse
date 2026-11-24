# Bundled runtime assets

`documents/` contains fictional records for Shaluk Threadworks Ltd., copied from
`fixtures/demo/`. Regenerate with `scripts/make_fixtures.py` and copy updates to this directory
when changing the public document library.

`tessdata/eng.traineddata` and `tessdata/ben.traineddata` come from the
[Tesseract tessdata_fast repository](https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd)
at commit `87416418657359cb625c412a48b6e1d6d41c29bd`, under the Apache License 2.0.
The files are bundled to make English and Bangla OCR available on serverless deployments.
See `TESSDATA_LICENSE` for the license.
