"""Incident summarization: turns a case's structured event timeline into a
plain-English report for investigators.

Kept strictly extractive/grounded per the design doc Sec 3 -- hallucination in
a legal summary is dangerous, so the default path is template-based and only
reorders/phrases facts that are already in the event JSON. An optional local
LLM (Ollama) can be wired in behind `settings.use_llm_summarizer` for nicer
prose, but every fact it uses is still sourced from the same event list.
"""

from config import get_settings


def _describe_event(event: dict) -> str:
    kind = event.get("type")
    ts = event.get("timestamp")
    if kind == "capture":
        return f"Evidence {event['evidence_id']} was captured by camera {event.get('camera_id', 'unknown')} at {ts}."
    if kind == "tamper":
        checks = event.get("result", {}).get("checks", {})
        flagged = [name for name, r in checks.items() if r.get("flagged")]
        if flagged:
            return f"Tamper check on {event['evidence_id']} at {ts} flagged: {', '.join(flagged)}."
        return f"Tamper check on {event['evidence_id']} at {ts} found no anomalies."
    if kind == "detection":
        count = len(event.get("result", {}).get("detections", []))
        return f"Object detection on {event['evidence_id']} at {ts} found {count} object(s)."
    if kind == "custody":
        return f"{event.get('actor', 'An investigator')} performed '{event.get('action')}' on {event['evidence_id']} at {ts}."
    return f"Event at {ts}: {event}"


def summarize_case(events: list[dict]) -> dict:
    ordered = sorted(events, key=lambda e: e.get("timestamp") or "")
    lines = [_describe_event(e) for e in ordered]

    settings = get_settings()
    if settings.use_llm_summarizer:
        try:
            return {"summary": _summarize_with_ollama(lines), "grounded_facts": lines, "engine": "ollama"}
        except Exception as exc:  # local LLM optional; fall back gracefully
            return {
                "summary": " ".join(lines),
                "grounded_facts": lines,
                "engine": "extractive-fallback",
                "llm_error": str(exc),
            }

    return {
        "summary": " ".join(lines) if lines else "No events recorded for this case yet.",
        "grounded_facts": lines,
        "engine": "extractive",
        "watermark": "AI-generated summary -- verify against source events before relying on it.",
    }


def _summarize_with_ollama(lines: list[str]) -> str:
    import requests

    settings = get_settings()
    prompt = (
        "Rewrite the following grounded case facts as a concise plain-English "
        "incident summary for an investigator. Do not add any fact not present "
        "in the list, and do not speculate.\n\nFacts:\n" + "\n".join(f"- {l}" for l in lines)
    )
    resp = requests.post(
        f"{settings.ollama_base_url}/api/generate",
        json={"model": "llama3.1", "prompt": prompt, "stream": False},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("response", " ".join(lines))
