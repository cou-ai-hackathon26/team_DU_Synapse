FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/backend \
    TESSDATA_PREFIX=/app/tessdata OMP_THREAD_LIMIT=1
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir --only-binary=pypdfium2,tesserocr,pillow -r backend/requirements.txt
RUN python -c 'from pathlib import Path; from urllib.request import urlretrieve; p=Path("/app/tessdata"); p.mkdir(); base="https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/"; [urlretrieve(base+lang+".traineddata", p/(lang+".traineddata")) for lang in ("eng","ben")]'
COPY backend/safetyproof backend/safetyproof
COPY fixtures/demo fixtures/demo
RUN useradd --system --no-create-home reviewer
USER reviewer
EXPOSE 10000
CMD ["sh","-c","exec uvicorn safetyproof.main:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1"]
