import io
import resource
from uuid import uuid4

import pytest
from reportlab.pdfgen import canvas

from safetyproof import pdf
from safetyproof.worker import isolated_pdf


@pytest.mark.parametrize("platform, memory_limited", [("darwin", False), ("linux", True)])
def test_platform_limits_preserve_cpu_and_linux_memory_cap(monkeypatch, platform, memory_limited):
    calls = []
    monkeypatch.setattr(pdf.sys, "platform", platform)
    monkeypatch.setattr(resource, "getrlimit", lambda kind: (resource.RLIM_INFINITY, resource.RLIM_INFINITY))
    monkeypatch.setattr(resource, "setrlimit", lambda kind, limits: calls.append((kind, limits)))
    pdf.configure_parser_limits()
    assert (resource.RLIMIT_CPU, (80, 85)) in calls
    assert any(kind == resource.RLIMIT_AS for kind, _ in calls) == memory_limited


def test_existing_stricter_limit_is_never_raised(monkeypatch):
    calls = []
    monkeypatch.setattr(pdf.sys, "platform", "linux")
    monkeypatch.setattr(resource, "getrlimit", lambda kind: (10, 20))
    monkeypatch.setattr(resource, "setrlimit", lambda kind, limits: calls.append(limits))
    pdf.configure_parser_limits()
    assert calls == [(10, 20), (10, 20)]


@pytest.mark.asyncio
async def test_real_isolated_parser_can_start_and_read_a_cap():
    output = io.BytesIO()
    document = canvas.Canvas(output)
    document.drawString(50, 750, "Corrective Action Plan - September inspection")
    document.drawString(50, 720, "Factory test record: clear emergency exit E-02.")
    document.save()
    parsed = await isolated_pdf(output.getvalue(), str(uuid4()), "unused-for-digital-pdf", 0, 8)
    assert parsed["total_pages"] == parsed["readable_pages"] == 1
    assert "Corrective Action Plan" in parsed["pages"][0]["text"]
