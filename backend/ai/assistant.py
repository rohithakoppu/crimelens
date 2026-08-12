"""AI investigation assistant: retrieval-augmented Q&A grounded strictly in a
case's own event log (per design doc Sec 3 -- answers must not draw on general
knowledge, only the case's actual events, for legal defensibility).

MVP retrieval uses TF-IDF cosine similarity (scikit-learn) over event
descriptions -- no external embedding API or GPU required, and the ranking is
easy to explain to a judge. A vector-store upgrade (Chroma + real embeddings)
is the noted "future polish" path.
"""

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from ai.summarizer import _describe_event


def answer_question(question: str, events: list[dict], top_k: int = 5) -> dict:
    if not events:
        return {
            "answer": "No events are recorded for this case yet, so I have nothing grounded to answer from.",
            "sources": [],
        }

    descriptions = [_describe_event(e) for e in events]
    corpus = descriptions + [question]

    # Character n-grams (not word tokens) so word-form variants like
    # "tamper" vs "tampering" still match -- important since a plain word
    # vectorizer would otherwise treat those as unrelated tokens and miss
    # obviously-relevant events.
    vectorizer = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5))
    matrix = vectorizer.fit_transform(corpus)
    question_vec = matrix[-1]
    event_vecs = matrix[:-1]

    similarities = cosine_similarity(question_vec, event_vecs).flatten()
    ranked_idx = similarities.argsort()[::-1][:top_k]
    relevant = [(descriptions[i], float(similarities[i])) for i in ranked_idx if similarities[i] > 0]

    if not relevant:
        return {
            "answer": "None of this case's recorded events appear relevant to that question.",
            "sources": [],
        }

    answer = "Based on this case's recorded events: " + " ".join(desc for desc, _ in relevant)
    return {
        "answer": answer,
        "sources": [{"text": desc, "relevance": round(score, 4)} for desc, score in relevant],
        "watermark": "Answer is grounded only in this case's logged events -- verify against source before acting.",
    }
