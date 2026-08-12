from datetime import datetime, timezone

from fpdf import FPDF
from fpdf.enums import XPos, YPos


def build_certificate_pdf(
    evidence_id: str,
    case_id: str,
    original_hash: str,
    current_hash: str,
    matches: bool,
    chain_tx_hash: str | None,
    blockchain_status: str,
    custody_intact: bool,
    custody_events: list[dict],
    camera_id: str = "UNAVAILABLE",
    owner_name: str = "UNAVAILABLE",
    captured_at: str = "UNAVAILABLE",
    duration_seconds: float | None = None,
    segment_count: int | None = None,
    root_hash: str | None = None,
    segment_chain_intact: bool | None = None,
    verdict: str | None = None,
) -> bytes:
    """Evidence Integrity Verification Certificate (not a legal/court
    certification -- see disclaimer). Shows the original vs. recomputed
    hash, the Evidence Root Hash over the segment chain, the Ed25519/
    Algorand-anchored integrity verdict, and the full hash-linked custody
    timeline, so any third party can independently check the underlying
    claims via the referenced Algorand transaction.

    Every value here comes from a real GET /evidence/{id}/verify result --
    nothing is invented. Fields that genuinely aren't available (e.g. no
    owner on record, no segments yet) print literally as "UNAVAILABLE"
    rather than being guessed or omitted silently.
    """
    duration_display = f"{duration_seconds:.1f}s" if duration_seconds is not None else "UNAVAILABLE"
    segment_count_display = str(segment_count) if segment_count is not None else "UNAVAILABLE"
    root_hash_display = root_hash or "UNAVAILABLE (no segments recorded)"
    verdict_display = verdict or ("AUTHENTIC" if matches else "TAMPERED")
    segment_chain_display = (
        "INTACT" if segment_chain_intact else ("BROKEN" if segment_chain_intact is False else "UNAVAILABLE")
    )

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, "CrimeLens - Evidence Integrity Verification Certificate", new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    pdf.set_font("Helvetica", size=10)
    pdf.cell(0, 8, f"Generated: {datetime.now(timezone.utc).isoformat()}", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(4)

    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Evidence Identity", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Helvetica", size=10)
    pdf.multi_cell(
        0, 6,
        f"Evidence ID: {evidence_id}\n"
        f"Case ID: {case_id}\n"
        f"Camera ID: {camera_id}\n"
        f"Owner / Submitted by: {owner_name}\n"
        f"Capture time: {captured_at}\n"
        f"Duration: {duration_display}\n"
        f"Segment count: {segment_count_display}",
        new_x=XPos.LMARGIN, new_y=YPos.NEXT,
    )
    pdf.ln(2)

    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Integrity Verification", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Helvetica", size=10)
    pdf.multi_cell(
        0,
        6,
        f"Original SHA-256 (at registration): {original_hash}\n"
        f"Current SHA-256 (recomputed now):   {current_hash}\n"
        f"Evidence Root Hash (segment chain):  {root_hash_display}\n"
        f"Segment chain status: {segment_chain_display}\n"
        f"Verdict: {verdict_display}\n"
        f"Algorand Testnet anchor status: {blockchain_status}\n"
        f"Algorand transaction ID: {chain_tx_hash or 'not yet anchored'}",
        new_x=XPos.LMARGIN, new_y=YPos.NEXT,
    )
    pdf.ln(2)

    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Chain of Custody", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Helvetica", size=9)
    pdf.multi_cell(0, 6, f"Custody chain status: {'INTACT' if custody_intact else 'BROKEN'}", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    if not custody_events:
        pdf.multi_cell(0, 6, "No custody events recorded.", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    for evt in custody_events:
        pdf.multi_cell(0, 5, f"[{evt['timestamp']}] {evt['action']} by {evt['actor']}", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.ln(4)

    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Limitations", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Helvetica", "I", 8)
    pdf.multi_cell(
        0,
        5,
        "This certificate proves: the referenced file and segment chain have the stated hashes, those "
        "hashes were digitally signed and (when anchored) recorded on Algorand Testnet at the stated "
        "time, and neither the file nor its segments have changed since. It does NOT prove the recorded "
        "footage is truthful, that the scene was not manipulated before capture, or any conclusion about "
        "guilt. The Algorand transaction above can be independently inspected by anyone on a public block "
        "explorer without trusting this platform operator. This is a hackathon prototype, not a certified "
        "forensic or legal document.",
        new_x=XPos.LMARGIN, new_y=YPos.NEXT,
    )

    return bytes(pdf.output())
